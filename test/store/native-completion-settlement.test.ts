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

import {createNativeQueueState} from '../../src/runtime/queue-runner/native-state.ts';
import {recordAsyncTerminalNotification} from '../../src/store/async-resolution-terminal.ts';
const payload=()=>JSON.stringify({threadId:'target',turn:{id:'turn',status:'completed'}});
test('native Final settles only exact persisted async proof and stages original unsent idle candidate',async()=>fixture(async(db,row,path)=>{
 await recordAsyncTerminalNotification(path,'target','turn',1n,'resident',payload());const expected=selectJob(db,'saved');const result=await createNativeQueueState(path).stageOwnedQueueCompletion(path,expected,'final',6,{observer:'resident',generation:1n});assert.equal(result.content,'final');assert.equal(readAsyncObligationsIn(db,'target').length,0);const updated=readAsyncObligationsIn(db,'target',false)[0]!;assert.equal(updated.execution_state,'terminal');assert.equal(updated.revision,8n);assert.equal(updated.admission_state,'settled');assert.equal(db.prepare('SELECT count(*) AS n FROM cdr_async_terminal_settlements').get()?.n,1);assert.equal(db.prepare('SELECT count(*) AS n FROM codex_turn_queue').get()?.n,0);assert.equal(db.prepare('SELECT state FROM cdr_idle_release').get()?.state,'Candidate');
}));
test('plain release metadata cannot manufacture proof or override mismatched observer/generation',async()=>{
 for(const mode of ['missing-proof','wrong-observer','wrong-generation'])await fixture(async(db,row,path)=>{
  if(mode!=='missing-proof')await recordAsyncTerminalNotification(path,'target','turn',1n,'resident',payload());const expected=selectJob(db,'saved');await createNativeQueueState(path).stageOwnedQueueCompletion(path,expected,'final',6,{observer:mode==='wrong-observer'?'foreign':'resident',generation:mode==='wrong-generation'?2n:1n});const updated=readAsyncObligationsIn(db,'target')[0]!;assert.equal(updated.execution_state,'unresolved');assert.equal(updated.revision,7n);assert.equal(db.prepare('SELECT count(*) AS n FROM cdr_async_terminal_settlements').get()?.n,0);assert.equal(db.prepare('SELECT count(*) AS n FROM cdr_idle_release').get()?.n,0);
 });
});
