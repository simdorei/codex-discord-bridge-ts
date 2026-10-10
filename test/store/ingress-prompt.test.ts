import assert from "node:assert/strict";
import {test} from "node:test";
import {createHash} from "node:crypto";
import {storeFixture} from "../helpers/store-fixture.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {getIngressIn,ingressByOriginIn,getIngress} from "../../src/store/ingress-read.ts";
import {newCommandPrompt,newExecutionPrompt,frozenSlashTarget,recordNewInput} from "../../src/store/ingress-new-input.ts";
import {admitPromptIntake,type NewPromptIntake} from "../../src/store/prompt-intake-write.ts";
import {getPromptIntake} from "../../src/store/prompt-intake.ts";
const intake=(overrides:Partial<NewPromptIntake>={}):NewPromptIntake=>({jobId:"job",targetThreadId:"target",channelId:1n,ownerUserId:2n,discordMessageId:3n,rawPrompt:"raw",autoQueueWhenBusy:true,requireCurrentMirror:false,createdAt:1,...overrides});
const envelope=()=>({version:1,plan:{Execute:{New:{prompt:"raw"}}},attachments:[{id:"a"}]});
async function seed(path:string,payload:unknown=envelope(),kind="message",phase="processing"):Promise<void>{const db=await openInitialized(path);try{
  db.prepare("INSERT INTO discord_ingress_journal(ingress_id,kind,event_id,channel_id,owner_user_id,payload_json,state,phase,target_thread_id,created_at,updated_at) VALUES ('i',?,3,1,2,?,'executing',?,'target',0,0)").run(kind,JSON.stringify(payload),phase);
}finally{db.close();}}
test("attachment preparation preserves original envelope and exact UTF-8 fingerprint",async()=>{
  await storeFixture(async path=>{await seed(path);const before=await getIngress(path,"i");assert.ok(before);assert.throws(()=>newExecutionPrompt(before),/no durable prepared input/);
    await recordNewInput(path,"i","raw","prepared",5);const after=await getIngress(path,"i");assert.ok(after);
    assert.deepEqual(after.payload,before.payload);assert.equal(newExecutionPrompt(after),"prepared");
    const out=after.outcome as {new_input:{source_sha256:string}};
    const golden='["i","message",3,1,2,{"attachments":[{"id":"a"}],"plan":{"Execute":{"New":{"prompt":"raw"}}},"version":1}]';
    assert.equal(out.new_input.source_sha256,createHash("sha256").update(golden).digest("hex"));
    await recordNewInput(path,"i","raw","prepared",6);assert.equal((await getIngress(path,"i"))?.updatedAt,5);
    await assert.rejects(()=>recordNewInput(path,"i","raw","different",6),/immutable/);
  });
});
test("attachment source change or late first preparation cannot become executable input",async()=>{
  await storeFixture(async path=>{await seed(path);await recordNewInput(path,"i","raw","prepared",5);
    const db=await openInitialized(path);try{db.prepare("UPDATE discord_ingress_journal SET payload_json=?").run(JSON.stringify({...envelope(),attachments:[{id:"other"}]}));}finally{db.close();}
    const changed=(await getIngress(path,"i"))!;
    assert.throws(()=>newExecutionPrompt(changed),/original envelope changed/);
  });
  await storeFixture(async path=>{await seed(path,envelope(),"message","thread/created");await assert.rejects(()=>recordNewInput(path,"i","raw","prepared",5),/frozen before thread\/start/);});
});
test("transport prompt variants and frozen slash mapping preserve exact Rust trim/version gates",async()=>{
  await storeFixture(async path=>{await seed(path,{version:1,work:{Slash:{name:"new",values:{prompt:{String:"\u0085 raw \u0085"}}}}},"interaction");
    const row=(await getIngress(path,"i"))!;assert.equal(newCommandPrompt(row),"raw");assert.equal(frozenSlashTarget(row),null);
    const ask={...row,payload:{version:1n,work:{Slash:{name:"ask",values:{prompt:{String:"raw"}}}}}};
    assert.equal(frozenSlashTarget(ask),"target");assert.equal(newCommandPrompt(ask),null);
    assert.equal(newCommandPrompt({...row,kind:"action",payload:{command:"new",prompt:" raw "}})," raw ");
    assert.equal(newCommandPrompt({...row,payload:{version:1,work:{Slash:{name:"new",values:{prompt:{String:"raw"}}}}}}),null);
  });
});
test("intake admission links only the matching original actor, rolling back failures",async()=>{
  await storeFixture(async path=>{await seed(path,{command:"ask",prompt:"raw"},"action");
    await assert.rejects(()=>admitPromptIntake(path,intake({ownerUserId:9n})),/handoff identity changed/);assert.equal(await getPromptIntake(path,"job"),null);
    const admitted=await admitPromptIntake(path,intake());assert.equal(admitted.created,true);
    const ingress=await getIngress(path,"i");assert.equal(ingress?.ownerId,"job");assert.equal(ingress?.state,"owned");
    const repeated=await admitPromptIntake(path,intake({jobId:"another",rawPrompt:"must not replace"}));assert.equal(repeated.created,false);assert.equal(repeated.intake.jobId,"job");assert.equal(repeated.intake.rawPrompt,"raw");
  });
});
test("new thread channel change requires prepared exact prompt and durable mirror mapping",async()=>{
  await storeFixture(async path=>{await seed(path);await recordNewInput(path,"i","raw","prepared",5);
    const db=await openInitialized(path);try{db.exec("UPDATE discord_ingress_journal SET phase='thread/created'; INSERT INTO mirror_threads VALUES ('target','project','title',1,10,0)");}finally{db.close();}
    const admitted=await admitPromptIntake(path,intake({channelId:10n,rawPrompt:"prepared"}));assert.equal(admitted.created,true);
    assert.equal((await getIngress(path,"i"))?.channelId,1n);assert.equal(admitted.intake.channelId,10n);
  });
});
test("cross-kind duplicate origin is ambiguous and corrupt outcome text precedes payload JSON decoding",async()=>{
  await storeFixture(async path=>{await seed(path);const db=await openInitialized(path);try{
    db.exec("INSERT INTO discord_ingress_journal(ingress_id,kind,event_id,channel_id,owner_user_id,payload_json,state,phase,created_at,updated_at) VALUES ('other','action',3,1,2,'{}','executing','processing',0,0)");
    assert.throws(()=>ingressByOriginIn(db,3n),/ambiguous ingress origin/);
    db.exec("UPDATE discord_ingress_journal SET payload_json='bad',outcome_json=CAST(x'80' AS TEXT) WHERE ingress_id='i'");
    assert.throws(()=>getIngressIn(db,"i"),/Invalid text encoding in column outcome_json/);
  }finally{db.close();}});
});
