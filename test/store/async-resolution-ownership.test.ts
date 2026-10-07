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
test("original sealed owner requires byte-exact claim, mirrored channel and whole running job", async () => {
  await fixture((db,row) => {
    assert.equal(exactAsyncOwnerIn(db,row),true);
    const owner=asyncExecutionOwnerIn(db,row);
    assert.equal(owner.generation,1n); assert.equal(owner.observer,"resident");
    db.exec("UPDATE codex_turn_queue SET attempt_count=attempt_count+1");
    assert.equal(exactAsyncOwnerIn(db,row),false);
  });
});
test("claim/mapping absence masks malformed owner evidence and never manufactures authority", async () => {
  for (const sql of ["DELETE FROM mirror_threads", "UPDATE mirror_threads SET discord_channel_id=3,discord_thread_id=4",
    "DELETE FROM codex_turn_queue"]) {
    await fixture((db,row) => {
      db.exec(sql);
      db.exec("DROP TABLE cdr_async_execution_handoffs");
      assert.doesNotThrow(() => assert.equal(exactAsyncOwnerIn(db,row),false), sql);
    });
  }
});
test("exact claim bytes matter even when equivalent JSON would parse identically", async () => {
  await fixture((db,row) => {
    db.exec("DROP TABLE cdr_async_execution_handoffs");
    assert.equal(exactAsyncOwnerIn(db,{...row,claim:row.claim+" "}),false);
  });
});
test("job timestamps are compared as IEEE bits and exact owner rejects changed observation and waiting state", async () => {
  const negative=executionOwnerJobValue(queueJob({createdAt:-0,updatedAt:1.25}));
  assert.equal(negative.created_at, 0x8000000000000000n);
  assert.equal(negative.updated_at,0x3ff4000000000000n);
  for(const sql of ["UPDATE codex_turn_queue SET goal_waiting=1", "UPDATE codex_turn_queue SET turn_observation_generation=2",
    "UPDATE codex_turn_queue SET updated_at=updated_at+0.0001", "UPDATE codex_turn_queue SET state='starting'"]) await fixture((db,row)=>{
      db.exec(sql); assert.equal(exactAsyncOwnerIn(db,row),false);
    });
});
test("malformed original seals and observer identities fail closed", async () => {
  await fixture((db,row) => {
    for (const seal of [null,"{}",'{"identity":{"job":null}}', "{" ]) {
      assert.throws(()=>asyncExecutionOwnerIn(db,{...row,original_seal:seal}));
    }
    for (const runtime_id of ["", "\u0085", "한".repeat(86)]) {
      assert.throws(()=>asyncExecutionOwnerIn(db,{...row,claim:serializeSerdeValue({generation:1n,runtime_id})}),/invalid execution owner/);
    }
    for (const generation of [-1n,1,9223372036854775808n]) {
      assert.throws(()=>asyncExecutionOwnerIn(db,{...row,claim:serializeSerdeValue({generation,runtime_id:"resident"})}));
    }
  });
});
test("latest handoff is hash and revision bound; malformed latest never falls back to original owner", async () => {
  await fixture((db,row)=>{
    const owner=asyncExecutionOwnerIn(db,row);
    const raw=serializeSerdeValue({version:1n,revision:7n,claim_sha256:row.claim_sha256,previous_terminal:"prior",owner});
    db.prepare("INSERT INTO cdr_async_execution_handoffs VALUES (?,?,?,?)").run("question",7,raw,createHash("sha256").update(raw).digest("hex"));
    assert.equal(asyncExecutionOwnerIn(db,row).observer,"resident");
    assert.equal(exactAsyncOwnerIn(db,row),true);
    db.prepare("INSERT INTO cdr_async_execution_handoffs VALUES (?,?,?,?)").run("question",8,"{}","0".repeat(64));
    assert.throws(()=>asyncExecutionOwnerIn(db,row),/invalid Goal ownership evidence/);
  });
});
test("well-hashed handoffs with stale claims/revisions or invalid owner reject", async () => {
  for(const changes of [{revision:8n},{claim_sha256:"wrong"},{version:2n},{owner:{turn_id:"other",generation:1n,observer:"resident",job:{}}}]) {
    await fixture((db,row)=>{
      const raw=serializeSerdeValue({version:1n,revision:7n,claim_sha256:row.claim_sha256,previous_terminal:"prior",owner:asyncExecutionOwnerIn(db,row),...changes});
      db.prepare("INSERT INTO cdr_async_execution_handoffs VALUES (?,?,?,?)").run("question",7,raw,createHash("sha256").update(raw).digest("hex"));
      assert.throws(()=>asyncExecutionOwnerIn(db,row));
    });
  }
});

