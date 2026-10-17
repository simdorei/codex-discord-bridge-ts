import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {roomCleanupPendingReasonIn as reason} from '../../src/store/room-cleanup-pending.ts';
import {StoreIntegrityError} from '../../src/store/schema-assembly.ts';
function fixture(run:(db:DatabaseSync)=>void){const db=new DatabaseSync(':memory:');try{db.exec(`
 CREATE TABLE codex_turn_queue(channel_id INTEGER,target_thread_id TEXT);
 CREATE TABLE codex_prompt_intakes(channel_id INTEGER,target_thread_id TEXT);
 CREATE TABLE discord_ingress_journal(channel_id INTEGER,target_thread_id TEXT,ingress_id TEXT,state TEXT,confirmation_delivered INTEGER,owner_kind TEXT,owner_id TEXT);
 CREATE TABLE codex_delivery_outbox(channel_id INTEGER,target_thread_id TEXT);
 CREATE TABLE codex_commentary_outbox(channel_id INTEGER,target_thread_id TEXT);
 CREATE TABLE busy_choices(channel_id INTEGER,target_thread_id TEXT,claimed_at REAL,expires_at REAL);
 CREATE TABLE codex_goal_progress(channel INTEGER,thread TEXT);
 CREATE TABLE codex_delivery_receipts(receipt_key TEXT,message_id INTEGER);
 `);run(db);}finally{db.close();}}
