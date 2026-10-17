import assert from "node:assert/strict";
import {test} from "node:test";
import type {DatabaseSync} from "node:sqlite";
import {storeFixture} from "../../helpers/store-fixture.ts";
import {queueJob} from "../../helpers/queue-job.ts";
import {openInitialized} from "../../../src/store/owned-driver.ts";
import {StateAccessFacade as state} from "../../../src/store/state-access-facade.ts";
import {deliverStartFailures,deliverPendingOutputs} from "../../../src/runtime/completion/pending-delivery.ts";
import {DiscordTransportFault,type DiscordReceiptTransport} from "../../../src/runtime/completion/receipt-sender.ts";
import {CompletionChannelIdError} from "../../../src/runtime/completion/final-delivery.ts";
async function edit<T>(path:string,run:(db:DatabaseSync)=>T):Promise<T>{const db=await openInitialized(path);try{return run(db);}finally{db.close();}}
async function notice(path:string,id="start",channel=1n){await state.enqueue(path,queueJob({jobId:id,targetThreadId:id,channelId:channel}));await edit(path,db=>{
  db.prepare("UPDATE codex_turn_queue SET last_error='[cdr-rust:auto-reserve-hold:v1] usage' WHERE job_id=?").run(id);
  db.prepare("INSERT INTO codex_reserve_start_notices(job_id,target_thread_id,channel_id,app_server_generation,attempt_count,content,created_at) VALUES (?,?,?,1,0,?,1)").run(id,id,channel,`Failed ${id}`);
});}
async function otherOutputs(path:string){await edit(path,db=>db.exec("INSERT INTO codex_commentary_outbox(delivery_key,job_id,target_thread_id,turn_id,channel_id,text) VALUES ('c','other','other','turn',1,'progress'); INSERT INTO codex_delivery_outbox(delivery_id,job_id,target_thread_id,turn_id,channel_id,content,created_at,updated_at) VALUES ('d','other','other','turn',1,'final',1,1)"));}
test("start notice requires exact no-turn receipt claim and retires only its notice",async()=>storeFixture(async path=>{
  await notice(path);let calls=0;await deliverStartFailures(path,{async sendValidated(r){calls++;assert.equal(JSON.parse(r.body).content,"Failed start");assert.equal((await state.pendingStartNotices(path)).length,1);return 123n;}});
  assert.equal(calls,1);assert.deepEqual(await state.pendingStartNotices(path),[]);
  await edit(path,db=>{assert.equal(db.prepare("SELECT state FROM codex_turn_queue").get()?.state,"pending");assert.equal(db.prepare("SELECT turn_id FROM codex_turn_queue").get()?.turn_id,null);assert.equal(db.prepare("SELECT message_id FROM codex_delivery_receipts").get()?.message_id,"123");});
}));
test("changed no-turn custody prevents start notice POST and retains evidence",async()=>storeFixture(async path=>{
  await notice(path);await edit(path,db=>db.exec("UPDATE codex_turn_queue SET turn_id='accepted',state='running'"));let calls=0;
  await assert.rejects(deliverStartFailures(path,{async sendValidated(){calls++;return 1n;}}),/exact held no-turn job/);assert.equal(calls,0);assert.equal((await state.pendingStartNotices(path)).length,1);
}));
test("notice completion failure reuses committed receipt and does not resend",async()=>storeFixture(async path=>{
  await notice(path);await edit(path,db=>db.exec("CREATE TRIGGER keep_notice BEFORE DELETE ON codex_reserve_start_notices BEGIN SELECT RAISE(ABORT,'keep notice'); END"));let calls=0;const t:DiscordReceiptTransport={async sendValidated(){calls++;return 1n;}};
  await assert.rejects(deliverStartFailures(path,t),/keep notice/);await edit(path,db=>db.exec("DROP TRIGGER keep_notice"));await deliverStartFailures(path,t);assert.equal(calls,1);
}));
test("pending phases send start notice then commentary then final",async()=>storeFixture(async path=>{
  await notice(path);await otherOutputs(path);const sent:string[]=[];
  await deliverPendingOutputs(path,{transport:{async sendValidated(r){sent.push(JSON.parse(r.body).content);return BigInt(sent.length);}},failures:{render:()=>"safe"},now:()=>1});
  assert.deepEqual(sent,["Failed start","In progress\nprogress","final"]);assert.deepEqual(await state.listPendingDeliveries(path),[]);
}));
test("start error is returned only after unrelated commentary and final attempts",async()=>storeFixture(async path=>{
  await notice(path,"bad",0n);await otherOutputs(path);const sent:string[]=[];
  await assert.rejects(deliverPendingOutputs(path,{transport:{async sendValidated(r){sent.push(JSON.parse(r.body).content);return BigInt(sent.length);}},failures:{render:()=>"safe"},now:()=>1}),CompletionChannelIdError);
  assert.deepEqual(sent,["In progress\nprogress","final"]);assert.equal((await state.pendingStartNotices(path)).length,1);assert.deepEqual(await state.listPendingDeliveries(path),[]);
}));
test("commentary error retains final behind barrier even when later phase is attempted",async()=>storeFixture(async path=>{
  await otherOutputs(path);let calls=0;
  await assert.rejects(deliverPendingOutputs(path,{transport:{async sendValidated(){calls++;throw new DiscordTransportFault("Transport","unknown");}},failures:{render:()=>"safe"},now:()=>1}));
  assert.equal(calls,1);assert.equal((await state.listPendingDeliveries(path))[0]?.attemptCount,1n);assert.equal((await state.pendingCommentary(path)).length,1);
}));
test("final-list decode error overrides earlier start error as source question-mark does",async()=>storeFixture(async path=>{
  await notice(path,"bad",0n);await otherOutputs(path);await edit(path,db=>db.exec("DELETE FROM codex_commentary_outbox; UPDATE codex_delivery_outbox SET content=x'FF'"));
  let caught:unknown;try{await deliverPendingOutputs(path,{transport:{async sendValidated(){throw new Error("no send");}},failures:{render:()=>"safe"},now:()=>1});}catch(error){caught=error;}
  assert.ok(caught);assert.equal(caught instanceof CompletionChannelIdError,false);assert.equal((await state.pendingStartNotices(path)).length,1);
}));
test("notice ordering uses timestamp then job identity and absent completion is harmless",async()=>storeFixture(async path=>{
  await notice(path,"z");await notice(path,"a");assert.deepEqual((await state.pendingStartNotices(path)).map(x=>x.jobId),["a","z"]);await state.completeStartNotice(path,"absent");assert.equal((await state.pendingStartNotices(path)).length,2);
}));
