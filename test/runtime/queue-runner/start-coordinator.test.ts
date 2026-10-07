import assert from "node:assert/strict";
import { test } from "node:test";
import { storeFixture } from "../../helpers/store-fixture.ts";
import { queueJob } from "../../helpers/queue-job.ts";
import { StateAccessFacade as state } from "../../../src/store/state-access-facade.ts";
import { openInitialized } from "../../../src/store/owned-driver.ts";
import { AdmissionGate, DrainFenceKey } from "../../../src/admission/drain-gate.ts";
import { REVIEWED_INCIDENT_THREAD } from "../../../src/store/async-resolution-policy.ts";
import {
  QueueStartCoordinator, BackendFailureError, AttemptClaimLostError,
  QueueIntegerRangeError,
  retryDelaySeconds, pendingRetryDueAt, pendingRetryIsDue,
} from "../../../src/runtime/queue-runner/start-coordinator.ts";
import type { QueueStartBackend } from "../../../src/runtime/queue-runner/start-coordinator.ts";

function backend(overrides: Partial<QueueStartBackend> = {}): {value: QueueStartBackend; calls: string[]} {
  const calls: string[] = [];
  const value: QueueStartBackend = {
    generation: () => { calls.push("generation"); return 1n; },
    residentInstanceId: () => { calls.push("resident"); return "resident"; },
    activeTurnId: async () => { calls.push("active"); return null; },
    resumeThread: async () => { calls.push("resume"); },
    readTurns: async () => { calls.push("read"); return [{turnId: "baseline"}]; },
    startClaimedTurn: async claim => { calls.push("start"); assert.equal(claim.state, "Starting"); return "ack"; },
    ...overrides,
  };
  return {value, calls};
}
async function update(path: string, sql: string): Promise<void> {
  const db = await openInitialized(path); try { db.exec(sql); } finally { db.close(); }
}
const fence = (): DrainFenceKey => DrainFenceKey.create("runtime", "1|2", "nonce");

test("runtime error display preserves backend/claim-loss context", () => {
  assert.equal(new BackendFailureError({kind: "Other", ambiguous: true, message: "failed"}).message,
    "Codex turn backend failed: failed");
  assert.equal(new AttemptClaimLostError("j", null).message,
    "durable queue attempt ownership changed for job j after backend start observation None; automatic replay is blocked");
  assert.equal(new AttemptClaimLostError("j", "ack").message,
    'durable queue attempt ownership changed for job j after backend start observation Some("ack"); automatic replay is blocked');
});

test("invalid backend generations reject before any store call and release the mutex", async () => {
  for (const generation of [-1n, 9223372036854775808n]) {
    const queue = new QueueStartCoordinator("unused", backend({generation: () => generation}).value, {
      state: {...state, asyncTargetDispatchHeld: async () => { throw new Error("unexpected store read"); }},
    });
    await assert.rejects(queue.kickTarget("target"), QueueIntegerRangeError);
    assert.equal(queue.locks.activeTargetCount, 0);
  }
});

test("retry boundaries preserve Rust integer count and finite-time semantics", () => {
  assert.deepEqual([-1n, 0n, 1n, 2n, 3n, 4n, 5n, 6n, 9223372036854775807n].map(retryDelaySeconds),
    [0, 0, 30, 60, 120, 240, 480, 900, 900]);
  assert.equal(pendingRetryDueAt(1n, "failed", 10), 40);
  assert.equal(pendingRetryIsDue(1n, "failed", 10, 39.999), false);
  assert.equal(pendingRetryIsDue(1n, "failed", 10, 40), true);
  assert.equal(pendingRetryIsDue(1n, "failed", 10, NaN), false);
  assert.equal(pendingRetryDueAt(1n, "failed", Infinity), null);
  assert.equal(pendingRetryIsDue(0n, "", 0, NaN), true);
});