test('empty legacy store has no pending reason; borrowed transaction remains untouched',()=>fixture(db=>{
 db.exec('BEGIN');assert.equal(reason(db,1n,null),null);assert.equal(db.isTransaction,true);db.exec('ROLLBACK');assert.equal(reason(db,1n,'target'),null);
}));
for(const [table,label] of [['codex_turn_queue','queued requests'],['codex_prompt_intakes','prompt intake'],['codex_delivery_outbox','undelivered result'],['codex_commentary_outbox','undelivered progress']] as const)test(`${label} protects either exact room or target`,()=>fixture(db=>{
 db.prepare(`INSERT INTO ${table} VALUES(?,?)`).run(1,'other');assert.equal(reason(db,1n,'target'),label);db.exec(`DELETE FROM ${table}`);db.prepare(`INSERT INTO ${table} VALUES(?,?)`).run(9,'target');assert.equal(reason(db,1n,'target'),label);assert.equal(reason(db,1n,null),null);
}));
test('earlier pending reason masks later malformed tables; no fallback for reached errors',()=>fixture(db=>{
 db.exec('DROP TABLE codex_delivery_outbox; INSERT INTO codex_turn_queue VALUES(1,NULL)');assert.equal(reason(db,1n,null),'queued requests');db.exec('DELETE FROM codex_turn_queue');assert.throws(()=>reason(db,1n,null),{code:'ERR_SQLITE_ERROR'});
}));
test('only explicitly allowed pre-commentary absence is skipped, malformed present table still errors',()=>fixture(db=>{
 db.exec('DROP TABLE codex_commentary_outbox');assert.throws(()=>reason(db,1n,null),{code:'ERR_SQLITE_ERROR'});assert.equal(reason(db,1n,null,null,true),null);db.exec('CREATE TABLE codex_commentary_outbox(wrong TEXT)');assert.throws(()=>reason(db,1n,null,null,true),{code:'ERR_SQLITE_ERROR'});
}));
test('ingress handoff exemption requires complete prompt ownership and delivered confirmation',()=>fixture(db=>{
 const insert=(state:string,delivered:number|null,kind:string|null,owner:string|null)=>{db.exec('DELETE FROM discord_ingress_journal');db.prepare("INSERT INTO discord_ingress_journal VALUES(1,NULL,'i',?,?,?,?)").run(state,delivered,kind,owner);};
 insert('completed',1,null,null);assert.equal(reason(db,1n,null),null);insert('owned',1,'prompt','p');assert.equal(reason(db,1n,null),null);
 for(const [state,delivered,kind,owner] of [['completed',0,null,null],['owned',null,'prompt','p'],['owned',1,null,'p'],['owned',1,'prompt',null],['owned',1,'prompt','   '],['owned',1,'queue','q']] as const){insert(state,delivered,kind,owner);assert.equal(reason(db,1n,null),'ingress');}
}));
test('exact ingress exclusions do not waive other machinery',()=>fixture(db=>{
 db.exec("INSERT INTO discord_ingress_journal VALUES(1,NULL,'i','observed',0,NULL,NULL)");assert.equal(reason(db,1n,null,'i'),null);assert.equal(reason(db,1n,null,null,false,['i']),null);assert.equal(reason(db,1n,null,'other',false,['other']),'ingress');
 db.exec('INSERT INTO codex_turn_queue VALUES(1,NULL)');assert.equal(reason(db,1n,null,'i',false,['i']),'queued requests');
}));
test('unclaimed unexpired choices and goal progress remain protected',()=>fixture(db=>{
 db.exec('INSERT INTO busy_choices VALUES(1,NULL,NULL,unixepoch()+60)');assert.equal(reason(db,1n,null),'busy choice');db.exec('UPDATE busy_choices SET claimed_at=1');assert.equal(reason(db,1n,null),null);db.exec('UPDATE busy_choices SET claimed_at=NULL,expires_at=unixepoch()-1');assert.equal(reason(db,1n,null),null);db.exec("INSERT INTO codex_goal_progress VALUES(9,'target')");assert.equal(reason(db,1n,'target'),'undelivered goal progress');
}));
test('optional async question and inbox tables preserve their protection order',()=>fixture(db=>{
 db.exec("CREATE TABLE cdr_async_questions(channel_id INTEGER,thread_id TEXT,state TEXT,dispatch_mode TEXT); INSERT INTO cdr_async_questions VALUES(1,'target','open','start'); CREATE TABLE cdr_async_question_inbox(candidate_channel_id INTEGER,thread_id TEXT,state TEXT); INSERT INTO cdr_async_question_inbox VALUES(1,'target','waiting')");assert.equal(reason(db,1n,'target'),'unanswered or unconfirmed async question');db.exec("UPDATE cdr_async_questions SET state='completed'");assert.equal(reason(db,1n,'target'),'unbound async question awaiting original ownership');
}));
test('unsettled ledger view takes precedence and a missing view fails closed',()=>fixture(db=>{
 db.exec('CREATE TABLE cdr_async_execution_obligations(question_id TEXT,thread_id TEXT); CREATE TABLE evidence(channel_id INTEGER); CREATE VIEW cdr_async_unsettled_obligations AS SELECT channel_id FROM evidence; INSERT INTO evidence VALUES(1)');assert.equal(reason(db,1n,null),'unresolved async execution or recovery authorization');db.exec('DROP VIEW cdr_async_unsettled_obligations');assert.throws(()=>reason(db,1n,null),{code:'ERR_SQLITE_ERROR'});
}));
test('idle release applies globally without a target and cannot be excluded through ingress',()=>fixture(db=>{
 db.exec("CREATE TABLE cdr_idle_release(thread_id TEXT,state TEXT); INSERT INTO cdr_idle_release VALUES('other','UnsubscribeSent')");assert.equal(reason(db,1n,null,null,false,['i']),'unsettled idle subscription release');assert.equal(reason(db,1n,'target'),null);db.exec("UPDATE cdr_idle_release SET state='Candidate'");assert.equal(reason(db,1n,null),null);db.exec("UPDATE cdr_idle_release SET state='Settled'");assert.equal(reason(db,1n,null),null);
}));
test('receipt attribution is exact i64, lazy and ignores delivered receipts',()=>fixture(db=>{
 const add=(key:string,message:number|null=null)=>db.prepare('INSERT INTO codex_delivery_receipts VALUES(?,?)').run(key,message);
 add('[2]');assert.equal(reason(db,1n,null),null);add('[1]');assert.equal(reason(db,1n,null),'unsettled delivery receipt (unknown, retryable or blocked)');db.exec('DELETE FROM codex_delivery_receipts');add('invalid',1);assert.equal(reason(db,1n,null),null);
 for(const key of ['[]','null','{"id":1}','[1.0]','[9223372036854775808]','invalid']){db.exec('DELETE FROM codex_delivery_receipts');add(key);assert.equal(reason(db,1n,null),'unattributable delivery receipt (invalid or missing channel identity)');}
}));
test('receipt invalid text is decoded only if reached after an earlier valid protection',()=>fixture(db=>{
 db.exec("INSERT INTO codex_delivery_receipts VALUES('[1]',NULL); INSERT INTO codex_delivery_receipts VALUES(CAST(x'ff' AS TEXT),NULL)");assert.equal(reason(db,1n,null),'unsettled delivery receipt (unknown, retryable or blocked)');db.exec("DELETE FROM codex_delivery_receipts WHERE receipt_key='[1]'");assert.throws(()=>reason(db,1n,null),StoreIntegrityError);
}));
test('validation rejects malformed thread, identity and accessor exclusions before SQL',()=>fixture(db=>{
 assert.throws(()=>reason(db,1n,'\ud800'),TypeError);assert.throws(()=>reason(db,1n<<63n,null),TypeError);let calls=0;const excluded=['i'];Object.defineProperty(excluded,'0',{get(){calls++;return 'i';}});assert.throws(()=>reason(db,1n,null,null,false,excluded),TypeError);assert.equal(calls,0);
}));
