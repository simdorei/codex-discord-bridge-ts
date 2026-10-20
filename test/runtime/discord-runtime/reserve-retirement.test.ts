import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {existsSync} from 'node:fs';
import {storeFixture} from '../../helpers/store-fixture.ts';import {openInitialized} from '../../../src/store/owned-driver.ts';import {enqueue,type NewQueueJob} from '../../../src/store/queue-enqueue.ts';
import {retireRuntimeReserveOffThread,RuntimeReserveRetirementError,RuntimeReserveRetirementUnconfirmed} from '../../../src/runtime/discord-runtime/reserve-retirement.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError,OwnedWorkerBudgetError,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
const limits={maxRows:128,maxBytes:1048576};
const job:NewQueueJob={jobId:'legacy',targetThreadId:'thread',channelId:42n,ownerUserId:3n,discordMessageId:null,appServerGeneration:1n,prompt:'retained',queued:true,ackSent:true,createdAt:1};
async function seed(path:string){await enqueue(path,job);const db=await openInitialized(path);try{db.exec("INSERT INTO codex_reserve_policy(thread_id,mode,state)VALUES('thread','auto','unknown')");}finally{db.close();}}
function read(path:string){const db=new DatabaseSync(path,{readOnly:true});try{return {mode:db.prepare('SELECT mode FROM codex_reserve_policy').get()!.mode,holds:db.prepare('SELECT COUNT(*) AS n FROM cdr_execution_holds').get()!.n,markers:db.prepare('SELECT COUNT(*) AS n FROM cdr_store_retirements').get()!.n,prompt:db.prepare('SELECT prompt FROM codex_turn_queue').get()!.prompt};}finally{db.close();}}
test('native startup retirement commits policy snapshot, execution hold and marker before success, then is idempotent',async()=>storeFixture(async path=>{
 await seed(path);assert.deepEqual(await retireRuntimeReserveOffThread(path,limits),{alreadyCompleted:false,heldJobs:1n,policySnapshots:1n});assert.deepEqual(read(path),{mode:'manual',holds:1,markers:1,prompt:'retained'});
 assert.deepEqual(await retireRuntimeReserveOffThread(path,limits),{alreadyCompleted:true,heldJobs:0n,policySnapshots:0n});assert.equal(ownedWorkerUsage().Control,0);
}));
test('native retirement marker failure rolls back all retirement changes before reporting failure',async()=>storeFixture(async path=>{
 await seed(path);const db=await openInitialized(path);try{db.exec("CREATE TRIGGER fail_retirement BEFORE INSERT ON cdr_store_retirements BEGIN SELECT RAISE(ABORT,'reject marker'); END");}finally{db.close();}
 await assert.rejects(retireRuntimeReserveOffThread(path,limits),e=>e instanceof RuntimeReserveRetirementError&&e.message.includes('reject marker'));assert.deepEqual(read(path),{mode:'auto',holds:0,markers:0,prompt:'retained'});assert.equal(ownedWorkerUsage().Control,0);
}));
test('abort after native submission joins completion but cannot claim retirement did not commit',async()=>storeFixture(async path=>{
 await seed(path);const a=new AbortController(),reason={cancelled:true},pending=retireRuntimeReserveOffThread(path,limits,10000,a.signal);a.abort(reason);
 await assert.rejects(retireRuntimeReserveOffThread(path,limits),OwnedWorkerBusyError);
 await assert.rejects(pending,e=>e instanceof RuntimeReserveRetirementUnconfirmed&&e.cause===reason&&e.path===path);
 assert.deepEqual(read(path),{mode:'manual',holds:1,markers:1,prompt:'retained'});assert.equal(ownedWorkerUsage().Control,0);
}));
test('native startup transaction waits off main thread while control slot remains occupied',async()=>storeFixture(async path=>{
 await seed(path);const db=new DatabaseSync(path);db.exec('BEGIN IMMEDIATE');let ticks=0;const timer=setInterval(()=>ticks++,5);const pending=retireRuntimeReserveOffThread(path,limits);
 try{await new Promise<void>(resolve=>setTimeout(resolve,500));assert.ok(ticks>=20);assert.equal(ownedWorkerUsage().Control,1);db.exec('ROLLBACK');assert.equal((await pending).heldJobs,1n);}finally{clearInterval(timer);if(db.isTransaction)db.exec('ROLLBACK');db.close();await pending.catch(()=>{});}
}));
test('preabort and invalid passive inputs cannot submit or create a store',async()=>storeFixture(async path=>{
 let hooks=0;const poisoned=Object.defineProperty({maxBytes:1},'maxRows',{get(){hooks++;return 1;}});await assert.rejects(retireRuntimeReserveOffThread(path,poisoned as never),TypeError);
 await assert.rejects(retireRuntimeReserveOffThread(path,new Proxy({},{getOwnPropertyDescriptor(){hooks++;throw Error('hook');}}) as never),TypeError);
 await assert.rejects(retireRuntimeReserveOffThread(path,limits,0),RangeError);const a=new AbortController();a.abort('pre');await assert.rejects(retireRuntimeReserveOffThread(path,limits,10000,a.signal),e=>e==='pre');assert.equal(hooks,0);assert.equal(existsSync(path),false);assert.equal(ownedWorkerUsage().Control,0);
}));
test('global control saturation is definitive no-submission and does not become a retirement uncertainty',async()=>storeFixture(async path=>{
 const slot=new OwnedWorkerSlot('Control'),shared=new SharedArrayBuffer(4),view=new Int32Array(shared),url=new URL('data:text/javascript,'+encodeURIComponent("import{parentPort,workerData}from'node:worker_threads';Atomics.wait(new Int32Array(workerData),0,0,10000);parentPort.postMessage('done');parentPort.close();"));const pending=slot.run(url,shared,10000);
 try{await assert.rejects(retireRuntimeReserveOffThread(path,limits),OwnedWorkerBudgetError);assert.equal(existsSync(path),false);}finally{Atomics.store(view,0,1);Atomics.notify(view,0);await pending;await slot.join();}
}));

test('native deadline joins worker and retains unknown outcome instead of silently repeating retirement',async()=>storeFixture(async path=>{
 await seed(path);await assert.rejects(retireRuntimeReserveOffThread(path,limits,1),RuntimeReserveRetirementUnconfirmed);assert.equal(ownedWorkerUsage().Control,0);assert.deepEqual(read(path),{mode:'manual',holds:1,markers:1,prompt:'retained'});
}));
test('commit blocked by a held read transaction is classified unconfirmed and never retried',async()=>storeFixture(async path=>{
 await seed(path);const reader=new DatabaseSync(path);reader.exec('PRAGMA journal_mode=DELETE;BEGIN');reader.prepare('SELECT * FROM codex_reserve_policy').all();
 try{await assert.rejects(retireRuntimeReserveOffThread(path,limits,10000),RuntimeReserveRetirementUnconfirmed);}finally{reader.exec('ROLLBACK');reader.close();}
 assert.deepEqual(read(path),{mode:'auto',holds:0,markers:0,prompt:'retained'});assert.equal(ownedWorkerUsage().Control,0);
}));