test("real queued job starts once across simultaneous kicks, with preflight before claim dispatch", async () => {
  await storeFixture(async path => {
    await state.enqueue(path, queueJob()); const b = backend();
    const queue = new QueueStartCoordinator(path, b.value);
    await Promise.all([queue.kickTarget("target"), queue.kickTarget("target")]);
    assert.deepEqual(b.calls.slice(0, 6), ["generation", "active", "resume", "read", "resident", "start"]);
    assert.equal(b.calls.filter(call => call === "start").length, 1);
    const job = (await state.listFiltered(path, "target", null))[0]!;
    assert.equal(job.state, "Running"); assert.equal(job.turnId, "ack");
    assert.deepEqual(job.baselineTurnIds, ["baseline"]); assert.equal(job.attemptCount, 1n);
    assert.equal(queue.locks.activeTargetCount, 0);
  });
});

test("resident identity is captured before dispatch and not borrowed from a replacement", async () => {
  await storeFixture(async path => {
    await state.enqueue(path, queueJob()); let resident = "original"; let captured: string | null = null;
    const b = backend({residentInstanceId: () => resident, startClaimedTurn: async () => { resident = "replacement"; return "ack"; }});
    const queue = new QueueStartCoordinator(path, b.value, {state: {...state,
      markRunningWithResidentIfClaimed: async (...args) => { captured = args[3]; return state.markRunningWithResidentIfClaimed(...args); },
    }});
    await queue.kickTarget("target"); assert.equal(captured, "original");
  });
});

test("backend receives an owned immutable claim and cannot change ACK ownership", async () => {
  await storeFixture(async path => {
    await state.enqueue(path, queueJob());
    const queue = new QueueStartCoordinator(path, backend({startClaimedTurn: async claim => {
      assert.equal(Object.isFrozen(claim), true); assert.equal(Object.isFrozen(claim.baselineTurnIds), true);
      assert.equal(Reflect.set(claim, "attemptCount", 99n), false);
      assert.equal(Reflect.set(claim.baselineTurnIds, "0", "different"), false);
      return "ack";
    }}).value);
    await queue.kickTarget("target");
    const job = (await state.listFiltered(path, "target", null))[0]!;
    assert.equal(job.attemptCount, 1n); assert.deepEqual(job.baselineTurnIds, ["baseline"]);
    assert.equal(job.turnId, "ack");
  });
});

test("an older pending head or any older active attempt blocks a newer queued job", async () => {
  for (const active of [false, true]) await storeFixture(async path => {
    await state.enqueue(path, queueJob({jobId: "old", appServerGeneration: 1n, createdAt: 1}));
    await state.enqueue(path, queueJob({jobId: "new", appServerGeneration: 2n, createdAt: 2}));
    if (active) await update(path, "UPDATE codex_turn_queue SET state='running',turn_id='old-turn',execution_generation=1,turn_observation_generation=1 WHERE job_id='old'");
    const b = backend({generation: () => 2n});
    await new QueueStartCoordinator(path, b.value).kickTarget("target");
    assert.deepEqual(b.calls, []);
    assert.equal((await state.listFiltered(path, "target", 2n))[0]?.state, "Pending");
  });
});

test("async hold and sealed admission prevent subsequent start-path reads", async () => {
  await storeFixture(async path => {
    await state.enqueue(path, queueJob({targetThreadId: REVIEWED_INCIDENT_THREAD}));
    const b = backend(); const gate = new AdmissionGate(); const key = fence(); gate.seal(key);
    const queue = new QueueStartCoordinator(path, b.value, {admission: gate, state: {...state,
      deadTargetHeld: async () => { throw new Error("must not reach dead-target check"); },
    }});
    await queue.kickTarget(REVIEWED_INCIDENT_THREAD); await queue.kickTarget("clear");
    assert.deepEqual(b.calls, ["generation", "generation"]);
    assert.equal(gate.isDrainedFor(key), true);
  });
});

