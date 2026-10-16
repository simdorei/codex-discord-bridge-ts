import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import type {Worker} from 'node:worker_threads';
import {NativeMutationOwner} from '../../src/runtime/native-mutation-owner.ts';
import {isOwnedMutationOutcomeUnknown,type MaintenanceClaim} from '../../src/app-server/maintenance-attempt.ts';
import {OwnedWorkerBusyError,ownedWorkerUsage} from '../../src/runtime/owned-worker-slot.ts';
import {openInitialized} from '../../src/store/owned-driver.ts';
import {storeFixture} from '../helpers/store-fixture.ts';
import {createMutationCustodyFence} from '../../src/runtime/mutation-custody-fence.ts';
import {selectJob,serializeStoredQueueJob} from '../../src/store/queue-read.ts';
import {parseSerdeValue} from '../../src/core/serde-json-parse.ts';
import {serializeSerdeValue} from '../../src/core/serde-json.ts';
import {claimStopControl} from '../../src/store/stop-control-dispatch.ts';
import type {DatabaseSync} from 'node:sqlite';
const render=(s:string)=>'safe: '+s;
async function fixture(run:(path:string,db:DatabaseSync,owner:NativeMutationOwner,claim:MaintenanceClaim)=>Promise<void>,timeout=5000){
 await storeFixture(async path=>{
  const db=await openInitialized(path);db.exec("INSERT INTO codex_mutation_runtime VALUES(1,'runtime'); INSERT INTO codex_app_server_runtime VALUES(1,'runtime')");
  const owner=new NativeMutationOwner(path,'runtime',render,timeout);
  const origin=createMutationCustodyFence(path,'runtime',e=>String(e)).requestOrigin('thread/settings/update',{threadId:'T'});
  const claim:MaintenanceClaim={ownerId:'resident',generation:1n,attemptId:'attempt',wire:12n,method:'thread/settings/update',params:{threadId:'T'},scoped:true,origin};
  try{await run(path,db,owner,claim);}finally{await owner.close();db.close();}
 });
}
const unknown=(error:unknown)=>isOwnedMutationOutcomeUnknown(error);
function state(db:DatabaseSync){return db.prepare('SELECT state FROM codex_mutation_attempts').get()?.state;}
function queue(db:DatabaseSync){db.exec("INSERT INTO codex_turn_queue(job_id,target_thread_id,channel_id,owner_user_id,app_server_generation,execution_generation,prompt,queued,ack_sent,state,attempt_count,baseline_turn_ids,created_at,updated_at) VALUES('job','T',42,3,1,1,'input',0,1,'starting',1,'[]',1,1)");return parseSerdeValue(serializeStoredQueueJob(selectJob(db,'job')));}

