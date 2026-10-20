import assert from "node:assert/strict";
import {test} from "node:test";
import type {DatabaseSync} from "node:sqlite";
import {storeFixture} from "../helpers/store-fixture.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {StateAccessFacade as state} from "../../src/store/state-access-facade.ts";
const {admitBusyInteraction}=state;
import {parseBusyChoice,serializeBusyChoice,BusyChoiceUnavailableError,type BusyChoice} from "../../src/store/busy-choice.ts";
import type {NewIngress} from "../../src/store/ingress-types.ts";
import {getIngressIn} from "../../src/store/ingress-read.ts";
import {getOwn} from "../../src/store/async-resolution-json-helpers.ts";
import {parseSerdeStruct} from "../../src/core/serde-struct-json.ts";
const choice:BusyChoice={choiceId:"choice",ownerUserId:2n,channelId:1n,targetThreadId:"target",prompt:"original",allowSteer:false,createdAt:0,expiresAt:10};
const request=(overrides:Partial<NewIngress>={}):NewIngress=>({ingressId:"original",kind:"interaction",eventId:3n,applicationId:4n,channelId:1n,ownerUserId:2n,sourceMessageId:null,payload:{version:1n},targetThreadId:null,canonicalOwner:null,now:1,...overrides});
async function edit<T>(path:string,run:(db:DatabaseSync)=>T):Promise<T>{const db=await openInitialized(path);try{return run(db);}finally{db.close();}}
async function active(path:string):Promise<void>{await edit(path,db=>db.exec("INSERT INTO busy_choices(choice_id,owner_user_id,channel_id,target_thread_id,prompt,allow_steer,created_at,expires_at,claimed_at,require_current_mirror) VALUES ('choice',2,1,'target','original',0,0,10,NULL,0)"));}
test("busy choice typed decoder supports map/sequence, missing Option and numeric float fields",()=>{
  assert.deepEqual(parseBusyChoice(serializeBusyChoice(choice)),choice);
  assert.deepEqual(parseBusyChoice('["choice",2,1,"target","original",false,0,1e1]'),choice);
  const raw=serializeBusyChoice(choice).replace('"target_thread_id":"target",','');assert.equal(parseBusyChoice(raw).targetThreadId,null);
  const fields=[["value","string?"]] as const;assert.equal(parseSerdeStruct("{}",{fields}).value,null);assert.equal(parseSerdeStruct("{}",{fields,defaults:{value:"fallback"}}).value,"fallback");assert.throws(()=>parseSerdeStruct("[]",{fields}),/Missing/);
});
test("busy typed decoder rejects duplicate identity, integer coercion, bad Option and invalid floats",()=>{
  const raw=serializeBusyChoice(choice);
  for(const value of [raw.replace('"choice_id":"choice"','"choice_id":"choice","choice_id":"other"'),raw.replace('"owner_user_id":2','"owner_user_id":2.0'),raw.replace('"target_thread_id":"target"','"target_thread_id":2'),raw.replace('"created_at":0.0','"created_at":null'),raw.replace('"expires_at":10.0','"expires_at":1e400'),'["choice",2,1,"target","original",false,0]'])assert.throws(()=>parseBusyChoice(value));
});
test("active busy admission freezes original display even when steer display is false",async()=>{
  await storeFixture(async path=>{await active(path);const admitted=await admitBusyInteraction(path,request(),"choice","steer");assert.equal(admitted.created,true);assert.equal(admitted.record?.targetThreadId,"target");assert.equal(admitted.record?.canonicalOwner,"busy-choice:choice");assert.equal(getOwn(admitted.record?.payload,"busy_action"),"steer");assert.deepEqual(admitted.busyChoice,choice);
    const repeated=await admitBusyInteraction(path,request(),"choice","queue");assert.equal(repeated.created,false);assert.equal(getOwn(repeated.record?.payload,"busy_action"),"steer");
  });
});
test("expired, claimed, wrong owner/channel and unsupported action cannot create first custody",async()=>{
  for(const overrides of [{now:10},{ownerUserId:9n},{channelId:9n}])await storeFixture(async path=>{await active(path);await assert.rejects(admitBusyInteraction(path,request(overrides),"choice","queue"),BusyChoiceUnavailableError);});
  await storeFixture(async path=>{await active(path);await assert.rejects(admitBusyInteraction(path,request(),"choice","unknown"),BusyChoiceUnavailableError);await edit(path,db=>db.exec("UPDATE busy_choices SET claimed_at=1"));await assert.rejects(admitBusyInteraction(path,request(),"choice","queue"),BusyChoiceUnavailableError);});
});
test("parent original permits late interaction IDs after the transient choice expires",async()=>{
  await storeFixture(async path=>{await active(path);await admitBusyInteraction(path,request(),"choice","queue");await edit(path,db=>db.exec("DELETE FROM busy_choices"));
    const repeat=await admitBusyInteraction(path,request({ingressId:"repeat",eventId:4n,now:50}),"choice","queue");assert.equal(repeat.created,false);assert.equal(repeat.canonicalRepeatCreated,true);assert.equal(repeat.record?.ownerKind,"ingress");assert.equal(repeat.record?.ownerId,"original");assert.equal(repeat.record?.phase,"canonical_duplicate");assert.deepEqual(repeat.busyChoice,choice);
  });
});
test("canonical durable receipt takes precedence and binds repeats to the prompt owner",async()=>{
  await storeFixture(async path=>{await edit(path,db=>db.prepare("INSERT INTO discord_ingress_owner_receipts VALUES ('busy-choice:choice','prompt','job','target',1,2,?,1)").run(serializeBusyChoice(choice)));
    const repeat=await admitBusyInteraction(path,request({now:50}),"choice","ignore");assert.equal(repeat.canonicalRepeatCreated,true);assert.equal(repeat.record?.ownerKind,"prompt");assert.equal(repeat.record?.ownerId,"job");assert.equal(repeat.record?.state,"owned");
    await assert.rejects(admitBusyInteraction(path,request({ingressId:"bad",eventId:4n,ownerUserId:9n}),"choice","ignore"),BusyChoiceUnavailableError);
  });
});
test("preflight rejection without dispatch is excluded from canonical parent ownership",async()=>{
  await storeFixture(async path=>{await active(path);await admitBusyInteraction(path,request(),"choice","stop");await edit(path,db=>db.exec(`UPDATE discord_ingress_journal SET state='completed',outcome_json='{"kind":"busy_control_preflight_rejected","control_dispatched":false}'`));
    const retry=await admitBusyInteraction(path,request({ingressId:"retry",eventId:4n}),"choice","stop");assert.equal(retry.created,true);assert.equal(retry.canonicalRepeatCreated,false);assert.equal(retry.record?.ownerId,null);
  });
});
test("canonical duplicate custody writes must retain the original admission proof",async()=>{
  await storeFixture(async path=>{await active(path);await admitBusyInteraction(path,request(),"choice","queue");await edit(path,db=>db.exec("CREATE TRIGGER tamper AFTER UPDATE OF owner_id ON discord_ingress_journal WHEN NEW.ingress_id='repeat' BEGIN UPDATE discord_ingress_journal SET target_thread_id='other' WHERE ingress_id=NEW.ingress_id; END"));
    await assert.rejects(admitBusyInteraction(path,request({ingressId:"repeat",eventId:4n}),"choice","queue"),/changed after ordinal/);
    await edit(path,db=>{assert.equal(getIngressIn(db,"repeat"),null);assert.equal(db.prepare("SELECT count(*) AS n FROM cdr_recovery_ingress_order").get()?.n,1);});
  });
});
test("held new interaction is not converted into canonical duplicate execution ownership",async()=>{
  await storeFixture(async path=>{await active(path);await admitBusyInteraction(path,request(),"choice","queue");await edit(path,db=>db.exec("CREATE TRIGGER hold_new AFTER INSERT ON discord_ingress_journal WHEN NEW.ingress_id='held' BEGIN UPDATE discord_ingress_journal SET state='held',phase='fenced' WHERE ingress_id=NEW.ingress_id; END"));
    const result=await admitBusyInteraction(path,request({ingressId:"held",eventId:4n}),"choice","queue");assert.equal(result.created,true);assert.equal(result.canonicalRepeatCreated,false);assert.equal(result.record?.state,"held");assert.equal(result.record?.ownerId,null);
  });
});
test("malformed durable receipt refuses instead of falling back to a live choice",async()=>{
  await storeFixture(async path=>{await active(path);await edit(path,db=>db.exec("INSERT INTO discord_ingress_owner_receipts VALUES ('busy-choice:choice','prompt','job','target',1,2,'{}',1)"));await assert.rejects(admitBusyInteraction(path,request(),"choice","queue"),/Missing Serde field/);await edit(path,db=>assert.equal(db.prepare("SELECT count(*) AS n FROM discord_ingress_journal").get()?.n,0));});
});
