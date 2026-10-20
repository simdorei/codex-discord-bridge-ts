import assert from "node:assert/strict";
import {test} from "node:test";
import {storeFixture} from "../helpers/store-fixture.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {admitBusyQueue as initializedAdmission,admitBusyQueueExisting} from "../../src/store/prompt-intake-busy.ts";
import {serializeBusyChoice,BusyChoiceUnavailableError,mirroredThreadIdIn,type BusyChoice} from "../../src/store/busy-choice.ts";
import {admitPromptIntake} from "../../src/store/prompt-intake-write.ts";
import {getPromptIntake} from "../../src/store/prompt-intake.ts";
import {getIngress} from "../../src/store/ingress-read.ts";
import {admitBusyInteraction} from "../../src/store/ingress-busy.ts";
import {recordIngressResult,confirmIngress} from "../../src/store/ingress-lifecycle.ts";
import {recoverPriorRuntimeIngress} from "../../src/store/ingress-recovery.ts";
import {finalDeliveryPreflight} from "../../src/store/delivery-preflight.ts";
const choice=():BusyChoice=>({choiceId:"choice",ownerUserId:2n,channelId:1n,targetThreadId:"target",prompt:"raw",allowSteer:false,createdAt:1,expiresAt:100});
async function sql(path:string,value:string):Promise<void>{const db=await openInitialized(path);try{db.exec(value);}finally{db.close();}}
async function seed(path:string,mode="0"):Promise<void>{await sql(path,`INSERT INTO busy_choices(choice_id,owner_user_id,channel_id,target_thread_id,prompt,allow_steer,created_at,expires_at,claimed_at,require_current_mirror)
  VALUES ('choice',2,1,'target','raw',0,1,100,NULL,${mode});
  INSERT INTO discord_ingress_journal(ingress_id,kind,event_id,channel_id,owner_user_id,payload_json,state,phase,canonical_owner,created_at,updated_at)
  VALUES ('i','interaction',3,1,2,'{}','executing','processing','busy-choice:choice',0,0);`);}
