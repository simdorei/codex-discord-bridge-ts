import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { storeFixture } from "../helpers/store-fixture.ts";
import { queueJob } from "../helpers/queue-job.ts";
import { StateAccessFacade as state } from "../../src/store/state-access-facade.ts";
import { openInitialized } from "../../src/store/owned-driver.ts";
import { selectJob } from "../../src/store/queue-read.ts";
import { holdIn } from "../../src/store/execution-hold.ts";
import { AsyncResolutionHeldError } from "../../src/store/async-resolution-admission.ts";
import { REVIEWED_INCIDENT_THREAD } from "../../src/store/async-resolution-policy.ts";

async function edit(path: string, change: (db: DatabaseSync) => void): Promise<void> {
  const db = await openInitialized(path);
  try { change(db); } finally { db.close(); }
}

test("atomic claim wins once across competing callers and freezes baseline before await", async () => {
  await storeFixture(async path => {
    await state.enqueue(path, queueJob());
    const baseline = ["before"];
    const first = state.tryBeginAttempt(path, "saved", baseline, 1n);
    baseline[0] = "changed";
    const second = state.tryBeginAttempt(path, "saved", [], 1n);
    const results = await Promise.all([first, second]);
    assert.equal(results.filter(value => value !== null).length, 1);
    const winner = results.find(value => value !== null)!;
    assert.equal(winner.state, "Starting"); assert.equal(winner.attemptCount, 1n);
    assert.equal(winner.executionGeneration, 1n); assert.equal(winner.turnId, null);
    assert.equal(winner.turnObservationGeneration, null); assert.equal(winner.goalWaiting, false);
    assert.deepEqual(winner.baselineTurnIds, ["before"]);
    await edit(path, db => assert.equal(selectJob(db, "saved").attemptCount, 1n));
  });
});

test("missing jobs and stale generations do not create claims", async () => {
  await storeFixture(async path => {
    assert.equal(await state.tryBeginAttempt(path, "missing", [], 1n), null);
    await state.enqueue(path, queueJob());
    assert.equal(await state.tryBeginAttempt(path, "saved", [], 2n), null);
    await edit(path, db => {
      const job = selectJob(db, "saved"); assert.equal(job.state, "Pending"); assert.equal(job.attemptCount, 0n);
    });
  });
});

test("attempt count saturates at signed i64 maximum", async () => {
  await storeFixture(async path => {
    await state.enqueue(path, queueJob());
    await edit(path, db => db.exec("UPDATE codex_turn_queue SET attempt_count=9223372036854775807"));
    assert.equal((await state.tryBeginAttempt(path, "saved", [], 1n))?.attemptCount, 9223372036854775807n);
  });
});

test("durable holds and legacy reserve prefixes suppress claims without mutation", async () => {
  for (const heldBy of ["record", "prefix"]) await storeFixture(async path => {
    await state.enqueue(path, queueJob());
    await edit(path, db => {
      if (heldBy === "record") holdIn(db, "saved", "target", "", "{}");
      else db.exec("UPDATE codex_turn_queue SET last_error='[cdr-rust:auto-reserve-hold:v1] paused'");
    });
    assert.equal(await state.tryBeginAttempt(path, "saved", [], 1n), null);
    await edit(path, db => assert.equal(selectJob(db, "saved").attemptCount, 0n));
  });
});

test("async admission hold throws its typed error and keeps Pending intact", async () => {
  await storeFixture(async path => {
    await state.enqueue(path, queueJob({targetThreadId: REVIEWED_INCIDENT_THREAD}));
    await assert.rejects(state.tryBeginAttempt(path, "saved", [], 1n), AsyncResolutionHeldError);
    await edit(path, db => {
      const job = selectJob(db, "saved"); assert.equal(job.state, "Pending"); assert.equal(job.attemptCount, 0n);
    });
  });
});

test("native mutation failure rolls back and releases the writer for a later claim", async () => {
  await storeFixture(async path => {
    await state.enqueue(path, queueJob());
    await edit(path, db => db.exec(`CREATE TRIGGER fail_claim BEFORE UPDATE ON codex_turn_queue
      BEGIN SELECT RAISE(ABORT,'claim denied'); END`));
    await assert.rejects(state.tryBeginAttempt(path, "saved", [], 1n), /claim denied/);
    await edit(path, db => {
      assert.equal(selectJob(db, "saved").state, "Pending"); db.exec("DROP TRIGGER fail_claim");
    });
    assert.equal((await state.tryBeginAttempt(path, "saved", [], 1n))?.attemptCount, 1n);
  });
});

