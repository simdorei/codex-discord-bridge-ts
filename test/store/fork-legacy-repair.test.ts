import assert from "node:assert/strict";
import {test} from "node:test";
import {storeFixture} from "../helpers/store-fixture.ts";
import {queueJob} from "../helpers/queue-job.ts";
import {StateAccessFacade as state} from "../../src/store/state-access-facade.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {ensureForkHandoffTable} from "../../src/store/fork-handoff-admission.ts";
import {repairLegacyDefiniteForkFailures} from "../../src/store/fork-legacy-repair.ts";
async function setup(path:string,extra=""):Promise<void>{
  const db=await openInitialized(path);try{
    ensureForkHandoffTable(db);
    db.exec(`INSERT INTO codex_thread_fork_handoffs(handoff_id,source_thread_id,expected_generation,discord_channel_id,discord_thread_id,
      quarantine_reason,last_fork_error,fork_failure_ambiguous,created_at) VALUES ('handoff','target',1,1,1,'reason',' definite failure ',0,0)`);
    if(extra)db.exec(extra);
  }finally{db.close();}
}
test("legacy definite repair preserves pending job and stages its durable notice before retiring handoff",async()=>{
  await storeFixture(async path=>{
    await state.enqueue(path,queueJob());await setup(path);
    const repaired=await repairLegacyDefiniteForkFailures(path);assert.equal(repaired.length,1);assert.equal(repaired[0]!.affectedJobs,1n);
    assert.equal(repaired[0]!.lastForkError,"definite failure");
    const job=(await state.listFiltered(path,"target",null))[0]!;assert.equal(job.state,"Pending");assert.equal(job.appServerGeneration,1n);
    assert.match(job.lastError,/app-server-fork-definite/);assert.equal((await state.listPendingDeliveries(path)).length,1);
    assert.deepEqual(await repairLegacyDefiniteForkFailures(path),[]);
  });
});
test("ambiguous and observed-target handoffs are not selected for definite repair",async()=>{
  for(const extra of ["UPDATE codex_thread_fork_handoffs SET fork_failure_ambiguous=1","UPDATE codex_thread_fork_handoffs SET observed_target_thread_id='observed'"])
    await storeFixture(async path=>{await setup(path,extra);assert.deepEqual(await repairLegacyDefiniteForkFailures(path),[]);
      const db=await openInitialized(path);try{assert.equal(db.prepare("SELECT count(*) AS n FROM codex_thread_fork_handoffs").get()?.n,1);}finally{db.close();}});
});
test("failed legacy notice insertion rolls back queue marker and handoff retirement",async()=>{
  await storeFixture(async path=>{
    await state.enqueue(path,queueJob());await setup(path,"CREATE TRIGGER reject_definite BEFORE INSERT ON codex_delivery_outbox BEGIN SELECT RAISE(ABORT,'notice blocked'); END");
    await assert.rejects(()=>repairLegacyDefiniteForkFailures(path),/notice blocked/);
    assert.equal((await state.listFiltered(path,"target",null))[0]!.lastError,"");
    const db=await openInitialized(path);try{assert.equal(db.prepare("SELECT count(*) AS n FROM codex_thread_fork_handoffs").get()?.n,1);}finally{db.close();}
  });
});