test("active backend turn prevents resume, claim and new dispatch", async () => {
  await storeFixture(async path => {
    await state.enqueue(path, queueJob()); const b = backend({activeTurnId: async () => ""});
    await new QueueStartCoordinator(path, b.value).kickTarget("target");
    assert.deepEqual(b.calls, ["generation"]);
    assert.equal((await state.listFiltered(path, "target", null))[0]?.attemptCount, 0n);
  });
});

test("known resume/read preflight errors are recorded without dispatch, and release the gate", async () => {
  for (const stage of ["resumeThread", "readTurns"] as const) await storeFixture(async path => {
    await state.enqueue(path, queueJob());
    const failure = new BackendFailureError({kind: "Other", ambiguous: false, message: "preflight failed"});
    const b = backend({[stage]: async () => { throw failure; }});
    const gate = new AdmissionGate(); const queue = new QueueStartCoordinator(path, b.value, {admission: gate});
    await assert.rejects(queue.kickTarget("target"), error => error === failure);
    const job = (await state.listFiltered(path, "target", null))[0]!;
    assert.equal(job.state, "Pending"); assert.equal(job.attemptCount, 1n); assert.equal(job.lastError, "preflight failed");
    assert.equal(b.calls.includes("start"), false);
    const key = fence(); gate.seal(key); assert.equal(gate.isDrainedFor(key), true);
    assert.equal(queue.locks.activeTargetCount, 0);
  });
});

test("usage-limit failure stages durable hold/notice and never retries on a later kick", async () => {
  await storeFixture(async path => {
    await state.enqueue(path, queueJob()); let starts = 0; let notices = 0;
    const failure = new BackendFailureError({kind: "UsageLimit", ambiguous: false, message: "quota"});
    const b = backend({startClaimedTurn: async () => { starts++; throw failure; }});
    const queue = new QueueStartCoordinator(path, b.value, {notifyDeliveryReady: () => { notices++; }});
    await assert.rejects(queue.kickTarget("target"), error => error === failure);
    await queue.kickTarget("target"); assert.equal(starts, 1); assert.equal(notices, 1);
    const db = await openInitialized(path);
    try {
      assert.equal(db.prepare("SELECT count(*) AS n FROM cdr_execution_holds").get()?.n, 1);
      assert.equal(db.prepare("SELECT count(*) AS n FROM codex_reserve_start_notices").get()?.n, 1);
    } finally { db.close(); }
  });
});

test("ambiguous and unknown dispatch failures remain Starting and are not replayed", async () => {
  for (const failure of [new BackendFailureError({kind: "Other", ambiguous: true, message: "unknown outcome"}), new Error("untyped transport failure")])
    await storeFixture(async path => {
      await state.enqueue(path, queueJob()); let starts = 0;
      const queue = new QueueStartCoordinator(path, backend({startClaimedTurn: async () => { starts++; throw failure; }}).value);
      await assert.rejects(queue.kickTarget("target"), error => error === failure);
      await queue.kickTarget("target");
      assert.equal(starts, 1); assert.equal((await state.listFiltered(path, "target", null))[0]?.state, "Starting");
    });
});

test("definite failure observes retry delay before a new attempt", async () => {
  await storeFixture(async path => {
    await state.enqueue(path, queueJob()); let starts = 0; let clock = 0;
    const failure = new BackendFailureError({kind: "Other", ambiguous: false, message: "not sent"});
    const queue = new QueueStartCoordinator(path, backend({startClaimedTurn: async () => {
      if (++starts === 1) throw failure; return "ack";
    }}).value, {clock: () => clock});
    await assert.rejects(queue.kickTarget("target"), error => error === failure);
    const job = (await state.listFiltered(path, "target", null))[0]!;
    clock = job.updatedAt + 29; await queue.kickTarget("target"); assert.equal(starts, 1);
    clock = job.updatedAt + 30; await queue.kickTarget("target"); assert.equal(starts, 2);
    assert.equal((await state.listFiltered(path, "target", null))[0]?.attemptCount, 2n);
  });
});

