import assert from "node:assert/strict";
import {test} from "node:test";
import {createHash} from "node:crypto";
import type {DatabaseSync} from "node:sqlite";
import {storeFixture} from "../helpers/store-fixture.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {sealAsyncQuestionIn,verifyAsyncQuestionIdentityIn,validateAsyncDispatchGuardsIn,validateAsyncDispatchGuardsExisting} from "../../src/store/async-question-guard.ts";
import {guardAsyncMutationIn,certifiedAsyncSuccessorIn} from "../../src/store/async-resolution-guards.ts";
import {ASYNC_QUESTION_CLAIM_SQL,executionOwnerJobValue} from "../../src/store/async-resolution-ownership.ts";
import {readAsyncObligationsIn} from "../../src/store/async-resolution-records.ts";
import {selectJob} from "../../src/store/queue-read.ts";
import {serializeSerdeValue} from "../../src/core/serde-json.ts";
import {parseSerdeValue} from "../../src/core/serde-json-parse.ts";
async function fixture(run:(db:DatabaseSync,path:string)=>void){await storeFixture(async path=>{const db=await openInitialized(path);try{
  db.prepare("INSERT INTO codex_turn_queue(job_id,target_thread_id,channel_id,owner_user_id,app_server_generation,prompt,queued,ack_sent,state,attempt_count,turn_id,baseline_turn_ids,created_at,updated_at) VALUES('job','T',42,3,1,'input',0,1,'running',1,'V','[]',?,?)").run(1790584100.0000021,1790584100.0000021);
  db.exec(`INSERT INTO mirror_threads VALUES('T','p','title',100,42,0); INSERT INTO cdr_async_questions(id,runtime_id,generation,thread_id,turn_id,item_id,origin_job_id,channel_id,owner_user_id,body,state,dispatch_mode,created_at,updated_at) VALUES('q','resident',1,'T','V','item','job',42,3,'{"index":0,"title":"choose","options":["yes"]}','dispatching','steer',0,0)`);
  run(db,path);
}finally{db.close();}});}
// Seed legacy/manual obligation variants without disabling any schema trigger. The
// normal tests retain steer mode and exercise the real auto-capture trigger.
function manualSeal(db:DatabaseSync){db.exec("UPDATE cdr_async_questions SET dispatch_mode=NULL");sealAsyncQuestionIn(db,"q");}
function obligation(db:DatabaseSync,changes:Record<string,unknown>={}){
  const q=db.prepare(`SELECT ${ASYNC_QUESTION_CLAIM_SQL} AS claim,preparation_json AS seal FROM cdr_async_questions q WHERE id='q'`).get()!;
  const c={version:1n,revision:7n,seal:q.seal,claim:q.claim,policy:"ordinary",execution:"unresolved",admission:"held",...changes};
  db.prepare("INSERT INTO cdr_async_execution_obligations(question_id,thread_id,origin_job_id,turn_id,channel_id,format_version,revision,answer_state,execution_state,admission_state,policy,original_seal,claim_json,owner_json,original_error,created_at,updated_at) VALUES('q','T','job','V',42,?,?,'submitted',?,?,?,?,?,NULL,'',0,0)").run(c.version as bigint,c.revision as bigint,c.execution as string,c.admission as string,c.policy as string,c.seal as string|null,c.claim as string);
}
test("original async preparation seals exact body/selection and timestamp bits inside caller transaction",async()=>fixture((db,path)=>{
  db.exec("BEGIN");sealAsyncQuestionIn(db,"q");verifyAsyncQuestionIdentityIn(db,"q");assert.equal(db.isTransaction,true);db.exec("COMMIT");
  const seal=parseSerdeValue<Record<string,any>>(db.prepare("SELECT preparation_json FROM cdr_async_questions").get()!.preparation_json as string);assert.equal(typeof seal.identity.job.created_at,"bigint");assert.equal(seal.identity.job.created_at,executionOwnerJobValue(selectJob(db,"job")).created_at);
  validateAsyncDispatchGuardsExisting(path,"T");assert.equal(db.isTransaction,false);
}));
test("legacy dispatch with no preparation fails but historical submitted questions without live obligations do not strand work",async()=>fixture(db=>{
  assert.throws(()=>validateAsyncDispatchGuardsIn(db,"T"),/legacy async dispatch/);db.exec("UPDATE cdr_async_questions SET state='submitted'");validateAsyncDispatchGuardsIn(db,"T");
}));
for(const change of ["UPDATE codex_turn_queue SET updated_at=updated_at+0.0001","UPDATE codex_turn_queue SET turn_observation_generation=2","UPDATE codex_turn_queue SET goal_waiting=1","UPDATE cdr_async_questions SET chosen=0","UPDATE cdr_async_questions SET message_id='posted'","UPDATE mirror_threads SET discord_thread_id=43","INSERT INTO codex_dead_generation_holds VALUES('T','r',1,0)"])
test(`sealed async identity revokes changed custody: ${change}`,async()=>fixture(db=>{sealAsyncQuestionIn(db,"q");db.exec(change);assert.throws(()=>validateAsyncDispatchGuardsIn(db,"T"));}));
test("another nonpending queue owner refuses steering while an additional Pending job does not",async()=>{
  for(const state of ["pending","starting"])await fixture(db=>{
    db.prepare("INSERT INTO codex_turn_queue(job_id,target_thread_id,channel_id,owner_user_id,app_server_generation,prompt,queued,ack_sent,state,attempt_count,baseline_turn_ids,created_at,updated_at) VALUES('other','T',42,3,1,'next',0,1,?,0,'[]',1,1)").run(state);
    if(state==="starting")assert.throws(()=>sealAsyncQuestionIn(db,"q"),/original turn/);
    else {sealAsyncQuestionIn(db,"q");validateAsyncDispatchGuardsIn(db,"T");assert.throws(()=>db.exec("UPDATE codex_turn_queue SET state='starting' WHERE job_id='other'"),/original execution unresolved/);}
  });
});
test("reply reservation requires exactly one quarantined job of original generation",async()=>fixture(db=>{
  db.exec("UPDATE codex_turn_queue SET turn_id='cdr-quarantined:v',last_error='[cdr-rust:app-server-fork-quarantine:v1] q'; UPDATE cdr_async_questions SET reply_job_id='job',dispatch_mode='start'");sealAsyncQuestionIn(db,"q");validateAsyncDispatchGuardsIn(db,"T");db.exec("UPDATE codex_turn_queue SET app_server_generation=2");assert.throws(()=>verifyAsyncQuestionIdentityIn(db,"q"),/reservation changed/);
}));
test("mutation guard preserves policy-first masking and rejects malformed original evidence before owner inspection",async()=>fixture(db=>{
  manualSeal(db);obligation(db,{seal:"{}"});assert.throws(()=>guardAsyncMutationIn(db,"T"),/invalid or unsupported/);
  db.exec("INSERT INTO cdr_async_recovery_policies VALUES('T',1,'publishing_recovery','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','v','origin','pending'); DROP TABLE cdr_async_execution_handoffs");
  assert.throws(()=>guardAsyncMutationIn(db,"T"),/reviewed publishing recovery policy/);
}));
for(const changes of [{version:2n},{revision:-1n},{seal:null},{seal:"null"},{seal:"[]"},{seal:"{"},{policy:"held"},{execution:"terminal"},{admission:"settled"}])test(`current mutation refuses unsupported evidence ${JSON.stringify(changes,(_k,v)=>typeof v==="bigint"?v.toString():v)}`,async()=>fixture(db=>{
  manualSeal(db);obligation(db,changes);assert.throws(()=>guardAsyncMutationIn(db,"T"));
}));
test("exact live original owner is allowed but state or claim drift revokes mutation",async()=>fixture(db=>{
  manualSeal(db);obligation(db);guardAsyncMutationIn(db,"T");validateAsyncDispatchGuardsIn(db,"T");assert.equal(certifiedAsyncSuccessorIn(db,"T","q"),false);
  db.exec("UPDATE codex_turn_queue SET prompt='changed'");assert.throws(()=>guardAsyncMutationIn(db,"T"),/no exact live owner/);
}));
test("certified successor permits only current execution and never authorizes the original answer again",async()=>fixture(db=>{
  manualSeal(db);obligation(db);const row=readAsyncObligationsIn(db,"T")[0]!;
  db.exec("UPDATE codex_turn_queue SET turn_id='next',turn_observation_generation=2,updated_at=3");
  const raw=serializeSerdeValue({version:1n,revision:7n,claim_sha256:row.claim_sha256,previous_terminal:"prior",owner:{turn_id:"next",generation:2n,observer:"resident",job:executionOwnerJobValue(selectJob(db,"job"))}});
  db.prepare("INSERT INTO cdr_async_execution_handoffs VALUES('q',7,?,?)").run(raw,createHash("sha256").update(raw).digest("hex"));
  assert.equal(certifiedAsyncSuccessorIn(db,"T","q"),true);validateAsyncDispatchGuardsIn(db,"T");assert.throws(()=>verifyAsyncQuestionIdentityIn(db,"q"),/original turn/);
  db.exec("UPDATE mirror_threads SET discord_thread_id=43");assert.throws(()=>validateAsyncDispatchGuardsIn(db,"T"));
}));
test("seal operation never rewrites a nondispatching question and malformed preparation is not permission",async()=>fixture(db=>{
  db.exec("UPDATE cdr_async_questions SET state='submitted'");sealAsyncQuestionIn(db,"q");assert.equal(db.prepare("SELECT preparation_json FROM cdr_async_questions").get()!.preparation_json,null);
  db.exec("UPDATE cdr_async_questions SET state='dispatching',preparation_json='{'");assert.throws(()=>verifyAsyncQuestionIdentityIn(db,"q"),SyntaxError);
}));
test("typed Seal rejects duplicate identity but accepts source struct sequence and ignored unknown fields",async()=>fixture(db=>{
  manualSeal(db);const raw=db.prepare("SELECT preparation_json FROM cdr_async_questions").get()!.preparation_json as string,value=parseSerdeValue<Record<string,unknown>>(raw),encoded=serializeSerdeValue(value.identity);
  db.prepare("UPDATE cdr_async_questions SET preparation_json=?").run(`{"identity":${encoded},"identity":${encoded}}`);assert.throws(()=>verifyAsyncQuestionIdentityIn(db,"q"),/Duplicate Serde field/);
  db.prepare("UPDATE cdr_async_questions SET preparation_json=?").run(`[${encoded}]`);verifyAsyncQuestionIdentityIn(db,"q");
  db.prepare("UPDATE cdr_async_questions SET preparation_json=?").run(`{"ignored":1e400,"identity":${encoded}}`);verifyAsyncQuestionIdentityIn(db,"q");
}));
