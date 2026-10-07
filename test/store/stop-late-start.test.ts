import assert from "node:assert/strict";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { storeFixture } from "../helpers/store-fixture.ts";
import { queueJob } from "../helpers/queue-job.ts";
import { StateAccessFacade as state } from "../../src/store/state-access-facade.ts";
import { openInitialized, ActiveTransactionError } from "../../src/store/owned-driver.ts";
import { selectJob } from "../../src/store/queue-read.ts";
import type { StoredQueueJob } from "../../src/store/queue-read.ts";
import { holdIn } from "../../src/store/execution-hold.ts";
import { bindLateStartIn } from "../../src/store/stop-late-start.ts";

function scope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {target: "target", channel: 1, owner: 2, jobs: ["saved"], hadPreparing: false, ingresses: [],
    binding: {target: "target", route: "Explicit", command: {Stop: {reference: "target"}}}, ...overrides};
}
async function edit(path: string, fn: (db: DatabaseSync) => void): Promise<void> {
  const db = await openInitialized(path); try { fn(db); } finally { db.close(); }
}
async function claimed(path: string): Promise<StoredQueueJob> {
  await state.enqueue(path, queueJob({ownerUserId: 2n}));
  return (await state.tryBeginAttempt(path, "saved", ["old-turn"], 1n))!;
}
async function stop(path: string, value = scope()): Promise<void> {
  await edit(path, db => {
    db.exec("UPDATE cdr_stop_clock SET revision=1");
    db.prepare("INSERT INTO cdr_stop_revision_receipts VALUES ('stop-1','target',1,?)").run(JSON.stringify(value));
    db.exec("INSERT INTO cdr_stop_revisions VALUES ('target',1,'stop-1')");
    holdIn(db, "saved", "target", "stop", "original-evidence");
  });
}
async function assertStarting(path: string): Promise<void> {
  await edit(path, db => {
    const job = selectJob(db, "saved"); assert.equal(job.state, "Starting"); assert.equal(job.turnId, null);
    assert.equal(db.prepare("SELECT count(*) AS n FROM cdr_stop_controls").get()?.n, 0);
  });
}

test("late resident ACK binds exactly the accepted stop and opaque running-job evidence", async () => {
  await storeFixture(async path => {
    const before = await claimed(path); await stop(path);
    const result = await state.markRunningWithResidentIfClaimed(path, before, "ack-turn", "resident-original");
    assert.equal(result?.state, "Running");
    await edit(path, db => {
      const row = db.prepare("SELECT * FROM cdr_stop_controls").get()!;
      assert.equal(row.phase, "accepted"); assert.equal(row.resident_owner, "resident-original");
      assert.equal(row.turn_id, "ack-turn"); assert.equal(row.claim_token, null);
      const record = JSON.parse(row.record_json as string);
      assert.equal(record.can_settle, true); assert.equal(record.owner, 2);
      assert.equal(record.jobs.length, 1); assert.equal(typeof record.jobs[0], "string");
      assert.equal(JSON.parse(record.jobs[0]).state, "Running");
      assert.equal(JSON.parse(record.jobs[0]).turn_id, "ack-turn");
      assert.equal(db.prepare("SELECT reason FROM cdr_execution_holds").get()?.reason, "stop");
    });
  });
});

test("no scope and a scope excluding this job do not manufacture stop authority", async () => {
  for (const excluded of [false, true]) await storeFixture(async path => {
    const before = await claimed(path);
    if (excluded) await stop(path, scope({jobs: ["other"]}));
    assert.equal((await state.markRunningWithResidentIfClaimed(path, before, "ack", "resident"))?.state, "Running");
    await edit(path, db => assert.equal(db.prepare("SELECT count(*) AS n FROM cdr_stop_controls").get()?.n, 0));
  });
});

test("missing or broad scope evidence never permits settlement", async () => {
  for (const value of [scope({hadPreparing: true}), scope({hadPreparing: null}), scope({ingresses: ["ingress"]}),
    scope({ingresses: undefined}), scope({jobs: ["saved", "other"]})]) await storeFixture(async path => {
    const before = await claimed(path); await stop(path, value);
    await state.markRunningWithResidentIfClaimed(path, before, "ack", "resident");
    await edit(path, db => assert.equal(JSON.parse(db.prepare("SELECT record_json FROM cdr_stop_controls").get()?.record_json as string).can_settle, false));
  });
});

test("wrong scope ownership, blank resident and invalid/new baseline turns roll back ACK", async () => {
  const cases = [
    {value: scope({target: "other"}), turn: "ack", resident: "resident"},
    {value: scope({channel: 9}), turn: "ack", resident: "resident"},
    {value: scope({owner: 9}), turn: "ack", resident: "resident"},
    {value: scope({jobs: Array(129).fill("saved")}), turn: "ack", resident: "resident"},
    {value: scope(), turn: "old-turn", resident: "resident"},
    {value: scope(), turn: " ack", resident: "resident"},
    {value: scope(), turn: "", resident: "resident"},
    {value: scope(), turn: "ack", resident: "\u0085"},
  ];
  for (const item of cases) await storeFixture(async path => {
    const before = await claimed(path); await stop(path, item.value);
    await assert.rejects(state.markRunningWithResidentIfClaimed(path, before, item.turn, item.resident));
    await assertStarting(path);
  });
});