test("changed attempt after dispatch raises claim-lost without overwriting newer ownership", async () => {
  for (const success of [false, true]) await storeFixture(async path => {
    await state.enqueue(path, queueJob());
    const queue = new QueueStartCoordinator(path, backend({startClaimedTurn: async () => {
      await update(path, "UPDATE codex_turn_queue SET attempt_count=attempt_count+1");
      if (success) return "observed-ack";
      throw new BackendFailureError({kind: "Other", ambiguous: false, message: "failed"});
    }}).value);
    await assert.rejects(queue.kickTarget("target"), error => {
      assert.ok(error instanceof AttemptClaimLostError);
      assert.equal(error.observedTurnId, success ? "observed-ack" : null); return true;
    });
    const job = (await state.listFiltered(path, "target", null))[0]!;
    assert.equal(job.attemptCount, 2n); assert.equal(job.state, "Starting"); assert.equal(job.turnId, null);
  });
});

test("an in-flight admitted dispatch keeps restart drain occupied until ACK finishes", async () => {
  await storeFixture(async path => {
    await state.enqueue(path, queueJob());
    let release!: () => void; let entered!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new AdmissionGate(); const key = fence();
    const queue = new QueueStartCoordinator(path, backend({startClaimedTurn: async () => {
      entered(); await waiting; return "ack";
    }}).value, {admission: gate});
    const pending = queue.kickTarget("target"); await started;
    gate.seal(key); assert.equal(gate.isDrainedFor(key), false);
    release(); await pending; assert.equal(gate.isDrainedFor(key), true);
  });
});

test("direct submit persists, claims and returns ACK; duplicate Discord message never starts twice", async () => {
  await storeFixture(async path => {
    const b = backend(); const queue = new QueueStartCoordinator(path, b.value);
    const first = await queue.submitIdentified("first", "target", 1n, 2n, 3n, "prompt");
    assert.deepEqual(first, {jobId: "first", queued: false, turnId: "ack"});
    const duplicate = await queue.submitIdentified("different-id", "target", 1n, 2n, 3n, "changed prompt");
    assert.deepEqual(duplicate, first);
    assert.equal(b.calls.filter(call => call === "start").length, 1);
    const jobs = await state.listFiltered(path, "target", null);
    assert.equal(jobs.length, 1); assert.equal(jobs[0]?.prompt, "prompt"); assert.equal(jobs[0]?.attemptCount, 1n);
  });
});

test("sealed restart gate keeps new work durable until a later admitted kick", async () => {
  await storeFixture(async path => {
    const gate = new AdmissionGate(); const key = fence(); gate.seal(key);
    const b = backend(); const queue = new QueueStartCoordinator(path, b.value, {admission: gate});
    assert.deepEqual(await queue.submitIdentified("j", "target", 1n, 2n, null, "prompt"),
      {jobId: "j", queued: true, turnId: null});
    assert.equal(b.calls.includes("start"), false); assert.equal(gate.isDrainedFor(key), true);
    assert.equal(gate.release(key), true); await queue.kickTarget("target");
    assert.equal((await state.listFiltered(path, "target", null))[0]?.state, "Running");
    assert.equal(b.calls.filter(call => call === "start").length, 1);
  });
});

test("async-held target saves the request and returns an execution-hold warning without dispatch", async () => {
  await storeFixture(async path => {
    const b = backend(); const queue = new QueueStartCoordinator(path, b.value);
    const result = await queue.submitIdentified("j", REVIEWED_INCIDENT_THREAD, 1n, 2n, null, "prompt");
    assert.equal(result.queued, true); assert.equal(result.warning?.kind, "ExecutionHeld");
    assert.equal(b.calls.includes("start"), false);
    assert.equal((await state.listFiltered(path, REVIEWED_INCIDENT_THREAD, null))[0]?.attemptCount, 0n);
  });
});

