import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {DatabaseSync} from 'node:sqlite';
import {realpathSync} from 'node:fs';
import {storeFixture} from '../helpers/store-fixture.ts';
import {openInitialized,ActiveTransactionError} from '../../src/store/owned-driver.ts';
import {enqueueInTransaction} from '../../src/store/queue-enqueue.ts';
import {captureAbandonmentSnapshotIn} from '../../src/store/abandonment-snapshot.ts';
import {serializeSerdeValue} from '../../src/core/serde-json.ts';
const source={version:1n,content:'!discard-request job',author_is_bot:false,plan:{Execute:{DiscardRequest:{job_id:'job'}}}};
async function fixture(run:(db:DatabaseSync,path:string)=>void,held=true){await storeFixture(async path=>{const db=await openInitialized(path);try{
 db.exec('BEGIN IMMEDIATE');enqueueInTransaction(db,{jobId:'job',targetThreadId:'t',channelId:1n,ownerUserId:2n,discordMessageId:7n,appServerGeneration:1n,prompt:'prompt',queued:true,ackSent:true,createdAt:1});
 db.exec("INSERT INTO mirror_threads VALUES('t','p','title',10,1,1); INSERT INTO codex_app_server_runtime VALUES(1,'app'); INSERT INTO codex_mutation_runtime VALUES(1,'wire')");
 if(held)db.prepare("INSERT INTO cdr_async_recovery_policies VALUES('t',1,'publishing_recovery',?,'turn','origin','job')").run('a'.repeat(64));
 db.prepare(`INSERT INTO discord_ingress_journal(ingress_id,kind,event_id,application_id,channel_id,owner_user_id,source_message_id,payload_json,runtime_id,state,phase,target_thread_id,created_at,updated_at)
 VALUES('message:5','message',5,NULL,1,2,5,?,'app','executing','processing','t',11,11)`).run(serializeSerdeValue(source));
 db.exec('COMMIT');run(db,path);
 }finally{if(db.isOpen){if(db.isTransaction)db.exec('ROLLBACK');db.close();}}});}
