import test from 'node:test';import assert from 'node:assert/strict';import {setImmediate as tick} from 'node:timers/promises';
import {existsSync} from 'node:fs';import {DatabaseSync} from 'node:sqlite';
import {NativeCompletionDiscoveryReader} from '../../../../src/runtime/completion/native-discovery.ts';
import {CompletionDiscovery} from '../../../../src/runtime/completion/scheduler/discovery.ts';
import {CompletionReady} from '../../../../src/runtime/completion/scheduler/ready.ts';
import {CompletionScheduler} from '../../../../src/runtime/completion/scheduler/run.ts';
import {CompletionEventBudget} from '../../../../src/runtime/completion/scheduler/envelope.ts';
import {ownedWorkerUsage} from '../../../../src/runtime/owned-worker-slot.ts';
import {openInitialized} from '../../../../src/store/owned-driver.ts';
import {StateAccessFacade as state} from '../../../../src/store/state-access-facade.ts';
import type {CompletionEntry} from '../../../../src/store/completion-metadata.ts';
import {storeFixture} from '../../../helpers/store-fixture.ts';import {queueJob} from '../../../helpers/queue-job.ts';
const gate=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};};
class PausedReader extends NativeCompletionDiscoveryReader{
 pause=false;entered=gate();release=gate();
 override async discover<L>(...args:Parameters<NativeCompletionDiscoveryReader['discover']>):ReturnType<NativeCompletionDiscoveryReader['discover']>{
  const result=await super.discover(...args);if(this.pause){this.pause=false;this.entered.resolve();await this.release.promise;}return result;
 }
}
const entry=(id:string,source:CompletionEntry['source']='Final'):CompletionEntry=>({source,id,target:id,turn:'turn',channel:1n,bytes:1n,position:{stamp:0,ordinal:0n,id}});
async function init(path:string,edit?:(db:DatabaseSync)=>void){const db=await openInitialized(path);try{edit?.(db);}finally{db.close();}}
const read=(d:CompletionDiscovery,q:CompletionReady<string>,active=new Set<string>(),signal?:AbortSignal)=>d.readAsync('runtime',1n,q,active,signal);
test('native discovery preserves source-local failure, rotation, active filtering and live FIFO',async()=>storeFixture(async path=>{
 for(let i=0;i<2;i++)await state.enqueue(path,queueJob({jobId:'job'+i,targetThreadId:'job'+i}));const owner=new NativeCompletionDiscoveryReader(path),d=new CompletionDiscovery(['Queue','Queue','Observed'],()=>0,owner),q=new CompletionReady<string>();let disposed=0;
 q.live({target:'live',needsNative:false,payload:'first',dispose(){disposed++;}});q.live({target:'live',needsNative:false,payload:'second',dispose(){disposed++;}});
 try{const reports=await read(d,q,new Set(['job0']));assert.deepEqual(reports.map(r=>r.ok),[true,false,true]);assert.equal(d.rotation,1);assert.equal(q.stateLength,3);assert.deepEqual(q.stateSnapshot().slice(0,2).map(w=>w.kind==='Live'?w.live.payload:''),['first','second']);assert.equal(disposed,0);assert.equal(d.snapshot()[1]!.cursor.finished,false);assert.equal(Object.hasOwn(d.snapshot()[0]!,'wakeVersion'),false);}finally{q.dispose();await owner.close();}assert.equal(disposed,2);
}));
test('snapshot failure rolls back all speculative hints and scan state without disposing live owner',async()=>storeFixture(async path=>{
 const owner=new NativeCompletionDiscoveryReader(path),d=new CompletionDiscovery(['Queue','Final'],()=>0,owner),q=new CompletionReady<string>();let disposed=0;q.live({target:'live',needsNative:false,payload:'x',dispose(){disposed++;}});q.durable(entry('old'),new Set());const before=d.snapshot();
 try{await assert.rejects(read(d,q));assert.deepEqual(d.snapshot(),before);assert.equal(d.rotation,0);assert.equal(q.stateLength,1);assert.equal(q.httpLength,1);assert.equal(disposed,0);assert.equal(existsSync(path),false);}finally{q.dispose();await owner.close();}assert.equal(disposed,1);
}));
test('late whole-round failure discards successful native source hints as one atomic draft',async()=>storeFixture(async path=>{
 await state.enqueue(path,queueJob({jobId:'one',targetThreadId:'target'}));const sentinel=new Error('late round finish refusal');
 class FailedReader extends NativeCompletionDiscoveryReader{override async discover<L>(...args:Parameters<NativeCompletionDiscoveryReader['discover']>):ReturnType<NativeCompletionDiscoveryReader['discover']>{await super.discover(...args);throw sentinel;}}
 const owner=new FailedReader(path),d=new CompletionDiscovery(['Queue'],()=>0,owner),ready=new CompletionReady<string>();ready.durable(entry('old'),new Set());const before=d.snapshot();
 try{await assert.rejects(read(d,ready),e=>e===sentinel);assert.equal(ready.stateLength,0);assert.equal(ready.httpLength,1);assert.deepEqual(d.snapshot(),before);assert.equal(d.rotation,0);assert.equal(ownedWorkerUsage().Discovery,0);}finally{ready.dispose();await owner.close();}
}));
test('new wake arriving during native restart is not overwritten by older scan commit',async()=>storeFixture(async path=>{
 await init(path);const owner=new PausedReader(path),d=new CompletionDiscovery(['Final'],()=>0,owner),q=new CompletionReady<string>();
 try{await read(d,q);assert.equal(d.drained,true);d.wake('Final');owner.pause=true;const pending=read(d,q);await owner.entered.promise;
  assert.throws(()=>q.dispose(),/owns/);await assert.rejects(read(d,q),/ownership/);d.wakeHttp();owner.release.resolve();await pending;
  assert.equal(d.snapshot()[0]!.wake,true);assert.equal(d.drained,false);await read(d,q);assert.equal(d.snapshot()[0]!.wake,false);assert.equal(d.drained,true);
 }finally{owner.release.resolve();await owner.close();q.dispose();}
}));
test('full ready keeps new page pending and cooldown/pending-only rounds never allocate worker',async()=>storeFixture(async path=>{
 for(let i=0;i<34;i++)await state.enqueue(path,queueJob({jobId:'job'+String(i).padStart(2,'0'),targetThreadId:'target'+i}));const owner=new NativeCompletionDiscoveryReader(path),d=new CompletionDiscovery(['Queue'],()=>0,owner),q=new CompletionReady<string>();
 for(let i=0;i<128;i++)q.live({target:'live'+i,needsNative:false,payload:'live',dispose(){}});
 try{await read(d,q);assert.equal(q.length,128);assert.equal(d.snapshot()[0]!.pending.length,32);const before=d.snapshot();
  const noPage=read(d,q);assert.equal(ownedWorkerUsage().Discovery,0);await noPage;assert.deepEqual(d.snapshot(),before);
  q.dispose();await read(d,q);assert.equal(q.stateLength,34);assert.equal(d.drained,true);
  const cooldown=read(d,q);assert.equal(ownedWorkerUsage().Discovery,0);await cooldown;assert.equal(q.stateLength,34);
 }finally{q.dispose();await owner.close();}
}));
test('native orphan sidecars identify only the newly appended hint and retain durable evidence',async()=>storeFixture(async path=>{
 await init(path,db=>db.exec("INSERT INTO cdr_async_execution_obligations(question_id,thread_id,origin_job_id,turn_id,channel_id,format_version,revision,answer_state,execution_state,admission_state,policy,claim_json,original_error,created_at,updated_at) VALUES ('q','orphan','lost','turn',1,1,0,'unresolved','unresolved','held','ordinary','{}','original uncertainty',0,0)"));
 const owner=new NativeCompletionDiscoveryReader(path),d=new CompletionDiscovery(['AsyncOrphan'],()=>0,owner),q=new CompletionReady<string>();q.live({target:'live',needsNative:false,payload:'x',dispose(){}});
 try{const reports=await read(d,q),negatives=reports.flatMap(r=>r.ok&&r.metadata!==null?r.metadata.deferred:[]);assert.equal(negatives.length,1);assert.equal(negatives[0]!.index,1);assert.equal(q.discardOrphanHints(negatives),1);assert.equal(q.discardOrphanHints(negatives),0);assert.equal(q.stateLength,1);const db=new DatabaseSync(path);try{assert.equal(db.prepare('SELECT count(*) AS n FROM cdr_async_execution_obligations').get()?.n,1);}finally{db.close();}}finally{q.dispose();await owner.close();}
}));
test('scheduler buffers new input while native read owns Ready and joins read before abort disposal',async()=>storeFixture(async path=>{
 await init(path);const owner=new PausedReader(path);owner.pause=true;const d=new CompletionDiscovery(['Final'],()=>0,owner),budget=new CompletionEventBudget(),cancel=new AbortController();let dispatched=0,done=false;
 const scheduler=new CompletionScheduler(path,{instanceId:()=> 'runtime',generation:()=>1n,prepare:()=>{dispatched++;throw Error('unexpected admission');},state:async()=>{},http:async()=>{dispatched++;},prepareFailed:()=>{},freshHeads:async()=>[],maintain:async()=>{},report:()=>{},gap:()=>{}},{discovery:d});
 const live=(target:string)=>budget.chargeOwned({kind:'Notification',generation:1n,notification:{method:'turn/completed',params:{threadId:target,turn:{id:'t',status:'completed'}}}})!;
 scheduler.offer(live('before'));const running=scheduler.run(cancel.signal).then(()=>{done=true;});
 try{await owner.entered.promise;scheduler.offer(live('during'));assert.equal(scheduler.pendingInput,1);assert.ok(budget.availableBytes<budget.capacity);cancel.abort(new Error('stop scheduler'));await tick();assert.equal(done,false);assert.equal(dispatched,0);owner.release.resolve();await running;assert.equal(budget.availableBytes,budget.capacity);assert.equal(ownedWorkerUsage().Discovery,0);assert.equal(dispatched,0);}finally{cancel.abort();owner.release.resolve();await running;await owner.close();}
}));
test('scheduler consumes native orphan negative proof before any state admission',async()=>storeFixture(async path=>{
 await init(path,db=>db.exec("INSERT INTO cdr_async_execution_obligations(question_id,thread_id,origin_job_id,turn_id,channel_id,format_version,revision,answer_state,execution_state,admission_state,policy,claim_json,original_error,created_at,updated_at) VALUES ('q','orphan','lost','turn',1,1,0,'unresolved','unresolved','held','ordinary','{}','original uncertainty',0,0)"));
 const owner=new NativeCompletionDiscoveryReader(path),d=new CompletionDiscovery(['AsyncOrphan'],()=>0,owner);let attempted=0;const errors:unknown[]=[];
 const scheduler=new CompletionScheduler(path,{instanceId:()=> 'runtime',generation:()=>1n,prepare:()=>{attempted++;throw Error('orphan admitted');},state:async()=>{},http:async()=>{},prepareFailed:e=>errors.push(e),freshHeads:async()=>[],maintain:async()=>{},report:e=>errors.push(e),gap:e=>errors.push(e)},{discovery:d});scheduler.finishInput();
 try{await scheduler.run(new AbortController().signal);assert.equal(attempted,0);assert.deepEqual(errors,[]);}finally{await owner.close();}
}));