test("baseline accessors/proxies and invalid IDs reject before database creation", async () => {
  await storeFixture(async path => {
    let hits = 0; const baseline: string[] = [];
    Object.defineProperty(baseline, "0", {get: () => { hits++; return "bad"; }});
    await assert.rejects(state.tryBeginAttempt(path, "saved", baseline, 1n), TypeError);
    await assert.rejects(state.tryBeginAttempt(path, "saved", new Proxy([], {}), 1n), TypeError);
    await assert.rejects(state.tryBeginAttempt(path, "\ud800", [], 1n), TypeError);
    await assert.rejects(state.tryBeginAttempt(path, "saved", [], 9223372036854775808n), TypeError);
    assert.equal(hits, 0); assert.equal(existsSync(path), false);
  });
});

test("dead target and sealed current runtime generation prevent claims", async () => {
  for (const mode of ["target", "generation"]) await storeFixture(async path => {
    await state.enqueue(path, queueJob());
    await edit(path, db => {
      if (mode === "target") db.exec(`INSERT INTO codex_dead_generation_holds
        (target_thread_id,runtime_id,generation,created_at) VALUES ('target','runtime',1,0)`);
      else db.exec(`INSERT INTO codex_app_server_runtime(singleton,runtime_id) VALUES (1,'runtime');
        INSERT INTO codex_dead_generation_incidents(runtime_id,generation,snapshot_json,queue_jobs_json,created_at)
        VALUES ('runtime',1,'{}','[]',0)`);
    });
    assert.equal(await state.tryBeginAttempt(path, "saved", [], 1n), null);
    await edit(path, db => assert.equal(selectJob(db, "saved").attemptCount, 0n));
  });
});

test("unresolved fork and ignored UPDATE return no claim without advancing attempts", async () => {
  for (const mode of ["fork", "ignore"]) await storeFixture(async path => {
    await state.enqueue(path, queueJob());
    await edit(path, db => {
      if (mode === "fork") db.exec(`INSERT INTO codex_thread_fork_handoffs
        (handoff_id,source_thread_id,expected_generation,discord_channel_id,discord_thread_id,quarantine_reason,created_at)
        VALUES ('handoff','target',1,1,1,'uncertain',0)`);
      else db.exec("CREATE TRIGGER ignore_claim BEFORE UPDATE ON codex_turn_queue BEGIN SELECT RAISE(IGNORE); END");
    });
    assert.equal(await state.tryBeginAttempt(path, "saved", [], 1n), null);
    await edit(path, db => assert.equal(selectJob(db, "saved").attemptCount, 0n));
  });
});

test("a hold short-circuits the clock and non-finite clocks roll back", async ctx => {
  await storeFixture(async path => {
    await state.enqueue(path, queueJob());
    ctx.mock.method(Date, "now", () => Number.NaN);
    await assert.rejects(state.tryBeginAttempt(path, "saved", [], 1n), /clock must be finite/);
    await edit(path, db => {
      assert.equal(selectJob(db, "saved").state, "Pending");
      holdIn(db, "saved", "target", "held", "{}");
    });
    assert.equal(await state.tryBeginAttempt(path, "saved", [], 1n), null);
  });
});

test("claimed failures preserve ambiguity, Unicode bounds and attempt count", async () => {
  for (const ambiguous of [false, true]) await storeFixture(async path => {
    await state.enqueue(path, queueJob());
    const claim = (await state.tryBeginAttempt(path, "saved", ["old"], 1n))!;
    const result = await state.recordStartFailureIfClaimed(path, claim, "\u0085" + "🌟".repeat(1001) + "\u0085", ambiguous);
    assert.equal(result?.state, ambiguous ? "Starting" : "Pending");
    assert.equal(result?.lastError, "🌟".repeat(1000));
    assert.equal(result?.attemptCount, 1n);
    await edit(path, db => assert.equal(db.prepare("SELECT count(*) AS n FROM cdr_execution_holds").get()?.n, 0));
  });
});

test("changed claim identity, generation, attempt, timestamp, baseline, turn or state rejects stale failure", async () => {
  const changes: [string, string | number | bigint][] = [
    ["target_thread_id", "moved"], ["app_server_generation", 2n], ["attempt_count", 2n],
    ["updated_at", 0], ["baseline_turn_ids", '["different"]'], ["turn_id", "ack"], ["state", "pending"],
  ];
  for (const [column, value] of changes) await storeFixture(async path => {
    await state.enqueue(path, queueJob());
    const claim = (await state.tryBeginAttempt(path, "saved", ["old"], 1n))!;
    await edit(path, db => db.prepare(`UPDATE codex_turn_queue SET ${column}=? WHERE job_id='saved'`).run(value));
    assert.equal(await state.recordStartFailureIfClaimed(path, claim, "late", false), null);
    await edit(path, db => assert.equal(selectJob(db, "saved").lastError, ""));
  });
});