test("new submission waits for old-generation recovery instead of adopting or bypassing it", async () => {
  await storeFixture(async path => {
    await state.enqueue(path, queueJob({jobId: "old", createdAt: 0}));
    const b = backend({generation: () => 2n}); const queue = new QueueStartCoordinator(path, b.value);
    assert.deepEqual(await queue.submitIdentified("new", "target", 1n, 2n, null, "prompt"),
      {jobId: "new", queued: true, turnId: null});
    assert.deepEqual(b.calls, []);
    const jobs = await state.listFiltered(path, "target", null);
    assert.deepEqual(jobs.map(job => job.appServerGeneration), [1n, 2n]);
    assert.equal(jobs.every(job => job.attemptCount === 0n), true);
  });
});

test("submission returns the durable failure presentation, without discarding its job", async () => {
  for (const failure of [
    {kind: "Other", ambiguous: false, message: "not sent"},
    {kind: "Other", ambiguous: true, message: "uncertain"},
    {kind: "UsageLimit", ambiguous: false, message: "quota"},
  ] as const) await storeFixture(async path => {
    const queue = new QueueStartCoordinator(path, backend({startClaimedTurn: async () => { throw new BackendFailureError(failure); }}).value);
    const result = await queue.submitIdentified("j", "target", 1n, 2n, null, "prompt");
    assert.equal(result.queued, true); assert.equal(result.turnId, null);
    assert.equal(result.warning?.kind, failure.kind === "UsageLimit" ? "ExecutionHeld" : "Other");
    assert.equal(result.warning?.ambiguous, failure.ambiguous);
    assert.equal((await state.listFiltered(path, "target", null))[0]?.attemptCount, 1n);
  });
});

test("mirrored submission checks mapping before enqueue/dispatch", async () => {
  await storeFixture(async path => {
    const b = backend(); const queue = new QueueStartCoordinator(path, b.value);
    await assert.rejects(queue.submitMirrorIdentified("j", "target", 1n, 2n, null, "prompt"), /mirror mapping changed/);
    assert.equal((await state.listFiltered(path, "target", null)).length, 0);
    await update(path, `INSERT INTO mirror_threads VALUES ('target','project','title',9,1,0)`);
    assert.equal((await queue.submitMirrorIdentified("j", "target", 1n, 2n, null, "prompt")).turnId, "ack");
    assert.equal(b.calls.filter(call => call === "start").length, 1);
  });
});

