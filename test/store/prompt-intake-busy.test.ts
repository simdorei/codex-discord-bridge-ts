import assert from "node:assert/strict";
import {test} from "node:test";
import {storeFixture} from "../helpers/store-fixture.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {admitBusyQueue} from "../../src/store/prompt-intake-busy.ts";
import {serializeBusyChoice,BusyChoiceUnavailableError,mirroredThreadIdIn,type BusyChoice} from "../../src/store/busy-choice.ts";
import {admitPromptIntake} from "../../src/store/prompt-intake-write.ts";
import {getPromptIntake} from "../../src/store/prompt-intake.ts";
import {getIngress} from "../../src/store/ingress-read.ts";
const choice=():BusyChoice=>({choiceId:"choice",ownerUserId:2n,channelId:1n,targetThreadId:"target",prompt:"raw",allowSteer:false,createdAt:1,expiresAt:100});
async function sql(path:string,value:string):Promise<void>{const db=await openInitialized(path);try{db.exec(value);}finally{db.close();}}
async function seed(path:string,mode="0"):Promise<void>{await sql(path,`INSERT INTO busy_choices(choice_id,owner_user_id,channel_id,target_thread_id,prompt,allow_steer,created_at,expires_at,claimed_at,require_current_mirror)
  VALUES ('choice',2,1,'target','raw',0,1,100,NULL,${mode});
  INSERT INTO discord_ingress_journal(ingress_id,kind,event_id,channel_id,owner_user_id,payload_json,state,phase,canonical_owner,created_at,updated_at)
  VALUES ('i','interaction',3,1,2,'{}','executing','processing','busy-choice:choice',0,0);`);}
async function state(path:string){const db=await openInitialized(path);try{return {claimed:db.prepare("SELECT claimed_at FROM busy_choices WHERE choice_id='choice'").get()?.claimed_at,receipts:db.prepare("SELECT count(*) AS n FROM persistent_component_claims").get()?.n};}finally{db.close();}}
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
