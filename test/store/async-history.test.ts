import assert from "node:assert/strict";
import {test} from "node:test";
import type {DatabaseSync} from "node:sqlite";
import {storeFixture} from "../helpers/store-fixture.ts";
import {historicalQuestionFixture} from "../helpers/async-history-fixture.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {captureAsyncHistorySnapshot,retainAsyncHistoryCandidate,type HistorySnapshot} from "../../src/store/async-history.ts";
import {originalHistoricalQuestion} from "../../src/store/async-history-question.ts";
import {answerPrompt} from "../../src/store/async-question-body.ts";
import {parseSerdeValue} from "../../src/core/serde-json-parse.ts";
async function fixture(run:(db:DatabaseSync,path:string,snapshot:HistorySnapshot,history:ReturnType<typeof historyValue>)=>Promise<void>):Promise<void>{
  await storeFixture(async path=>{
    const {row}=historicalQuestionFixture(),db=await openInitialized(path);
    try{
      db.exec("INSERT INTO mirror_threads VALUES ('target','project','title',1,1,0)");
      db.prepare(`INSERT INTO cdr_async_execution_obligations(question_id,thread_id,origin_job_id,turn_id,channel_id,format_version,revision,
        answer_state,execution_state,admission_state,policy,original_seal,claim_json,owner_json,original_error,created_at,updated_at)
        VALUES ('q','target','job','turn',1,1,7,'unresolved','unresolved','held','ordinary',?,?,NULL,'original',0,0)`).run(row.original_seal,row.claim);
      const snapshot=await captureAsyncHistorySnapshot(path,"target");assert.ok(snapshot);
      await run(db,path,snapshot,historyValue());
    }finally{db.close();}
  });
}
function historyValue(){
  const q=originalHistoricalQuestion(historicalQuestionFixture().row);
  return {threadId:"target",truncated:false,turns:[{id:"turn",status:"completed",items:[{id:"input",type:"userMessage",content:[{type:"text",text:answerPrompt(q,q.chosen)}]}]}]};
}
test("captured historical answer stores provenance and receipt but never settles execution",async()=>{
  await fixture(async(db,path,snapshot,history)=>{
    assert.deepEqual(snapshot.turnIds(),["turn"]);assert.equal(snapshot.obligationCount(),1);
    assert.equal(await retainAsyncHistoryCandidate(path,snapshot,history,"reader",1n),1);
    const row=db.prepare("SELECT answer_state,execution_state,admission_state,terminal_proof_json FROM cdr_async_execution_obligations").get()!;
    assert.equal(row.answer_state,"exact_history_confirmed");assert.equal(row.execution_state,"unresolved");assert.equal(row.admission_state,"held");assert.equal(row.terminal_proof_json,null);
    const raw=db.prepare("SELECT evidence_text FROM cdr_async_terminal_candidates").get()?.evidence_text as string;
    const value=parseSerdeValue<Record<string,unknown>>(raw);assert.equal(value.execution_authority,false);assert.equal(value.source,"historical_read_candidate_v1");
  });
});
test("mutable caller history is snapshotted before asynchronous open",async()=>{
  await fixture(async(db,path,snapshot,history)=>{
    const op=retainAsyncHistoryCandidate(path,snapshot,history,"reader",1n);history.turns[0]!.items=[];
    await op;assert.equal(db.prepare("SELECT answer_state FROM cdr_async_execution_obligations").get()?.answer_state,"exact_history_confirmed");
  });
});
test("changed mapping snapshot and forged handles cannot record evidence",async()=>{
  await fixture(async(db,path,snapshot,history)=>{
    await assert.rejects(()=>retainAsyncHistoryCandidate(path,{turnIds:()=>["turn"],obligationCount:()=>1},history,"reader",1n),/captured history snapshot/);
    db.exec("UPDATE mirror_threads SET discord_thread_id=2");
    await assert.rejects(()=>retainAsyncHistoryCandidate(path,snapshot,history,"reader",1n),/snapshot changed/);
    assert.equal(db.prepare("SELECT count(*) AS n FROM cdr_async_terminal_candidates").get()?.n,0);
  });
});
test("duplicate turns/items and unsupported turn status reject without receipt writes",async()=>{
  for(const mode of ["turn","item","status"])await fixture(async(db,path,snapshot,history)=>{
    if(mode==="turn")history.turns.push(structuredClone(history.turns[0]!));
    if(mode==="item")history.turns[0]!.items.push(structuredClone(history.turns[0]!.items[0]!));
    if(mode==="status")history.turns[0]!.status="unknown";
    await assert.rejects(()=>retainAsyncHistoryCandidate(path,snapshot,history,"reader",1n),/duplicated|not typed/);
    assert.equal(db.prepare("SELECT answer_state FROM cdr_async_execution_obligations").get()?.answer_state,"unresolved");
  });
});
test("multiple exact inputs create diagnostic conflict instead of confirming the answer",async()=>{
  await fixture(async(db,path,snapshot,history)=>{
    const second=structuredClone(history.turns[0]!.items[0]!);second.id="input2";history.turns[0]!.items.push(second);
    await retainAsyncHistoryCandidate(path,snapshot,history,"reader",1n);
    const raw=db.prepare("SELECT evidence_text FROM cdr_async_terminal_candidates").get()?.evidence_text as string;
    const evidence=parseSerdeValue<Record<string,unknown>>(raw);assert.equal(evidence.answer_conflict,true);assert.equal(evidence.matching_input,null);
    assert.equal(db.prepare("SELECT answer_state FROM cdr_async_execution_obligations").get()?.answer_state,"unresolved");
  });
});
test("capacity exhaustion or ignored insertion cannot claim a stored receipt",async()=>{
  for(const capacity of [false,true])await fixture(async(db,path,snapshot,history)=>{
    if(capacity){const insert=db.prepare("INSERT INTO cdr_async_terminal_candidates VALUES ('q',7,'unverified',?,'{}')");for(let i=0;i<8;i++)insert.run(String(i));}
    else db.exec("CREATE TRIGGER test_ignore_history BEFORE INSERT ON cdr_async_terminal_candidates BEGIN SELECT RAISE(IGNORE); END");
    await assert.rejects(()=>retainAsyncHistoryCandidate(path,snapshot,history,"reader",1n),/storage bound reached/);
    assert.equal(db.prepare("SELECT answer_state FROM cdr_async_execution_obligations").get()?.answer_state,"unresolved");
  });
});
test("same semantic answer can reuse older valid reader provenance after fresh snapshot",async()=>{
  await fixture(async(db,path,snapshot,history)=>{
    await retainAsyncHistoryCandidate(path,snapshot,history,"reader1",1n);
    const next=await captureAsyncHistorySnapshot(path,"target");assert.ok(next);
    await retainAsyncHistoryCandidate(path,next,{...history,extra:"different observation"},"reader2",2n);
    assert.equal(db.prepare("SELECT count(*) AS n FROM cdr_async_terminal_candidates").get()?.n,1);
  });
});
import {createHash} from "node:crypto";
import {serializeSerdeValue} from "../../src/core/serde-json.ts";
test("a matching review key is not authority when stored provenance flags are corrupted",async()=>{
  await fixture(async(db,path,snapshot,history)=>{
    await retainAsyncHistoryCandidate(path,snapshot,history,"reader",1n);
    const old=db.prepare("SELECT evidence_text FROM cdr_async_terminal_candidates").get()?.evidence_text as string;
    const value=parseSerdeValue<Record<string,unknown>>(old);value.execution_authority=true;
    const forged=serializeSerdeValue(value);
    db.prepare("INSERT INTO cdr_async_terminal_candidates VALUES ('q',7,'unverified',?,?)")
      .run(createHash("sha256").update(forged).digest("hex"),forged);
    db.exec("UPDATE cdr_async_execution_obligations SET answer_state='unresolved'");
    const fresh=await captureAsyncHistorySnapshot(path,"target");assert.ok(fresh);
    await assert.rejects(()=>retainAsyncHistoryCandidate(path,fresh,history,"reader",1n),/does not preserve the exact verified answer facts/);
    assert.equal(db.prepare("SELECT answer_state FROM cdr_async_execution_obligations").get()?.answer_state,"unresolved");
  });
});
