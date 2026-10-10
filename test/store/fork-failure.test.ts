import assert from "node:assert/strict";
import {test} from "node:test";
import {storeFixture} from "../helpers/store-fixture.ts";
import {queueJob} from "../helpers/queue-job.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {enqueue} from "../../src/store/queue-enqueue.ts";
import {listFiltered} from "../../src/store/queue-read.ts";
import {beginAppServerForkHandoff} from "../../src/store/fork-begin.ts";
import {stageAppServerForkTarget,cancelAppServerForkHandoffAfterDefiniteFailure} from "../../src/store/fork-target.ts";
import {recordAppServerForkFailure,recordAppServerForkFinalizeFailure,recordAndCancelDefiniteForkFailure} from "../../src/store/fork-failure.ts";
import {forkHandoffByIdIn} from "../../src/store/fork-handoff-by-id.ts";
async function sql(path:string,s:string):Promise<void>{const db=await openInitialized(path);try{db.exec(s);}finally{db.close();}}
async function saved(path:string){const db=await openInitialized(path);try{return forkHandoffByIdIn(db,"h");}finally{db.close();}}
async function seed(path:string){await enqueue(path,queueJob({targetThreadId:"source"}));return (await beginAppServerForkHandoff(path,{handoffId:"h",ambiguousJobId:null,sourceThreadId:"source",expectedGeneration:1n,quarantineReason:"reason"})).handoff;}
async function notices(path:string):Promise<number>{const db=await openInitialized(path);try{return Number(db.prepare("SELECT count(*) AS n FROM codex_delivery_outbox").get()?.n);}finally{db.close();}}
test("ambiguous fork failure atomically stages durable notices and ambiguity cannot later be downgraded",async()=>{
  await storeFixture(async path=>{await seed(path);const first=await recordAppServerForkFailure(path,"h"," timeout ",true);assert.equal(first.forkFailureAmbiguous,true);assert.equal(first.lastForkError,"timeout");assert.equal(await notices(path),1);
    const second=await recordAppServerForkFailure(path,"h","definite later",false);assert.equal(second.forkFailureAmbiguous,true);await assert.rejects(()=>cancelAppServerForkHandoffAfterDefiniteFailure(path,"h"),/cannot be cancelled/);
    assert.match((await listFiltered(path,"source",null))[0]!.lastError,/fork-unresolved/);
  });
});
test("notice write failure rolls back ambiguity and handoff error updates",async()=>{
  await storeFixture(async path=>{await seed(path);await sql(path,"CREATE TRIGGER fail_notice BEFORE INSERT ON codex_delivery_outbox BEGIN SELECT RAISE(ABORT,'notice failure'); END");
    await assert.rejects(()=>recordAppServerForkFailure(path,"h","timeout",true),/notice failure/);assert.equal((await saved(path))?.forkFailureAmbiguous,false);assert.equal((await saved(path))?.lastForkError,"");assert.equal((await listFiltered(path,"source",null))[0]!.lastError,"");
  });
});
test("fork outcome cannot overwrite an observed target; finalize failure requires and preserves that observation",async()=>{
  await storeFixture(async path=>{await seed(path);await assert.rejects(()=>recordAppServerForkFinalizeFailure(path,"h","failed"),/not been durably observed/);
    await stageAppServerForkTarget(path,"h","new");await assert.rejects(()=>recordAppServerForkFailure(path,"h","timeout",true),/already observed/);
    const recorded=await recordAppServerForkFinalizeFailure(path,"h","mapping moved");assert.equal(recorded.observedTargetThreadId,"new");assert.equal(recorded.targetThreadId,null);assert.equal(recorded.lastForkError,"mapping moved");assert.equal(await notices(path),1);
  });
});
test("definite failure requires full expected identity and commits notices with fence cancellation",async()=>{
  await storeFixture(async path=>{const original=await seed(path);await recordAppServerForkFailure(path,"h","previous",false);
    await assert.rejects(()=>recordAndCancelDefiniteForkFailure(path,original,"definite"),/different fork handoff/);assert.ok(await saved(path));
    const current=(await saved(path))!;const result=await recordAndCancelDefiniteForkFailure(path,current," definite ");assert.equal(result.affectedJobs,1n);assert.equal(result.lastForkError,"definite");assert.equal(await saved(path),null);assert.equal(await notices(path),1);
    assert.match((await listFiltered(path,"source",null))[0]!.lastError,/fork-definite/);
  });
});
test("definite cancellation failure leaves all previous queue and fence evidence intact",async()=>{
  await storeFixture(async path=>{const h=await seed(path);await sql(path,"CREATE TRIGGER refuse_cancel BEFORE DELETE ON codex_thread_fork_handoffs BEGIN SELECT RAISE(IGNORE); END");
    await assert.rejects(()=>recordAndCancelDefiniteForkFailure(path,h,"definite"),/different fork handoff/);assert.equal((await saved(path))?.lastForkError,"");assert.equal(await notices(path),0);assert.equal((await listFiltered(path,"source",null))[0]!.lastError,"");
  });
});
test("definite failure snapshots all expected fields before awaits and bounds diagnostic scalar length",async()=>{
  await storeFixture(async path=>{const h=await seed(path),pending=recordAndCancelDefiniteForkFailure(path,h,"😀".repeat(1001));h.lastForkError="changed";
    const result=await pending;assert.equal(result.lastForkError,"😀".repeat(1000));assert.equal(await saved(path),null);
  });
});