async function state(path:string){const db=await openInitialized(path);try{return {claimed:db.prepare("SELECT claimed_at FROM busy_choices WHERE choice_id='choice'").get()?.claimed_at,receipts:db.prepare("SELECT count(*) AS n FROM persistent_component_claims").get()?.n};}finally{db.close();}}
for(const existing of [false,true]){
const admitBusyQueue:typeof initializedAdmission=async(...args)=>(existing?admitBusyQueueExisting:initializedAdmission)(...args);
test("busy admission preserves typed receipt field order and saves custody before returning preparation authority",async()=>{
  assert.equal(serializeBusyChoice(choice()),'{"choice_id":"choice","owner_user_id":2,"channel_id":1,"target_thread_id":"target","prompt":"raw","allow_steer":false,"created_at":1.0,"expires_at":100.0}');
  await storeFixture(async path=>{await seed(path);const result=await admitBusyQueue(path,choice(),"target",false,"confirmation",10);
    assert.equal(result.jobId,"busy-choice:choice");assert.equal(result.intake?.rawPrompt,"raw");assert.equal((await getIngress(path,"i"))?.ownerId,result.jobId);
    const db=await openInitialized(path);try{assert.equal(db.prepare("SELECT expires_at FROM persistent_component_claims").get()?.expires_at,1810);assert.equal(db.prepare("SELECT payload_json FROM discord_ingress_owner_receipts").get()?.payload_json,serializeBusyChoice(choice()));}finally{db.close();}
  });
});
test("repeated acceptance uses durable receipt even after choice and intake removal without replay",async()=>{
  await storeFixture(async path=>{await seed(path);const first=await admitBusyQueue(path,choice(),"target",false,"confirmation",10);assert.ok(first.intake);
    await sql(path,"DELETE FROM busy_choices; DELETE FROM codex_prompt_intakes; INSERT INTO mirror_threads VALUES ('moved','p','t',9,1,0)");
    const repeated=await admitBusyQueue(path,choice(),"target",false,"confirmation",20);assert.equal(repeated.intake,null);assert.equal(repeated.jobId,first.jobId);
    assert.equal(await getPromptIntake(path,first.jobId),null);
  });
});

for(const restartBeforeQueue of [false,true])test(`queue after an undispatched busy rejection preserves final delivery across restart (${restartBeforeQueue})`,async()=>{
  await storeFixture(async path=>{await seed(path);
    await sql(path,"DELETE FROM discord_ingress_journal");
    await admitBusyInteraction(path,{ingressId:"i",kind:"interaction",eventId:3n,applicationId:5n,channelId:1n,ownerUserId:2n,sourceMessageId:null,payload:{version:1n},targetThreadId:null,canonicalOwner:null,now:1},"choice","steer");
    await recordIngressResult(path,"i",{kind:"busy_control_preflight_rejected",control_dispatched:false},1);
    if(restartBeforeQueue)await recoverPriorRuntimeIngress(path,"restarted",1.5);
    const rejected=await getIngress(path,"i");
    const next=await admitBusyInteraction(path,{ingressId:"accepted",kind:"interaction",eventId:4n,applicationId:5n,channelId:1n,ownerUserId:2n,sourceMessageId:null,payload:{version:1n},targetThreadId:null,canonicalOwner:null,now:2},"choice","queue");
    assert.equal(next.created,true);
    const admitted=await admitBusyQueue(path,choice(),"target",false,"confirmation",3);assert.ok(admitted.intake);
    assert.deepEqual(await getIngress(path,"i"),rejected);
    assert.equal((await getIngress(path,"accepted"))?.ownerId,admitted.jobId);
    const final={deliveryId:admitted.jobId,jobId:admitted.jobId,targetThreadId:"target",turnId:"turn",channelId:1n,content:"Final response",attemptCount:0n,lastError:"",createdAt:4,updatedAt:4};
    assert.deepEqual(finalDeliveryPreflight(path,final),{kind:"FirstReply",request:"accepted"});
    await recordIngressResult(path,"accepted",{kind:"component",action_completed:true},4);await confirmIngress(path,"accepted",5);
    assert.deepEqual(finalDeliveryPreflight(path,final),{kind:"Ready"});
    await recoverPriorRuntimeIngress(path,"restarted-again",5.5);
    const recovered=await getIngress(path,"i");assert.equal(recovered?.state,"held");assert.equal(recovered?.ownerId,null);
    const repeated=await admitBusyQueue(path,choice(),"target",false,"confirmation",6);assert.equal(repeated.intake,null);
    assert.deepEqual(await getIngress(path,"i"),recovered);
    assert.deepEqual(finalDeliveryPreflight(path,final),{kind:"Ready"});
  });
});

test("busy ownership keeps the first-reply barrier without an exact terminal undispatched rejection",async()=>{
  for(const held of [false,true])for(const outcome of [null,{}, {kind:"other",control_dispatched:false},{kind:"busy_control_preflight_rejected",control_dispatched:true},{kind:"busy_control_preflight_rejected",control_dispatched:"false"}]){
    await storeFixture(async path=>{await seed(path);await recordIngressResult(path,"i",outcome,1);
      if(held)await recoverPriorRuntimeIngress(path,"restarted",2);
      const admitted=await admitBusyQueue(path,choice(),"target",false,"confirmation",3);
      assert.equal((await getIngress(path,"i"))?.ownerId,admitted.jobId);
      assert.deepEqual(finalDeliveryPreflight(path,{deliveryId:admitted.jobId,jobId:admitted.jobId,targetThreadId:"target",turnId:"turn",channelId:1n,content:"Final response",attemptCount:0n,lastError:"",createdAt:4,updatedAt:4}),{kind:"FirstReply",request:"i"});
    });
  }
});
test("changed displayed choice, expired choice, unknown route and route mode mismatch do not claim",async()=>{
  for(const variant of ["prompt","expires","unknown","mode"]){await storeFixture(async path=>{await seed(path,variant==="unknown"?"NULL":"0");const c=choice();if(variant==="prompt")c.prompt="changed";
    await assert.rejects(()=>admitBusyQueue(path,c,"target",variant==="mode","confirmation",variant==="expires"?100:10),/unavailable|expired, changed|route mode changed/);
    assert.deepEqual(await state(path),{claimed:null,receipts:0});assert.equal(await getPromptIntake(path,"busy-choice:choice"),null);
  });}
});
test("a changed mirror route or ambiguous room refuses admission, project fallback remains source-compatible",async()=>{
  await storeFixture(async path=>{await seed(path,"1");await sql(path,"INSERT INTO mirror_threads VALUES ('other','p','t',9,1,0)");
    await assert.rejects(()=>admitBusyQueue(path,choice(),"target",true,"confirmation",10),/original busy prompt route changed/);
    await sql(path,"INSERT INTO mirror_threads VALUES ('target','p','t',9,1,0)");await assert.rejects(()=>admitBusyQueue(path,choice(),"target",true,"confirmation",10),/multiple Codex threads/);
  });
  await storeFixture(async path=>{await seed(path,"1");await sql(path,"INSERT INTO mirror_threads VALUES ('target','p','t',1,9,0)");
    assert.ok((await admitBusyQueue(path,choice(),"target",true,"confirmation",10)).intake);
    const db=await openInitialized(path);try{assert.equal(mirroredThreadIdIn(db,0n),null);assert.equal(mirroredThreadIdIn(db,null),null);}finally{db.close();}
  });
});
test("intake without acceptance receipt and downstream owner failure roll back the exact choice claim",async()=>{
  await storeFixture(async path=>{await seed(path);await admitPromptIntake(path,{jobId:"busy-choice:choice",targetThreadId:"target",channelId:1n,ownerUserId:2n,discordMessageId:null,rawPrompt:"raw",autoQueueWhenBusy:true,requireCurrentMirror:false,createdAt:1});
    await assert.rejects(()=>admitBusyQueue(path,choice(),"target",false,"confirmation",10),/without an acceptance receipt/);assert.deepEqual(await state(path),{claimed:null,receipts:0});
  });
  await storeFixture(async path=>{await seed(path);await sql(path,"CREATE TRIGGER refuse_receipt BEFORE INSERT ON discord_ingress_owner_receipts BEGIN SELECT RAISE(ABORT,'receipt failure'); END");
    await assert.rejects(()=>admitBusyQueue(path,choice(),"target",false,"confirmation",10),/receipt failure/);assert.deepEqual(await state(path),{claimed:null,receipts:0});assert.equal(await getPromptIntake(path,"busy-choice:choice"),null);
  });
});
test("only one concurrent acceptance may prepare; copied input survives caller mutation",async()=>{
  await storeFixture(async path=>{await seed(path);const c=choice();const pending=admitBusyQueue(path,c,"target",false,"confirmation",10);c.prompt="changed";c.ownerUserId=9n;
    const other=admitBusyQueue(path,choice(),"target",false,"confirmation",10);const results=await Promise.all([pending,other]);assert.equal(results.filter(r=>r.intake!==null).length,1);
  });
});
test("invalid admission values reject before custody mutation",async()=>{
  await storeFixture(async path=>{await seed(path);for(const now of [NaN,Infinity,-1])await assert.rejects(()=>admitBusyQueue(path,choice(),"target",false,"confirmation",now),/invalid busy queue admission/);
    await assert.rejects(()=>admitBusyQueue(path,choice(),"target",false,"",10),/invalid busy queue admission/);
    await assert.rejects(()=>admitBusyQueue(path,choice(),"wrong",false,"confirmation",10),BusyChoiceUnavailableError);assert.deepEqual(await state(path),{claimed:null,receipts:0});
  });
});

}