function installProof(db: DatabaseSync, row: AsyncObligation, changes: Record<string, unknown> = {}): string {
  const metadata={threadId:"target",turn:{id:"turn",status:"completed"}};
  const raw=serializeSerdeValue({version:1n,source:"resident_notification_v1",observer:"resident",generation:1n,
    thread_id:"target",turn_id:"turn",canonical_terminal:metadata,payload_sha256:sha256SerdeValue(metadata),
    claim_sha256:row.claim_sha256,revision:row.revision,owner_verified:true,...changes});
  db.prepare("UPDATE cdr_async_execution_obligations SET terminal_proof_json=?").run(raw);
  return raw;
}
import { settleOwnedAsyncIn, retainAsyncTerminalJournalIn } from "../../src/store/async-resolution-terminal.ts";
const release={observer:"resident",generation:1n};
test("owned terminal settlement atomically retains proof and closes question, preserving caller rollback", async () => {
  await fixture((db,row)=>{
    const raw=installProof(db,row), expected=selectJob(db,"saved");
    db.exec("BEGIN IMMEDIATE"); settleOwnedAsyncIn(db,expected,release);
    assert.equal(db.isTransaction,true);
    assert.deepEqual({...db.prepare("SELECT execution_state,admission_state,answer_state,revision FROM cdr_async_execution_obligations").get()},
      {execution_state:"terminal",admission_state:"settled",answer_state:"terminal_without_receipt",revision:8});
    assert.equal(db.prepare("SELECT proof_json FROM cdr_async_terminal_settlements").get()?.proof_json,raw);
    assert.equal(db.prepare("SELECT state FROM cdr_async_questions").get()?.state,"closed_unknown");
    assert.equal(readAsyncObligationsIn(db,"target").length,0);
    db.exec("ROLLBACK"); assert.equal(readAsyncObligationsIn(db,"target").length,1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM cdr_async_terminal_settlements").get()?.n,0);
  });
});
test("missing/mismatched release and stale whole job cannot settle", async () => {
  for(const mode of ["none","observer","generation","job","proof","conflict"]) await fixture((db,row)=>{
    installProof(db,row,mode==="proof"?{owner_verified:false}:{});
    let expected=selectJob(db,"saved");
    if(mode==="job") expected={...expected,attemptCount:expected.attemptCount+1n};
    if(mode==="conflict") db.prepare("INSERT INTO cdr_async_terminal_candidates VALUES (?,?,?,?,?)").run("question",7,"conflict","digest","{}");
    db.exec("BEGIN IMMEDIATE");
    settleOwnedAsyncIn(db,expected,mode==="none"?null:mode==="observer"?{...release,observer:"other"}:mode==="generation"?{...release,generation:2n}:release);
    assert.equal(db.prepare("SELECT execution_state FROM cdr_async_execution_obligations").get()?.execution_state,"unresolved",mode);
    db.exec("ROLLBACK");
  });
});
test("settlement certificate insertion failure is visible and caller rollback restores obligation", async () => {
  await fixture((db,row)=>{
    installProof(db,row); const expected=selectJob(db,"saved");
    db.exec("CREATE TRIGGER test_reject BEFORE INSERT ON cdr_async_terminal_settlements BEGIN SELECT RAISE(ABORT,'test certificate failure'); END; BEGIN IMMEDIATE");
    assert.throws(()=>settleOwnedAsyncIn(db,expected,release),/test certificate failure/);
    db.exec("ROLLBACK");
    assert.equal(db.prepare("SELECT revision FROM cdr_async_execution_obligations").get()?.revision,7);
    assert.equal(db.prepare("SELECT state FROM cdr_async_questions").get()?.state,"dispatching");
  });
});
test("nonordinary policies remain held after exact terminal settlement", async () => {
  await fixture((db,row)=>{
    db.exec("UPDATE cdr_async_execution_obligations SET policy='review',answer_state='delivered'");
    installProof(db,row); db.exec("BEGIN IMMEDIATE"); settleOwnedAsyncIn(db,selectJob(db,"saved"),release);
    const result=db.prepare("SELECT admission_state,answer_state FROM cdr_async_execution_obligations").get()!;
    assert.equal(result.admission_state,"held"); assert.equal(result.answer_state,"delivered"); db.exec("ROLLBACK");
  });
});
function journal(db:DatabaseSync,payload=JSON.stringify({threadId:"target",turn:{id:"turn",status:"completed"}}),resident="resident"):void {
  db.prepare("INSERT INTO codex_observed_completions(thread_id,turn_id,generation,payload,resident_owner) VALUES ('target','turn',1,?,?)").run(payload,resident);
}
test("unresolved journal is removable only with exact accepted proof and matching resident notification", async () => {
  await fixture((db,row)=>{
    assert.equal(retainAsyncTerminalJournalIn(db,"target","turn"),false);
    journal(db); assert.equal(retainAsyncTerminalJournalIn(db,"target","turn"),true);
    installProof(db,row); assert.equal(retainAsyncTerminalJournalIn(db,"target","turn"),false);
    db.exec("UPDATE codex_observed_completions SET resident_owner='other'");
    assert.equal(retainAsyncTerminalJournalIn(db,"target","turn"),true);
  });
});
test("malformed ownership/proof and oversized notification retain journal; raw row decoding errors propagate", async () => {
  for(const mode of ["proof","payload","conflict","owner","generation","text"]) await fixture((db,row)=>{
    installProof(db,row); journal(db);
    if(mode==="proof") db.exec("UPDATE cdr_async_execution_obligations SET terminal_proof_json='{}'");
    if(mode==="payload") db.prepare("UPDATE codex_observed_completions SET payload=?").run("x".repeat(131073));
    if(mode==="conflict") db.prepare("INSERT INTO cdr_async_terminal_candidates VALUES (?,?,?,?,?)").run("question",7,"conflict","digest","{}");
    if(mode==="owner") db.exec("DROP TABLE cdr_async_execution_handoffs");
    if(mode==="generation") db.exec("UPDATE codex_observed_completions SET generation=2");
    if(mode==="text") db.exec("UPDATE codex_observed_completions SET payload=CAST(x'80' AS TEXT)");
    if(mode==="text") assert.throws(()=>retainAsyncTerminalJournalIn(db,"target","turn"),/Invalid text encoding/);
    else assert.equal(retainAsyncTerminalJournalIn(db,"target","turn"),true,mode);
  });
});
test("revision overflow and ignored settlement CAS cannot silently issue certificates", async () => {
  for (const overflow of [false,true]) await fixture((db,initial)=>{
    if(overflow) db.exec("UPDATE cdr_async_execution_obligations SET revision=9223372036854775807");
    const row=overflow?readAsyncObligationsIn(db,"target")[0]!:initial;
    installProof(db,row);
    if(!overflow) db.exec("CREATE TRIGGER test_ignore BEFORE UPDATE OF execution_state ON cdr_async_execution_obligations BEGIN SELECT RAISE(IGNORE); END");
    db.exec("BEGIN IMMEDIATE");
    assert.throws(()=>settleOwnedAsyncIn(db,selectJob(db,"saved"),release),overflow?/terminal revision overflow/:/lost its exact revision/);
    db.exec("ROLLBACK");
    assert.equal(db.prepare("SELECT count(*) AS n FROM cdr_async_terminal_settlements").get()?.n,0);
  });
});
test("oversized accepted proof throws during settlement, while a conflict masks its read", async () => {
  await fixture((db,row)=>{
    installProof(db,row); db.prepare("UPDATE cdr_async_execution_obligations SET terminal_proof_json=?").run("x".repeat(131073));
    db.exec("BEGIN IMMEDIATE");
    assert.throws(()=>settleOwnedAsyncIn(db,selectJob(db,"saved"),release),/oversized terminal proof must remain preserved/);
    db.exec("ROLLBACK");
    db.prepare("INSERT INTO cdr_async_terminal_candidates VALUES (?,?,?,?,?)").run("question",7,"conflict","digest","{}");
    db.exec("BEGIN IMMEDIATE");
    assert.doesNotThrow(()=>settleOwnedAsyncIn(db,selectJob(db,"saved"),release));
    assert.equal(db.prepare("SELECT execution_state FROM cdr_async_execution_obligations").get()?.execution_state,"unresolved");
    db.exec("ROLLBACK");
  });
});
test("settlement does not acquire a transaction or close the caller's connection", async () => {
  await fixture((db,row)=>{
    installProof(db,row);
    assert.throws(()=>settleOwnedAsyncIn(db,selectJob(db,"saved"),release),/requires an active transaction/);
    assert.equal(db.isOpen,true); assert.equal(db.isTransaction,false);
    assert.doesNotThrow(()=>settleOwnedAsyncIn(db,selectJob(db,"saved"),null));
  });
});

test("owned outbox completion combines settlement and queue deletion in one rollback boundary", async () => {
  for (const fail of [false,true]) await fixture(async(db,row,path)=>{
    installProof(db,row);journal(db);
    if(fail) db.exec("CREATE TRIGGER test_outbox_failure BEFORE INSERT ON codex_delivery_outbox BEGIN SELECT RAISE(ABORT,'outbox failed'); END");
    const operation=state.stageOwnedQueueCompletion(path,selectJob(db,"saved"),"final",5,release);
    if(fail) await assert.rejects(()=>operation,/outbox failed/);
    else assert.equal((await operation).content,"final");
    assert.equal(db.prepare("SELECT execution_state FROM cdr_async_execution_obligations").get()?.execution_state,fail?"unresolved":"terminal");
    assert.equal(db.prepare("SELECT count(*) AS n FROM codex_turn_queue").get()?.n,fail?1:0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM cdr_async_terminal_settlements").get()?.n,fail?0:1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM codex_observed_completions").get()?.n,fail?1:0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM cdr_idle_release").get()?.n,fail?0:1);
  });
});
import { recordAsyncTerminalNotification, asyncJournalObservationAllowedIn } from "../../src/store/async-resolution-terminal.ts";
const payload=(status="completed")=>JSON.stringify({threadId:"target",turn:{id:"turn",status}});
test("resident producer creates exact typed proof and enables later journal authorization",async()=>{
  await fixture(async(db,row,path)=>{
    assert.equal(asyncJournalObservationAllowedIn(db,"target","turn",1n,"resident",payload()),false);
    await recordAsyncTerminalNotification(path,"target","turn",1n,"resident",payload());
    const raw=db.prepare("SELECT terminal_proof_json FROM cdr_async_execution_obligations").get()?.terminal_proof_json;
    assert.equal(typeof raw,"string");
    assert.ok((raw as string).startsWith('{"version":1,"source":"resident_notification_v1","observer":"resident","generation":1,"thread_id":"target","turn_id":"turn","canonical_terminal":'));
    assert.ok((raw as string).endsWith('"revision":7,"owner_verified":true}'));
    assert.equal(asyncJournalObservationAllowedIn(db,"target","turn",1n,"resident",payload()),true);
    assert.equal(asyncJournalObservationAllowedIn(db,"target","turn",1n,"other",payload()),false);
    await recordAsyncTerminalNotification(path,"target","turn",1n,"resident",payload());
    assert.equal(db.prepare("SELECT count(*) AS n FROM cdr_async_terminal_candidates").get()?.n,0);
    await state.stageOwnedQueueCompletion(path,selectJob(db,"saved"),"final",5,release);
    assert.equal(db.prepare("SELECT execution_state FROM cdr_async_execution_obligations").get()?.execution_state,"terminal");
  });
});
test("conflicting accepted notification commits one conflict and keeps the accepted proof before throwing",async()=>{
  await fixture(async(db,row,path)=>{
    await recordAsyncTerminalNotification(path,"target","turn",1n,"resident",payload());
    const original=db.prepare("SELECT terminal_proof_json FROM cdr_async_execution_obligations").get()?.terminal_proof_json;
    await assert.rejects(()=>recordAsyncTerminalNotification(path,"target","turn",1n,"resident",payload("failed")),/conflicting accepted terminal/);
    await assert.rejects(()=>recordAsyncTerminalNotification(path,"target","turn",1n,"resident",payload("interrupted")),/conflicting accepted terminal/);
    assert.equal(db.prepare("SELECT count(*) AS n FROM cdr_async_terminal_candidates WHERE kind='conflict'").get()?.n,1);
    assert.equal(db.prepare("SELECT terminal_proof_json FROM cdr_async_execution_obligations").get()?.terminal_proof_json,original);
    assert.equal(asyncJournalObservationAllowedIn(db,"target","turn",1n,"resident",payload()),false);
  });
});
test("foreign observations are bounded diagnostics and cannot become accepted proof",async()=>{
  await fixture(async(db,row,path)=>{
    for(let i=0;i<12;i++) await recordAsyncTerminalNotification(path,"target","turn",BigInt(i+2),"other",payload());
    assert.equal(db.prepare("SELECT count(*) AS n FROM cdr_async_terminal_candidates WHERE kind='unverified'").get()?.n,8);
    assert.equal(db.prepare("SELECT terminal_proof_json FROM cdr_async_execution_obligations").get()?.terminal_proof_json,null);
    await recordAsyncTerminalNotification(path,"target","turn",1n,"resident",payload());
    assert.equal(asyncJournalObservationAllowedIn(db,"target","turn",1n,"resident",payload()),true);
  });
});
test("invalid proof replacement preserves exact bytes and stops when lifetime retention is full",async()=>{
  await fixture(async(db,row,path)=>{
    for(let i=0;i<3;i++) {
      const raw="invalid-proof-"+i;
      db.prepare("UPDATE cdr_async_execution_obligations SET terminal_proof_json=?").run(raw);
      const op=recordAsyncTerminalNotification(path,"target","turn",1n,"resident",payload());
      if(i<2) await op; else await assert.rejects(()=>op,/existing invalid proof must be retained/);
      if(i===2) assert.equal(db.prepare("SELECT terminal_proof_json FROM cdr_async_execution_obligations").get()?.terminal_proof_json,raw);
    }
    assert.deepEqual(db.prepare("SELECT evidence_text FROM cdr_async_terminal_candidates WHERE kind='replaced' ORDER BY evidence_text").all().map(r=>r.evidence_text),["invalid-proof-0","invalid-proof-1"]);
  });
});
test("unmatched notification skips observer and payload interpretation; matching invalid observer rejects",async()=>{
  await fixture(async(db,row,path)=>{
    await assert.doesNotReject(()=>recordAsyncTerminalNotification(path,"target","other",-1n,"","not json"));
    await assert.rejects(()=>recordAsyncTerminalNotification(path,"target","turn",-1n,"","not json"),/observer identity is invalid/);
    assert.equal(db.prepare("SELECT terminal_proof_json FROM cdr_async_execution_obligations").get()?.terminal_proof_json,null);
  });
});
test("lost proof CAS rolls back candidate retention instead of partially replacing evidence",async()=>{
  await fixture(async(db,row,path)=>{
    db.exec("UPDATE cdr_async_execution_obligations SET terminal_proof_json='invalid'; CREATE TRIGGER test_ignore_proof BEFORE UPDATE OF terminal_proof_json ON cdr_async_execution_obligations BEGIN SELECT RAISE(IGNORE); END");
    await assert.rejects(()=>recordAsyncTerminalNotification(path,"target","turn",1n,"resident",payload()),/accepted terminal proof lost/);
    assert.equal(db.prepare("SELECT count(*) AS n FROM cdr_async_terminal_candidates").get()?.n,0);
    assert.equal(db.prepare("SELECT terminal_proof_json FROM cdr_async_execution_obligations").get()?.terminal_proof_json,"invalid");
  });
});
test("live resident journaling preserves proof across later journal failure, then safely retries",async()=>{
  await fixture(async(db,row,path)=>{
    db.exec("CREATE TRIGGER test_journal_failure BEFORE INSERT ON codex_observed_completions BEGIN SELECT RAISE(ABORT,'journal failed'); END");
    await assert.rejects(()=>state.recordObservedCompletionForResident(path,"target","turn",1n,payload(),"resident"),/journal failed/);
    assert.equal(typeof db.prepare("SELECT terminal_proof_json FROM cdr_async_execution_obligations").get()?.terminal_proof_json,"string");
    assert.equal(db.prepare("SELECT count(*) AS n FROM codex_observed_completions").get()?.n,0);
    db.exec("DROP TRIGGER test_journal_failure");
    assert.equal(await state.recordObservedCompletionForResident(path,"target","turn",1n,payload(),"resident"),true);
    assert.equal(db.prepare("SELECT resident_owner FROM codex_observed_completions").get()?.resident_owner,"resident");
    assert.equal(await state.recordObservedCompletionForResident(path,"target","turn",1n,payload(),"resident"),false);
    await state.stageOwnedQueueCompletion(path,selectJob(db,"saved"),"final",5,release);
    assert.equal(db.prepare("SELECT count(*) AS n FROM codex_observed_completions").get()?.n,0);
  });
});
test("foreign resident notification remains diagnostic and cannot enter the owned journal",async()=>{
  await fixture(async(db,row,path)=>{
    assert.equal(await state.recordObservedCompletionForResident(path,"target","turn",1n,payload(),"foreign"),false);
    assert.equal(db.prepare("SELECT count(*) AS n FROM codex_observed_completions").get()?.n,0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM cdr_async_terminal_candidates WHERE kind='unverified'").get()?.n,1);
  });
});
