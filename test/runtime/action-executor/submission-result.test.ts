import assert from "node:assert/strict";
import {test} from "node:test";
import {submissionResult,requestEcho} from "../../../src/runtime/action-executor/submission-result.ts";
import {INTERVIEW_HEADER} from "../../../src/runtime/action-executor/interview-header.ts";
import type {BackendFailureKind} from "../../../src/runtime/queue-runner/saved-submission.ts";
test("request echo preserves Rust whitespace, scalar length and exact interview prefix stripping",()=>{
  assert.equal(requestEcho("  한글 요청\n 확인해줘  "),"한글 요청 확인해줘");assert.equal(requestEcho("가".repeat(121)),"가".repeat(120)+"…");
  assert.equal(requestEcho("😀".repeat(120)),"😀".repeat(120));assert.equal(requestEcho("😀".repeat(121)),"😀".repeat(120)+"…");
  assert.equal(requestEcho(INTERVIEW_HEADER+"한글 요청"),"한글 요청");assert.equal(requestEcho("User request: 원문"),"User request: 원문");
  assert.equal(requestEcho("\u0085a\u0085b\uFEFF"),"a b\uFEFF");assert.equal(requestEcho(""),"");assert.throws(()=>requestEcho("\uD800"),TypeError);
});
test("queue and preparation are never reported as a confirmed running turn",()=>{
  for(const [queued,turnId,expected] of [[false,"turn","In progress\nmessage: 요청 에코"],[true,null,"Queued\nmessage: 앞선 작업이 끝나면 시작합니다."],[false,null,"Preparing\nmessage: 작업 시작을 확인하고 있습니다."]] as const)
    assert.deepEqual(submissionResult("thread","mirror",{jobId:"job",queued,turnId},"요청 에코"),{text:expected,waitsForFinal:true,ui:null});
});
test("manual hold classes never advertise automatic retry or waiting for a final",()=>{
  for(const kind of ["Quarantined","ForkFenced","StartingCandidatesHeld","ExecutionHeld"] as const){const result=submissionResult("thread","mirror",{jobId:"job",queued:true,turnId:null,warning:{kind,ambiguous:true,message:"reason"}},"raw");
    assert.equal(result.waitsForFinal,false);assert.match(result.text,/was not replayed/);assert.doesNotMatch(result.text,/queued for automatic retry/);
  }
  assert.equal(submissionResult("thread",null,{jobId:"job",queued:false,turnId:null,warning:{kind:"StartingCandidatesHeld",ambiguous:true,message:"reason"}},"raw").text,
    "Codex request was not replayed\nthread_id: thread\njob_id: job\nstatus: target queue is held for manual resolution\nreason: reason\nsafety: no turn was selected and no request was replayed");
});
test("held ambiguous start remains unknown while other backend warnings preserve source labels",()=>{
  for(const ambiguous of [false,true]){const held=submissionResult("thread",null,{jobId:"job",queued:true,turnId:null,warning:{kind:"ExecutionHeld",ambiguous,message:"reason"}},"raw");
    assert.equal(held.text.includes("start_outcome:"),ambiguous);assert.equal(held.waitsForFinal,false);
    for(const kind of ["Other","ActiveWriter","UsageLimit"] as BackendFailureKind[]){const result=submissionResult("thread","mirror",{jobId:"job",queued:true,turnId:null,warning:{kind,ambiguous,message:"reason"}},"raw");
      assert.equal(result.waitsForFinal,true);assert.match(result.text,/source: mirror/);assert.equal(result.text.includes("start may have reached Codex"),ambiguous);
    }
  }
});
