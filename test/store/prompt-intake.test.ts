import assert from "node:assert/strict";
import {test} from "node:test";
import {storeFixture} from "../helpers/store-fixture.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {getPromptIntake,listPromptIntakes,promptIntakeHasDurableOwner,tryClaimPromptIntake,renewPromptIntakeClaimIfCurrent,
  recordPromptIntakeFailureIfClaimed,releaseAllPromptIntakeClaims,InvalidPromptIntakeLeaseError,InvalidPromptIntakeRetryError} from "../../src/store/prompt-intake.ts";
async function seed(path:string,extra=""):Promise<void>{const db=await openInitialized(path);try{
  db.exec("INSERT INTO codex_prompt_intakes(job_id,target_thread_id,channel_id,owner_user_id,discord_message_id,raw_prompt,auto_queue_when_busy,require_current_mirror,created_at,updated_at) VALUES ('intake','target',9007199254740993,2,3,'prompt',1,0,1,1)");if(extra)db.exec(extra);
}finally{db.close();}}
test("intake reads preserve 64-bit identity and filter both retry and lease deadlines",async()=>{
  await storeFixture(async path=>{await seed(path,"UPDATE codex_prompt_intakes SET retry_after=10,claim_expires_at=20");
    assert.equal((await getPromptIntake(path,"intake"))?.channelId,9007199254740993n);assert.equal((await listPromptIntakes(path)).length,1);
    assert.equal((await listPromptIntakes(path,19.999)).length,0);assert.equal((await listPromptIntakes(path,20)).length,1);
    assert.equal(await getPromptIntake(path,"missing"),null);
  });
});
test("concurrent claim admits one owner, expiration permits a new token and stale renewals fail",async()=>{
  await storeFixture(async path=>{await seed(path);
    const claims=await Promise.all([tryClaimPromptIntake(path,"intake",10,20),tryClaimPromptIntake(path,"intake",10,20)]);
    assert.equal(claims.filter(Boolean).length,1);const claim=claims.find(c=>c!==null)!;
    assert.equal(await renewPromptIntakeClaimIfCurrent(path,claim,11,20),null);
    const renewed=await renewPromptIntakeClaimIfCurrent(path,claim,11,30);assert.ok(renewed);assert.equal(renewed.claimToken,claim.claimToken);
    assert.equal(await tryClaimPromptIntake(path,"intake",29.999,40),null);
    const next=await tryClaimPromptIntake(path,"intake",30,40);assert.ok(next);assert.notEqual(next.claimToken,claim.claimToken);
    assert.equal(await renewPromptIntakeClaimIfCurrent(path,claim,31,50),null);
    assert.equal(await recordPromptIntakeFailureIfClaimed(path,claim,"stale",60),null);
  });
});
test("failure clears only its token, preserves fork fencing and saturates attempt count",async()=>{
  await storeFixture(async path=>{await seed(path,"UPDATE codex_prompt_intakes SET attempt_count=9223372036854775807,last_error='[cdr-rust:app-server-fork-unresolved:v1] original'");
    const claim=await tryClaimPromptIntake(path,"intake",10,20);assert.ok(claim);
    const failed=await recordPromptIntakeFailureIfClaimed(path,claim,"new error",30);assert.ok(failed);
    assert.equal(failed.attemptCount,9223372036854775807n);assert.equal(failed.lastError,"[cdr-rust:app-server-fork-unresolved:v1] original");assert.equal(failed.claimToken,null);
    assert.equal(await tryClaimPromptIntake(path,"intake",29,40),null);assert.notEqual(await tryClaimPromptIntake(path,"intake",30,40),null);
  });
});
test("blank intake errors get fallback text and scalar bounding, invalid leases/retries reject",async()=>{
  await storeFixture(async path=>{await seed(path);const claim=await tryClaimPromptIntake(path,"intake",10,20);assert.ok(claim);
    await assert.rejects(()=>recordPromptIntakeFailureIfClaimed(path,claim,"error",Infinity),InvalidPromptIntakeRetryError);
    const failed=await recordPromptIntakeFailureIfClaimed(path,claim,"\u0085 ",0);assert.equal(failed?.lastError,"prompt intake processing failed without an error message");
    for(const [now,end]of [[10,10],[NaN,20],[10,Infinity]])await assert.rejects(()=>tryClaimPromptIntake(path,"intake",now!,end!),InvalidPromptIntakeLeaseError);
    const next=await tryClaimPromptIntake(path,"intake",20,30);assert.ok(next);
    assert.equal((await recordPromptIntakeFailureIfClaimed(path,next,"😀".repeat(1001),0))?.lastError,"😀".repeat(1000));
  });
});
test("execution hold prevents claim and startup-only lease release does not remove intake",async()=>{
  await storeFixture(async path=>{await seed(path,"INSERT INTO cdr_execution_holds VALUES ('intake','target','held','{}',0)");
    assert.equal(await tryClaimPromptIntake(path,"intake",10,20),null);
    const db=await openInitialized(path);try{db.exec("DELETE FROM cdr_execution_holds; UPDATE codex_prompt_intakes SET claim_token='old',claim_expires_at=99");}finally{db.close();}
    assert.equal(await releaseAllPromptIntakeClaims(path),1n);assert.equal(await releaseAllPromptIntakeClaims(path),0n);
    assert.notEqual(await getPromptIntake(path,"intake"),null);
  });
});
test("durable owner requires intake removal and a matching queue/outbox occurrence",async()=>{
  await storeFixture(async path=>{await seed(path);assert.equal(await promptIntakeHasDurableOwner(path,"intake"),false);
    const db=await openInitialized(path);try{db.exec("INSERT INTO codex_delivery_outbox(delivery_id,job_id,target_thread_id,turn_id,channel_id,content,created_at,updated_at) VALUES ('delivery','intake','target','turn',1,'final',0,0)");}finally{db.close();}
    assert.equal(await promptIntakeHasDurableOwner(path,"intake"),false);
    const edit=await openInitialized(path);try{edit.exec("DELETE FROM codex_prompt_intakes");}finally{edit.close();}
    assert.equal(await promptIntakeHasDurableOwner(path,"intake"),true);assert.equal(await promptIntakeHasDurableOwner(path,"other"),false);
  });
});
