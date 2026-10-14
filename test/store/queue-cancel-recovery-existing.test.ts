import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {storeFixture} from '../helpers/store-fixture.ts';
import {queueJob} from '../helpers/queue-job.ts';
import {openInitialized} from '../../src/store/owned-driver.ts';
import {StateAccessFacade as state} from '../../src/store/state-access-facade.ts';
import type {RecoveryCancellationCheck} from '../../src/store/queue-cancel-recovery.ts';
import {currentStopRevisionIn} from '../../src/store/stop-revision-read.ts';
const checked:RecoveryCancellationCheck=()=>undefined;
async function seeded(run:(path:string)=>Promise<void>){await storeFixture(async path=>{await state.enqueue(path,queueJob({jobId:'job',ownerUserId:2n,createdAt:1}));await run(path);});}
test('existing-only cancellation preserves started evidence and never opens an initializer',()=>seeded(async path=>{
 const db=await openInitialized(path);try{db.exec("UPDATE codex_turn_queue SET state='running',turn_id='turn',attempt_count=1");}finally{db.close();}
 let checks=0;assert.deepEqual(state.cancelForRecoveryExisting(path,'target',1n,2n,10,()=>{checks++;return undefined;}),{jobs:['job'],startedOrUncertain:1});assert.equal(checks,2);
 const read=await openInitialized(path);try{assert.equal(read.prepare('SELECT COUNT(*) AS n FROM codex_request_cancellations').get()?.n,1);assert.equal(read.prepare('SELECT COUNT(*) AS n FROM cdr_execution_holds').get()?.n,1);assert.equal(currentStopRevisionIn(read),1n);}finally{read.close();}
}));
test('missing existing path is not created or initialized',()=>storeFixture(async path=>{
 assert.equal(existsSync(path),false);assert.throws(()=>state.cancelForRecoveryExisting(path,'target',1n,2n,10,checked));assert.equal(existsSync(path),false);
}));
test('borrowed cancellation keeps transaction open and caller rollback restores all evidence',()=>seeded(async path=>{
 const db=await openInitialized(path);try{assert.throws(()=>state.cancelForRecoveryIn(db,'target',1n,2n,10,checked),/transaction/);db.exec('BEGIN IMMEDIATE');assert.deepEqual(state.cancelForRecoveryIn(db,'target',1n,2n,10,checked),{jobs:['job'],startedOrUncertain:0});assert.equal(db.isTransaction,true);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM codex_turn_queue').get()?.n,0);db.exec('ROLLBACK');assert.equal(db.prepare('SELECT COUNT(*) AS n FROM codex_turn_queue').get()?.n,1);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM codex_request_cancellations').get()?.n,0);assert.equal(currentStopRevisionIn(db),0n);}finally{db.close();}
}));
test('last original custody rejection is identical and fully rolls back existing write',()=>seeded(async path=>{
 const sentinel={original:'custody'},check=(()=>{if(++calls===2)throw sentinel;return undefined;}) as RecoveryCancellationCheck;let calls=0;assert.throws(()=>state.cancelForRecoveryExisting(path,'target',1n,2n,10,check),e=>e===sentinel);const db=await openInitialized(path);try{assert.equal(db.prepare('SELECT COUNT(*) AS n FROM codex_turn_queue').get()?.n,1);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cdr_execution_holds').get()?.n,0);assert.equal(currentStopRevisionIn(db),0n);}finally{db.close();}
}));
test('synchronous callback returning rejected Promise is observed and never commits',()=>seeded(async path=>{
 const check=(()=>Promise.reject(new Error('async forbidden'))) as unknown as RecoveryCancellationCheck;assert.throws(()=>state.cancelForRecoveryExisting(path,'target',1n,2n,10,check),/synchronous recovery/);await new Promise(resolve=>setImmediate(resolve));const db=await openInitialized(path);try{assert.equal(db.prepare('SELECT COUNT(*) AS n FROM codex_turn_queue').get()?.n,1);assert.equal(currentStopRevisionIn(db),0n);}finally{db.close();}
}));
for(const count of [128,129])test(`bounded inventory ${count} proves completeness or rolls back`,()=>storeFixture(async path=>{
 const db=await openInitialized(path);try{const q=db.prepare("INSERT INTO codex_prompt_intakes(job_id,target_thread_id,channel_id,owner_user_id,raw_prompt,auto_queue_when_busy,require_current_mirror,created_at,updated_at) VALUES (?,'target',1,2,'hello',1,0,1,1)");for(let i=0;i<count;i++)q.run('intake-'+i);}finally{db.close();}
 if(count===128)assert.equal(state.cancelForRecoveryExisting(path,'target',1n,2n,10,checked).jobs.length,128);else assert.throws(()=>state.cancelForRecoveryExisting(path,'target',1n,2n,10,checked),/too many/);
 const read=await openInitialized(path);try{assert.equal(read.prepare('SELECT COUNT(*) AS n FROM codex_prompt_intakes').get()?.n,count===128?0:129);assert.equal(read.prepare('SELECT COUNT(*) AS n FROM codex_request_cancellations').get()?.n,count===128?128:0);}finally{read.close();}
}));