test('native intent and explicit completion retain exact owner, generation and wire identity',async()=>fixture(async(_p,db,owner,c)=>{
 const r=await owner.begin(c);assert.equal(Object.isFrozen(r),true);assert.equal(state(db),'prepared');
 const row=db.prepare('SELECT owner_id,generation,wire_id,target_thread_id FROM codex_mutation_attempts').get()!;
 assert.deepEqual({...row},{owner_id:'resident',generation:1,wire_id:'12',target_thread_id:'T'});
 await owner.finish(r,'reply_ok');assert.equal(state(db),'reply_ok');assert.throws(()=>owner.finish(r,'reply_error'),/unused receipt/);
}));
test('close after committed begin never invents not_sent or erases prepared intent',async()=>fixture(async(_p,db,owner,c)=>{
 await owner.begin(c);await owner.close();assert.equal(state(db),'prepared');assert.equal(ownedWorkerUsage().Control,0);
}));
test('forged and cross-owner receipts cannot settle another store',async()=>fixture(async(_p,db,owner,c)=>storeFixture(async otherPath=>{
 const other=await openInitialized(otherPath);other.exec("INSERT INTO codex_mutation_runtime VALUES(1,'runtime')");const b=new NativeMutationOwner(otherPath,'runtime',render);
 try{const r=await owner.begin(c);assert.throws(()=>owner.finish({...r},'not_sent'),/unused receipt/);assert.throws(()=>b.finish(r,'not_sent'),/unused receipt/);assert.equal(state(db),'prepared');assert.equal(state(other),undefined);await owner.finish(r,'not_sent');assert.equal(state(db),'not_sent');}finally{await b.close();other.close();}
})));
test('captured claim cannot be redirected by mutation after native admission',async()=>fixture(async(_p,db,owner,c)=>{
 const mutable={...c,params:{threadId:'T'}};const pending=owner.begin(mutable);mutable.ownerId='other';mutable.params.threadId='elsewhere';
 await pending;const row=db.prepare('SELECT owner_id,target_thread_id FROM codex_mutation_attempts').get()!;assert.equal(row.owner_id,'resident');assert.equal(row.target_thread_id,'T');
}));
test('preabort, getters and oversize claim fail before admission and do not create a store',async()=>storeFixture(async path=>{
 const owner=new NativeMutationOwner(path,'runtime',render),a=new AbortController(),reason={cancel:true};a.abort(reason);let getters=0;
 try{assert.throws(()=>owner.begin({} as MaintenanceClaim,a.signal),e=>e===reason);assert.throws(()=>owner.begin(Object.defineProperty({},'params',{enumerable:true,get(){getters++;throw 0;}}) as MaintenanceClaim));assert.throws(()=>owner.begin({params:'x'.repeat(1048577)} as MaintenanceClaim),/boundary/);assert.equal(getters,0);assert.equal(owner.busy,false);assert.equal(existsSync(path),false);}finally{await owner.close();}
}));
test('one active mutation has no queue and accepted cancellation joins before reporting unknown',async()=>fixture(async(_p,db,owner,c)=>{
 const a=new AbortController(),pending=owner.begin(c,a.signal),rejected=assert.rejects(pending,unknown);assert.equal(owner.busy,true);assert.throws(()=>owner.begin(c),OwnedWorkerBusyError);a.abort(new Error('leave'));
 await rejected;assert.equal(owner.busy,false);assert.equal(ownedWorkerUsage().Control,0);assert.equal(state(db),'prepared');
}));
test('native deadline cannot pretend a committed late begin rolled back',async()=>fixture(async(_p,db,owner,c)=>{
 await assert.rejects(owner.begin(c),unknown);assert.equal(ownedWorkerUsage().Control,0);assert.equal(state(db),'prepared');
},1));
test('actual SQLite lock wait leaves event loop responsive and joins native transaction',async()=>fixture(async(_p,db,owner,c)=>{
 db.exec('BEGIN IMMEDIATE');let timerElapsed=Infinity;const start=performance.now();const timer=setTimeout(()=>{timerElapsed=performance.now()-start;db.exec('COMMIT');},250);
 try{await owner.begin(c);assert.ok(timerElapsed<1500,`event loop timer delayed ${timerElapsed}ms`);assert.equal(state(db),'prepared');assert.equal(ownedWorkerUsage().Control,0);}finally{clearTimeout(timer);if(db.isTransaction)db.exec('ROLLBACK');}
}));
test('queue validation stays inside insertion transaction and post-insert drift rolls back',async()=>fixture(async(_p,db,owner,c)=>{
 const original=queue(db);db.exec("CREATE TRIGGER changed AFTER INSERT ON codex_mutation_attempts BEGIN UPDATE codex_turn_queue SET owner_user_id=99 WHERE job_id='job'; END");
 await assert.rejects(owner.beginQueue({ownerId:c.ownerId,generation:c.generation,attemptId:c.attemptId,wire:c.wire,method:'turn/start',params:{threadId:'T'},claim:original}),unknown);
 assert.equal(state(db),undefined);assert.equal(selectJob(db,'job').ownerUserId,3n);
}));
test('failed completion consumes its receipt but retains durable intent for reconciliation',async()=>fixture(async(_p,db,owner,c)=>{
 const r=await owner.begin(c);db.exec("CREATE TRIGGER denied BEFORE UPDATE ON codex_mutation_attempts BEGIN SELECT RAISE(ABORT,'completion denied'); END");
 await assert.rejects(owner.finish(r,'reply_error'),unknown);assert.equal(state(db),'prepared');assert.throws(()=>owner.finish(r,'not_sent'),/unused receipt/);
}));
test('a stop accepted after original capture prevents ordinary native begin',async()=>fixture(async(_p,db,owner,c)=>{
 db.exec("UPDATE cdr_stop_clock SET revision=1; INSERT INTO cdr_stop_revision_receipts VALUES('stop','T',1,'{}'); INSERT INTO cdr_stop_revisions VALUES('T',1,'stop')");
 await assert.rejects(owner.begin(c),unknown);assert.equal(state(db),undefined);
}));
test('already accepted original stop completes through dedicated native path without releasing execution hold',async()=>fixture(async(path,db,owner,c)=>{
 queue(db);db.exec("UPDATE codex_turn_queue SET state='running',turn_id='V',turn_observation_generation=1; INSERT INTO cdr_execution_holds VALUES('job','T','stop','{}',0)");
 const control={operation_id:'stop-original',target:'T',channel:42n,owner:3n,resident:'resident',generation:1n,turn:'V',binding:{target:'T',route:'Selected',command:{Stop:{reference:null}}},jobs:[serializeStoredQueueJob(selectJob(db,'job'))],can_settle:true};
 const json=`{${Object.entries(control).map(([k,v])=>`${JSON.stringify(k)}:${serializeSerdeValue(v)}`).join(',')}}`;
 db.prepare("INSERT INTO cdr_stop_controls(operation_id,target_thread_id,resident_owner,generation,turn_id,record_json,phase) VALUES('stop-original','T','resident',1,'V',?,'accepted')").run(json);
 const stop=claimStopControl(path,control,()=>{})!;const r=await owner.beginStop({ownerId:c.ownerId,generation:c.generation,attemptId:c.attemptId,wire:c.wire,params:{threadId:'T',turnId:'V'},claim:stop});
 assert.equal(db.prepare('SELECT phase FROM cdr_stop_controls').get()!.phase,'dispatching');await owner.finish(r,'reply_ok');assert.equal(db.prepare('SELECT phase FROM cdr_stop_controls').get()!.phase,'acknowledged');assert.equal(db.prepare('SELECT count(*) AS n FROM cdr_execution_holds').get()!.n,1);assert.equal(state(db),undefined);
}));
test('wrong runtime and absent store cannot gain a committed receipt',async()=>fixture(async(path,db,_owner,c)=>{
 const wrong=new NativeMutationOwner(path,'foreign',render);
 try{await assert.rejects(wrong.begin(c),unknown);assert.equal(state(db),undefined);}finally{await wrong.close();}
 await storeFixture(async absent=>{const missing=new NativeMutationOwner(absent,'runtime',render);try{await assert.rejects(missing.begin(c),unknown);assert.equal(existsSync(absent),false);}finally{await missing.close();}});
}));
test('global Control saturation rejects before native admission without inventing an unknown commit',async()=>fixture(async(path,db,owner,c)=>{
 const other=new NativeMutationOwner(path,'runtime',render);const first=owner.begin(c);
 try{await assert.rejects(other.begin({...c,attemptId:'other',params:{threadId:'other'}}),e=>e instanceof OwnedWorkerBusyError&&!unknown(e));await first;assert.equal(db.prepare('SELECT count(*) AS n FROM codex_mutation_attempts').get()!.n,1);}finally{await other.close();await Promise.allSettled([first]);}
}));
test('completion cannot borrow a changed runtime and cancellation never synthesizes its outcome',async()=>fixture(async(_p,db,owner,c)=>{
 const receipt=await owner.begin(c);db.exec("UPDATE codex_mutation_runtime SET runtime_id='new-runtime'");
 await assert.rejects(owner.finish(receipt,'reply_ok'),unknown);assert.equal(state(db),'prepared');
}));

