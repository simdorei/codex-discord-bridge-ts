import assert from "node:assert/strict";
import {test} from "node:test";
import type {DatabaseSync} from "node:sqlite";
import {storeFixture} from "../../helpers/store-fixture.ts";
import {newReply} from "../../helpers/delivery-custody.ts";
import {openInitialized} from "../../../src/store/owned-driver.ts";
import {StateAccessFacade as state} from "../../../src/store/state-access-facade.ts";
import {deliverCommentary,deliverPendingCommentary} from "../../../src/runtime/completion/commentary-delivery.ts";
import {DiscordTransportFault,isCompletionHeld,type DiscordReceiptTransport} from "../../../src/runtime/completion/receipt-sender.ts";
async function edit<T>(path:string,run:(db:DatabaseSync)=>T):Promise<T>{const db=await openInitialized(path);try{return run(db);}finally{db.close();}}
async function add(path:string,key:string,job="job",content="progress",channel=1n):Promise<void>{await edit(path,db=>db.prepare("INSERT INTO codex_commentary_outbox(delivery_key,job_id,target_thread_id,turn_id,channel_id,text) VALUES (?,?,'target','turn',?,?)").run(key,job,channel,content));}
test("progress waits for earlier same-job item then sends in sequence",async()=>storeFixture(async path=>{
  await add(path,"a","job","first");await add(path,"b","job","second");const items=await state.pendingCommentary(path),sent:string[]=[];const t:DiscordReceiptTransport={async sendValidated(r){sent.push(JSON.parse(r.body).content);return BigInt(sent.length);}};
  await assert.rejects(deliverCommentary(path,items[1]!,t),/earlier undelivered progress/);assert.deepEqual(sent,[]);
  await deliverPendingCommentary(path,t);assert.deepEqual(sent,["In progress\nfirst","In progress\nsecond"]);assert.deepEqual(await state.pendingCommentary(path),[]);
}));
test("failed first progress blocks same job but later unrelated job still runs",async()=>storeFixture(async path=>{
  await add(path,"a","job","first");await add(path,"b","job","second");await add(path,"c","other","other job");const sent:string[]=[];
  await assert.rejects(deliverPendingCommentary(path,{async sendValidated(r){const content=JSON.parse(r.body).content;sent.push(content);if(content.endsWith("first"))throw new DiscordTransportFault("Transport","unknown");return 99n;}}));
  assert.deepEqual(sent,["In progress\nfirst","In progress\nother job"]);assert.deepEqual((await state.pendingCommentary(path)).map(x=>x.text),["first","second"]);
}));
test("first reply barrier performs no POST and retains progress",async()=>storeFixture(async path=>{
  await add(path,"a");await state.admitIngress(path,{ingressId:"original",kind:"message",eventId:3n,applicationId:null,channelId:1n,ownerUserId:2n,sourceMessageId:null,payload:{version:1n},targetThreadId:"target",canonicalOwner:null,now:1});
  await edit(path,db=>db.exec("UPDATE discord_ingress_journal SET state='owned',owner_kind='prompt',owner_id='job'"));let calls=0;const t:DiscordReceiptTransport={async sendValidated(){calls++;return 99n;}};
  await assert.rejects(deliverPendingCommentary(path,t),/first reply is not confirmed/);assert.equal(calls,0);
  await edit(path,db=>db.exec("UPDATE discord_ingress_journal SET confirmation_delivered=1"));await deliverPendingCommentary(path,t);assert.equal(calls,1);
}));
test("New hold precedes original reply and leaves commentary intact",async()=>storeFixture(async path=>{
  await newReply(path);await add(path,"a","job","progress",2n);let calls=0;
  await assert.rejects(deliverPendingCommentary(path,{async sendValidated(){calls++;return 1n;}}),isCompletionHeld);assert.equal(calls,0);assert.equal((await state.pendingCommentary(path)).length,1);
}));
test("retirement failure keeps confirmed receipt and never sends again",async()=>storeFixture(async path=>{
  await add(path,"a");await edit(path,db=>db.exec("CREATE TRIGGER keep_progress BEFORE DELETE ON codex_commentary_outbox BEGIN SELECT RAISE(ABORT,'keep progress'); END"));let calls=0;const t:DiscordReceiptTransport={async sendValidated(){calls++;return 1n;}};
  await assert.rejects(deliverPendingCommentary(path,t),/keep progress/);await edit(path,db=>db.exec("DROP TRIGGER keep_progress"));await deliverPendingCommentary(path,t);assert.equal(calls,1);
}));
test("commentary input is captured before first read await and rejects accessors",async()=>storeFixture(async path=>{
  await add(path,"a");const pending=(await state.pendingCommentary(path))[0]!;let sent="";
  const work=deliverCommentary(path,pending,{async sendValidated(r){sent=r.path+" "+JSON.parse(r.body).content;return 1n;}});
  Object.assign(pending,{channelId:88n,text:"tampered",sequence:999n});await work;assert.equal(sent,"channels/1/messages In progress\nprogress");assert.deepEqual(await state.pendingCommentary(path),[]);
  let reads=0;Object.defineProperty(pending,"text",{get(){reads++;return "trap";}});await assert.rejects(deliverCommentary(path,pending,{async sendValidated(){throw new Error("must not send");}}),TypeError);assert.equal(reads,0);
}));