test("an unrelated thread completes submission while another dispatch waits", async () => {
  await storeFixture(async path => {
    let release!: () => void; let entered!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const queue = new QueueStartCoordinator(path, backend({startClaimedTurn: async claim => {
      if (claim.targetThreadId === "slow") { entered(); await wait; }
      return `ack-${claim.targetThreadId}`;
    }}).value);
    const slow = queue.submitIdentified("slow-job", "slow", 1n, 2n, 3n, "slow prompt");
    await started;
    assert.equal((await queue.submitIdentified("fast-job", "fast", 1n, 2n, 4n, "fast prompt")).turnId, "ack-fast");
    assert.equal(queue.locks.activeTargetCount, 1);
    release(); assert.equal((await slow).turnId, "ack-slow");
    assert.equal(queue.locks.activeTargetCount, 0);
  });
});
test("completion persists delivery then notifies and starts the next queued job under the shared lock", async () => {
  await storeFixture(async path => {
    let starts=0, notifications=0;
    const b=backend({startClaimedTurn:async()=>"turn"+(++starts)});
    const queue=new QueueStartCoordinator(path,b.value,{notifyDeliveryReady:()=>{notifications++;}});
    await state.enqueue(path,queueJob()); await queue.kickTarget("target");
    const expected=(await state.listFiltered(path,"target",null))[0]!;
    await state.enqueue(path,queueJob({jobId:"next",createdAt:1}));
    const delivery=await queue.stageOwnedTurnCompletion(expected,"final",1n);
    assert.equal(delivery?.jobId,"saved"); assert.equal(notifications,1); assert.equal(starts,2);
    const remaining=await state.listFiltered(path,"target",null);
    assert.equal(remaining.length,1); assert.equal(remaining[0]!.jobId,"next"); assert.equal(remaining[0]!.turnId,"turn2");
    assert.equal(queue.locks.activeTargetCount,0);
  });
});
test("compatibility completion has no release authority; observed stable resident does",async()=>{
  for(const observed of [null,1n]) await storeFixture(async path=>{
    const queue=new QueueStartCoordinator(path,backend().value);
    await state.enqueue(path,queueJob());await queue.kickTarget("target");
    await queue.stageTurnCompletion("target","ack","final",observed);
    const db=await openInitialized(path);
    try{assert.equal(db.prepare("SELECT count(*) AS n FROM cdr_idle_release").get()?.n,observed===null?0:1);}finally{db.close();}
  });
});
test("generation or resident changes across state read suppress release without losing final delivery",async()=>{
  for(const change of ["generation","resident"]) await storeFixture(async path=>{
    await state.enqueue(path,queueJob());
    const claim=(await state.tryBeginAttempt(path,"saved",[],1n))!;await state.markRunningIfClaimed(path,claim,"ack");
    let generation=1n,resident="resident";
    const queue=new QueueStartCoordinator(path,backend({generation:()=>generation,residentInstanceId:()=>resident}).value,{state:{...state,
      listFiltered:async(...args)=>{const rows=await state.listFiltered(...args);if(change==="generation") generation=2n;else resident="other";return rows;},
    }});
    assert.equal((await queue.stageTurnCompletion("target","ack","final",1n))?.content,"final");
    const db=await openInitialized(path);try{assert.equal(db.prepare("SELECT count(*) AS n FROM cdr_idle_release").get()?.n,0);}finally{db.close();}
  });
});
test("completion rejects observed stale owner rather than selecting a newer attempt by ID",async()=>{
  await storeFixture(async path=>{
    const queue=new QueueStartCoordinator(path,backend().value);
    await state.enqueue(path,queueJob());await queue.kickTarget("target");
    const stale=(await state.listFiltered(path,"target",null))[0]!;
    await update(path,"UPDATE codex_turn_queue SET attempt_count=attempt_count+1");
    await assert.rejects(()=>queue.stageOwnedTurnCompletion(stale,"final",1n),/ownership changed during observation/);
    assert.equal((await state.listFiltered(path,"target",null)).length,1);
  });
});
test("held or unmatched completion is a no-op and does not notify",async()=>{
  let notifications=0;
  const b=backend();const queue=new QueueStartCoordinator("unused",b.value,{state:{...state,deadTargetHeld:async()=>true},notifyDeliveryReady:()=>{notifications++;}});
  assert.equal(await queue.stageTurnCompletion("target","turn","final",1n),null);
  assert.deepEqual(b.calls,[]);assert.equal(notifications,0);
  await storeFixture(async path=>{
    const unmatched=new QueueStartCoordinator(path,backend().value,{notifyDeliveryReady:()=>{notifications++;}});
    assert.equal(await unmatched.stageTurnCompletion("target","missing","final"),null);assert.equal(notifications,0);
  });
});
test("start-next failure after completion cannot undo the committed final",async()=>{
  await storeFixture(async path=>{
    await state.enqueue(path,queueJob());const claim=(await state.tryBeginAttempt(path,"saved",[],1n))!;
    await state.markRunningIfClaimed(path,claim,"turn");await state.enqueue(path,queueJob({jobId:"next",createdAt:1}));
    const sentinel=new Error("next preflight unknown");
    const queue=new QueueStartCoordinator(path,backend({resumeThread:async()=>{throw sentinel;}}).value);
    await assert.rejects(()=>queue.stageTurnCompletion("target","turn","final"),e=>e===sentinel);
    const db=await openInitialized(path);try{
      assert.equal(db.prepare("SELECT content FROM codex_delivery_outbox WHERE delivery_id='saved'").get()?.content,"final");
      assert.equal(db.prepare("SELECT count(*) AS n FROM codex_turn_queue WHERE job_id='saved'").get()?.n,0);
    }finally{db.close();}
    assert.equal(queue.locks.activeTargetCount,0);
  });
});