test("baseline comparison preserves matching stored JSON spelling", async () => {
  await storeFixture(async path => {
    await state.enqueue(path, queueJob());
    const claim = (await state.tryBeginAttempt(path, "saved", ["old"], 1n))!;
    await edit(path, db => db.exec(`UPDATE codex_turn_queue SET baseline_turn_ids=' [ "old" ] '`));
    assert.equal((await state.recordStartFailureIfClaimed(path, claim, "failure", false))?.state, "Pending");
    await edit(path, db => assert.equal(db.prepare("SELECT baseline_turn_ids AS raw FROM codex_turn_queue").get()?.raw, ' [ "old" ] '));
  });
});

test("definite execution hold atomically stages durable hold and notice; ambiguous failure does not", async () => {
  for (const ambiguous of [false, true]) await storeFixture(async path => {
    await state.enqueue(path, queueJob());
    const claim = (await state.tryBeginAttempt(path, "saved", [], 1n))!;
    const pending = state.recordStartFailureIfClaimed(path, claim, "[cdr-rust:execution-held:v1] quota", ambiguous);
    claim.targetThreadId = "mutated-after-call"; claim.baselineTurnIds.push("mutated");
    const result = await pending;
    assert.equal(result?.targetThreadId, "target");
    await edit(path, db => {
      assert.equal(db.prepare("SELECT count(*) AS n FROM cdr_execution_holds").get()?.n, ambiguous ? 0 : 1);
      assert.equal(db.prepare("SELECT count(*) AS n FROM codex_reserve_start_notices").get()?.n, ambiguous ? 0 : 1);
    });
    if (!ambiguous) assert.equal(await state.tryBeginAttempt(path, "saved", [], 1n), null);
  });
});

test("notice failure rolls back the state and hold in the same transaction", async () => {
  await storeFixture(async path => {
    await state.enqueue(path, queueJob());
    const claim = (await state.tryBeginAttempt(path, "saved", [], 1n))!;
    await edit(path, db => db.exec(`CREATE TRIGGER fail_notice BEFORE INSERT ON codex_reserve_start_notices
      BEGIN SELECT RAISE(ABORT,'notice denied'); END`));
    await assert.rejects(state.recordStartFailureIfClaimed(path, claim, "[cdr-rust:execution-held:v1] quota", false), /notice denied/);
    await edit(path, db => {
      const stored = selectJob(db, "saved");
      assert.equal(stored.state, "Starting"); assert.equal(stored.lastError, "");
      assert.equal(db.prepare("SELECT count(*) AS n FROM cdr_execution_holds").get()?.n, 0);
    });
  });
});

test("claim accessors are rejected without calling them or creating a database", async () => {
  await storeFixture(async path => {
    let hits = 0; const claim = queueJob();
    Object.defineProperty(claim, "jobId", {get: () => { hits++; return "saved"; }});
    await assert.rejects(state.recordStartFailureIfClaimed(path, claim, "failure", false), TypeError);
    assert.equal(hits, 0); assert.equal(existsSync(path), false);
  });
});

test("non-resident ACK is claim-fenced, records origin and cannot overwrite a committed turn", async () => {
  await storeFixture(async path => {
    await state.enqueue(path, queueJob());
    const claim = (await state.tryBeginAttempt(path, "saved", ["old"], 1n))!;
    const running = await state.markRunningIfClaimed(path, claim, "new-turn");
    assert.equal(running?.state, "Running"); assert.equal(running?.turnId, "new-turn");
    assert.equal(running?.turnObservationGeneration, 1n);
    assert.equal(running?.executionGeneration, 1n);
    assert.equal(running?.attemptCount, 1n);
    assert.equal(await state.markRunningIfClaimed(path, claim, "late-replacement"), null);
    await edit(path, db => {
      assert.equal(selectJob(db, "saved").turnId, "new-turn");
      assert.equal(db.prepare("SELECT count(*) AS n FROM codex_session_mirror_events").get()?.n, 1);
    });
  });
});

test("ACK turn tampering and origin-record failure roll back the Starting transition", async () => {
  for (const mode of ["tamper", "origin"]) await storeFixture(async path => {
    await state.enqueue(path, queueJob());
    const claim = (await state.tryBeginAttempt(path, "saved", [], 1n))!;
    await edit(path, db => db.exec(mode === "tamper"
      ? `CREATE TRIGGER tamper_ack AFTER UPDATE OF turn_id ON codex_turn_queue
         WHEN NEW.turn_id='ack' BEGIN UPDATE codex_turn_queue SET turn_id='wrong' WHERE job_id=NEW.job_id; END`
      : `CREATE TRIGGER fail_origin BEFORE INSERT ON codex_session_mirror_events
         BEGIN SELECT RAISE(ABORT,'origin denied'); END`));
    await assert.rejects(state.markRunningIfClaimed(path, claim, "ack"), mode === "tamper" ? /ACK turn differs/ : /origin denied/);
    await edit(path, db => {
      const stored = selectJob(db, "saved"); assert.equal(stored.state, "Starting"); assert.equal(stored.turnId, null);
      assert.equal(db.prepare("SELECT count(*) AS n FROM codex_session_mirror_events").get()?.n, 0);
    });
  });
});
