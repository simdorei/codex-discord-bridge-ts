import assert from "node:assert/strict";
import {test} from "node:test";
import {storeFixture} from "../helpers/store-fixture.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {admitPromptIntakeWithIngress,type NewReplySeed} from "../../src/store/prompt-intake-new-thread.ts";
import type {NewPromptIntake} from "../../src/store/prompt-intake-write.ts";
import {getPromptIntake} from "../../src/store/prompt-intake.ts";
import {getIngress} from "../../src/store/ingress-read.ts";
import {containsManagedTargetIn} from "../../src/store/queue-managed-target.ts";
const input=(patch:Partial<NewPromptIntake>={}):NewPromptIntake=>({jobId:"job",targetThreadId:"target",channelId:1n,ownerUserId:2n,discordMessageId:3n,rawPrompt:"raw",autoQueueWhenBusy:true,requireCurrentMirror:false,createdAt:5,...patch});
const reply=():NewReplySeed=>({stateDb:{platform:"windows-utf16",units:[67,58,92,100,98]},acknowledgement:"created"});
async function seed(path:string,outcome:unknown={thread_start_generation:7,new_creation:{version:1}}):Promise<void>{const db=await openInitialized(path);try{
  db.prepare(`INSERT INTO discord_ingress_journal(ingress_id,kind,event_id,channel_id,owner_user_id,payload_json,state,phase,target_thread_id,outcome_json,created_at,updated_at)
    VALUES ('i','action',3,1,2,'{"command":"new","prompt":"raw"}','executing','thread/created','target',?,0,0)`).run(JSON.stringify(outcome));
}finally{db.close();}}
async function managed(path:string):Promise<boolean>{const db=await openInitialized(path);try{return containsManagedTargetIn(db,"target");}finally{db.close();}}
test("new creation atomically records managed generation, first prompt custody and immutable reply seed",async()=>{
  await storeFixture(async path=>{await seed(path);const result=await admitPromptIntakeWithIngress(path,input(),"i",7n,reply());
    assert.equal(result.created,true);assert.equal(await managed(path),true);const saved=await getIngress(path,"i");
    assert.equal(saved?.state,"owned");assert.equal(saved?.phase,"durable_prompt");assert.equal(saved?.ownerId,"job");
    assert.deepEqual((saved?.outcome as {new_reply_seed:unknown}).new_reply_seed,{acknowledgement:"created",state_db:"C:\\db"});
    await assert.rejects(()=>admitPromptIntakeWithIngress(path,input(),"i",7n,reply()),/no matching recorded attempt/);
  });
});
test("wrong generation or exact original prompt identity prevents all custody writes",async()=>{
  for(const variant of ["generation","prompt","actor","event"]){await storeFixture(async path=>{await seed(path);
    const patch=variant==="prompt"?{rawPrompt:"changed"}:variant==="actor"?{ownerUserId:9n}:variant==="event"?{discordMessageId:9n}:{};
    await assert.rejects(()=>admitPromptIntakeWithIngress(path,input(patch),"i",variant==="generation"?8n:7n),/no matching recorded attempt|prompt identity changed/);
    assert.equal(await managed(path),false);assert.equal(await getPromptIntake(path,"job"),null);assert.equal((await getIngress(path,"i"))?.state,"executing");
  });}
});
test("missing acknowledgement creation identity rolls back managed target and admitted intake",async()=>{
  await storeFixture(async path=>{await seed(path,{thread_start_generation:7});
    await assert.rejects(()=>admitPromptIntakeWithIngress(path,input(),"i",7n,reply()),/seed has no unique original owner/);
    assert.equal(await managed(path),false);assert.equal(await getPromptIntake(path,"job"),null);assert.equal((await getIngress(path,"i"))?.ownerId,null);
  });
});
test("creation without reply seed remains supported and caller mutation cannot replace the prepared seed",async()=>{
  await storeFixture(async path=>{await seed(path);await admitPromptIntakeWithIngress(path,input(),"i",7n);assert.ok(await getPromptIntake(path,"job"));});
  await storeFixture(async path=>{await seed(path);const request=input(),r=reply(),units=r.stateDb.units as number[];
    const pending=admitPromptIntakeWithIngress(path,request,"i",7n,r);request.rawPrompt="changed";r.acknowledgement="changed";units[0]=88;
    await pending;assert.deepEqual((await getIngress(path,"i"))?.outcome,{new_creation:{version:1n},new_reply_seed:{acknowledgement:"created",state_db:"C:\\db"},thread_start_generation:7n});
  });
});
test("a trigger-rejected ownership link causes reply seed failure and full rollback",async()=>{
  await storeFixture(async path=>{await seed(path);const db=await openInitialized(path);try{db.exec("CREATE TRIGGER refuse_owner BEFORE UPDATE OF owner_id ON discord_ingress_journal BEGIN SELECT RAISE(IGNORE); END");}finally{db.close();}
    await assert.rejects(()=>admitPromptIntakeWithIngress(path,input(),"i",7n,reply()),/seed has no unique original owner/);
    assert.equal(await managed(path),false);assert.equal(await getPromptIntake(path,"job"),null);
  });
});
