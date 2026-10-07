import assert from "node:assert/strict";
import {test} from "node:test";
import {storeFixture} from "../helpers/store-fixture.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {admitPromptIntake,PromptIntakeClaimLostError,PromptIntakeIdentityConflictError,type NewPromptIntake} from "../../src/store/prompt-intake-write.ts";
import {getPromptIntake,tryClaimPromptIntake,renewPromptIntakeClaimIfCurrent,promptIntakeHasDurableOwner} from "../../src/store/prompt-intake.ts";
import {promotePromptIntakeToQueue} from "../../src/store/prompt-intake-promotion.ts";
import {enqueue,type NewQueueJob} from "../../src/store/queue-enqueue.ts";
import {getIngress} from "../../src/store/ingress-read.ts";
const input=(patch:Partial<NewPromptIntake>={}):NewPromptIntake=>({jobId:"job",targetThreadId:"target",channelId:1n,ownerUserId:2n,discordMessageId:3n,rawPrompt:"raw",autoQueueWhenBusy:true,requireCurrentMirror:false,createdAt:1,...patch});
const job=(patch:Partial<NewQueueJob>={}):NewQueueJob=>({jobId:"job",targetThreadId:"target",channelId:1n,ownerUserId:2n,discordMessageId:3n,appServerGeneration:1n,prompt:"enriched",queued:true,ackSent:false,createdAt:12,...patch});
async function sql(path:string,statement:string):Promise<void>{const db=await openInitialized(path);try{db.exec(statement);}finally{db.close();}}
async function claimed(path:string,patch:Partial<NewPromptIntake>={}){await admitPromptIntake(path,input(patch));const claim=await tryClaimPromptIntake(path,"job",10,20);assert.ok(claim);return claim;}
async function queueCount(path:string):Promise<number>{const db=await openInitialized(path);try{return Number(db.prepare("SELECT count(*) AS n FROM codex_turn_queue").get()?.n);}finally{db.close();}}
test("promotion atomically accepts enriched prompt and a renewed lease held by an older snapshot",async()=>{
  await storeFixture(async path=>{const claim=await claimed(path);assert.ok(await renewPromptIntakeClaimIfCurrent(path,claim,11,40));
    const result=await promotePromptIntakeToQueue(path,claim,job(),25);assert.equal(result.created,true);assert.equal(result.job.prompt,"enriched");
    assert.equal(await getPromptIntake(path,"job"),null);assert.equal(await promptIntakeHasDurableOwner(path,"job"),true);
    await assert.rejects(()=>promotePromptIntakeToQueue(path,claim,job(),26),PromptIntakeClaimLostError);assert.equal(await queueCount(path),1);
  });
});
test("stale token, expired lease and altered stable intake snapshot cannot promote",async()=>{
  for(const variant of ["token","expiry","raw"]){await storeFixture(async path=>{const claim=await claimed(path);
    if(variant==="token")claim.claimToken="forged";if(variant==="raw")claim.intake.rawPrompt="forged";
    await assert.rejects(()=>promotePromptIntakeToQueue(path,claim,job(),variant==="expiry"?20:12),PromptIntakeClaimLostError);
    assert.equal(await queueCount(path),0);assert.ok(await getPromptIntake(path,"job"));
  });}
});
test("queue identity conflict and already queued different prompt leave the lease intact",async()=>{
  await storeFixture(async path=>{const claim=await claimed(path);
    await assert.rejects(()=>promotePromptIntakeToQueue(path,claim,job({ownerUserId:9n}),12),PromptIntakeIdentityConflictError);
    await enqueue(path,job({prompt:"different"}));
    await assert.rejects(()=>promotePromptIntakeToQueue(path,claim,job(),12),PromptIntakeIdentityConflictError);
    assert.ok(await getPromptIntake(path,"job"));assert.equal(await queueCount(path),1);
  });
});
test("already queued exact occurrence transfers intake without replacing generation or flags",async()=>{
  await storeFixture(async path=>{const claim=await claimed(path);await enqueue(path,job({appServerGeneration:8n,ackSent:true}));
    const result=await promotePromptIntakeToQueue(path,claim,job(),12);assert.equal(result.created,false);assert.equal(result.job.appServerGeneration,8n);assert.equal(result.job.ackSent,true);
    assert.equal(await getPromptIntake(path,"job"),null);
  });
});
test("direct target changes reject, mirror mode permits only the current exact mapping",async()=>{
  await storeFixture(async path=>{const claim=await claimed(path);await assert.rejects(()=>promotePromptIntakeToQueue(path,claim,job({targetThreadId:"other"}),12),/moved/);assert.equal(await queueCount(path),0);});
  await storeFixture(async path=>{const claim=await claimed(path,{requireCurrentMirror:true});await assert.rejects(()=>promotePromptIntakeToQueue(path,claim,job({targetThreadId:"other"}),12),/mirror mapping changed/);
    await sql(path,"INSERT INTO mirror_threads VALUES ('other','project','title',9,1,0)");
    assert.equal((await promotePromptIntakeToQueue(path,claim,job({targetThreadId:"other"}),12)).job.targetThreadId,"other");
  });
});
test("failed final lease deletion rolls back queue insertion and preserves original owner",async()=>{
  await storeFixture(async path=>{const claim=await claimed(path);
    await sql(path,"CREATE TRIGGER refuse_intake_delete BEFORE DELETE ON codex_prompt_intakes BEGIN SELECT RAISE(IGNORE); END");
    await assert.rejects(()=>promotePromptIntakeToQueue(path,claim,job(),12),PromptIntakeClaimLostError);
    assert.equal(await queueCount(path),0);assert.equal((await getPromptIntake(path,"job"))?.claimToken,claim.claimToken);
  });
});
test("new evidence conflict rolls back insertion; accepted evidence shares the queue transaction",async()=>{
  await storeFixture(async path=>{
    await sql(path,`INSERT INTO discord_ingress_journal(ingress_id,kind,event_id,channel_id,owner_user_id,payload_json,state,phase,target_thread_id,created_at,updated_at)
      VALUES ('i','action',3,1,2,'{"command":"new","prompt":"raw"}','executing','processing','target',0,0)`);
    const claim=await claimed(path);
    await sql(path,`UPDATE discord_ingress_journal SET outcome_json='{"new_verification":null}'`);
    await assert.rejects(()=>promotePromptIntakeToQueue(path,claim,job(),12),/prepared input evidence changed/);
    assert.equal(await queueCount(path),0);assert.ok(await getPromptIntake(path,"job"));
    await sql(path,"UPDATE discord_ingress_journal SET outcome_json=NULL");
    await promotePromptIntakeToQueue(path,claim,job(),12);
    const outcome=(await getIngress(path,"i"))?.outcome as {new_verification:{thread_id:string;channel_id:bigint;prompt_sha256:string}};
    assert.equal(outcome.new_verification.thread_id,"target");assert.equal(outcome.new_verification.channel_id,1n);assert.match(outcome.new_verification.prompt_sha256,/^[a-f0-9]{64}$/);
  });
});
test("caller mutation after async invocation cannot replace snapshotted claim or prepared queue prompt",async()=>{
  await storeFixture(async path=>{const claim=await claimed(path),prepared=job();const pending=promotePromptIntakeToQueue(path,claim,prepared,12);
    claim.intake.rawPrompt="changed";claim.claimToken="changed";prepared.prompt="changed";prepared.ownerUserId=9n;
    assert.equal((await pending).job.prompt,"enriched");
  });
});
