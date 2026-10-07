import {getOwn} from "../../src/store/async-resolution-json-helpers.ts";
import assert from "node:assert/strict";
import {test} from "node:test";
import type {DatabaseSync} from "node:sqlite";
import {storeFixture} from "../helpers/store-fixture.ts";
import {queueJob} from "../helpers/queue-job.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {StateAccessFacade as state} from "../../src/store/state-access-facade.ts";
import type {RecoveryCancellationCheck} from "../../src/store/queue-cancel-recovery.ts";
import {admitIngress} from "../../src/store/ingress-admission.ts";
import {getIngressIn} from "../../src/store/ingress-read.ts";
import {validateStopRevisionIn,currentStopRevisionIn} from "../../src/store/stop-revision-read.ts";
import {parseSerdeValue} from "../../src/core/serde-json-parse.ts";
async function edit<T>(path:string,run:(db:DatabaseSync)=>T):Promise<T>{const db=await openInitialized(path);try{return run(db);}finally{db.close();}}
async function queue(path:string,id="job",owner=2n):Promise<void>{await state.enqueue(path,queueJob({jobId:id,ownerUserId:owner,createdAt:1}));}
async function ingress(path:string,owner=2n):Promise<void>{await admitIngress(path,{ingressId:"original",kind:"message",eventId:3n,applicationId:null,channelId:1n,ownerUserId:owner,sourceMessageId:null,payload:{version:1n,plan:{Execute:{Ask:{prompt:"hello"}}}},targetThreadId:"target",canonicalOwner:null,now:1});}
const cancel=(path:string,check?:RecoveryCancellationCheck)=>state.cancelForRecovery(path,"target",1n,2n,10,check);
const counts=(path:string)=>edit(path,db=>["codex_turn_queue","codex_prompt_intakes","codex_request_cancellations","cdr_execution_holds"].map(table=>db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n));
test("full recovery retains started evidence, cancellation fences and outbox without claiming process exit",async()=>{
  await storeFixture(async path=>{await queue(path);await edit(path,db=>db.exec("UPDATE codex_turn_queue SET state='running',turn_id='turn',attempt_count=1,execution_generation=1; INSERT INTO codex_dead_generation_holds VALUES ('target','old',1,1); INSERT INTO codex_delivery_outbox(delivery_id,job_id,target_thread_id,turn_id,channel_id,content,created_at,updated_at) VALUES ('delivery','job','target','turn',1,'prior output',1,1)"));
    assert.deepEqual(await cancel(path),{jobs:["job"],startedOrUncertain:1});assert.deepEqual(await counts(path),[0,0,1,1]);await edit(path,db=>{assert.equal(db.prepare("SELECT count(*) AS n FROM codex_delivery_outbox").get()?.n,1);assert.equal(currentStopRevisionIn(db),1n);assert.throws(()=>validateStopRevisionIn(db,"target",{target:"target",stopRevision:0n}),/predates stop/);const evidence=parseSerdeValue(String(db.prepare("SELECT evidence_json FROM cdr_execution_holds").get()?.evidence_json));assert.equal(getOwn(evidence,"kind"),"queue");assert.equal(getOwn(getOwn(evidence,"request"),"turn_id"),"turn");});
  });
});
test("queue and intake cancellation preserve evidence with one shared final revision",async()=>{
  await storeFixture(async path=>{await queue(path);await edit(path,db=>db.exec("INSERT INTO codex_prompt_intakes(job_id,target_thread_id,channel_id,owner_user_id,raw_prompt,auto_queue_when_busy,require_current_mirror,created_at,updated_at) VALUES ('intake','target',1,2,'raw prompt',1,0,2,2)"));const result=await cancel(path);assert.deepEqual(result.jobs,["job","intake"]);assert.equal(result.startedOrUncertain,0);assert.deepEqual(await counts(path),[0,0,2,2]);await edit(path,db=>assert.equal(currentStopRevisionIn(db),1n));});
});
test("unowned started prompt loses replay authority and retains original payload evidence",async()=>{
  await storeFixture(async path=>{await ingress(path);await state.beginIngressExecution(path,"original","processing","target",2);assert.deepEqual(await cancel(path),{jobs:["ingress:original"],startedOrUncertain:1});await edit(path,db=>{const record=getIngressIn(db,"original")!;assert.equal(record.phase,"cancelled");assert.equal(record.ownerKind,"cancellation");assert.equal(record.ownerId,"ingress:original");});});
});
test("another actor anywhere in scope blocks all cancellation, including late-discovered ingress",async()=>{
  await storeFixture(async path=>{await queue(path);await queue(path,"foreign",9n);await assert.rejects(cancel(path),/another sender/);assert.deepEqual(await counts(path),[2,0,0,0]);});
  await storeFixture(async path=>{await queue(path);await ingress(path,9n);await assert.rejects(cancel(path),/ingress scope changed/);assert.deepEqual(await counts(path),[1,0,0,0]);});
});
test("128-request cap is checked across inventory and rollback preserves every row",async()=>{
  await storeFixture(async path=>{await queue(path);await edit(path,db=>{const insert=db.prepare("INSERT INTO codex_prompt_intakes(job_id,target_thread_id,channel_id,owner_user_id,raw_prompt,auto_queue_when_busy,require_current_mirror,created_at,updated_at) VALUES (?,'target',1,2,'hello',1,0,1,1)");for(let i=0;i<128;i++)insert.run(`intake-${i}`);});await assert.rejects(cancel(path),/too many requests/);assert.deepEqual(await counts(path),[1,128,0,0]);});
});
test("trusted custody check runs before and after cancellation; failure rolls everything back",async()=>{
  await storeFixture(async path=>{await queue(path);let calls=0;await assert.rejects(cancel(path,()=>{if(++calls===2)throw new Error("original custody changed");return undefined;}),/original custody changed/);assert.equal(calls,2);assert.deepEqual(await counts(path),[1,0,0,0]);await edit(path,db=>assert.equal(currentStopRevisionIn(db),0n));});
});
test("async custody callbacks are rejected before starting their body",async()=>{
  await storeFixture(async path=>{await queue(path);let calls=0;const bad=(async()=>{calls++;}) as unknown as RecoveryCancellationCheck;await assert.rejects(cancel(path,bad),/synchronous recovery/);assert.equal(calls,0);assert.deepEqual(await counts(path),[1,0,0,0]);});
});
test("ignored Stop receipt INSERT rolls back all preceding cancellation effects",async()=>{
  await storeFixture(async path=>{await queue(path);await edit(path,db=>db.exec("CREATE TRIGGER ignore_revision BEFORE INSERT ON cdr_stop_revision_receipts BEGIN SELECT RAISE(IGNORE); END"));await assert.rejects(cancel(path),/stop revision evidence differs/);assert.deepEqual(await counts(path),[1,0,0,0]);await edit(path,db=>assert.equal(currentStopRevisionIn(db),0n));});
});
test("empty recovery still revokes earlier RPC metadata, and exhausted revision refuses",async()=>{
  await storeFixture(async path=>{assert.deepEqual(await cancel(path),{jobs:[],startedOrUncertain:0});await edit(path,db=>{assert.equal(currentStopRevisionIn(db),1n);assert.throws(()=>validateStopRevisionIn(db,"target"),/predates stop/);});});
  await storeFixture(async path=>{await queue(path);await edit(path,db=>db.exec("UPDATE cdr_stop_clock SET revision=9223372036854775807; INSERT INTO cdr_stop_revision_receipts VALUES ('max','target',9223372036854775807,'{}'); INSERT INTO cdr_stop_revisions VALUES ('target',9223372036854775807,'max')"));await assert.rejects(cancel(path),/stop revision evidence differs/);assert.deepEqual(await counts(path),[1,0,0,0]);});
});
test("malformed intake evidence fails closed before its cancellation can commit",async()=>{
  await storeFixture(async path=>{await edit(path,db=>db.exec("INSERT INTO codex_prompt_intakes(job_id,target_thread_id,channel_id,owner_user_id,raw_prompt,auto_queue_when_busy,require_current_mirror,created_at,updated_at) VALUES ('intake','target',1,2,CAST(x'80' AS TEXT),1,0,1,1)"));await assert.rejects(cancel(path),/Invalid text encoding|Invalid/);assert.deepEqual(await counts(path),[0,1,0,0]);});
});
