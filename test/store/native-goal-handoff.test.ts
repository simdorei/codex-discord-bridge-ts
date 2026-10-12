import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { storeFixture } from "../helpers/store-fixture.ts";
import { queueJob } from "../helpers/queue-job.ts";
import { StateAccessFacade as state } from "../../src/store/state-access-facade.ts";
import { openInitialized } from "../../src/store/owned-driver.ts";
import { selectJob } from "../../src/store/queue-read.ts";
import { readAsyncObligationsIn, type AsyncObligation } from "../../src/store/async-resolution-records.ts";
import { asyncExecutionOwnerIn, exactAsyncOwnerIn, executionOwnerJobValue } from "../../src/store/async-resolution-ownership.ts";
import { serializeSerdeValue, sha256SerdeValue } from "../../src/core/serde-json.ts";

async function fixture(run: (db: DatabaseSync, row: AsyncObligation, path: string) => void | Promise<void>): Promise<void> {
  await storeFixture(async path => {
    await state.enqueue(path, queueJob({ownerUserId:2n}));
    const claim=(await state.tryBeginAttempt(path,"saved",[],1n))!;
    await state.markRunningIfClaimed(path,claim,"turn");
    const db=await openInitialized(path);
    try {
      const seal=serializeSerdeValue({identity:{job:executionOwnerJobValue(selectJob(db,"saved"))}});
      db.exec("INSERT INTO mirror_threads VALUES ('target','project','title',1,10,0)");
      db.prepare(`INSERT INTO cdr_async_questions
        (id,runtime_id,generation,thread_id,turn_id,item_id,origin_job_id,channel_id,owner_user_id,body,owner_confirmed,created_at,updated_at,preparation_json,state,dispatch_mode)
        VALUES ('question','resident',1,'target','turn','item','saved',1,2,'body',1,0,0,?,'dispatching','steer')`).run(seal);
      db.exec(`INSERT INTO cdr_async_execution_obligations
        (question_id,thread_id,origin_job_id,turn_id,channel_id,format_version,revision,answer_state,execution_state,admission_state,policy,original_seal,claim_json,owner_json,original_error,created_at,updated_at)
        SELECT q.id,q.thread_id,q.origin_job_id,q.turn_id,q.channel_id,1,7,'unresolved','unresolved','held','ordinary',q.preparation_json,
        json_object('id',q.id,'runtime_id',q.runtime_id,'generation',q.generation,'thread_id',q.thread_id,'turn_id',q.turn_id,'item_id',q.item_id,
          'origin_job_id',q.origin_job_id,'channel_id',q.channel_id,'owner_user_id',q.owner_user_id,'body',q.body,'chosen',q.chosen,'message_id',q.message_id,'dispatch_mode',q.dispatch_mode),
        NULL,'original',0,0 FROM cdr_async_questions q`);
      await run(db,readAsyncObligationsIn(db,"target")[0]!,path);
    } finally { db.close(); }
  });
}
function installProof(db: DatabaseSync, row: AsyncObligation, changes: Record<string, unknown> = {}): string {
  const metadata={threadId:"target",turn:{id:"turn",status:"completed"}};
  const raw=serializeSerdeValue({version:1n,source:"resident_notification_v1",observer:"resident",generation:1n,
    thread_id:"target",turn_id:"turn",canonical_terminal:metadata,payload_sha256:sha256SerdeValue(metadata),
    claim_sha256:row.claim_sha256,revision:row.revision,owner_verified:true,...changes});
  db.prepare("UPDATE cdr_async_execution_obligations SET terminal_proof_json=?").run(raw);
  return raw;
}