const capture=(db:DatabaseSync,path:string,creating=true)=>captureAbandonmentSnapshotIn(db,path,'job','message:5',creating);
test('private snapshot seals all source pages, runtimes, source and canonical database without writes',()=>fixture((db,path)=>{
 assert.throws(()=>capture(db,path),ActiveTransactionError);db.exec('BEGIN; PRAGMA query_only=ON');const before=db.prepare('SELECT total_changes() AS n').get()!.n;
 const result=capture(db,path),e=result.evidence as any;
 assert.deepEqual(result.target,{job:'job',thread:'t',owner:2n,channel:1n});assert.equal(e.job.rows.length,1);assert.equal(e.context.siblings.rows.length,0);
 assert.equal(e.context.mapping.rows.length,1);assert.equal(e.context.policy.rows.length,1);assert.equal(e.context.source.id,'message:5');assert.deepEqual(e.context.runtime,{app:'app',wire:'wire'});
 assert.equal(e.context.database,realpathSync(path));assert.deepEqual(e.context.stop_origin,{target:'t',stopRevision:0n});assert.equal(Object.keys(e.context).length,21);
 assert.ok(Object.isFrozen(e));assert.ok(Object.isFrozen(result.target));assert.equal(db.prepare('SELECT total_changes() AS n').get()!.n,before);assert.equal(db.isTransaction,true);db.exec('ROLLBACK');
}));
test('unheld Pending request cannot create private abandonment evidence',()=>fixture((db,path)=>{db.exec('BEGIN');assert.throws(()=>capture(db,path),/held, unstarted Pending/);},false));
test('started, goal-waiting, missing message and owner are rejected',async()=>{
 for(const sql of ["turn_id='turn'","goal_waiting=1","discord_message_id=NULL","owner_user_id=NULL"])
 await fixture((db,path)=>{db.exec('UPDATE codex_turn_queue SET '+sql+'; BEGIN');assert.throws(()=>capture(db,path),/owner|held, unstarted Pending/);});
});
test('ambiguous mapping and scoped or global prepared mutation fail closed',async()=>{
 await fixture((db,path)=>{db.exec("INSERT INTO mirror_threads VALUES('other','p','title',10,1,1); BEGIN");assert.throws(()=>capture(db,path),/mapping or unresolved/);});
 for(const scoped of [0,1])await fixture((db,path)=>{db.prepare(`INSERT INTO codex_mutation_attempts(attempt_id,runtime_id,owner_id,generation,wire_id,method,target_thread_id,scoped,request_sha256,state,created_at,updated_at)
 VALUES('a','wire','o',1,'w','turn/start',?,?,?,'prepared',1,1)`).run(scoped?'t':null,scoped,'a'.repeat(64));db.exec('BEGIN');assert.throws(()=>capture(db,path),/mapping or unresolved/);});
});
test('source ownership and current processing are verified; historical capture retains identity',()=>fixture((db,path)=>{
 db.exec("UPDATE discord_ingress_journal SET state='completed',phase='done'; BEGIN");assert.throws(()=>capture(db,path),/processing custody/);assert.doesNotThrow(()=>capture(db,path,false));
 db.exec("UPDATE discord_ingress_journal SET owner_user_id=8");assert.throws(()=>capture(db,path,false),/exact authenticated owner/);
}));
test('private prompt bound applies before materializing original queue job',()=>fixture((db,path)=>{
 db.prepare('UPDATE codex_turn_queue SET prompt=?').run('x'.repeat(131073));db.exec('BEGIN');assert.throws(()=>capture(db,path),/original input exceeds private evidence bound/);
}));
test('snapshot retains SQLite cell identity and rejects invalid text and oversized blob',()=>fixture((db,path)=>{
 db.exec('ALTER TABLE mirror_threads ADD COLUMN extra BLOB; BEGIN');db.prepare('UPDATE mirror_threads SET extra=?').run(Buffer.from([0,255]));const e=capture(db,path).evidence as any;
 assert.deepEqual(e.context.mapping.rows[0].at(-1),['blob_hex','00ff']);db.exec("UPDATE mirror_threads SET extra=CAST(x'ff' AS TEXT)");assert.throws(()=>capture(db,path),/non-UTF8 evidence/);
 db.prepare('UPDATE mirror_threads SET extra=?').run(Buffer.alloc(196609));assert.throws(()=>capture(db,path),/private evidence blob exceeds bound/);
}));
test('canonical database identity must exist and errors do not close caller transaction',()=>fixture((db,path)=>{
 db.exec('BEGIN');assert.throws(()=>capture(db,path+'.absent'),/database identity is unavailable/);assert.equal(db.isTransaction,true);assert.equal(db.isOpen,true);
}));
test('either job or original Discord message cancellation blocks capture',async()=>{
 for(const [job,message] of [['job',null],['other',7n]] as const)await fixture((db,path)=>{
  db.prepare("INSERT INTO codex_request_cancellations VALUES(?,'t',1,2,?,12)").run(job,message);db.exec('BEGIN');assert.throws(()=>capture(db,path),/mapping or unresolved/);
 });
});
test('siblings exclude original job and 129th sibling exceeds private page bound',()=>fixture((db,path)=>{
 const columns=db.prepare('PRAGMA table_info(codex_turn_queue)').all().map(c=>String(c.name)),other=columns.filter(c=>!['job_id','discord_message_id'].includes(c)),quote=(c:string)=>'"'+c.replaceAll('"','""')+'"';
 const add=db.prepare(`INSERT INTO codex_turn_queue(job_id,discord_message_id,${other.map(quote).join(',')}) SELECT ?,NULL,${other.map(quote).join(',')} FROM codex_turn_queue WHERE job_id='job'`);
 for(let i=0;i<128;i++)add.run('sibling'+i);db.exec('BEGIN');assert.equal((capture(db,path).evidence as any).context.siblings.rows.length,128);
 add.run('overflow');assert.throws(()=>capture(db,path),/private evidence page exceeds bound/);
}));
test('shared budget and final structural overhead reject oversized private evidence',async()=>{
 await fixture((db,path)=>{db.exec('ALTER TABLE mirror_threads ADD COLUMN extra TEXT; ALTER TABLE codex_turn_queue ADD COLUMN extra TEXT');
  db.prepare('UPDATE mirror_threads SET extra=?').run('x'.repeat(210000));db.prepare('UPDATE codex_turn_queue SET extra=?').run('y'.repeat(210000));db.exec('BEGIN');assert.throws(()=>capture(db,path),/private evidence exceeds bound/);
 });
 await fixture((db,path)=>{db.exec("ALTER TABLE mirror_threads ADD COLUMN extra TEXT; UPDATE mirror_threads SET extra=''; BEGIN");
  const e=capture(db,path).evidence as any;const size=Buffer.byteLength(serializeSerdeValue(e));
  db.prepare('UPDATE mirror_threads SET extra=?').run('x'.repeat(393216-size+1));assert.throws(()=>capture(db,path),/private snapshot exceeds bound/);
 });
});
