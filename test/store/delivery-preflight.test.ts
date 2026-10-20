import assert from "node:assert/strict";
import {test} from "node:test";
import {existsSync} from "node:fs";
import type {DatabaseSync} from "node:sqlite";
import {storeFixture} from "../helpers/store-fixture.ts";
import {newReply,finalGrant} from "../helpers/delivery-custody.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {admitIngress} from "../../src/store/ingress-admission.ts";
import {StateAccessFacade as state} from "../../src/store/state-access-facade.ts";
const {finalDeliveryPreflight,pendingFirstReply}=state;
import {selectDelivery,type StoredDelivery} from "../../src/store/delivery.ts";
const delivery=(overrides:Partial<StoredDelivery>={}):StoredDelivery=>({deliveryId:"delivery",jobId:"job",targetThreadId:"target",turnId:"turn",channelId:1n,content:"final",attemptCount:0n,lastError:"",createdAt:1,updatedAt:1,...overrides});
async function edit<T>(path:string,run:(db:DatabaseSync)=>T):Promise<T>{const db=await openInitialized(path);try{return run(db);}finally{db.close();}}
async function owned(path:string,id="original",createdAt=1,kind:"message"|"action"="message"):Promise<void>{
  await admitIngress(path,{ingressId:id,kind,eventId:BigInt(createdAt+2),applicationId:null,channelId:1n,ownerUserId:2n,sourceMessageId:null,payload:{version:1n},targetThreadId:"target",canonicalOwner:null,now:createdAt});
  await edit(path,db=>db.prepare("UPDATE discord_ingress_journal SET state='owned',owner_kind='prompt',owner_id='job' WHERE ingress_id=?").run(id));
}
test("final preflight checks first reply before progress and never caches a prior result",async()=>{
  await storeFixture(async path=>{await owned(path);await edit(path,db=>db.exec("INSERT INTO codex_commentary_outbox(delivery_key,job_id,target_thread_id,turn_id,channel_id,text) VALUES ('commentary','job','target','turn',1,'progress'); INSERT INTO codex_goal_progress(thread,turn,channel,content,job_id) VALUES ('target','turn',1,'goal','job')"));
    assert.deepEqual(finalDeliveryPreflight(path,delivery()),{kind:"FirstReply",request:"original"});await edit(path,db=>db.exec("UPDATE discord_ingress_journal SET confirmation_delivered=1"));assert.deepEqual(finalDeliveryPreflight(path,delivery()),{kind:"Commentary"});
    await edit(path,db=>db.exec("DELETE FROM codex_commentary_outbox"));assert.deepEqual(finalDeliveryPreflight(path,delivery()),{kind:"GoalProgress"});await edit(path,db=>db.exec("DELETE FROM codex_goal_progress"));assert.deepEqual(finalDeliveryPreflight(path,delivery()),{kind:"Ready"});
  });
});
test("later unconfirmed duplicate cannot re-close a confirmed earliest visible reply",async()=>{
  await storeFixture(async path=>{await owned(path);await owned(path,"later",2);await edit(path,db=>db.exec("UPDATE discord_ingress_journal SET confirmation_delivered=1 WHERE ingress_id='original'"));assert.equal(await pendingFirstReply(path,"job"),null);assert.deepEqual(finalDeliveryPreflight(path,delivery()),{kind:"Ready"});});
});
test("headless action has no visible first-reply barrier",async()=>{
  await storeFixture(async path=>{await owned(path,"action",1,"action");assert.equal(await pendingFirstReply(path,"job"),null);assert.deepEqual(finalDeliveryPreflight(path,delivery()),{kind:"Ready"});});
});
test("new first-input readiness precedes the ordinary first-reply barrier",async()=>{
  await storeFixture(async path=>{await newReply(path);await edit(path,db=>db.exec("UPDATE codex_new_first_replies SET state='pending',last_error='waiting'"));assert.deepEqual(finalDeliveryPreflight(path,delivery({channelId:2n})),{kind:"Held",reason:"new first input verification is pending; output remains saved: waiting"});});
});
test("legacy goal progress blocks its target but another explicit job does not",async()=>{
  await storeFixture(async path=>{await edit(path,db=>db.exec("INSERT INTO codex_goal_progress(thread,turn,channel,content,job_id) VALUES ('target','turn',1,'goal','different-job')"));assert.deepEqual(finalDeliveryPreflight(path,delivery()),{kind:"Ready"});await edit(path,db=>db.exec("UPDATE codex_goal_progress SET job_id=NULL"));assert.deepEqual(finalDeliveryPreflight(path,delivery()),{kind:"GoalProgress"});});
});
test("existing saved-final grant alone may bypass original first reply, with fresh evidence every time",async()=>{
  await storeFixture(async path=>{await finalGrant(path);const pending=await edit(path,db=>selectDelivery(db,"final"));assert.equal(await pendingFirstReply(path,"job"),"original");assert.deepEqual(finalDeliveryPreflight(path,pending),{kind:"Ready"});
    await edit(path,db=>db.exec("UPDATE discord_ingress_journal SET owner_user_id=9"));assert.throws(()=>finalDeliveryPreflight(path,pending),/evidence or frozen payload changed/);
  });
});
test("invalid existing grant fails before an unrelated malformed new-reply decoder is reached",async()=>{
  await storeFixture(async path=>{await finalGrant(path);const pending=await edit(path,db=>selectDelivery(db,"final"));await edit(path,db=>db.exec("UPDATE cdr_final_recovery SET grant_json='{}'; INSERT INTO codex_new_first_replies(job_id,ingress_id,identity_json) VALUES ('job','original','not-json')"));assert.throws(()=>finalDeliveryPreflight(path,pending),/Missing Serde field: request/);});
});
test("preflight is read-only and rejects malformed delivery accessors without invoking them",async()=>{
  await storeFixture(async path=>{assert.throws(()=>finalDeliveryPreflight(path,delivery()));assert.equal(existsSync(path),false);await edit(path,()=>{});let calls=0;const bad={...delivery(),get jobId(){calls++;return "job";}};assert.throws(()=>finalDeliveryPreflight(path,bad),/own delivery field/);assert.equal(calls,0);assert.deepEqual(finalDeliveryPreflight(path,delivery()),{kind:"Ready"});});
});
