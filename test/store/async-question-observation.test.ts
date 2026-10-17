import assert from "node:assert/strict";
import {test} from "node:test";
import {createHash} from "node:crypto";
import {storeFixture} from "../helpers/store-fixture.ts";
import {queueJob} from "../helpers/queue-job.ts";
import {StateAccessFacade as state} from "../../src/store/state-access-facade.ts";
import {asyncQuestionOccurrenceId,type NewAsyncQuestion} from "../../src/store/async-question-observation.ts";
import {usingInitializedStore} from "../../src/store/owned-scope.ts";
const fresh=(extra:Partial<NewAsyncQuestion>={}):NewAsyncQuestion=>({runtime_id:"resident",generation:1n,thread_id:"target",turn_id:"turn",item_id:"item",body:{index:0n,source_text:"context",title:"질문",options:["예","아니오"]},now:123,...extra});
async function running(path:string){await state.enqueue(path,queueJob({ownerUserId:2n}));const claim=(await state.tryBeginAttempt(path,"saved",[],1n))!;await state.markRunningIfClaimed(path,claim,"turn");return claim;}
async function inbox(path:string){return usingInitializedStore(path,db=>db.prepare('SELECT * FROM cdr_async_question_inbox').all());}
async function questions(path:string){return usingInitializedStore(path,db=>db.prepare('SELECT * FROM cdr_async_questions').all());}

