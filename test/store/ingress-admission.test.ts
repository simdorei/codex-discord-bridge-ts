import assert from "node:assert/strict";
import {test} from "node:test";
import type {DatabaseSync} from "node:sqlite";
import {storeFixture} from "../helpers/store-fixture.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {admitIngressRecordedIn} from "../../src/store/ingress-admission.ts";
import {StateAccessFacade as state} from "../../src/store/state-access-facade.ts";
const {admitIngress,pendingNewPrompt}=state;
import {getIngressIn} from "../../src/store/ingress-read.ts";
import {verifyRecordedAdmissionIn} from "../../src/store/ingress-admission-order.ts";
import type {NewIngress} from "../../src/store/ingress-types.ts";
import {getOwn,pointer} from "../../src/store/async-resolution-json-helpers.ts";
const request=(overrides:Partial<NewIngress>={}):NewIngress=>({ingressId:"original",kind:"message",eventId:3n,applicationId:null,channelId:1n,ownerUserId:2n,sourceMessageId:null,payload:{version:1n,author_is_bot:false,content:"hello",plan:{Execute:{Ask:{prompt:"hello"}}}},targetThreadId:"target",canonicalOwner:null,now:1,...overrides});
async function edit(path:string,run:(db:DatabaseSync)=>void):Promise<void>{const db=await openInitialized(path);try{run(db);}finally{db.close();}}
const arm=():NewIngress=>request({ingressId:"arm",payload:{version:1n,author_is_bot:false,content:" !NeW ",plan:{Execute:{New:{prompt:""}}}}});
const next=(overrides:Partial<NewIngress>={}):NewIngress=>request({ingressId:"next",eventId:4n,...overrides});
test("ingress persists original identity, ordinal and processed receipt before returning",async()=>{
  await storeFixture(async path=>{const r=request();const pending=admitIngress(path,r);r.ownerUserId=9n;(r.payload as Record<string,unknown>).content="changed";
    const admitted=await pending;assert.equal(admitted.created,true);assert.equal(admitted.record?.ownerUserId,2n);assert.equal(getOwn(admitted.record?.payload,"content"),"hello");
    await edit(path,db=>{assert.equal(db.prepare("SELECT count(*) AS n FROM cdr_recovery_ingress_order").get()?.n,1);assert.equal(db.prepare("SELECT message_id FROM discord_processed_messages").get()?.message_id,3);});
  });
});
test("duplicate never captures a new stop or acquires another admission order",async()=>{
  await storeFixture(async path=>{
    const first=await admitIngress(path,request({payload:{settings_binding:{}}}));assert.deepEqual(getOwn(first.record?.payload,"stop_origin"),{stopRevision:0n,target:"target"});
    await edit(path,db=>db.exec("UPDATE cdr_stop_clock SET revision=1; INSERT INTO cdr_stop_revision_receipts VALUES ('stop','target',1,'{}'); INSERT INTO cdr_stop_revisions VALUES ('target',1,'stop')"));
    const duplicate=await admitIngress(path,request({ingressId:"different-id",payload:{settings_binding:{new:1n}},targetThreadId:"other",now:9}));assert.equal(duplicate.created,false);assert.equal(duplicate.record?.ingressId,"original");assert.deepEqual(duplicate.record?.payload,first.record?.payload);
    await edit(path,db=>assert.equal(db.prepare("SELECT count(*) AS n FROM cdr_recovery_ingress_order").get()?.n,1));
  });
});
test("by-origin ambiguity is evaluated even when by-id already exists",async()=>{
  await storeFixture(async path=>{await admitIngress(path,request());await edit(path,db=>db.exec(`INSERT INTO discord_ingress_journal(ingress_id,kind,event_id,channel_id,owner_user_id,payload_json,state,phase,created_at,updated_at) VALUES ('other','action',3,1,2,'{}','staged','staged',1,1)`));
    await assert.rejects(admitIngress(path,request()),/ambiguous ingress origin/);
  });
});
test("legacy processed message does not manufacture a journal or fresh order",async()=>{
  await storeFixture(async path=>{await edit(path,db=>db.exec("INSERT INTO discord_processed_messages VALUES (3,1)"));const result=await admitIngress(path,request());assert.deepEqual(result,{created:false,canonicalRepeatCreated:false,record:null,busyChoice:null});await edit(path,db=>assert.equal(db.prepare("SELECT count(*) AS n FROM cdr_recovery_ingress_order").get()?.n,0));});
});
test("invalid custody and conflicting owner refuse without changing persisted admission",async()=>{
  await storeFixture(async path=>{await admitIngress(path,request());for(const overrides of [{ownerUserId:9n},{channelId:9n}])await assert.rejects(admitIngress(path,request(overrides)),/original owner/);
    for(const overrides of [{ingressId:" bad"},{channelId:0n},{ownerUserId:0n},{eventId:null},{eventId:0n},{now:NaN},{now:-1},{payload:[]}])await assert.rejects(admitIngress(path,request(overrides)),/invalid ingress/);
    await edit(path,db=>assert.equal(db.prepare("SELECT count(*) AS n FROM discord_ingress_journal").get()?.n,1));
  });
});
test("new arm consumes once in same room and owner, preserving original ordinal custody",async()=>{
  await storeFixture(async path=>{const ready=await admitIngress(path,arm());assert.equal(ready.record?.targetThreadId,null);assert.equal(typeof pointer(ready.record?.payload,"/plan/Respond"),"string");assert.equal(await pendingNewPrompt(path,1n,2n,4n),"arm");assert.equal(await pendingNewPrompt(path,1n,9n,4n),null);
    const result=await admitIngress(path,next());assert.equal(result.record?.targetThreadId,null);assert.equal(pointer(result.record?.payload,"/plan/Execute/New/prompt"),"hello");assert.equal(getOwn(result.record?.payload,"new_prompt_arm_ref"),"arm");assert.equal(await pendingNewPrompt(path,1n,2n,5n),null);
    const later=await admitIngress(path,next({ingressId:"later",eventId:5n}));assert.equal(pointer(later.record?.payload,"/plan/Execute/Ask/prompt"),"hello");
    await edit(path,db=>assert.equal(pointer(getIngressIn(db,"arm")?.payload,"/new_prompt_arm/consumed_by"),"next"));
  });
});
test("new arm changed route consumes reservation but refuses new execution",async()=>{
  await storeFixture(async path=>{await admitIngress(path,arm());await edit(path,db=>db.exec("INSERT INTO mirror_threads VALUES ('mapped','p','title',10,1,1)"));const result=await admitIngress(path,next());assert.match(String(pointer(result.record?.payload,"/plan/Respond")),/방 연결이 변경/);assert.equal(pointer(result.record?.payload,"/plan/Execute/New"),undefined);});
});
test("stale mention reservation refuses rather than silently treating it as ordinary input",async()=>{
  await storeFixture(async path=>{await admitIngress(path,arm());const value=next();(value.payload as Record<string,unknown>).new_prompt_mention_arm="wrong";const result=await admitIngress(path,value);assert.match(String(pointer(result.record?.payload,"/plan/Respond")),/이미 사용되었거나 변경/);assert.equal(await pendingNewPrompt(path,1n,2n,5n),"arm");});
});
test("post-receipt mutation rolls back arm consumption, new journal, ordinal and processed marker together",async()=>{
  await storeFixture(async path=>{await admitIngress(path,arm());await edit(path,db=>db.exec("CREATE TRIGGER corrupt AFTER INSERT ON discord_processed_messages WHEN NEW.message_id=4 BEGIN UPDATE discord_ingress_journal SET owner_user_id=9 WHERE ingress_id='next'; END"));await assert.rejects(admitIngress(path,next()),/changed after ordinal/);
    assert.equal(await pendingNewPrompt(path,1n,2n,5n),"arm");await edit(path,db=>{assert.equal(getIngressIn(db,"next"),null);assert.equal(db.prepare("SELECT count(*) AS n FROM cdr_recovery_ingress_order").get()?.n,1);assert.equal(db.prepare("SELECT count(*) AS n FROM discord_processed_messages WHERE message_id=4").get()?.n,0);});
  });
});
test("borrowed admission returns exact original proof for later custody verification",async()=>{
  await storeFixture(async path=>{await edit(path,db=>{db.exec("BEGIN IMMEDIATE");const [result,proof]=admitIngressRecordedIn(db,request());assert.equal(result.created,true);assert.ok(proof);verifyRecordedAdmissionIn(db,proof);db.exec("UPDATE discord_ingress_journal SET payload_json='{}'");assert.throws(()=>verifyRecordedAdmissionIn(db,proof),/changed after ordinal/);db.exec("ROLLBACK");assert.equal(getIngressIn(db,"original"),null);});});
});
test("concurrent same-event admissions retain one original record and one ordinal",async()=>{
  await storeFixture(async path=>{await edit(path,()=>{});const results=await Promise.all(Array.from({length:5},(_,i)=>admitIngress(path,request({ingressId:`concurrent-${i}`}))));
    assert.equal(results.filter(r=>r.created).length,1);assert.equal(new Set(results.map(r=>r.record?.ingressId)).size,1);
    await edit(path,db=>{assert.equal(db.prepare("SELECT count(*) AS n FROM discord_ingress_journal").get()?.n,1);assert.equal(db.prepare("SELECT count(*) AS n FROM cdr_recovery_ingress_order").get()?.n,1);});
  });
});
test("new arm does not consume command, bot, old-event or different-owner messages",async()=>{
  const variants:Partial<NewIngress>[]=[{eventId:2n},{ownerUserId:9n},{channelId:9n},{payload:{version:1n,author_is_bot:true,content:"hello",plan:{Execute:{Ask:{prompt:"hello"}}}}},{payload:{version:1n,author_is_bot:false,content:"!help",plan:{Execute:{Ask:{prompt:"!help"}}}}}];
  for(const variant of variants)await storeFixture(async path=>{await admitIngress(path,arm());const result=await admitIngress(path,next(variant));assert.equal(pointer(result.record?.payload,"/plan/Execute/New"),undefined);assert.equal(await pendingNewPrompt(path,1n,2n,10n),"arm");});
});
test("action without event is admissible and explicit null new-origin is preserved",async()=>{
  await storeFixture(async path=>{const result=await admitIngress(path,request({kind:"action",eventId:null,payload:{command:"new",new_origin:null}}));assert.equal(result.created,true);assert.equal(getOwn(result.record?.payload,"new_origin"),null);await edit(path,db=>assert.equal(db.prepare("SELECT count(*) AS n FROM discord_processed_messages").get()?.n,0));});
});
