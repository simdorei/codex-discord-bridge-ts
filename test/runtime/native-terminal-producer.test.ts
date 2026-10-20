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

import {NativeObservationLedgerOwner} from "../../src/runtime/native-observation-ledger.ts";
import {IdleObservationError} from "../../src/app-server/notification-state.ts";
import {ownedWorkerUsage} from "../../src/runtime/owned-worker-slot.ts";
import {observeCompletionTerminal} from "../../src/runtime/completion/observation.ts";
import {createNativeObservationState} from "../../src/runtime/completion/native-observation-state.ts";
const payload=JSON.stringify({threadId:"target",turn:{id:"turn",status:"completed"}});
test("native terminal blocked by SQLite keeps main timer live and preserves both exact committed stages",async()=>fixture(async(db,_row,path)=>{
 const owner=new NativeObservationLedgerOwner(path);db.exec("BEGIN IMMEDIATE");const p=owner.recordTerminal("target","turn",1n,payload,"resident");void p.catch(()=>{});
 try{await new Promise(r=>setTimeout(r,50));assert.equal(owner.busy,true);assert.equal(ownedWorkerUsage().Observation,1);assert.equal(ownedWorkerUsage().Control,0);db.exec("ROLLBACK");assert.equal(await p,true);
 assert.equal(typeof db.prepare("SELECT terminal_proof_json FROM cdr_async_execution_obligations").get()?.terminal_proof_json,"string");
 assert.equal(db.prepare("SELECT resident_owner FROM codex_observed_completions").get()?.resident_owner,"resident");
 }finally{if(db.isTransaction)db.exec("ROLLBACK");await Promise.allSettled([p]);await owner.close();}
}));
test("native terminal raw failure cannot roll back accepted proof or fabricate success",async()=>fixture(async(db,_row,path)=>{
 const owner=new NativeObservationLedgerOwner(path);db.exec("CREATE TRIGGER deny_native_raw BEFORE INSERT ON codex_observed_completions BEGIN SELECT RAISE(ABORT,'raw failed'); END");
 try{await assert.rejects(owner.recordTerminal("target","turn",1n,payload,"resident"),IdleObservationError);
 assert.equal(typeof db.prepare("SELECT terminal_proof_json FROM cdr_async_execution_obligations").get()?.terminal_proof_json,"string");
 assert.equal(db.prepare("SELECT count(*) AS n FROM codex_observed_completions").get()?.n,0);
 }finally{await owner.close();}
}));
test("native cancelled producer joins late commit but keeps its caller unconfirmed",async()=>fixture(async(db,_row,path)=>{
 const owner=new NativeObservationLedgerOwner(path),c=new AbortController();db.exec("BEGIN IMMEDIATE");
 const p=owner.recordTerminal("target","turn",1n,payload,"resident",c.signal),rejected=assert.rejects(p,IdleObservationError);let settled=false;void p.then(()=>{settled=true;},()=>{settled=true;});c.abort(new Error("stop"));
 try{await new Promise(r=>setTimeout(r,40));assert.equal(settled,false);db.exec("ROLLBACK");await rejected;assert.equal(owner.busy,false);assert.equal(db.prepare("SELECT resident_owner FROM codex_observed_completions").get()?.resident_owner,"resident");}
 finally{if(db.isTransaction)db.exec("ROLLBACK");await Promise.allSettled([p]);await owner.close();}
}));
test("native final retains first owned answer and rejects a different turn or generation",async()=>fixture(async(db,_row,path)=>{
 const owner=new NativeObservationLedgerOwner(path);
 try{assert.equal(await owner.recordFinal("target","other",1n,"wrong"),false);assert.equal(await owner.recordFinal("target","turn",2n,"wrong"),false);assert.equal(await owner.recordFinal("target","turn",1n,"original"),true);assert.equal(await owner.recordFinal("target","turn",1n,"replace"),false);assert.equal(db.prepare("SELECT content FROM codex_observed_final_answers").get()?.content,"original");}finally{await owner.close();}
}));
test("actual event producer uses native port with original resident and terminal payload",async()=>fixture(async(db,_row,path)=>{
 const native=createNativeObservationState(path);
 try{await observeCompletionTerminal(path,"resident",{kind:"Notification",generation:1n,notification:{method:"turn/completed",params:JSON.parse(payload)}},native.state);assert.equal(db.prepare("SELECT payload FROM codex_observed_completions").get()?.payload,'{"threadId":"target","turn":{"durationMs":null,"error":{"codexErrorInfo":null,"message":""},"id":"turn","status":"completed"}}');assert.equal(db.prepare("SELECT resident_owner FROM codex_observed_completions").get()?.resident_owner,"resident");}finally{await native.close();}
}));