test("revision clock and per-target history inconsistencies refuse late ACK", async () => {
  for (const sql of ["UPDATE cdr_stop_clock SET revision=2", "UPDATE cdr_stop_revisions SET operation_id='different'"])
    await storeFixture(async path => {
      const before = await claimed(path); await stop(path); await edit(path, db => db.exec(sql));
      await assert.rejects(state.markRunningWithResidentIfClaimed(path, before, "ack", "resident"), /stop revision evidence differs/);
      await assertStarting(path);
    });
});

test("post-insert receipt/hold/queue mutations are detected and rolled back together", async () => {
  for (const sql of [
    "UPDATE cdr_stop_controls SET phase='unknown' WHERE operation_id=NEW.operation_id;",
    "UPDATE cdr_execution_holds SET reason='tampered' WHERE job_id='saved';",
    "UPDATE codex_turn_queue SET prompt='tampered' WHERE job_id='saved';",
    "UPDATE cdr_stop_revisions SET operation_id='tampered' WHERE target_thread_id='target';",
  ]) await storeFixture(async path => {
    const before = await claimed(path); await stop(path);
    await edit(path, db => db.exec(`CREATE TRIGGER tamper_control AFTER INSERT ON cdr_stop_controls BEGIN ${sql} END`));
    await assert.rejects(state.markRunningWithResidentIfClaimed(path, before, "ack", "resident"));
    await assertStarting(path);
    await edit(path, db => assert.equal(db.prepare("SELECT reason FROM cdr_execution_holds").get()?.reason, "stop"));
  });
});

test("an existing stop control is neither widened nor replaced", async () => {
  await storeFixture(async path => {
    const before = await claimed(path); await stop(path);
    await edit(path, db => db.exec(`INSERT INTO cdr_stop_controls
      (operation_id,target_thread_id,resident_owner,generation,turn_id,record_json,phase)
      VALUES ('stop-1','target','previous',1,'previous-turn','original','unknown')`));
    assert.equal((await state.markRunningWithResidentIfClaimed(path, before, "ack", "replacement"))?.state, "Running");
    await edit(path, db => assert.equal(db.prepare("SELECT record_json FROM cdr_stop_controls").get()?.record_json, "original"));
  });
});

test("late binding requires an active writer transaction", async () => {
  await storeFixture(async path => {
    const before = await claimed(path); const db = await openInitialized(path);
    try { assert.throws(() => bindLateStartIn(db, before, before, "resident"), ActiveTransactionError); }
    finally { db.close(); }
  });
});

test("mapped and selected stop bindings recheck current mirror ownership", async () => {
  for (const [route, mapped, accepted] of [
    ["Mapped", "target", true], ["Mapped", "other", false], ["Mapped", null, false],
    ["Selected", null, true], ["Selected", "other", false],
  ] as const) await storeFixture(async path => {
    const before = await claimed(path);
    await stop(path, scope({binding: {target: "target", route, command: {Stop: {reference: null}}}}));
    if (mapped !== null) await edit(path, db => db.prepare(`INSERT INTO mirror_threads
      (codex_thread_id,project_key,thread_title,discord_channel_id,discord_thread_id,updated_at)
      VALUES (?,'project','title',9,1,0)`).run(mapped));
    if (accepted) assert.equal((await state.markRunningWithResidentIfClaimed(path, before, "ack", "resident"))?.state, "Running");
    else {
      await assert.rejects(state.markRunningWithResidentIfClaimed(path, before, "ack", "resident"), /stop custody differs/);
      await assertStarting(path);
    }
  });
});

test("queue/intake identity collision prevents settlement and malformed intake fails closed", async () => {
  for (const corrupt of [false, true]) await storeFixture(async path => {
    const before = await claimed(path); await stop(path);
    await edit(path, db => {
      db.exec(`INSERT INTO codex_prompt_intakes
        (job_id,target_thread_id,channel_id,raw_prompt,auto_queue_when_busy,require_current_mirror,created_at,updated_at)
        VALUES ('saved','target',1,'prompt',0,0,0,0)`);
      if (corrupt) db.exec("UPDATE codex_prompt_intakes SET raw_prompt=CAST(X'FF' AS TEXT)");
    });
    if (corrupt) {
      await assert.rejects(state.markRunningWithResidentIfClaimed(path, before, "ack", "resident"));
      await assertStarting(path);
    } else {
      await state.markRunningWithResidentIfClaimed(path, before, "ack", "resident");
      await edit(path, db => assert.equal(JSON.parse(db.prepare("SELECT record_json FROM cdr_stop_controls").get()?.record_json as string).can_settle, false));
    }
  });
});

test("missing hold, malformed scope and ignored stop insertion all roll back ACK", async () => {
  for (const sql of [
    "DELETE FROM cdr_execution_holds",
    "UPDATE cdr_stop_revision_receipts SET scope_json='not-json'",
    `UPDATE cdr_stop_revision_receipts SET scope_json='{"jobs":null}'`,
    "CREATE TRIGGER ignore_control BEFORE INSERT ON cdr_stop_controls BEGIN SELECT RAISE(IGNORE); END",
  ]) await storeFixture(async path => {
    const before = await claimed(path); await stop(path); await edit(path, db => db.exec(sql));
    await assert.rejects(state.markRunningWithResidentIfClaimed(path, before, "ack", "resident"));
    await assertStarting(path);
  });
});
