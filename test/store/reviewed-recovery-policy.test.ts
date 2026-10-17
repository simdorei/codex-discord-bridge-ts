import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {installReviewedRecoveryPolicyOn,reviewedRecoveryPolicyInstalledIn,installReviewedRecoveryPolicy} from '../../src/store/reviewed-recovery-policy.ts';
import {REVIEWED_INCIDENT_THREAD as T,asyncRecoveryPolicyHeldIn} from '../../src/store/async-resolution-policy.ts';
import {AsyncResolutionHeldError} from '../../src/store/async-resolution-admission.ts';
import {storeFixture} from '../helpers/store-fixture.ts';import {openInitialized} from '../../src/store/owned-driver.ts';
function memory(run:(db:DatabaseSync)=>void){const db=new DatabaseSync(':memory:');try{db.exec("CREATE TABLE cdr_runtime_capability_requirements(component TEXT,format_version INTEGER);INSERT INTO cdr_runtime_capability_requirements VALUES('async_recovery_policy',1);CREATE TABLE cdr_async_recovery_policies(thread_id TEXT PRIMARY KEY,format_version INTEGER,policy TEXT,proposal_sha256 TEXT,original_turn_id TEXT,origin_job_id TEXT,pending_job_id TEXT);CREATE TABLE cdr_async_execution_obligations(thread_id TEXT,format_version INTEGER,policy TEXT,admission_state TEXT)");run(db);}finally{db.close();}}
test('exact installation is idempotent, holds only incident obligations and never clears fallback',()=>memory(db=>{
 db.prepare("INSERT INTO cdr_async_execution_obligations VALUES(?,1,'ordinary','ready')").run(T);db.exec("INSERT INTO cdr_async_execution_obligations VALUES('other',1,'ordinary','ready')");
 assert.equal(reviewedRecoveryPolicyInstalledIn(db),false);installReviewedRecoveryPolicyOn(db);installReviewedRecoveryPolicyOn(db);assert.equal(reviewedRecoveryPolicyInstalledIn(db),true);
 assert.equal(db.prepare('SELECT count(*) n FROM cdr_async_recovery_policies').get()!.n,1);
 assert.deepEqual({...db.prepare('SELECT policy,admission_state FROM cdr_async_execution_obligations WHERE thread_id=?').get(T)},{policy:'publishing_recovery',admission_state:'held'});
 assert.equal(db.prepare("SELECT admission_state FROM cdr_async_execution_obligations WHERE thread_id='other'").get()!.admission_state,'ready');
 assert.equal(asyncRecoveryPolicyHeldIn(db,T),true);
}));
test('unsupported capability fails before registration',()=>memory(db=>{
 db.exec('UPDATE cdr_runtime_capability_requirements SET format_version=2');assert.throws(()=>installReviewedRecoveryPolicyOn(db),AsyncResolutionHeldError);assert.equal(db.prepare('SELECT count(*) n FROM cdr_async_recovery_policies').get()!.n,0);assert.equal(db.isTransaction,false);
}));
test('changed persisted identity is preserved and refuses installation',()=>memory(db=>{
 installReviewedRecoveryPolicyOn(db);db.exec("UPDATE cdr_async_recovery_policies SET pending_job_id='foreign'");
 assert.throws(()=>installReviewedRecoveryPolicyOn(db),/identity changed/);assert.equal(db.prepare('SELECT pending_job_id FROM cdr_async_recovery_policies').get()!.pending_job_id,'foreign');
}));
test('unsupported original obligation rolls back newly inserted registration',()=>memory(db=>{
 db.prepare("INSERT INTO cdr_async_execution_obligations VALUES(?,2,'ordinary','ready')").run(T);
 assert.throws(()=>installReviewedRecoveryPolicyOn(db),/unsupported original/);assert.equal(db.prepare('SELECT count(*) n FROM cdr_async_recovery_policies').get()!.n,0);assert.equal(db.prepare('SELECT policy FROM cdr_async_execution_obligations').get()!.policy,'ordinary');
}));
test('already publishing but not held fails final verification and rolls back ordinary changes',()=>memory(db=>{
 db.prepare("INSERT INTO cdr_async_execution_obligations VALUES(?,1,'ordinary','ready'),(?,1,'publishing_recovery','ready')").run(T,T);
 assert.throws(()=>installReviewedRecoveryPolicyOn(db),/did not commit exactly/);assert.equal(db.prepare('SELECT count(*) n FROM cdr_async_recovery_policies').get()!.n,0);assert.equal(db.prepare("SELECT count(*) n FROM cdr_async_execution_obligations WHERE policy='ordinary'").get()!.n,1);
}));
test('native update failure rolls back registration and preserves original obligation',()=>memory(db=>{
 db.prepare("INSERT INTO cdr_async_execution_obligations VALUES(?,1,'ordinary','ready')").run(T);db.exec("CREATE TRIGGER denied BEFORE UPDATE ON cdr_async_execution_obligations BEGIN SELECT RAISE(ABORT,'fixture denial'); END");
 assert.throws(()=>installReviewedRecoveryPolicyOn(db),/fixture denial/);assert.equal(db.prepare('SELECT count(*) n FROM cdr_async_recovery_policies').get()!.n,0);
}));
test('caller transaction is neither committed nor rolled back',()=>memory(db=>{
 db.exec('BEGIN');assert.throws(()=>installReviewedRecoveryPolicyOn(db),/transaction/i);assert.equal(db.isTransaction,true);db.exec('ROLLBACK');
}));
test('registration detects wrong storage class and invalid UTF8 rather than replacing evidence',()=>memory(db=>{
 installReviewedRecoveryPolicyOn(db);db.exec("UPDATE cdr_async_recovery_policies SET pending_job_id=CAST(x'ff' AS TEXT)");assert.throws(()=>reviewedRecoveryPolicyInstalledIn(db),/text|encoding/i);
}));
test('real initialized schema accepts the exact registration through the owned path',async()=>storeFixture(async path=>{
 await installReviewedRecoveryPolicy(path);const db=await openInitialized(path);try{assert.equal(reviewedRecoveryPolicyInstalledIn(db),true);assert.equal(asyncRecoveryPolicyHeldIn(db,T),true);}finally{db.close();}
}));
test('missing table and a same-named view are not installation evidence',()=>{
 const db=new DatabaseSync(':memory:');try{assert.equal(reviewedRecoveryPolicyInstalledIn(db),false);db.exec('CREATE VIEW cdr_async_recovery_policies AS SELECT 1');assert.equal(reviewedRecoveryPolicyInstalledIn(db),false);}finally{db.close();}
});
