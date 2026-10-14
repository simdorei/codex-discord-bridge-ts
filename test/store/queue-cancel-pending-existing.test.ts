import assert from "node:assert/strict";
import {test} from "node:test";
import {DatabaseSync} from "node:sqlite";
import {existsSync,readdirSync} from "node:fs";
import {dirname} from "node:path";
import {performance} from "node:perf_hooks";
import {storeFixture} from "../helpers/store-fixture.ts";
import {queueJob} from "../helpers/queue-job.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {StateAccessFacade as state} from "../../src/store/state-access-facade.ts";
import {getIngressIn} from "../../src/store/ingress-read.ts";
import {DeadGenerationTargetHeldError} from "../../src/store/queue-mark-running.ts";
const cancel=(path:string)=>state.cancelLatestPendingExisting(path,"target",1n,2n,10);
function edit<T>(path:string,body:(db:DatabaseSync)=>T):T {const db=new DatabaseSync(path);try{return body(db);}finally{db.close();}}
async function initialized(path:string):Promise<void>{const db=await openInitialized(path);db.close();}
async function queue(path:string,id="job",at=1):Promise<void>{await state.enqueue(path,queueJob({jobId:id,ownerUserId:2n,createdAt:at}));}
async function ingress(path:string,id="original",at=2):Promise<void>{await state.admitIngress(path,{ingressId:id,kind:"message",eventId:3n,applicationId:null,channelId:1n,ownerUserId:2n,sourceMessageId:null,payload:{version:1n,plan:{Execute:{Ask:{prompt:"hello"}}}},targetThreadId:"target",canonicalOwner:null,now:at});}
function intakes(db:DatabaseSync,count:number,prompt="small",prefix="intake-"):void {
  const q=db.prepare("INSERT INTO codex_prompt_intakes(job_id,target_thread_id,channel_id,owner_user_id,raw_prompt,auto_queue_when_busy,require_current_mirror,created_at,updated_at) VALUES (?,'target',1,2,?,1,0,?,1)");
  for(let i=0;i<count;i++)q.run(prefix+i,prompt,i);
}
function owners(db:DatabaseSync,count:number,payload='{"version":1}'):void {
  const q=db.prepare("INSERT INTO discord_ingress_journal(ingress_id,kind,channel_id,owner_user_id,payload_json,state,phase,target_thread_id,owner_kind,owner_id,created_at,updated_at) VALUES (?,'message',1,2,?,'owned','processing','target','prompt','job',1,1)");
  for(let i=0;i<count;i++)q.run("owner-"+i,payload);
}
function unchanged(path:string,queueCount=1):void {edit(path,db=>{
  assert.equal(db.prepare("SELECT count(*) AS n FROM codex_turn_queue").get()?.n,queueCount);
  assert.equal(db.prepare("SELECT count(*) AS n FROM codex_request_cancellations").get()?.n,0);
});}

