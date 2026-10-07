import assert from "node:assert/strict";
import {test} from "node:test";
import type {DatabaseSync} from "node:sqlite";
import {storeFixture} from "../helpers/store-fixture.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {admitIngress} from "../../src/store/ingress-admission.ts";
import {getIngressIn} from "../../src/store/ingress-read.ts";
import {recordNewInput} from "../../src/store/ingress-new-input.ts";
import {RequestCancelledError} from "../../src/store/ingress-lifecycle.ts";
import {StateAccessFacade as state} from "../../src/store/state-access-facade.ts";
const {acknowledgeIngress,beginIngressConfirmation,beginIngressExecution,beginIngressThreadStart,recordIngressCreatedThread,recordIngressResult,confirmIngress,recordIngressProcessingMode}=state;
import {getOwn} from "../../src/store/async-resolution-json-helpers.ts";
import {serializeSerdeValue} from "../../src/core/serde-json.ts";
import type {NewIngress} from "../../src/store/ingress-types.ts";
const request=(overrides:Partial<NewIngress>={}):NewIngress=>({ingressId:"original",kind:"message",eventId:3n,applicationId:null,channelId:1n,ownerUserId:2n,sourceMessageId:null,payload:{version:1n,author_is_bot:false,content:"!new hello",plan:{Execute:{New:{prompt:"hello"}}}},targetThreadId:"target",canonicalOwner:null,now:1,...overrides});
async function edit<T>(path:string,run:(db:DatabaseSync)=>T):Promise<T>{const db=await openInitialized(path);try{return run(db);}finally{db.close();}}
const read=(path:string)=>edit(path,db=>getIngressIn(db,"original")!);
test("acknowledgement and execution claim transitions are idempotent without rewriting original payload",async()=>{
  await storeFixture(async path=>{await admitIngress(path,request());const before=(await read(path)).payload;
    assert.equal(await acknowledgeIngress(path,"original",2),true);assert.equal(await acknowledgeIngress(path,"original",3),false);
    assert.equal(await beginIngressExecution(path,"original","processing",null,4),true);assert.equal(await beginIngressExecution(path,"original","other","other",5),false);
    const after=await read(path);assert.equal(after.phase,"processing");assert.equal(after.targetThreadId,"target");assert.deepEqual(after.payload,before);
  });
});
test("frozen slash target rejects changed mirror and explicit retargeting before execution",async()=>{
  await storeFixture(async path=>{await admitIngress(path,request({kind:"interaction",payload:{version:1n,work:{Slash:{name:"ask",values:{prompt:{String:"hello"}}}}}}));
    await assert.rejects(beginIngressExecution(path,"original","processing","target",2),/mapping changed/);
    await edit(path,db=>db.exec("INSERT INTO mirror_threads VALUES ('target','p','title',10,1,1)"));
    await assert.rejects(beginIngressExecution(path,"original","processing","other",2),/mapping changed/);assert.equal((await read(path)).state,"staged");
    assert.equal(await beginIngressExecution(path,"original","processing",null,3),true);
  });
});
test("thread creation requires original New input and exact generation-bound attempt",async()=>{
  await storeFixture(async path=>{await admitIngress(path,request());assert.throws(()=>beginIngressThreadStart(path,"original",0n,2),/generation/);
    assert.equal(await beginIngressThreadStart(path,"original",7n,2),true);assert.equal((await read(path)).targetThreadId,null);
    await assert.rejects(recordIngressCreatedThread(path,"original",8n,"created",3),/generation-bound/);
    await recordIngressCreatedThread(path,"original",7n,"created",3);const record=await read(path);assert.equal(record.phase,"thread/created");assert.equal(record.targetThreadId,"created");
    await assert.rejects(recordIngressCreatedThread(path,"original",7n,"other",4),/generation-bound/);
  });
  await storeFixture(async path=>{await admitIngress(path,request({payload:{command:"ask"}}));await assert.rejects(beginIngressThreadStart(path,"original",1n,2),/original New input/);assert.equal((await read(path)).state,"staged");});
});
test("new attachments must have durable prepared input before thread-start claim",async()=>{
  await storeFixture(async path=>{const r=request();(r.payload as Record<string,unknown>).attachments=[{id:"attachment"}];await admitIngress(path,r);await beginIngressExecution(path,"original","processing",null,2);
    await assert.rejects(beginIngressThreadStart(path,"original",1n,3),/no durable prepared input/);
    await recordNewInput(path,"original","hello","prepared hello",3);assert.equal(await beginIngressThreadStart(path,"original",1n,4),true);
  });
});
test("recorded result preserves original stop and new creation evidence over caller replacements",async()=>{
  await storeFixture(async path=>{await admitIngress(path,request());await edit(path,db=>db.exec(`UPDATE discord_ingress_journal SET state='executing',phase='stop_accepted',outcome_json='{"accepted":true,"new_creation":{"version":1},"new_verification":null,"new_input":{"prompt":"original"}}'`));
    const supplied={answer:"done",stop_receipt:"replace",new_creation:"replace",new_verification:"replace",new_input:"replace"};const pending=recordIngressResult(path,"original",supplied,3);supplied.answer="mutated";await pending;
    const result=await read(path);assert.equal(result.state,"completed");assert.equal(result.phase,"result_recorded");assert.equal(getOwn(result.outcome,"answer"),"done");assert.equal(getOwn(getOwn(result.outcome,"stop_receipt"),"accepted"),true);assert.deepEqual(getOwn(result.outcome,"new_creation"),{version:1n});assert.equal(getOwn(result.outcome,"new_verification"),null);assert.deepEqual(getOwn(result.outcome,"new_input"),{prompt:"original"});
    await recordIngressResult(path,"original",{answer:"again"},4);assert.equal(getOwn(getOwn((await read(path)).outcome,"stop_receipt"),"accepted"),true);
  });
});
test("missing stop evidence and primitive outcomes cannot discard original evidence",async()=>{
  for(const old of ["null",'{"new_creation":{}}'])await storeFixture(async path=>{await admitIngress(path,request());await edit(path,db=>db.prepare("UPDATE discord_ingress_journal SET state='executing',phase=?,outcome_json=?").run(old==="null"?"stop_accepted":"processing",old));
    await assert.rejects(recordIngressResult(path,"original","primitive",3),/evidence/);assert.equal((await read(path)).state,"executing");
  });
});
test("owned result remains owned, held records refuse results, original cancellation wins",async()=>{
  await storeFixture(async path=>{await admitIngress(path,request());await edit(path,db=>db.exec("UPDATE discord_ingress_journal SET state='owned',owner_kind='prompt',owner_id='job'"));await recordIngressResult(path,"original",{ok:true},2);assert.equal((await read(path)).state,"owned");
    await edit(path,db=>db.exec("UPDATE discord_ingress_journal SET state='held'"));await assert.rejects(recordIngressResult(path,"original",{ok:false},3),/cannot be recorded/);assert.deepEqual((await read(path)).outcome,{ok:true});
    await edit(path,db=>db.exec("UPDATE discord_ingress_journal SET state='owned',phase='cancelled'; INSERT INTO codex_request_cancellations VALUES ('job','target',1,2,3,3)"));
    await assert.rejects(recordIngressResult(path,"original",{ok:false},4),RequestCancelledError);assert.deepEqual((await read(path)).outcome,{ok:true});
  });
});
test("confirmation retry is bounded to canonical prompt duplicate ownership",async()=>{
  await storeFixture(async path=>{await admitIngress(path,request());assert.equal(await beginIngressConfirmation(path,"original",2),false);await edit(path,db=>db.exec("UPDATE discord_ingress_journal SET state='owned',phase='canonical_duplicate',owner_kind='prompt',owner_id='job'"));assert.equal(await beginIngressConfirmation(path,"original",3),true);assert.equal(await beginIngressConfirmation(path,"original",4),false);});
});
test("first reply confirmation requires acknowledgement except for internal action",async()=>{
  for(const kind of ["message","action"] as const)await storeFixture(async path=>{await admitIngress(path,request({kind}));await recordIngressResult(path,"original",{ok:true},2);
    const identity={ingress_id:"original",job_id:"job",thread_id:"target",cwd:"C:/work",state_db:"C:/state.db",channel_id:1n,origin_channel_id:1n,event_id:3n,kind,creation_generation:1n,prompt_sha256:"a".repeat(64),acknowledgement:"ready"};
    await edit(path,db=>db.prepare("INSERT INTO codex_new_first_replies(job_id,ingress_id,identity_json) VALUES ('job','original',?)").run(serializeSerdeValue(identity)));
    if(kind==="message"){await assert.rejects(confirmIngress(path,"original",3),/acknowledgement receipt/);assert.equal((await read(path)).confirmationDelivered,false);await edit(path,db=>db.exec("UPDATE codex_new_first_replies SET confirmation_delivered=1"));}
    await confirmIngress(path,"original",4);assert.equal((await read(path)).confirmationDelivered,true);
  });
});
test("processing mode is only writable while staged and confirmation needs an outcome",async()=>{
  await storeFixture(async path=>{await admitIngress(path,request());await assert.rejects(confirmIngress(path,"original",2),/has no outcome/);await recordIngressProcessingMode(path,"original","mode-a");await recordIngressProcessingMode(path,"original","mode-b");assert.equal(getOwn((await read(path)).payload,"processing_mode"),"mode-b");await acknowledgeIngress(path,"original",3);await assert.rejects(recordIngressProcessingMode(path,"original","late"),/already frozen/);assert.equal(getOwn((await read(path)).payload,"processing_mode"),"mode-b");});
});