test("question occurrence uses the exact Rust tuple bytes and keeps positions distinct",()=>{
  assert.equal(asyncQuestionOccurrenceId("한글","turn","item",0n),createHash('sha256').update('["한글","turn","item",0]').digest('hex'));
  assert.notEqual(asyncQuestionOccurrenceId("t","r","i",0n),asyncQuestionOccurrenceId("t","r","i",1n));
  assert.throws(()=>asyncQuestionOccurrenceId("t","r","i",-1n));assert.throws(()=>asyncQuestionOccurrenceId("t","r","i",1n<<64n));
});
test("live observation pins candidate but only exact reconcile grants confirmed question ownership",async()=>storeFixture(async path=>{
  await running(path);await state.recordAsyncQuestionObservation(path,fresh());let rows=await inbox(path);assert.equal(rows.length,1);assert.equal((await questions(path)).length,0);
  assert.equal(rows[0]!.candidate_job_id,"saved");assert.equal(rows[0]!.candidate_generation,1);assert.equal(rows[0]!.candidate_execution_generation,1);
  assert.equal(rows[0]!.body,'{"index":0,"source_text":"context","title":"질문","options":["예","아니오"]}');
  assert.equal(await state.reconcileAsyncQuestionObservations(path,"resident",1n),1n);assert.equal((await inbox(path)).length,0);const q=(await questions(path))[0]!;assert.equal(q.owner_confirmed,1);assert.equal(q.origin_job_id,"saved");
  assert.equal(await state.reconcileAsyncQuestionObservations(path,"resident",1n),0n);
}));
test("same occurrence duplicate preserves original owner and clock; changed body is rejected",async()=>storeFixture(async path=>{
  await running(path);await state.recordAsyncQuestionObservation(path,fresh());const before=await inbox(path);
  await state.recordAsyncQuestionObservation(path,fresh({runtime_id:"new-resident",generation:2n,now:999}));assert.deepEqual(await inbox(path),before);
  await assert.rejects(state.recordAsyncQuestionObservation(path,fresh({body:{...fresh().body,title:"different"}})),/changed its content/);assert.deepEqual(await inbox(path),before);
}));
test("existing delivered question wins over inbox and never gets revived by observation",async()=>storeFixture(async path=>{
  await running(path);await state.observeAsyncQuestion(path,fresh());await usingInitializedStore(path,db=>{db.exec("UPDATE cdr_async_questions SET state='expired'");});const before=await questions(path);
  await state.recordAsyncQuestionObservation(path,fresh({runtime_id:"new",generation:3n}));assert.deepEqual(await questions(path),before);assert.equal((await inbox(path)).length,0);
}));
test("no owner, ownerless job and duplicate non-pending jobs cannot create selectable questions",async()=>{
  for(const mode of ["absent","ownerless","duplicate"]){await storeFixture(async path=>{
    if(mode!=="absent")await running(path);
    await usingInitializedStore(path,db=>{if(mode==="ownerless")db.exec("UPDATE codex_turn_queue SET owner_user_id=NULL");if(mode==="duplicate")db.exec("INSERT INTO codex_turn_queue(job_id,target_thread_id,channel_id,prompt,queued,ack_sent,state,attempt_count,baseline_turn_ids,created_at,updated_at,app_server_generation) VALUES('other','target',1,'p',1,1,'quarantined',0,'[]',0,0,1)");});
    await assert.rejects(state.recordAsyncQuestionObservation(path,fresh()),/no unique original Discord job candidate/);assert.equal((await inbox(path)).length,0);
  });}
});
test("pending jobs are ignored; quarantined sole owner is retained only as candidate",async()=>storeFixture(async path=>{
  await running(path);await state.enqueue(path,queueJob({jobId:"pending",ownerUserId:3n}));await usingInitializedStore(path,db=>{db.exec("UPDATE codex_turn_queue SET state='quarantined' WHERE job_id='saved'");});
  await state.recordAsyncQuestionObservation(path,fresh());assert.equal((await inbox(path))[0]!.candidate_job_id,"saved");assert.equal(await state.reconcileAsyncQuestionObservations(path,"resident",1n),0n);assert.equal((await questions(path)).length,0);
}));
test("event preceding exact new-generation handoff stays unbound until original provenance matches",async()=>storeFixture(async path=>{
  await running(path);await state.recordAsyncQuestionObservation(path,fresh({generation:2n}));assert.equal(await state.reconcileAsyncQuestionObservations(path,"resident",2n),0n);
  await usingInitializedStore(path,db=>{db.exec("UPDATE codex_turn_queue SET turn_observation_generation=2");});assert.equal(await state.reconcileAsyncQuestionObservations(path,"resident",2n),1n);
}));
test("reconciliation filters runtime and generation and preserves changed attempt or replacement job",async()=>storeFixture(async path=>{
  await running(path);await state.recordAsyncQuestionObservation(path,fresh());assert.equal(await state.reconcileAsyncQuestionObservations(path,"other",1n),0n);assert.equal(await state.reconcileAsyncQuestionObservations(path,"resident",2n),0n);
  await usingInitializedStore(path,db=>{db.exec("UPDATE codex_turn_queue SET attempt_count=attempt_count+1");});assert.equal(await state.reconcileAsyncQuestionObservations(path,"resident",1n),0n);
  await usingInitializedStore(path,db=>{db.exec("UPDATE codex_turn_queue SET job_id='replacement',attempt_count=attempt_count-1");});assert.equal(await state.reconcileAsyncQuestionObservations(path,"resident",1n),0n);assert.equal((await inbox(path)).length,1);
}));
test("observation captures input before initialized open yields",async()=>storeFixture(async path=>{
  await running(path);const input=fresh();const pending=state.recordAsyncQuestionObservation(path,input);input.body.title="mutated";await pending;assert.match(String((await inbox(path))[0]!.body),/질문/);
}));
test("source UTF8 body limit is inclusive and checked before database access",async()=>storeFixture(async path=>{
  await running(path);const b={index:0n,source_text:"",title:"",options:[]};const empty='{"index":0,"source_text":"","title":"","options":[]}';b.title="x".repeat(32768-Buffer.byteLength(empty));await state.recordAsyncQuestionObservation(path,fresh({body:b}));
  await assert.rejects(state.recordAsyncQuestionObservation(path,fresh({item_id:"other",body:{...b,title:b.title+"x"}})),/oversized/);assert.equal((await inbox(path)).length,1);
}));
test("blank Rust-whitespace identities, invalid generation and nonfinite clock reject; BOM is retained",async()=>storeFixture(async path=>{
  await running(path);for(const value of [fresh({thread_id:"\u0085"}),fresh({item_id:"\u2028"}),fresh({generation:-1n}),fresh({generation:1n<<63n}),fresh({now:Infinity}),fresh({runtime_id:""})])await assert.rejects(state.recordAsyncQuestionObservation(path,value));
  await state.recordAsyncQuestionObservation(path,fresh({item_id:"\ufeff"}));assert.equal((await inbox(path))[0]!.item_id,"\ufeff");
}));
test("known decode failures do not overwrite stored body and a failed insert rolls back",async()=>storeFixture(async path=>{
  await running(path);await state.recordAsyncQuestionObservation(path,fresh());await usingInitializedStore(path,db=>{db.exec("UPDATE cdr_async_question_inbox SET body='not json'");});await assert.rejects(state.recordAsyncQuestionObservation(path,fresh()),SyntaxError);assert.equal((await inbox(path))[0]!.body,"not json");
  await usingInitializedStore(path,db=>{db.exec("CREATE TRIGGER reject_question BEFORE INSERT ON cdr_async_question_inbox BEGIN SELECT RAISE(ABORT,'question denied'); END");});await assert.rejects(state.recordAsyncQuestionObservation(path,fresh({item_id:"second"})),/question denied/);assert.equal((await inbox(path)).length,1);
}));
