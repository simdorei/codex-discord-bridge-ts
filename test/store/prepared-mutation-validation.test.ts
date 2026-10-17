import {ensureForkHandoffTable} from '../../src/store/fork-handoff-admission.ts';
import test from 'node:test';import assert from 'node:assert/strict';import {existsSync} from 'node:fs';import {performance} from 'node:perf_hooks';import type {DatabaseSync} from 'node:sqlite';
import {revalidatePreparedMutation} from '../../src/store/prepared-mutation-validation.ts';import {openInitialized} from '../../src/store/owned-driver.ts';import {begin,type NewAttempt} from '../../src/store/mutation-attempt.ts';import {storeFixture} from '../helpers/store-fixture.ts';import {revalidateQueueStartAuthorityIn} from '../../src/store/queue-start-authority.ts';import {selectJob,serializeStoredQueueJob} from '../../src/store/queue-read.ts';import {parseSerdeValue} from '../../src/core/serde-json-parse.ts';
const claim:NewAttempt={runtimeId:'runtime',ownerId:'owner',generation:1n,attemptId:'attempt',wireId:'"wire"',method:'turn/start',targetThreadId:'T',scoped:true,payload:{request:'original'}};
async function fixture(run:(path:string,db:DatabaseSync)=>void|Promise<void>,c:NewAttempt=claim){await storeFixture(async path=>{const db=await openInitialized(path);ensureForkHandoffTable(db);db.exec("INSERT INTO codex_mutation_runtime VALUES(1,'runtime')");begin(path,c);try{await run(path,db);}finally{db.close();}});}
function extra(db:DatabaseSync,id:string,target:string,scoped=1){db.prepare("INSERT INTO codex_mutation_attempts(attempt_id,runtime_id,owner_id,generation,wire_id,method,target_thread_id,scoped,request_sha256,state,created_at,updated_at) VALUES(?,'runtime','other',1,'other','turn/start',?,?,'hash','prepared',1,1)").run(id,target,scoped);}
test('own exact prepared row is excluded and final authority check is query-only inside one transaction',async()=>fixture((path,db)=>{
 const before=db.prepare('SELECT * FROM codex_mutation_attempts').all();let calls=0;revalidatePreparedMutation(path,claim,c=>{calls++;assert.equal(c.isTransaction,true);assert.equal(c.prepare('PRAGMA query_only').get()!.query_only,1);return undefined;});assert.equal(calls,1);assert.deepEqual(db.prepare('SELECT * FROM codex_mutation_attempts').all(),before);
}));
test('different same-target corrupt-store and global prepared rows are never excluded as own',async()=>{
 for(const scoped of [0,1])await fixture((path,db)=>{if(scoped){assert.throws(()=>extra(db,'other','T',1),/UNIQUE/);db.exec('DROP INDEX codex_mutation_prepared_target');}extra(db,'other',scoped?'T':'elsewhere',scoped);assert.throws(()=>revalidatePreparedMutation(path,claim,()=>undefined),/another prepared/);});
});
test('unrelated scoped hold is allowed for scoped request, but blocks global request',async()=>{
 await fixture((path,db)=>{extra(db,'other','unrelated');revalidatePreparedMutation(path,claim,()=>undefined);});
 const global={...claim,targetThreadId:null,scoped:false};await fixture((path,db)=>{extra(db,'other','unrelated');assert.throws(()=>revalidatePreparedMutation(path,global,()=>undefined),/another prepared/);},global);
});
test('each original identity and payload hash remains bound',async()=>{
 for(const changed of [{ownerId:'other'},{generation:2n},{wireId:'other'},{method:'turn/steer'},{targetThreadId:'other'},{scoped:false},{payload:{request:'changed'}}])await fixture(path=>assert.throws(()=>revalidatePreparedMutation(path,{...claim,...changed},()=>undefined),/missing or changed/));
});
test('changed runtime, settled row and deleted intent cannot regain permission',async()=>{
 for(const sql of ["UPDATE codex_mutation_runtime SET runtime_id='other'","UPDATE codex_mutation_attempts SET state='reply_ok'","DELETE FROM codex_mutation_attempts"])await fixture((path,db)=>{db.exec(sql);assert.throws(()=>revalidatePreparedMutation(path,claim,()=>undefined));});
});
test('original queue owner drift after native commit is refused by same-connection final guard',async()=>fixture((path,db)=>{
 db.exec("INSERT INTO codex_turn_queue(job_id,target_thread_id,channel_id,owner_user_id,app_server_generation,execution_generation,prompt,queued,ack_sent,state,attempt_count,baseline_turn_ids,created_at,updated_at) VALUES('job','T',42,3,1,1,'input',0,1,'starting',1,'[]',1,1)");const original=parseSerdeValue(serializeStoredQueueJob(selectJob(db,'job')));
 revalidatePreparedMutation(path,claim,c=>{revalidateQueueStartAuthorityIn(c,original,'T',1n);return undefined;});db.exec('UPDATE codex_turn_queue SET owner_user_id=99');assert.throws(()=>revalidatePreparedMutation(path,claim,c=>{revalidateQueueStartAuthorityIn(c,original,'T',1n);return undefined;}),/original queue start authority/);assert.equal(db.prepare('SELECT state FROM codex_mutation_attempts').get()!.state,'prepared');
}));
test('read callback cannot alter intent or create data and its rejection preserves rows',async()=>fixture((path,db)=>{
 assert.throws(()=>revalidatePreparedMutation(path,claim,c=>{c.exec("UPDATE codex_mutation_attempts SET state='reply_ok'");return undefined;}));assert.equal(db.prepare('SELECT state FROM codex_mutation_attempts').get()!.state,'prepared');revalidatePreparedMutation(path,claim,()=>undefined);
}));
test('exclusive writer contention fails promptly with zero SQLite busy retry',async()=>fixture((path,db)=>{
 db.exec('BEGIN EXCLUSIVE');try{const t=performance.now();assert.throws(()=>revalidatePreparedMutation(path,claim,()=>undefined));assert.ok(performance.now()-t<1000);}finally{db.exec('ROLLBACK');}
}));
test('absent database, hostile getters and async authority callbacks do not create a store',async()=>storeFixture(async path=>{
 let calls=0;assert.throws(()=>revalidatePreparedMutation(path,claim,()=>undefined));assert.equal(existsSync(path),false);
 const accessor=Object.defineProperty({...claim},'payload',{enumerable:true,get(){calls++;throw 0;}});assert.throws(()=>revalidatePreparedMutation(path,accessor,()=>undefined));assert.equal(calls,0);
 assert.throws(()=>revalidatePreparedMutation(path,claim,(async()=>undefined) as unknown as (db:DatabaseSync)=>undefined),/synchronous/);assert.equal(existsSync(path),false);
}));
test('unexpected callback result or ended transaction is not a successful final validation',async()=>fixture(path=>{
 assert.throws(()=>revalidatePreparedMutation(path,claim,(()=>Promise.resolve()) as unknown as (db:DatabaseSync)=>undefined),/synchronously/);
 assert.throws(()=>revalidatePreparedMutation(path,claim,c=>{c.exec('COMMIT');return undefined;}),/ended unexpectedly/);
}));
test('read-only queue authority refuses every existing durable queue hold without DDL',async()=>{
 for(const sql of ["INSERT INTO cdr_execution_holds VALUES('job','T','stop','{}',0)","INSERT INTO codex_request_cancellations VALUES('job','T',42,3,NULL,0)","INSERT INTO codex_archive_fences VALUES('T','op',NULL,'attempted')","INSERT INTO codex_dead_generation_holds VALUES('T','runtime',1,0)","INSERT INTO codex_dead_generation_incidents VALUES('runtime',1,'{}','[]',0)","INSERT INTO cdr_async_recovery_policies VALUES('T',1,'publishing_recovery','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','v','origin','pending')"]){await fixture((path,db)=>{
  db.exec("INSERT INTO codex_app_server_runtime VALUES(1,'runtime'); INSERT INTO codex_turn_queue(job_id,target_thread_id,channel_id,owner_user_id,app_server_generation,execution_generation,prompt,queued,ack_sent,state,attempt_count,baseline_turn_ids,created_at,updated_at) VALUES('job','T',42,3,1,1,'input',0,1,'starting',1,'[]',1,1)");const original=parseSerdeValue(serializeStoredQueueJob(selectJob(db,'job')));db.exec(sql);assert.throws(()=>revalidatePreparedMutation(path,claim,c=>{revalidateQueueStartAuthorityIn(c,original,'T',1n);return undefined;}));
 });}
});
test('existing fork guards preserve unresolved/moved/exact-routing behavior on query-only handle',async()=>{
 const {requireNoUnresolvedHandoffExistingIn:unresolved,requireSourceNotMovedExistingIn:moved}=await import('../../src/store/fork-handoff-admission.ts');
 await fixture((_path,db)=>{
  db.exec("INSERT INTO codex_thread_fork_handoffs(handoff_id,source_thread_id,expected_generation,discord_channel_id,discord_thread_id,quarantine_reason,created_at) VALUES('h','T',1,2,3,'reason',0); PRAGMA query_only=ON");assert.throws(()=>unresolved(db,'T'),/unresolved/);db.exec('PRAGMA query_only=OFF');
  db.exec("UPDATE codex_thread_fork_handoffs SET target_thread_id='next',observed_target_thread_id='next',completed_generation=2,completed_at=1; PRAGMA query_only=ON");unresolved(db,'T');assert.throws(()=>moved(db,'T'),/moved source/);db.exec('PRAGMA query_only=OFF');db.exec('CREATE TABLE codex_exact_thread_routing(enabled INTEGER); PRAGMA query_only=ON');moved(db,'T');
 });
});
test('missing fork schema fails closed without repairing the store during final read',async()=>{
 const {requireNoUnresolvedHandoffExistingIn:unresolved}=await import('../../src/store/fork-handoff-admission.ts');
 await fixture((path,db)=>{db.exec('DROP TABLE codex_thread_fork_handoffs');assert.throws(()=>revalidatePreparedMutation(path,claim,c=>{unresolved(c,'T');return undefined;}),/no such table/);assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='codex_thread_fork_handoffs'").get()!.n,0);});
});
test('read-only fork decoding still rejects malformed completed record before filtering',async()=>{
 const {requireNoUnresolvedHandoffExistingIn:unresolved}=await import('../../src/store/fork-handoff-admission.ts');
 await fixture((_path,db)=>{db.exec("INSERT INTO codex_thread_fork_handoffs(handoff_id,source_thread_id,expected_generation,discord_channel_id,discord_thread_id,quarantine_reason,created_at,target_thread_id,observed_target_thread_id,completed_generation,completed_at) VALUES('h','T','bad',2,3,'reason',0,'next','next',2,1); PRAGMA query_only=ON");assert.throws(()=>unresolved(db,'T'));});
});
