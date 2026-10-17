import test from 'node:test';import assert from 'node:assert/strict';import type {DatabaseSync} from 'node:sqlite';
import {storeFixture} from '../helpers/store-fixture.ts';import {openInitialized} from '../../src/store/owned-driver.ts';import {enqueue,type NewQueueJob} from '../../src/store/queue-enqueue.ts';import {reasonIn} from '../../src/store/execution-hold.ts';import {retireAutomaticReserveAtStartupIn} from '../../src/store/reserve-retirement.ts';import {withStoreTransaction,commitStore} from '../../src/store/owned-scope.ts';import {serializeSerdeValue} from '../../src/core/serde-json.ts';import {parseSerdeValue} from '../../src/core/serde-json-parse.ts';import {admitIngress} from '../../src/store/ingress-admission.ts';
const limits={maxRows:128,maxBytes:1048576};
const job=(id:string,message:bigint|null):NewQueueJob=>({jobId:id,targetThreadId:'thread',channelId:42n,ownerUserId:3n,discordMessageId:message,appServerGeneration:1n,prompt:'preserve input',queued:true,ackSent:true,createdAt:1});
function ingress(db:DatabaseSync,id:string,event:bigint,accepted:boolean){db.prepare(`INSERT INTO discord_ingress_journal(ingress_id,kind,event_id,channel_id,owner_user_id,payload_json,state,phase,target_thread_id,owner_kind,owner_id,confirmation_delivered,created_at,updated_at)VALUES (?,'message',?,42,3,'{}','owned','durable_prompt','thread','prompt',?,?,1,1)`).run('message:'+event,event,id,accepted?1:0);}
function retire(db:DatabaseSync,l=limits){return withStoreTransaction(db,'IMMEDIATE',()=>commitStore(retireAutomaticReserveAtStartupIn(db,l)));}
async function fixture(body:(path:string,db:DatabaseSync)=>Promise<void>){await storeFixture(async path=>{const db=await openInitialized(path);try{await body(path,db);}finally{if(db.isTransaction)db.exec('ROLLBACK');db.close();}});}
test('startup empty-headless retirement trusts exact acceptance rather than ACK and preserves policy observations',async()=>fixture(async(path,db)=>{
 for(const [id,message,accepted]of[['accepted',11n,true],['reported',12n,true],['unaccepted',13n,false],['legacy',14n,true]] as const){await enqueue(path,job(id,message));ingress(db,id,message,accepted);}
 await enqueue(path,job('headless',null));db.exec("UPDATE codex_turn_queue SET last_error='[cdr-rust:auto-reserve-hold:v1] uncertain' WHERE job_id='legacy';INSERT INTO codex_reserve_policy(thread_id,mode,state,revision,usage_failure_reason)VALUES('thread','auto','unknown',7,'retain episode')");
 const key=serializeSerdeValue([42n,'message/error/v1','inbound-message/12/error-report',0n]);db.prepare("INSERT INTO codex_delivery_receipts(receipt_key,content_hash,message_id)VALUES (?,'hash','999')").run(key);
 const queueBefore=db.prepare('SELECT * FROM codex_turn_queue ORDER BY job_id').all(),policyBefore=db.prepare('SELECT * FROM codex_reserve_policy').get()!;
 assert.deepEqual(retire(db),{alreadyCompleted:false,heldJobs:4n,policySnapshots:1n});assert.equal(reasonIn(db,'accepted'),null);for(const id of ['reported','unaccepted','legacy','headless'])assert.notEqual(reasonIn(db,id),null);
 assert.deepEqual(db.prepare('SELECT * FROM codex_turn_queue ORDER BY job_id').all(),queueBefore);const after=db.prepare('SELECT * FROM codex_reserve_policy').get()!;assert.equal(after.mode,'manual');assert.deepEqual({...after,mode:policyBefore.mode},{...policyBefore});
 const audit=parseSerdeValue<Record<string,unknown>>(db.prepare('SELECT policy_json FROM cdr_reserve_retirement_evidence').get()!.policy_json as string);assert.equal(audit.mode,'auto');assert.equal(audit.revision,7n);assert.equal(audit.usage_failure_reason,'retain episode');
 const evidence=parseSerdeValue(db.prepare('SELECT evidence_json FROM cdr_store_retirements').get()!.evidence_json as string);assert.deepEqual(evidence,{headless:[],result:{already_completed:false,held_jobs:4n,policy_snapshots:1n}});
 assert.deepEqual(retire(db),{alreadyCompleted:true,heldJobs:0n,policySnapshots:0n});
}));
test('completion marker failure rolls back policy audit, mode, holds and marker together',async()=>fixture(async(path,db)=>{
 await enqueue(path,job('unknown',null));db.exec("INSERT INTO codex_reserve_policy(thread_id,mode,state)VALUES('thread','on','reserve');CREATE TRIGGER fail_retirement BEFORE INSERT ON cdr_store_retirements BEGIN SELECT RAISE(ABORT,'marker failure'); END");
 assert.throws(()=>retire(db),/marker failure/);assert.equal(reasonIn(db,'unknown'),null);assert.equal(db.prepare('SELECT mode FROM codex_reserve_policy').get()!.mode,'on');assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cdr_reserve_retirement_evidence').get()!.n,0);assert.equal(db.isTransaction,false);
 db.exec('DROP TRIGGER fail_retirement');assert.equal(retire(db).heldJobs,1n);
}));
test('duplicate or mismatched ingress never proves acceptance and nonpending queue remains unchanged',async()=>fixture(async(path,db)=>{
 for(const [id,event]of[['duplicate',21n],['wrong-room',23n],['running',24n]] as const){await enqueue(path,job(id,event));ingress(db,id,event,true);}
 ingress(db,'duplicate',22n,true);db.exec("UPDATE discord_ingress_journal SET channel_id=43 WHERE owner_id='wrong-room';UPDATE codex_turn_queue SET state='running' WHERE job_id='running'");
 assert.equal(retire(db).heldJobs,2n);assert.notEqual(reasonIn(db,'duplicate'),null);assert.notEqual(reasonIn(db,'wrong-room'),null);assert.equal(reasonIn(db,'running'),null);
}));
test('unowned ingress receives existing saved-request hold exactly once, without executing or deleting its payload',async()=>fixture(async(path,db)=>{
 await admitIngress(path,{ingressId:'unowned',kind:'message',eventId:77n,applicationId:null,channelId:42n,ownerUserId:3n,sourceMessageId:77n,payload:{version:1n,attachments:[{name:'kept'}]},targetThreadId:'thread',canonicalOwner:null,now:1});
 const payload=db.prepare("SELECT payload_json FROM discord_ingress_journal WHERE ingress_id='unowned'").get()!.payload_json;
 assert.equal(retire(db).heldJobs,0n);const row=db.prepare("SELECT state,notice_staged,payload_json FROM discord_ingress_journal WHERE ingress_id='unowned'").get()!;assert.equal(row.state,'held');assert.equal(row.notice_staged,1);assert.equal(row.payload_json,payload);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM codex_delivery_outbox').get()!.n,1);retire(db);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM codex_delivery_outbox').get()!.n,1);
}));
test('whole-operation row and JSON byte budgets reject without partial audit or mode updates',async()=>fixture(async(path,db)=>{
 await enqueue(path,job('unknown',null));db.exec("INSERT INTO codex_reserve_policy(thread_id,mode,state)VALUES('thread','auto','ordinary')");
 for(const l of [{...limits,maxRows:1},{...limits,maxBytes:1}]){assert.throws(()=>retire(db,l));assert.equal(db.prepare('SELECT mode FROM codex_reserve_policy').get()!.mode,'auto');assert.equal(reasonIn(db,'unknown'),null);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cdr_store_retirements').get()!.n,0);}
 assert.equal(retire(db).heldJobs,1n);
}));
test('strict malformed text profile holds whole retirement and caller lifetime is never consumed',async()=>fixture(async(path,db)=>{
 await enqueue(path,job('unknown',null));db.exec("UPDATE codex_turn_queue SET prompt=CAST(x'ff' AS TEXT)");assert.throws(()=>retire(db),/evidence encoding/);assert.equal(reasonIn(db,'unknown'),null);
 assert.throws(()=>retireAutomaticReserveAtStartupIn(db,limits),/caller-owned transaction/);db.exec('BEGIN IMMEDIATE');assert.throws(()=>retireAutomaticReserveAtStartupIn(db,limits));assert.equal(db.isTransaction,true);db.exec('ROLLBACK');
}));
test('completed one-time marker masks missing later legacy tables and existing holds are never replaced',async()=>fixture(async(path,db)=>{
 await enqueue(path,job('unknown',null));db.exec("INSERT INTO cdr_execution_holds VALUES('unknown','thread','original reason','{}',1)");assert.equal(retire(db).heldJobs,1n);assert.equal(reasonIn(db,'unknown'),'original reason');db.exec('DROP TABLE codex_reserve_policy');assert.equal(retire(db).alreadyCompleted,true);
}));

test('retirement preserves intake payload and lease while execution hold blocks a subsequent claim',async()=>fixture(async(path,db)=>{
 const {tryClaimPromptIntake}=await import('../../src/store/prompt-intake.ts');
 db.exec("INSERT INTO codex_prompt_intakes(job_id,target_thread_id,channel_id,owner_user_id,discord_message_id,raw_prompt,auto_queue_when_busy,require_current_mirror,created_at,updated_at,claim_token,claim_expires_at) VALUES ('intake','thread',42,3,81,'original intake',1,0,1,1,'old-token',99)");
 const before=db.prepare('SELECT * FROM codex_prompt_intakes').get();assert.equal(retire(db).heldJobs,1n);
 assert.deepEqual(db.prepare('SELECT * FROM codex_prompt_intakes').get(),before);assert.notEqual(reasonIn(db,'intake'),null);
 assert.equal(await tryClaimPromptIntake(path,'intake',100,120),null);assert.deepEqual(db.prepare('SELECT * FROM codex_prompt_intakes').get(),before);
 const evidence=parseSerdeValue<Record<string,unknown>>(db.prepare("SELECT evidence_json FROM cdr_execution_holds WHERE job_id='intake'").get()!.evidence_json as string);assert.equal(evidence.intake,true);
}));

test('odd byte budgets accept a small BLOB audit field without numeric conversion failure',async()=>fixture(async(_path,db)=>{
 db.exec("ALTER TABLE codex_reserve_policy ADD COLUMN extra_blob BLOB;INSERT INTO codex_reserve_policy(thread_id,mode,state,extra_blob)VALUES('thread','auto','ordinary',x'0102')");
 assert.equal(retire(db,{...limits,maxBytes:1048575}).policySnapshots,1n);
 const audit=parseSerdeValue<Record<string,unknown>>(db.prepare('SELECT policy_json FROM cdr_reserve_retirement_evidence').get()!.policy_json as string);assert.deepEqual(audit.extra_blob,{blob_hex:'0102'});
}));
