import assert from "node:assert/strict";
import { test } from "node:test";
import { storeFixture } from "../helpers/store-fixture.ts";
import { queueJob } from "../helpers/queue-job.ts";
import { StateAccessFacade as state } from "../../src/store/state-access-facade.ts";
import { holdStartingForAmbiguousCandidatesIfClaimed } from "../../src/store/queue-claims.ts";
import { openInitialized } from "../../src/store/owned-driver.ts";
import { STARTING_CANDIDATE_HOLD_PREFIX } from "../../src/store/queue-read.ts";
import { listPendingDeliveries, completeDelivery } from "../../src/store/delivery.ts";

test("ambiguous hold deduplicates/sorts candidates and atomically stages one bounded notice",async()=>{
  await storeFixture(async path=>{
    await state.enqueue(path,queueJob());const claimed=(await state.tryBeginAttempt(path,"saved",[],1n))!;
    const held=await holdStartingForAmbiguousCandidatesIfClaimed(path,claimed,["z","a","a"]);
    assert.equal(held?.state,"Starting");assert.equal(held?.turnId,null);
    assert.equal(held?.lastError,STARTING_CANDIDATE_HOLD_PREFIX+'candidate_count=2; candidate_turn_ids=["a","z"]; candidate_ids_listed=2');
    const notices=await listPendingDeliveries(path);assert.equal(notices.length,1);
    assert.equal(notices[0]!.deliveryId,"turn-start-candidates-ambiguous:saved");
    assert.match(notices[0]!.content,/count=2, listed=2 \["a","z"\]/);
    assert.equal(await holdStartingForAmbiguousCandidatesIfClaimed(path,claimed,["new"]),null);
  });
});
test("held refresh changes only pending notice and never recreates consumed notification",async()=>{
  await storeFixture(async path=>{
    await state.enqueue(path,queueJob());const claimed=(await state.tryBeginAttempt(path,"saved",[],1n))!;
    const held=(await holdStartingForAmbiguousCandidatesIfClaimed(path,claimed,["a","b"]))!;
    const refreshed=(await holdStartingForAmbiguousCandidatesIfClaimed(path,held,["c","d","e"]))!;
    assert.equal(refreshed.lastError,held.lastError);assert.equal(refreshed.updatedAt,held.updatedAt);
    assert.match((await listPendingDeliveries(path))[0]!.content,/count=3/);
    await completeDelivery(path,"turn-start-candidates-ambiguous:saved");
    assert.notEqual(await holdStartingForAmbiguousCandidatesIfClaimed(path,refreshed,["f","g"]),null);
    assert.deepEqual(await listPendingDeliveries(path),[]);
  });
});
test("bounded marker and notice count Unicode scalars and sort UTF-8 rather than UTF-16",async()=>{
  await storeFixture(async path=>{
    await state.enqueue(path,queueJob());const claimed=(await state.tryBeginAttempt(path,"saved",[],1n))!;
    const ids=["😀".repeat(130),"\ue000",...Array.from({length:10},(_,i)=>"x"+i)];
    const held=(await holdStartingForAmbiguousCandidatesIfClaimed(path,claimed,ids))!;
    assert.match(held.lastError,/candidate_count=12/);assert.match(held.lastError,/candidate_ids_listed=4/);
    assert.ok([...held.lastError].length<=1000);
    const notice=(await listPendingDeliveries(path))[0]!.content;assert.match(notice,/listed=8/);assert.ok([...notice].length<=1900);
    // A separate two-ID snapshot proves the supplementary character sorts after U+E000.
    const refreshed=await holdStartingForAmbiguousCandidatesIfClaimed(path,held,["😀","\ue000"]);
    assert.notEqual(refreshed,null);assert.ok((await listPendingDeliveries(path))[0]!.content.endsWith('["\ue000","😀"]'));
  });
});
test("notice insertion failure rolls back the hold rather than losing the user's warning",async()=>{
  await storeFixture(async path=>{
    await state.enqueue(path,queueJob());const claimed=(await state.tryBeginAttempt(path,"saved",[],1n))!;
    const db=await openInitialized(path);try{db.exec("CREATE TRIGGER reject_notice BEFORE INSERT ON codex_delivery_outbox BEGIN SELECT RAISE(ABORT,'notice failed'); END");}finally{db.close();}
    await assert.rejects(()=>holdStartingForAmbiguousCandidatesIfClaimed(path,claimed,["a","b"]),/notice failed/);
    const unchanged=(await state.listFiltered(path,"target",null))[0]!;assert.equal(unchanged.lastError,claimed.lastError);assert.equal(unchanged.updatedAt,claimed.updatedAt);
  });
});
