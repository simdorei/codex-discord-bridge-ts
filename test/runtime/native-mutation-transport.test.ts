import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {performance} from 'node:perf_hooks';
import type {Worker} from 'node:worker_threads';
import type {DatabaseSync} from 'node:sqlite';
import {NativeMutationTransport} from '../../src/runtime/native-mutation-transport.ts';
import {OwnedWorkerSlot,OwnedWorkerBudgetError,ownedWorkerUsage,ownedWorkerModuleUrl} from '../../src/runtime/owned-worker-slot.ts';
import {createMutationCustodyFence} from '../../src/runtime/mutation-custody-fence.ts';
import {openInitialized} from '../../src/store/owned-driver.ts';
import {storeFixture} from '../helpers/store-fixture.ts';

const deadline=5000;
const helper=ownedWorkerModuleUrl(new URL('../helpers/native-mixed-lane-worker.ts',import.meta.url),import.meta.url);
function openGates(state:Int32Array){for(const index of [0,3]){Atomics.store(state,index,1);Atomics.notify(state,index);}}
async function gated(run:(state:Int32Array)=>Promise<void>){
 const state=new Int32Array(new SharedArrayBuffer(16)),slot=new OwnedWorkerSlot('Control');
 const pending=slot.run(helper,{id:'mutation-transport-blocker',shared:state.buffer,offered:'bounded'},deadline).then(value=>({value}),error=>({error}));
 try{
  const until=performance.now()+deadline;
  while(Atomics.load(state,1)!==1&&performance.now()<until)await delay(5);
  assert.equal(Atomics.load(state,1),1,'actual Control worker reached its gate');
  await run(state);
 }finally{openGates(state);await pending;await slot.join();}
}
async function fixture(run:(path:string,db:DatabaseSync,transport:NativeMutationTransport)=>Promise<void>){
 await storeFixture(async path=>{
  const db=await openInitialized(path);db.exec("INSERT INTO codex_mutation_runtime VALUES(1,'runtime'); INSERT INTO codex_app_server_runtime VALUES(1,'runtime')");
  const transport=new NativeMutationTransport(path,'runtime',deadline);
  try{await run(path,db,transport);}finally{if(db.isTransaction)db.exec('ROLLBACK');await transport.close();db.close();}
 });
}
function prepare(path:string,id:string,wire:bigint){
 const fence=createMutationCustodyFence(path,'runtime',String),params={threadId:id};
 assert.equal(fence.beginMutationWithOrigin({ownerId:'resident',generation:1n,attemptId:id,wire,method:'thread/settings/update',params,scoped:true,origin:fence.requestOrigin('thread/settings/update',params)}),true);
 return {ownerId:'resident',generation:1n,attemptId:id,wire,outcome:'reply_ok' as const};
}

test('transport phases belong to exact promises and genuine Control saturation constructs no mutation worker',async()=>storeFixture(async path=>{
 const transport=new NativeMutationTransport(path,'runtime',deadline),other=new NativeMutationTransport(path,'runtime',deadline);
 let constructions=0;const observe=(_worker:Worker)=>{constructions++;};process.on('worker',observe);
 try{
  await gated(async()=>{
   assert.equal(constructions,1);assert.equal(ownedWorkerUsage().Control,1);
   for(const operation of ['beginMutationWithOrigin','beginQueueMutation','beginStopMutation'] as const){
    const pending=transport.submit(operation,{});
    assert.equal(transport.wasAdmitted(pending),false);
    assert.throws(()=>other.wasAdmitted(pending),/Expected submission/);
    const wrapped=pending.then(value=>value,error=>{throw error;});
    const wrappedRejected=assert.rejects(wrapped,OwnedWorkerBudgetError);
    assert.throws(()=>transport.wasAdmitted(wrapped),/Expected submission/);
    await assert.rejects(pending,OwnedWorkerBudgetError);await wrappedRejected;
    assert.equal(transport.wasAdmitted(pending),false,'phase remains available after settlement');
   }
   assert.throws(()=>transport.wasAdmitted(Promise.resolve()),/Expected submission/);
   assert.equal(constructions,1);assert.equal(existsSync(path),false);assert.equal(transport.busy,false);
  });
  assert.equal(ownedWorkerUsage().Control,0);
 }finally{process.off('worker',observe);await transport.close();await other.close();}
}));

