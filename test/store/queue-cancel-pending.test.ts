import assert from "node:assert/strict";
import {test} from "node:test";
import type {DatabaseSync} from "node:sqlite";
import {storeFixture} from "../helpers/store-fixture.ts";
import {queueJob} from "../helpers/queue-job.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {StateAccessFacade as state} from "../../src/store/state-access-facade.ts";
const {cancelLatestPending}=state;
import {admitIngress} from "../../src/store/ingress-admission.ts";
import {getIngressIn} from "../../src/store/ingress-read.ts";
import {DeadGenerationTargetHeldError} from "../../src/store/queue-mark-running.ts";
async function edit<T>(path:string,run:(db:DatabaseSync)=>T):Promise<T>{const db=await openInitialized(path);try{return run(db);}finally{db.close();}}
async function queue(path:string,id="job",time=1):Promise<void>{await state.enqueue(path,queueJob({jobId:id,ownerUserId:2n,createdAt:time}));}
async function ingress(path:string):Promise<void>{await admitIngress(path,{ingressId:"original",kind:"message",eventId:3n,applicationId:null,channelId:1n,ownerUserId:2n,sourceMessageId:null,payload:{version:1n,plan:{Execute:{Ask:{prompt:"hello"}}}},targetThreadId:"target",canonicalOwner:null,now:2});}
const cancel=(path:string)=>cancelLatestPending(path,"target",1n,2n,10);
const count=(path:string,table:string)=>edit(path,db=>db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n);
test("latest eligible pending request is cancelled once with a durable replay fence",async()=>{
  await storeFixture(async path=>{assert.equal(await cancel(path),null);await queue(path,"older",1);await queue(path,"newer",2);assert.equal(await cancel(path),"newer");assert.equal(await count(path,"codex_turn_queue"),1);await assert.rejects(queue(path,"newer",3),/cancelled/);assert.equal(await cancel(path),"older");assert.equal(await cancel(path),null);assert.equal(await count(path,"codex_request_cancellations"),2);});
});
test("started or unknown work is not removed; an older eligible pending request may be selected",async()=>{
  await storeFixture(async path=>{await queue(path,"started",2);await edit(path,db=>db.exec("UPDATE codex_turn_queue SET state='running',turn_id='turn'"));await assert.rejects(cancel(path),/outcome is unknown/);await queue(path,"older",1);assert.equal(await cancel(path),"older");await edit(path,db=>assert.equal(db.prepare("SELECT state FROM codex_turn_queue").get()?.state,"running"));});
});
test("only the exact pure active-writer preflight failure restores pending cancellation eligibility",async()=>{
  await storeFixture(async path=>{await queue(path);await edit(path,db=>db.exec("UPDATE codex_turn_queue SET attempt_count=1,last_error='other'") );await assert.rejects(cancel(path),/outcome is unknown/);
    await edit(path,db=>db.exec("UPDATE codex_turn_queue SET last_error='app-server returned error -32600 for thread/resume: thread target already has an active writer',execution_generation=NULL,turn_observation_generation=NULL,goal_waiting=0,baseline_turn_ids='[]'"));assert.equal(await cancel(path),"job");
  });
});
test("claimed intake can be withdrawn before promotion and its receipt blocks resurrection",async()=>{
  await storeFixture(async path=>{await edit(path,db=>db.exec("INSERT INTO codex_prompt_intakes(job_id,target_thread_id,channel_id,owner_user_id,raw_prompt,auto_queue_when_busy,require_current_mirror,claim_token,claim_expires_at,created_at,updated_at) VALUES ('intake','target',1,2,'hello',1,0,'claim',100,1,1)"));assert.equal(await cancel(path),"intake");assert.equal(await count(path,"codex_prompt_intakes"),0);
    await assert.rejects(edit(path,db=>db.exec("INSERT INTO codex_prompt_intakes(job_id,target_thread_id,channel_id,owner_user_id,raw_prompt,auto_queue_when_busy,require_current_mirror,created_at,updated_at) VALUES ('intake','target',1,2,'hello',1,0,1,1)")),/cancelled/);
  });
});
test("unstarted ingress cancellation preserves prior scalar outcome and prevents execution claim",async()=>{
  await storeFixture(async path=>{await ingress(path);await edit(path,db=>db.exec(`UPDATE discord_ingress_journal SET outcome_json='"prior"'`));assert.equal(await cancel(path),"ingress:original");const row=await edit(path,db=>getIngressIn(db,"original")!);assert.equal(row.state,"completed");assert.equal(row.ownerKind,"cancellation");assert.deepEqual(row.outcome,{prior_result:"prior",kind:"request_cancelled",job_id:"ingress:original"});assert.equal(await state.beginIngressExecution(path,"original","processing","target",11),false);});
});
test("queue ownership transitions every matching ingress while retaining prior result evidence",async()=>{
  await storeFixture(async path=>{await ingress(path);await queue(path);await edit(path,db=>db.exec(`UPDATE discord_ingress_journal SET state='owned',owner_kind='prompt',owner_id='job',outcome_json='["prior"]'`));assert.equal(await cancel(path),"job");const row=await edit(path,db=>getIngressIn(db,"original")!);assert.equal(row.phase,"cancelled");assert.deepEqual(row.outcome,{prior_result:["prior"],kind:"request_cancelled",job_id:"job"});});
});
test("identity collisions, conflicting owner and uncertain outbox leave work untouched",async()=>{
  for(const mode of ["collision","outbox","owner"])await storeFixture(async path=>{await queue(path);if(mode==="owner"){await ingress(path);await edit(path,db=>db.exec("UPDATE discord_ingress_journal SET state='owned',owner_kind='prompt',owner_id='job',owner_user_id=9"));}
    if(mode==="collision")await edit(path,db=>db.exec("INSERT INTO codex_prompt_intakes(job_id,target_thread_id,channel_id,owner_user_id,raw_prompt,auto_queue_when_busy,require_current_mirror,created_at,updated_at) VALUES ('job','target',1,2,'hello',1,0,2,2)"));
    if(mode==="outbox")await edit(path,db=>db.exec("INSERT INTO codex_delivery_outbox(delivery_id,job_id,target_thread_id,turn_id,channel_id,content,created_at,updated_at) VALUES ('delivery','job','target','turn',1,'result',1,1)"));
    await assert.rejects(cancel(path),/uncertain|conflicting/);assert.equal(await count(path,"codex_turn_queue"),1);assert.equal(await count(path,"codex_request_cancellations"),0);
  });
});
test("room remapping, fork fence and dead generation cannot be bypassed by pending cancellation",async()=>{
  await storeFixture(async path=>{await queue(path);await assert.rejects(cancelLatestPending(path,"target",1n,2n,10,true),/mapping changed/);await edit(path,db=>db.exec("INSERT INTO codex_dead_generation_holds VALUES ('target','old',1,1)"));await assert.rejects(cancel(path),DeadGenerationTargetHeldError);assert.equal(await count(path,"codex_turn_queue"),1);});
  await storeFixture(async path=>{await queue(path);await edit(path,db=>db.exec("INSERT INTO codex_thread_fork_handoffs(handoff_id,source_thread_id,expected_generation,discord_channel_id,discord_thread_id,quarantine_reason,created_at) VALUES ('fork','target',1,10,1,'unknown',1)"));await assert.rejects(cancel(path),/fork handoff is unresolved/);assert.equal(await count(path,"codex_turn_queue"),1);});
});
test("failed deletion rolls back the already inserted cancellation receipt",async()=>{
  await storeFixture(async path=>{await queue(path);await edit(path,db=>db.exec("CREATE TRIGGER block_delete BEFORE DELETE ON codex_turn_queue BEGIN SELECT RAISE(IGNORE); END"));await assert.rejects(cancel(path),/ownership changed/);assert.equal(await count(path,"codex_turn_queue"),1);assert.equal(await count(path,"codex_request_cancellations"),0);});
});