test('unsubmitted refusal binds this owner and exact attempt, wire and method only',async()=>fixture(async(path,_db,owner,c)=>{
 const other=new NativeMutationOwner(path,'runtime',render),active=owner.begin(c);
 try{
  let local:unknown;try{owner.begin(c);}catch(error){local=error;}
  assert.ok(local instanceof OwnedWorkerBusyError);
  assert.equal(owner.ownsUnsubmittedFailure(local,c.attemptId,c.wire,c.method),true);
  assert.equal(owner.ownsUnsubmittedFailure(local,'other',c.wire,c.method),false);
  assert.equal(owner.ownsUnsubmittedFailure(local,c.attemptId,13n,c.method),false);
  assert.equal(owner.ownsUnsubmittedFailure(local,c.attemptId,c.wire,'turn/start'),false);
  assert.equal(other.ownsUnsubmittedFailure(local,c.attemptId,c.wire,c.method),false);
  assert.equal(owner.ownsUnsubmittedFailure(new OwnedWorkerBusyError(),c.attemptId,c.wire,c.method),false);
  let global:unknown;try{await other.begin({...c,attemptId:'second'});}catch(error){global=error;}
  assert.ok(global instanceof OwnedWorkerBusyError);
  assert.equal(other.ownsUnsubmittedFailure(global,'second',c.wire,c.method),true);
  assert.equal(owner.ownsUnsubmittedFailure(global,'second',c.wire,c.method),false);
  await active;
 }finally{await Promise.allSettled([active,other.close()]);}
}));

test('renderer reentrancy retains classified owner busy and close waits without deadlock',async()=>fixture(async(path,_db,_owner,c)=>{
 let entered=0,closing:Promise<void>|undefined;
 const owner=new NativeMutationOwner(path,'foreign',text=>{
  entered++;assert.equal(owner.busy,true);
  assert.throws(()=>owner.begin(c),OwnedWorkerBusyError);
  closing=owner.close();return 'safe: '+text;
 });
 try{await assert.rejects(owner.begin(c),unknown);assert.equal(entered,1);assert.ok(closing);await closing;assert.equal(owner.busy,false);assert.equal(ownedWorkerUsage().Control,0);}
 finally{await owner.close();}
}));

for(const action of ['abort','close'] as const)test(`joined raw-result boundary still observes owner ${action}`,async()=>fixture(async(_path,db,owner,c)=>{
 const controller=new AbortController(),reason=new Error('cancel after transport result');let reached=false,closing:Promise<void>|undefined;
 // The slot exit settles its result. Its awaiting transport first joins the
 // already-resolved idle promise, then resolves raw data. Two queued microtasks
 // intervene after that raw resolution but before owner classification.
 const observe=(worker:Worker)=>worker.once('exit',()=>queueMicrotask(()=>queueMicrotask(()=>{
  reached=true;assert.equal(owner.busy,true);
  if(action==='abort')controller.abort(reason);else closing=owner.close(reason);
 })));
 process.on('worker',observe);
 try{
  await assert.rejects(owner.begin(c,controller.signal),unknown);
  assert.equal(reached,true);await closing;assert.equal(owner.busy,false);
  assert.equal(ownedWorkerUsage().Control,0);assert.equal(state(db),'prepared');
 }finally{process.off('worker',observe);await owner.close();}
}));