test('actual completions preserve FIFO while cancelled queued work never constructs a worker',async()=>fixture(async(path,db,transport)=>{
 const first=prepare(path,'first',1n),cancelled=prepare(path,'cancelled',2n),last=prepare(path,'last',3n);
 db.exec('CREATE TABLE completion_order(sequence INTEGER PRIMARY KEY, attempt_id TEXT); CREATE TRIGGER record_completion AFTER UPDATE OF state ON codex_mutation_attempts BEGIN INSERT INTO completion_order(attempt_id) VALUES(NEW.attempt_id); END');
 let constructions=0;const observe=(_worker:Worker)=>{constructions++;};process.on('worker',observe);
 const pending:Promise<unknown>[]=[];
 try{
  await gated(async state=>{
   const controller=new AbortController(),reason=new Error('cancel queued completion');
   const a=transport.submit('finishMutation',first),b=transport.submit('finishMutation',cancelled,controller.signal),c=transport.submit('finishMutation',last);pending.push(a,b,c);
   const rejected=assert.rejects(b,error=>error===reason);
   for(const submission of pending)assert.equal(transport.wasAdmitted(submission),true);
   assert.equal(constructions,1);assert.equal(transport.busy,true);
   controller.abort(reason);await rejected;
   assert.equal(transport.wasAdmitted(b),true,'queued phase remains conservative after cancellation');
   assert.equal(constructions,1);assert.equal(db.prepare('SELECT count(*) AS n FROM completion_order').get()!.n,0);
   openGates(state);
   assert.deepEqual(await a,{ok:true});assert.deepEqual(await c,{ok:true});
   assert.equal(transport.wasAdmitted(a),true);assert.equal(transport.wasAdmitted(c),true,'settled native work retains its initial phase');
  });
  assert.deepEqual(db.prepare('SELECT attempt_id FROM completion_order ORDER BY sequence').all().map(row=>row.attempt_id),['first','last']);
  assert.equal(db.prepare("SELECT state FROM codex_mutation_attempts WHERE attempt_id='cancelled'").get()!.state,'prepared');
  assert.equal(constructions,3);assert.equal(transport.busy,false);assert.equal(ownedWorkerUsage().Control,0);
 }finally{await Promise.allSettled(pending);process.off('worker',observe);}
}));

test('close cancels both queued completion operations without starting native workers',async()=>storeFixture(async path=>{
 const transport=new NativeMutationTransport(path,'runtime',deadline);
 let constructions=0;const observe=(_worker:Worker)=>{constructions++;};process.on('worker',observe);
 try{
  await gated(async()=>{
   const reason=new Error('close queued transport');
   const a=transport.submit('finishMutation',{}),b=transport.submit('finishStopMutation',{});
   const rejected=Promise.all([assert.rejects(a,error=>error===reason),assert.rejects(b,error=>error===reason)]);
   assert.equal(transport.wasAdmitted(a),true);assert.equal(transport.wasAdmitted(b),true);
   await transport.close(reason);await rejected;
   assert.equal(transport.busy,false);assert.equal(constructions,1);assert.equal(existsSync(path),false);
   assert.equal(ownedWorkerUsage().Control,1,'unrelated actual gate remains owned');
   assert.throws(()=>transport.submit('finishMutation',{}),/closed/);
  });
  assert.equal(ownedWorkerUsage().Control,0);
 }finally{process.off('worker',observe);await transport.close();}
}));

test('close of an admitted native completion waits for actual exit despite cancellation',async()=>fixture(async(path,db,transport)=>{
 const completion=prepare(path,'active',1n),reason=new Error('close active transport');
 db.exec('BEGIN IMMEDIATE');
 const pending=transport.submit('finishMutation',completion),rejected=assert.rejects(pending,error=>error===reason);
 assert.equal(transport.wasAdmitted(pending),true);
 // A completion gets its Control grant on the next microtask. Keep the actual
 // database locked until close has demonstrably remained pending.
 await delay(0);assert.equal(ownedWorkerUsage().Control,1);
 let closed=false;const closing=transport.close(reason).then(()=>{closed=true;});
 try{
  await delay(25);assert.equal(closed,false);assert.equal(transport.busy,true);assert.equal(ownedWorkerUsage().Control,1);
 }finally{db.exec('COMMIT');await closing;await rejected;}
 assert.equal(transport.busy,false);assert.equal(ownedWorkerUsage().Control,0);assert.equal(transport.wasAdmitted(pending),true);
 assert.equal(db.prepare("SELECT state FROM codex_mutation_attempts WHERE attempt_id='active'").get()!.state,'reply_ok','cancellation did not undo durable native completion');
}));

test('transport rejects off-main submissions before any nested worker construction',async()=>{
 const module=ownedWorkerModuleUrl(new URL('../../src/runtime/native-mutation-transport.ts',import.meta.url),import.meta.url).href;
 const source=`import {parentPort} from 'node:worker_threads';
 import {NativeMutationTransport} from ${JSON.stringify(module)};
 let constructions=0;process.on('worker',()=>{constructions++;});
 const transport=new NativeMutationTransport('unused-no-io','runtime',5000);
 const results=[];
 for(const operation of ['beginMutationWithOrigin','beginQueueMutation','beginStopMutation','finishMutation','finishStopMutation']){
  const pending=transport.submit(operation,{});
  try{await pending;results.push({unexpected:true});}catch(error){results.push({message:error.message,admitted:transport.wasAdmitted(pending)});}
 }
 await transport.close();parentPort.postMessage({results,constructions,busy:transport.busy});parentPort.close();`;
 const slot=new OwnedWorkerSlot('Background');
 try{
  const raw=await slot.run(new URL('data:text/javascript,'+encodeURIComponent(source)),null,deadline) as {results:{message:string;admitted:boolean}[];constructions:number;busy:boolean};
  assert.equal(raw.results.length,5);for(const result of raw.results){assert.match(result.message,/main runtime owner/);assert.equal(result.admitted,false);}
  assert.equal(raw.constructions,0);assert.equal(raw.busy,false);
 }finally{await slot.join();}
 assert.equal(ownedWorkerUsage().Background,0);assert.equal(ownedWorkerUsage().Control,0);
});
