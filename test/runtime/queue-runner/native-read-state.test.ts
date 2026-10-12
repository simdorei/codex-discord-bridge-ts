import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {queueJob} from '../../helpers/queue-job.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {holdIn} from '../../../src/store/execution-hold.ts';
import {createNativeQueueReadState,NativeQueueReadUnavailableError} from '../../../src/runtime/queue-runner/native-read-state.ts';
import {QueueReadCoordinator} from '../../../src/runtime/queue-runner/read-coordinator.ts';
import {OwnedWorkerBudgetError,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
async function edit<T>(path:string,run:(db:DatabaseSync)=>T):Promise<T>{const db=await openInitialized(path);try{return run(db);}finally{db.close();}}
function insert(db:DatabaseSync,id:string,target:string,generation:bigint,created:number){
 db.prepare("INSERT INTO codex_turn_queue(job_id,target_thread_id,channel_id,app_server_generation,prompt,queued,ack_sent,state,attempt_count,baseline_turn_ids,last_error,created_at,updated_at) VALUES(?,?,9007199254740995,?,'prompt',1,0,'pending',0,'[]','',?,?)").run(id,target,generation,created,created);
}
test('native queue facade overrides exactly four functions and retains all other original identities',()=>{
 const facade=createNativeQueueReadState('db');assert.equal(Object.isFrozen(facade),true);assert.deepEqual(Object.keys(facade),Object.keys(state));
 for(const key of Object.keys(state) as (keyof typeof state)[])if(key==='listFiltered'||key==='eligibleJobs'||key==='deadTargetHeld'||key==='asyncTargetDispatchHeld')assert.notEqual(facade[key],state[key]);else assert.equal(facade[key],state[key]);
});
test('native list preserves four filter modes, exact order, empty/astral target and lossless signed values',async()=>storeFixture(async path=>{
 await edit(path,db=>{insert(db,'b','😀',-2n,2);insert(db,'a','😀',-2n,2);insert(db,'c','',3n,1);insert(db,'d','😀',3n,3);});const native=createNativeQueueReadState(path);
 for(const [target,generation] of [[null,null],['😀',null],[null,-2n],['😀',-2n],['',null],['absent',null]] as const){const received=await native.listFiltered(path,target,generation);for(const row of received)assert.equal(Object.getPrototypeOf(row),null);assert.deepEqual(received.map(row=>({...row})),await state.listFiltered(path,target,generation));assert.equal(ownedWorkerUsage().Control,0);}
 const all=await native.listFiltered(path,null,null);assert.deepEqual(all.map(j=>j.jobId),['c','a','b','d']);assert.equal(all[0]!.channelId,9007199254740995n);
}));
test('native list rejects complete response when a later row cannot decode, rather than returning a prefix',async()=>storeFixture(async path=>{
 await edit(path,db=>{insert(db,'good','t',1n,1);insert(db,'bad','t',1n,2);db.exec("UPDATE codex_turn_queue SET baseline_turn_ids='invalid-json' WHERE job_id='bad'");});
 await assert.rejects(state.listFiltered(path,'t',null));await assert.rejects(createNativeQueueReadState(path).listFiltered(path,'t',null),NativeQueueReadUnavailableError);assert.equal(ownedWorkerUsage().Control,0);
}));
test('native eligible preserves Pending-only hold query, duplicates and captured input order',async()=>storeFixture(async path=>{
 await edit(path,db=>holdIn(db,'held','target','hold','{}'));const held=queueJob({jobId:'held'}),free=queueJob({jobId:'free'}),running=queueJob({jobId:'held',state:'Running'}),input=[free,held,running,free];const expected=await state.eligibleJobs(path,input),native=createNativeQueueReadState(path);
 const task=native.eligibleJobs(path,input);free.prompt='changed';input.reverse();const result=await task;assert.deepEqual(result.map(j=>j.jobId),['free','held','free']);assert.equal(result[0]!.prompt,'prompt');assert.notEqual(result[0],free);assert.deepEqual(result.map(j=>j.state),expected.map(j=>j.state));assert.equal(ownedWorkerUsage().Control,0);
}));
test('non-Pending eligible rows skip absent holds table, while Pending requires it',async()=>storeFixture(async path=>{
 await edit(path,db=>db.exec('DROP TABLE cdr_execution_holds'));const native=createNativeQueueReadState(path),rows=[queueJob({state:'Running'}),queueJob({state:'Quarantined'})];const received=await native.eligibleJobs(path,rows);for(const row of received)assert.equal(Object.getPrototypeOf(row),null);assert.deepEqual(received.map(row=>({...row})),rows);await assert.rejects(native.eligibleJobs(path,[queueJob()]),NativeQueueReadUnavailableError);
}));
test('eligible strict UTF8 reason error remains unavailable rather than falsely permitting a Pending job',async()=>storeFixture(async path=>{
 await edit(path,db=>{holdIn(db,'saved','target','held','{}');db.exec("UPDATE cdr_execution_holds SET reason=CAST(X'80' AS TEXT)");});assert.throws(()=>state.eligibleJobsExisting(path,[queueJob()]));await assert.rejects(createNativeQueueReadState(path).eligibleJobs(path,[queueJob()]),NativeQueueReadUnavailableError);
}));
test('missing store refuses empty eligible input and list without creating or initializing a database',async()=>storeFixture(async path=>{
 const native=createNativeQueueReadState(path);for(const call of [()=>native.eligibleJobs(path,[]),()=>native.listFiltered(path,null,null)]){await assert.rejects(call(),NativeQueueReadUnavailableError);assert.equal(existsSync(path),false);assert.equal(ownedWorkerUsage().Control,0);}
}));
test('queue input validation rejects path retargeting, invalid generation, accessors and surrogate without invoking hooks',async()=>storeFixture(async path=>{
 const native=createNativeQueueReadState(path);await assert.rejects(native.listFiltered(path+'other',null,null),TypeError);await assert.rejects(native.eligibleJobs(path+'other',[]),TypeError);await assert.rejects(native.listFiltered(path,'\ud800',null));await assert.rejects(native.listFiltered(path,null,1n<<63n),TypeError);
 let calls=0;const row=Object.defineProperty(queueJob(),'prompt',{get(){calls++;return 'unsafe';}});await assert.rejects(native.eligibleJobs(path,[row]));const proxy=new Proxy(queueJob(),{get(){calls++;throw Error('trap');}});await assert.rejects(native.eligibleJobs(path,[proxy]));assert.equal(calls,0);assert.equal(existsSync(path),false);
}));
test('native Control saturation refuses a second read and never uses Background or falls back to main SQLite',async()=>storeFixture(async path=>{
 await edit(path,()=>{});const native=createNativeQueueReadState(path),first=native.listFiltered(path,null,null);assert.equal(ownedWorkerUsage().Control,1);await assert.rejects(native.listFiltered(path,null,null),OwnedWorkerBudgetError);assert.equal(ownedWorkerUsage().Background,0);await first;assert.equal(ownedWorkerUsage().Control,0);
}));
test('blocked native read deadline keeps target lease until actual SQLite exit while main timers continue',async()=>storeFixture(async path=>{
 await edit(path,()=>{});const db=new DatabaseSync(path);db.exec('PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE');const native=createNativeQueueReadState(path,30),queue=new QueueReadCoordinator(path,{activeTurnId:async()=>null},native);let settled=false,ticks=0;const timer=setInterval(()=>ticks++,10),task=queue.busyStatus('target');void task.then(()=>settled=true,()=>settled=true);const rejected=assert.rejects(task,NativeQueueReadUnavailableError);
 try{await new Promise(r=>setTimeout(r,200));assert.ok(ticks>=3);assert.equal(settled,false);assert.equal(queue.locks.tryAcquire('target'),undefined);assert.equal(ownedWorkerUsage().Control,1);db.exec('ROLLBACK');await rejected;assert.equal(queue.locks.activeTargetCount,0);assert.equal(ownedWorkerUsage().Control,0);}finally{clearInterval(timer);if(db.isTransaction)db.exec('ROLLBACK');await task.catch(()=>{});db.close();}
}));
test('cancellation cannot release target lease before pending native read and original following eligible read settle',async()=>storeFixture(async path=>{
 await edit(path,()=>{});const db=new DatabaseSync(path);db.exec('PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE');const abort=new AbortController(),sentinel=new Error('cancel-owned'),native=createNativeQueueReadState(path),queue=new QueueReadCoordinator(path,{activeTurnId:async()=>null},native);let settled=false;const task=queue.busyStatus('target',abort.signal);void task.then(()=>settled=true,()=>settled=true);const rejected=assert.rejects(task,e=>e===sentinel);
 try{await new Promise(r=>setTimeout(r,100));abort.abort(sentinel);await new Promise(r=>setTimeout(r,50));assert.equal(settled,false);assert.equal(queue.locks.tryAcquire('target'),undefined);db.exec('ROLLBACK');await rejected;assert.equal(queue.locks.activeTargetCount,0);assert.equal(ownedWorkerUsage().Control,0);}finally{if(db.isTransaction)db.exec('ROLLBACK');await task.catch(()=>{});db.close();}
}));