test("existing pending cancellation is synchronous, durable, ordered and actor/room scoped",()=>storeFixture(async path=>{
  await queue(path,"older",1);await queue(path,"newer",2);
  edit(path,db=>{intakes(db,1,"small","foreign-");db.exec("UPDATE codex_prompt_intakes SET owner_user_id=9,created_at=100");});
  assert.equal(cancel(path),"newer");assert.equal(cancel(path),"older");assert.equal(cancel(path),null);
  edit(path,db=>{assert.equal(db.prepare("SELECT count(*) AS n FROM codex_request_cancellations").get()?.n,2);assert.equal(db.prepare("SELECT count(*) AS n FROM codex_prompt_intakes").get()?.n,1);});
  await assert.rejects(queue(path,"newer",3),/cancelled/);
}));
test("equal timestamps preserve descending job and kind tie ordering",()=>storeFixture(async path=>{
  await queue(path,"b",1);edit(path,db=>intakes(db,1,"small","a-"));edit(path,db=>db.exec("UPDATE codex_prompt_intakes SET created_at=1"));assert.equal(cancel(path),"b");
}));
test("started latest request is retained while an older eligible pending request can be cancelled",()=>storeFixture(async path=>{
  await queue(path,"started",2);edit(path,db=>db.exec("UPDATE codex_turn_queue SET state='running',turn_id='turn'"));assert.throws(()=>cancel(path),/outcome is unknown/);
  await queue(path,"older",1);assert.equal(cancel(path),"older");edit(path,db=>assert.equal(db.prepare("SELECT state FROM codex_turn_queue").get()?.state,"running"));
}));
test("only exact pure active-writer rejection remains cancellation eligible",()=>storeFixture(async path=>{
  await queue(path);edit(path,db=>db.exec("UPDATE codex_turn_queue SET attempt_count=1,last_error='other'"));assert.throws(()=>cancel(path),/outcome is unknown/);
  edit(path,db=>db.exec("UPDATE codex_turn_queue SET last_error='app-server returned error -32600 for thread/resume: thread target already has an active writer',execution_generation=NULL,turn_observation_generation=NULL,goal_waiting=0,baseline_turn_ids='[]'"));assert.equal(cancel(path),"job");
}));
test("claimed intake cancellation retains replay fence",()=>storeFixture(async path=>{
  await initialized(path);edit(path,db=>{intakes(db,1);db.exec("UPDATE codex_prompt_intakes SET claim_token='claim',claim_expires_at=100");});assert.equal(cancel(path),"intake-0");
  edit(path,db=>assert.throws(()=>intakes(db,1),/cancelled/));
}));
for(const kind of ["message","interaction"] as const)test("unstarted "+kind+" prompt retains scalar outcome and blocks execution",()=>storeFixture(async path=>{
  await ingress(path);edit(path,db=>{db.exec("UPDATE discord_ingress_journal SET outcome_json='[\"prior\"]'");if(kind==="interaction"){db.exec("INSERT INTO mirror_threads VALUES ('target','p','title',10,1,1)");db.prepare("UPDATE discord_ingress_journal SET kind='interaction',payload_json=?").run('{"version":1,"work":{"Slash":{"name":"interview","values":{"prompt":{"String":"hello"}}}}}');}});
  assert.equal(cancel(path),"ingress:original");edit(path,db=>{const row=getIngressIn(db,"original")!;assert.equal(row.state,"completed");assert.equal(row.phase,"cancelled");assert.equal(row.ownerKind,"cancellation");assert.deepEqual(row.outcome,{prior_result:["prior"],kind:"request_cancelled",job_id:"ingress:original"});});
  assert.equal(await state.beginIngressExecution(path,"original","processing","target",11),false);
}));
test("executing ingress cannot be cancelled and does not hide an older pending queue request",()=>storeFixture(async path=>{
  await ingress(path);edit(path,db=>db.exec("UPDATE discord_ingress_journal SET state='executing'"));assert.throws(()=>cancel(path),/outcome is unknown/);await queue(path,"older",1);assert.equal(cancel(path),"older");
}));
test("all valid prompt ingress owners transition while original outcomes and room survive",()=>storeFixture(async path=>{
  await queue(path);edit(path,db=>{owners(db,2);db.exec("UPDATE discord_ingress_journal SET outcome_json='[\"prior\"]'");});assert.equal(cancel(path),"job");
  edit(path,db=>{for(const key of ["owner-0","owner-1"]){const row=getIngressIn(db,key)!;assert.equal(row.channelId,1n);assert.equal(row.ownerKind,"prompt");assert.equal(row.ownerId,"job");assert.equal(row.state,"completed");assert.deepEqual(row.outcome,{prior_result:["prior"],kind:"request_cancelled",job_id:"job"});}});
}));
test("versioned new-room proof permits cancellation without rewriting original ingress room",()=>storeFixture(async path=>{
  await queue(path);edit(path,db=>{owners(db,1,'{"command":"new","prompt":"hello"}');db.exec("UPDATE discord_ingress_journal SET kind='action',channel_id=50,outcome_json='{\"new_creation\":{\"version\":1,\"origin_channel_id\":50}}'; INSERT INTO mirror_threads VALUES ('target','p','title',10,1,1)");});
  assert.equal(cancel(path),"job");edit(path,db=>assert.equal(getIngressIn(db,"owner-0")?.channelId,50n));
}));
for(const mutation of ["owner_user_id=9","owner_kind='other'","target_thread_id='other'","state='held'","channel_id=50"])test("conflicting ingress "+mutation+" refuses atomically",()=>storeFixture(async path=>{
  await queue(path);edit(path,db=>{owners(db,1);db.exec("UPDATE discord_ingress_journal SET "+mutation);});assert.throws(()=>cancel(path),/conflicting|uncertain/);unchanged(path);
}));
for(const kind of ["collision","outbox"] as const)test(kind+" evidence refuses whole cancellation",()=>storeFixture(async path=>{
  await queue(path);edit(path,db=>{if(kind==="collision"){intakes(db,1);db.exec("UPDATE codex_prompt_intakes SET job_id='job'");}else db.exec("INSERT INTO codex_delivery_outbox(delivery_id,job_id,target_thread_id,turn_id,channel_id,content,created_at,updated_at) VALUES ('delivery','job','target','turn',1,'result',1,1)");});assert.throws(()=>cancel(path),/conflicting|uncertain/);unchanged(path);
}));
test("mapping and dead-generation fences fail before cancellation",()=>storeFixture(async path=>{
  await queue(path);assert.throws(()=>state.cancelLatestPendingExisting(path,"target",1n,2n,10,true),/mapping changed/);
  edit(path,db=>db.exec("INSERT INTO codex_dead_generation_holds VALUES ('target','old',1,1)"));assert.throws(()=>cancel(path),DeadGenerationTargetHeldError);unchanged(path);
}));
for(const mode of ["unresolved","moved"] as const)test(mode+" fork fence refuses existing cancellation",()=>storeFixture(async path=>{
  await queue(path);edit(path,db=>{db.exec("INSERT INTO codex_thread_fork_handoffs(handoff_id,source_thread_id,expected_generation,discord_channel_id,discord_thread_id,quarantine_reason,created_at) VALUES ('fork','target',1,10,1,'unknown',1)");if(mode==="moved")db.exec("DROP TABLE IF EXISTS codex_exact_thread_routing; UPDATE codex_thread_fork_handoffs SET observed_target_thread_id='moved',target_thread_id='moved',completed_generation=1,completed_at=1");});assert.throws(()=>cancel(path),/fork handoff/);unchanged(path);
}));
test("missing path is neither created nor initialized",()=>storeFixture(async path=>{
  assert.equal(existsSync(path),false);assert.throws(()=>cancel(path));assert.equal(existsSync(path),false);assert.deepEqual(readdirSync(dirname(path)),[]);
}));
test("absent lazy fork inventory stays absent; schema and legacy indexes are never changed",()=>storeFixture(async path=>{
  await queue(path);edit(path,db=>db.exec("DROP TABLE codex_thread_fork_handoffs"));const before=edit(path,db=>db.prepare("PRAGMA schema_version").get()?.schema_version);assert.equal(cancel(path),"job");edit(path,db=>{assert.equal(db.prepare("PRAGMA schema_version").get()?.schema_version,before);assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='codex_thread_fork_handoffs'").get()?.n,0);});
}));
test("existing handoff index is not dropped",()=>storeFixture(async path=>{
  await queue(path);edit(path,db=>db.exec("CREATE INDEX codex_thread_fork_handoffs_observed_target ON codex_thread_fork_handoffs(observed_target_thread_id)"));const before=edit(path,db=>db.prepare("PRAGMA schema_version").get()?.schema_version);assert.equal(cancel(path),"job");assert.equal(edit(path,db=>db.prepare("PRAGMA schema_version").get()?.schema_version),before);
}));
for(const definition of ["CREATE TABLE codex_thread_fork_handoffs(source_thread_id TEXT)","CREATE VIEW codex_thread_fork_handoffs AS SELECT 1 AS source_thread_id"])test("partial fork schema fails without repairs: "+definition,()=>storeFixture(async path=>{
  await queue(path);edit(path,db=>db.exec("DROP TABLE codex_thread_fork_handoffs; "+definition));const before=edit(path,db=>db.prepare("PRAGMA schema_version").get()?.schema_version);assert.throws(()=>cancel(path),/no such column/);unchanged(path);assert.equal(edit(path,db=>db.prepare("PRAGMA schema_version").get()?.schema_version),before);
}));
test("missing required cancellation schema fails even for a no-op",()=>storeFixture(async path=>{
  await initialized(path);edit(path,db=>db.exec("DROP TABLE codex_request_cancellations"));assert.throws(()=>cancel(path),/no such table/);edit(path,db=>assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='codex_request_cancellations'").get()?.n,0));
}));
for(const count of [128,129])test(count+" candidate records prove complete inventory or refuse",()=>storeFixture(async path=>{
  await initialized(path);edit(path,db=>intakes(db,count));if(count===128)assert.equal(cancel(path),"intake-127");else assert.throws(()=>cancel(path),/too many/);edit(path,db=>assert.equal(db.prepare("SELECT count(*) AS n FROM codex_prompt_intakes").get()?.n,count===128?127:129));
}));
test("candidate budget is combined across queue and intake",()=>storeFixture(async path=>{
  await queue(path);edit(path,db=>intakes(db,128));assert.throws(()=>cancel(path),/too many/);unchanged(path);
}));
for(const count of [128,129])test(count+" owners are bounded before full record decoding",()=>storeFixture(async path=>{
  await queue(path);edit(path,db=>owners(db,count));if(count===128)assert.equal(cancel(path),"job");else {assert.throws(()=>cancel(path),/too many/);unchanged(path);}
}));
for(const field of ["prompt","last_error","baseline_turn_ids","attempt_count"] as const)test("oversized queue "+field+" refuses before materialization",()=>storeFixture(async path=>{
  await queue(path);edit(path,db=>db.prepare("UPDATE codex_turn_queue SET "+field+"=?").run(field==="attempt_count"?new Uint8Array(1048577):"x".repeat(1048577)));assert.throws(()=>cancel(path),/byte budget/);unchanged(path);
}));
test("oversized older candidate refuses instead of selecting newer small request",()=>storeFixture(async path=>{
  await queue(path,"older",1);await queue(path,"newer",2);edit(path,db=>db.prepare("UPDATE codex_turn_queue SET prompt=? WHERE job_id='older'").run("x".repeat(1048577)));assert.throws(()=>cancel(path),/byte budget/);unchanged(path,2);
}));
test("cumulative bytes refuse individually small candidates",()=>storeFixture(async path=>{
  await initialized(path);edit(path,db=>intakes(db,10,"x".repeat(900000)));assert.throws(()=>cancel(path),/byte budget/);unchanged(path,0);
}));
test("oversized unowned non-prompt ingress is bounded before JSON filtering",()=>storeFixture(async path=>{
  await queue(path);await ingress(path);edit(path,db=>db.prepare("UPDATE discord_ingress_journal SET payload_json=?").run("x".repeat(1048577)));assert.throws(()=>cancel(path),/byte budget/);unchanged(path);
}));
for(const field of ["payload_json","outcome_json","application_id"] as const)test("oversized owner "+field+" is bounded before decoding",()=>storeFixture(async path=>{
  await queue(path);edit(path,db=>{owners(db,1);db.prepare("UPDATE discord_ingress_journal SET "+field+"=?").run(field==="application_id"?new Uint8Array(1048577):"x".repeat(1048577));});assert.throws(()=>cancel(path),/byte budget/);unchanged(path);
}));
test("cumulative owner bytes refuse before decoding",()=>storeFixture(async path=>{
  await queue(path);edit(path,db=>owners(db,10,JSON.stringify({padding:"x".repeat(900000)})));assert.throws(()=>cancel(path),/byte budget/);unchanged(path);
}));
for(const encoding of ["UTF-16le","UTF-16be"])test(encoding+" stored bytes determine the row budget",()=>storeFixture(async path=>{
  edit(path,db=>db.exec("PRAGMA encoding='"+encoding+"'; CREATE TABLE encoding_marker(n INTEGER)"));await queue(path);edit(path,db=>db.prepare("UPDATE codex_turn_queue SET prompt=?").run("x".repeat(530000)));assert.throws(()=>cancel(path),/byte budget/);unchanged(path);
}));
test("unrelated oversized actor and target rows are not inspected",()=>storeFixture(async path=>{
  await queue(path);edit(path,db=>{intakes(db,2,"x".repeat(1048577));db.exec("UPDATE codex_prompt_intakes SET owner_user_id=9 WHERE job_id='intake-0'; UPDATE codex_prompt_intakes SET target_thread_id='elsewhere' WHERE job_id='intake-1'");});assert.equal(cancel(path),"job");
}));
for(const kind of ["input","result","owner"] as const)test(kind+" identity byte overflow refuses before mutation",()=>storeFixture(async path=>{
  await queue(path);if(kind==="input")assert.throws(()=>state.cancelLatestPendingExisting(path,"x".repeat(16385),1n,2n,10),/byte budget/);
  else {edit(path,db=>{if(kind==="result")db.prepare("UPDATE codex_turn_queue SET job_id=?").run("x".repeat(16385));else {owners(db,1);db.prepare("UPDATE discord_ingress_journal SET ingress_id=?").run("x".repeat(16385));}});assert.throws(()=>cancel(path),/byte budget/);}unchanged(path);
}));
test("mapping target bytes and fork evidence are preflighted",()=>storeFixture(async path=>{
  await queue(path);edit(path,db=>db.prepare("INSERT INTO mirror_threads VALUES (?,'p','title',10,1,1)").run("x".repeat(16385)));assert.throws(()=>state.cancelLatestPendingExisting(path,"target",1n,2n,10,true),/byte budget/);
  edit(path,db=>db.prepare("INSERT INTO codex_thread_fork_handoffs(handoff_id,source_thread_id,expected_generation,discord_channel_id,discord_thread_id,quarantine_reason,created_at) VALUES ('fork','target',1,10,1,?,1)").run("x".repeat(1048577)));assert.throws(()=>cancel(path),/byte budget/);unchanged(path);
}));
for(const action of ["receipt","delete","owned","unowned"] as const)test("ignored "+action+" mutation cannot report success",()=>storeFixture(async path=>{
  if(action==="unowned")await ingress(path);else await queue(path);
  edit(path,db=>{if(action==="owned")owners(db,1);const target=action==="receipt"?"INSERT ON codex_request_cancellations":action==="delete"?"DELETE ON codex_turn_queue":"UPDATE ON discord_ingress_journal";db.exec("CREATE TRIGGER ignore_write BEFORE "+target+" BEGIN SELECT RAISE(IGNORE); END");});
  assert.throws(()=>cancel(path),/receipt|ownership changed/);unchanged(path,action==="unowned"?0:1);if(action==="owned"||action==="unowned")edit(path,db=>assert.notEqual(db.prepare("SELECT state FROM discord_ingress_journal").get()?.state,"completed"));
}));
test("later trigger removing receipt rolls back deletion",()=>storeFixture(async path=>{
  await queue(path);edit(path,db=>db.exec("CREATE TRIGGER lose_receipt AFTER DELETE ON codex_turn_queue BEGIN DELETE FROM codex_request_cancellations; END"));assert.throws(()=>cancel(path),/receipt/);unchanged(path);
}));
test("trigger-enlarged outcome is bounded again before SQL JSON mutation",()=>storeFixture(async path=>{
  await queue(path);edit(path,db=>{owners(db,1);db.exec("CREATE TRIGGER enlarge_owner AFTER INSERT ON codex_request_cancellations BEGIN UPDATE discord_ingress_journal SET outcome_json=zeroblob(1048577); END");});assert.throws(()=>cancel(path),/byte budget/);unchanged(path);edit(path,db=>assert.equal(db.prepare("SELECT outcome_json FROM discord_ingress_journal").get()?.outcome_json,null));
}));
test("100ms existing busy wait refuses a held writer and recovers after release",()=>storeFixture(async path=>{
  await queue(path);const holder=new DatabaseSync(path);try{holder.exec("BEGIN IMMEDIATE");const start=performance.now();assert.throws(()=>cancel(path),/locked|busy/);const elapsed=performance.now()-start;assert.ok(elapsed<1500,"100ms busy policy must not inherit the initialized five-second wait");holder.exec("ROLLBACK");assert.equal(cancel(path),"job");}finally{holder.close();}
}));
for(const mutation of ["owner_user_id=9","channel_id=9","event_id=9","target_thread_id='elsewhere'","owner_kind='other'","owner_id='different'"])test("post-update "+mutation+" cannot return success",()=>storeFixture(async path=>{
  await queue(path);edit(path,db=>{owners(db,1);db.exec("CREATE TRIGGER corrupt_result AFTER UPDATE ON discord_ingress_journal WHEN NEW.phase='cancelled' BEGIN UPDATE discord_ingress_journal SET "+mutation+" WHERE ingress_id=NEW.ingress_id; END");});assert.throws(()=>cancel(path),/result was not retained/);unchanged(path);edit(path,db=>assert.equal(getIngressIn(db,"owner-0")?.state,"owned"));
}));
test("lossless signed i64 actor, channel and origin remain exact",()=>storeFixture(async path=>{
  const channel=9223372036854775805n,owner=9223372036854775806n,event=9223372036854775807n;
  await state.enqueue(path,queueJob({jobId:"large-ids",channelId:channel,ownerUserId:owner,discordMessageId:event}));
  assert.equal(state.cancelLatestPendingExisting(path,"target",channel,owner,10),"large-ids");edit(path,db=>{const q=db.prepare("SELECT channel_id,owner_user_id,discord_message_id FROM codex_request_cancellations");q.setReadBigInts(true);assert.deepEqual({...q.get()},{channel_id:channel,owner_user_id:owner,discord_message_id:event});});
}));
for(const count of [128,129])test(count+" unowned raw records are bounded before prompt filtering",()=>storeFixture(async path=>{
  await initialized(path);edit(path,db=>{owners(db,count);db.exec("UPDATE discord_ingress_journal SET state='staged',owner_kind=NULL,owner_id=NULL");});if(count===128)assert.equal(cancel(path),null);else assert.throws(()=>cancel(path),/too many/);unchanged(path,0);
}));
test("invalid argument types and unpaired Unicode fail before any write",()=>storeFixture(async path=>{
  await queue(path);assert.throws(()=>state.cancelLatestPendingExisting(path,"\ud800",1n,2n,10),/well-formed/);assert.throws(()=>state.cancelLatestPendingExisting(path,"target",1 as unknown as bigint,2n,10),/i64/);assert.throws(()=>state.cancelLatestPendingExisting(path,"target",1n,2n,NaN),/timestamp/);assert.throws(()=>state.cancelLatestPendingExisting(path,"target",1n,2n,10,"yes" as unknown as boolean),/mirror policy/);unchanged(path);
}));
test("128 cross-room owners charge every repeated 16KiB mapping read to cumulative bytes",()=>storeFixture(async path=>{
  const target="t".repeat(16384);await state.enqueue(path,queueJob({jobId:"job",targetThreadId:target,ownerUserId:2n}));
  edit(path,db=>{owners(db,128,'{"command":"new","prompt":"hello"}');db.prepare("UPDATE discord_ingress_journal SET target_thread_id=?,kind='action',channel_id=50,outcome_json='{\"new_creation\":{\"version\":1,\"origin_channel_id\":50}}'").run(target);db.prepare("INSERT INTO mirror_threads VALUES (?,'p','title',10,1,1)").run(target);});
  assert.throws(()=>state.cancelLatestPendingExisting(path,target,1n,2n,10,true),/byte budget/);unchanged(path);edit(path,db=>assert.equal(db.prepare("SELECT count(*) AS n FROM discord_ingress_journal WHERE state='owned'").get()?.n,128));
}));
test("missing replay-fence trigger fails closed without recreating it",()=>storeFixture(async path=>{
  await queue(path);edit(path,db=>db.exec("DROP TRIGGER cancelled_codex_turn_queue_INSERT"));const before=edit(path,db=>db.prepare("PRAGMA schema_version").get()?.schema_version);assert.throws(()=>cancel(path),/replay-fence schema is incomplete/);unchanged(path);assert.equal(edit(path,db=>db.prepare("PRAGMA schema_version").get()?.schema_version),before);
}));
