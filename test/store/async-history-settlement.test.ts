import assert from "node:assert/strict";
import {test} from "node:test";
import type {DatabaseSync} from "node:sqlite";
import {storeFixture} from "../helpers/store-fixture.ts";
import {historicalQuestionFixture} from "../helpers/async-history-fixture.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {captureTerminalHistorySnapshot,settleTerminalHistory,type TerminalHistorySnapshot} from "../../src/store/async-history.ts";
import {serializeSerdeValue,sha256SerdeValue} from "../../src/core/serde-json.ts";
import {readAsyncObligationsIn} from "../../src/store/async-resolution-records.ts";
import {serializeTerminalEvidence} from "../../src/store/async-resolution-proof.ts";
async function fixture(run:(db:DatabaseSync,path:string,snapshot:TerminalHistorySnapshot)=>Promise<void>):Promise<void>{
  await storeFixture(async path=>{
    const f=historicalQuestionFixture(),db=await openInitialized(path);
    try{
      db.exec("INSERT INTO mirror_threads VALUES ('target','project','title',1,1,0)");
      db.prepare(`INSERT INTO cdr_async_questions(id,runtime_id,generation,thread_id,turn_id,item_id,origin_job_id,channel_id,owner_user_id,
        body,owner_confirmed,state,message_id,chosen,dispatch_mode,preparation_json,created_at,updated_at)
        VALUES ('q','resident',1,'target','turn','item','job',1,2,?,1,'dispatching','message',1,'steer',?,0,0)`)
        .run(serializeSerdeValue(f.body),f.row.original_seal);
      db.exec(`INSERT INTO cdr_async_execution_obligations(question_id,thread_id,origin_job_id,turn_id,channel_id,format_version,revision,
        answer_state,execution_state,admission_state,policy,original_seal,claim_json,original_error,created_at,updated_at)
        SELECT q.id,q.thread_id,q.origin_job_id,q.turn_id,q.channel_id,1,7,'unresolved','unresolved','held','ordinary',q.preparation_json,
          json_object('id',q.id,'runtime_id',q.runtime_id,'generation',q.generation,'thread_id',q.thread_id,'turn_id',q.turn_id,'item_id',q.item_id,
          'origin_job_id',q.origin_job_id,'channel_id',q.channel_id,'owner_user_id',q.owner_user_id,'body',q.body,'chosen',q.chosen,'message_id',q.message_id,'dispatch_mode',q.dispatch_mode),
          'original',0,0 FROM cdr_async_questions q`);
      const snapshot=await captureTerminalHistorySnapshot(path,"target");assert.ok(snapshot);await run(db,path,snapshot);
    }finally{db.close();}
  });
}
function observed(){return {threadId:"target",truncated:false,thread_observation:{thread:{id:"target",status:{type:"idle"}}},goal_observation:{goal:null as unknown},turns:[{id:"turn",status:"completed"}]};}
function insertJob(db:DatabaseSync,id="job",state="pending"):void{
  db.prepare(`INSERT INTO codex_turn_queue(job_id,target_thread_id,channel_id,prompt,queued,ack_sent,state,attempt_count,baseline_turn_ids,created_at,updated_at,app_server_generation)
    VALUES (?,'target',1,'prompt',1,1,?,0,'[]',0,0,1)`).run(id,state);
}
test("orphan historical terminal settles exact certificate without creating queue or resident notification",async()=>{
  await fixture(async(db,path,snapshot)=>{
    assert.deepEqual(snapshot.turnIds(),["turn"]);
    assert.equal(await settleTerminalHistory(path,snapshot,observed(),"reader",2n),1);
    const row=db.prepare("SELECT execution_state,admission_state,answer_state,revision FROM cdr_async_execution_obligations").get()!;
    assert.deepEqual({...row},{execution_state:"terminal",admission_state:"settled",answer_state:"terminal_without_receipt",revision:8});
    assert.equal(db.prepare("SELECT state FROM cdr_async_questions").get()?.state,"closed_unknown");
    assert.equal(db.prepare("SELECT count(*) AS n FROM codex_turn_queue").get()?.n,0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM codex_observed_completions").get()?.n,0);
    assert.equal(readAsyncObligationsIn(db,"target").length,0);
  });
});
test("terminal observation requires exact idle thread, ended Goal and unique typed owner turn",async()=>{
  for(const mode of ["thread","busy","goal","truncated","missing","duplicate","inProgress"])await fixture(async(db,path,snapshot)=>{
    const value=observed();
    if(mode==="thread")value.thread_observation.thread.id="other";
    if(mode==="busy")value.thread_observation.thread.status.type="active";
    if(mode==="goal")value.goal_observation.goal={threadId:"target",status:"active"};
    if(mode==="truncated")value.truncated=true;
    if(mode==="missing")value.turns=[];
    if(mode==="duplicate")value.turns.push({...value.turns[0]!});
    if(mode==="inProgress")value.turns[0]!.status="inProgress";
    await assert.rejects(()=>settleTerminalHistory(path,snapshot,value,"reader",2n));
    assert.equal(db.prepare("SELECT execution_state FROM cdr_async_execution_obligations").get()?.execution_state,"unresolved");
  });
});
test("active target or reappearing original job invalidates orphan authority",async()=>{
  for(const mode of ["original","active"])await fixture(async(db,path,snapshot)=>{
    insertJob(db,mode==="original"?"job":"other",mode==="original"?"pending":"starting");
    assert.equal(await captureTerminalHistorySnapshot(path,"target"),null);
    await assert.rejects(()=>settleTerminalHistory(path,snapshot,observed(),"reader",2n),/owner changed/);
  });
});
test("changed revision and forged terminal snapshot cannot settle",async()=>{
  await fixture(async(db,path,snapshot)=>{
    await assert.rejects(()=>settleTerminalHistory(path,{turnIds:()=>["turn"]},observed(),"reader",2n),/captured terminal history snapshot/);
    db.exec("UPDATE cdr_async_execution_obligations SET revision=8");
    await assert.rejects(()=>settleTerminalHistory(path,snapshot,observed(),"reader",2n),/snapshot changed/);
  });
});
test("ignored certificate or post-write original question tampering rolls back all settlement writes",async()=>{
  for(const mode of ["ignore","tamper"])await fixture(async(db,path,snapshot)=>{
    db.exec(mode==="ignore"?"CREATE TRIGGER test_ignore BEFORE INSERT ON cdr_async_terminal_settlements BEGIN SELECT RAISE(IGNORE); END":
      "CREATE TRIGGER test_tamper AFTER INSERT ON cdr_async_terminal_settlements BEGIN UPDATE cdr_async_questions SET error='changed' WHERE id='q'; END");
    await assert.rejects(()=>settleTerminalHistory(path,snapshot,observed(),"reader",2n),/atomic certificate|changed its original question/);
    assert.equal(db.prepare("SELECT revision FROM cdr_async_execution_obligations").get()?.revision,7);
    assert.equal(db.prepare("SELECT count(*) AS n FROM cdr_async_terminal_settlements").get()?.n,0);
    assert.equal(db.prepare("SELECT state FROM cdr_async_questions").get()?.state,"dispatching");
  });
});
test("publishing recovery stays held even after historical execution ends",async()=>{
  await fixture(async(db,path,snapshot)=>{
    db.exec("UPDATE cdr_async_execution_obligations SET policy='publishing_recovery',answer_state='exact_history_confirmed'");
    const current=await captureTerminalHistorySnapshot(path,"target");assert.ok(current);
    await settleTerminalHistory(path,current,observed(),"reader",2n);
    assert.equal(db.prepare("SELECT admission_state FROM cdr_async_execution_obligations").get()?.admission_state,"held");
    assert.equal(db.prepare("SELECT answer_state FROM cdr_async_execution_obligations").get()?.answer_state,"exact_history_confirmed");
  });
});
test("retained resident proof must agree with historical terminal status",async()=>{
  for(const status of ["completed","failed"])await fixture(async(db,path,snapshot)=>{
    const row=readAsyncObligationsIn(db,"target")[0]!,metadata={threadId:"target",turn:{id:"turn",status:"completed"}};
    const raw=serializeTerminalEvidence({version:1n,source:"resident_notification_v1",observer:"resident",generation:1n,thread_id:"target",turn_id:"turn",
      canonical_terminal:metadata,payload_sha256:sha256SerdeValue(metadata),claim_sha256:row.claim_sha256,revision:7n,owner_verified:true});
    db.prepare("UPDATE cdr_async_execution_obligations SET terminal_proof_json=?").run(raw);
    const current=await captureTerminalHistorySnapshot(path,"target");assert.ok(current);
    const value=observed();value.turns[0]!.status=status;
    if(status==="completed")assert.equal(await settleTerminalHistory(path,current,value,"reader",2n),1);
    else await assert.rejects(()=>settleTerminalHistory(path,current,value,"reader",2n),/lacks exact terminal evidence/);
  });
});