import {createNativeQueueState,NativeQueueAttemptUnconfirmedError} from '../../src/runtime/queue-runner/native-state.ts';
import type {StoredQueueJob} from '../../src/store/queue-read.ts';
import {recordAsyncTerminalNotification} from '../../src/store/async-resolution-terminal.ts';
import {stageOwnedGoalProgress,pendingGoalProgress} from '../../src/store/goal-progress.ts';
const payload=(status='completed')=>JSON.stringify({threadId:'target',turn:{id:'turn',status}});
async function attachGoalTurnObservedIfOwned(path:string,input:StoredQueueJob,turn:string,generation:bigint){return createNativeQueueState(path).attachGoalTurnObservedIfOwned(path,input,turn,generation);}
test("native goal handoff: Goal progress and successor preserve original job while carrying exact prior terminal evidence",async()=>{
  await fixture(async(db,row,path)=>{
    await recordAsyncTerminalNotification(path,"target","turn",1n,"resident",payload());
    const original=selectJob(db,"saved"),progress=await stageOwnedGoalProgress(path,original,"progress");
    assert.equal(progress?.content,"progress");const waiting=selectJob(db,"saved");assert.equal(waiting.goalWaiting,true);
    assert.equal(await attachGoalTurnObservedIfOwned(path,waiting,"successor",2n),true);
    const next=selectJob(db,"saved");assert.equal(next.turnId,"successor");assert.equal(next.goalWaiting,false);
    assert.equal(next.appServerGeneration,original.appServerGeneration);assert.equal(next.executionGeneration,original.executionGeneration);assert.equal(next.turnObservationGeneration,2n);
    const updated=readAsyncObligationsIn(db,"target")[0]!;assert.equal(updated.revision,8n);
    const owner=asyncExecutionOwnerIn(db,updated);assert.equal(owner.turn_id,"successor");assert.equal(owner.generation,2n);assert.equal(owner.observer,"resident");
    assert.equal(exactAsyncOwnerIn(db,updated),true);assert.equal(db.prepare("SELECT terminal_proof_json FROM cdr_async_execution_obligations").get()?.terminal_proof_json,null);
    const handoff=db.prepare("SELECT evidence_json FROM cdr_async_execution_handoffs").get()?.evidence_json as string;
    assert.ok(handoff.startsWith('{"version":1,"revision":8,"claim_sha256":'));assert.ok(handoff.includes('"owner":{"turn_id":"successor","generation":2,"observer":"resident","job":'));
    const nextPayload=JSON.stringify({threadId:"target",turn:{id:"successor",status:"completed"}});
    await recordAsyncTerminalNotification(path,"target","successor",2n,"resident",nextPayload);
    await state.stageOwnedQueueCompletion(path,next,"final",6,{observer:"resident",generation:2n});
    assert.equal(db.prepare("SELECT execution_state FROM cdr_async_execution_obligations").get()?.execution_state,"terminal");
    assert.equal((await pendingGoalProgress(path)).length,1);
  });
});
test("native goal handoff: Goal handoff without accepted prior proof rolls back the successor queue update",async()=>{
  await fixture(async(db,row,path)=>{
    const original=selectJob(db,"saved");await stageOwnedGoalProgress(path,original,"");const waiting=selectJob(db,"saved");
    await assert.rejects(()=>attachGoalTurnObservedIfOwned(path,waiting,"successor",2n),NativeQueueAttemptUnconfirmedError);
    const unchanged=selectJob(db,"saved");assert.equal(unchanged.turnId,"turn");assert.equal(unchanged.goalWaiting,true);
    assert.equal(db.prepare("SELECT count(*) AS n FROM cdr_async_execution_handoffs").get()?.n,0);
  });
});
test("native goal handoff: ignored obligation handoff CAS rolls back both successor and new evidence row",async()=>{
  await fixture(async(db,row,path)=>{
    await recordAsyncTerminalNotification(path,"target","turn",1n,"resident",payload());
    await stageOwnedGoalProgress(path,selectJob(db,"saved"),"");const waiting=selectJob(db,"saved");
    db.exec("CREATE TRIGGER test_ignore_handoff BEFORE UPDATE OF revision ON cdr_async_execution_obligations BEGIN SELECT RAISE(IGNORE); END");
    await assert.rejects(()=>attachGoalTurnObservedIfOwned(path,waiting,"successor",2n),NativeQueueAttemptUnconfirmedError);
    assert.equal(selectJob(db,"saved").turnId,"turn");assert.equal(db.prepare("SELECT count(*) AS n FROM cdr_async_execution_handoffs").get()?.n,0);
  });
});
import {serializeOwnershipHandoff} from "../../src/store/async-resolution-proof.ts";
test("native goal handoff: Goal handoff lifetime chain cap rolls back the successor without discarding prior evidence",async()=>{
  await fixture(async(db,row,path)=>{
    const owner=asyncExecutionOwnerIn(db,row);
    db.exec("BEGIN IMMEDIATE");
    for(let revision=1n;revision<=128n;revision++){
      const raw=serializeOwnershipHandoff({version:1n,revision,claim_sha256:row.claim_sha256,previous_terminal:"prior",owner});
      db.prepare("INSERT INTO cdr_async_execution_handoffs VALUES (?,?,?,?)").run("question",revision,raw,createHash("sha256").update(raw).digest("hex"));
    }
    db.exec("UPDATE cdr_async_execution_obligations SET revision=128; COMMIT");
    const current=readAsyncObligationsIn(db,"target")[0]!;installProof(db,current);
    await stageOwnedGoalProgress(path,selectJob(db,"saved"),"");const waiting=selectJob(db,"saved");
    await assert.rejects(()=>attachGoalTurnObservedIfOwned(path,waiting,"successor",2n),NativeQueueAttemptUnconfirmedError);
    assert.equal(selectJob(db,"saved").turnId,"turn");assert.equal(db.prepare("SELECT count(*) AS n FROM cdr_async_execution_handoffs").get()?.n,128);
  });
});
test("native goal handoff: Goal execution revision overflow preserves waiting queue and old terminal proof",async()=>{
  await fixture(async(db,row,path)=>{
    db.exec("UPDATE cdr_async_execution_obligations SET revision=9223372036854775807");
    const current=readAsyncObligationsIn(db,"target")[0]!,raw=installProof(db,current);
    await stageOwnedGoalProgress(path,selectJob(db,"saved"),"");const waiting=selectJob(db,"saved");
    await assert.rejects(()=>attachGoalTurnObservedIfOwned(path,waiting,"successor",2n),NativeQueueAttemptUnconfirmedError);
    assert.equal(selectJob(db,"saved").goalWaiting,true);
    assert.equal(db.prepare("SELECT terminal_proof_json FROM cdr_async_execution_obligations").get()?.terminal_proof_json,raw);
  });
});

