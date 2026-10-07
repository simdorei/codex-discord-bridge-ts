import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import {
  asyncLifecycleAdmissionHeldIn as lifecycle,
  asyncResolutionHeldIn as held,
  asyncUnsettledObligationHeldIn as unsettled,
} from "../../src/store/async-resolution-admission.ts";
import { REVIEWED_INCIDENT_THREAD } from "../../src/store/async-resolution-policy.ts";
import { StoreIntegrityError } from "../../src/store/schema-assembly.ts";

const ordinary = '{"version":1,"command":"help"}';
const control = '{"version":1,"command":"stop"}';
const refusal = JSON.stringify({kind: "mirror_cleanup_refused", version: 1,
  sync_completed: false, delete_dispatched: false, earlier_changes_possible: true,
  blocked_room_id: 1, protection_reason: "queued requests"});

function database(run: (db: DatabaseSync) => void, encoding = "UTF-8"): void {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`PRAGMA encoding='${encoding}'`);
    run(db);
  } finally { if (db.isOpen) db.close(); }
}

function schema(db: DatabaseSync): void {
  // Query fixture, deliberately nullable and affinity-free for corrupt values.
  db.exec(`CREATE TABLE cdr_async_execution_obligations(question_id TEXT, thread_id TEXT);
    INSERT INTO cdr_async_execution_obligations VALUES ('q','t');
    CREATE TABLE discord_ingress_journal(ingress_id INTEGER PRIMARY KEY, created_at INTEGER,
      target_thread_id TEXT, owner_id TEXT, state TEXT, phase TEXT, payload_json, outcome_json);
    CREATE VIEW cdr_async_unsettled_obligations AS
      SELECT thread_id FROM cdr_async_execution_obligations WHERE 0;`);
}

function row(db: DatabaseSync, payload: string | Uint8Array | number | null = ordinary,
  outcome: string | Uint8Array | number | null = null, thread = "t"): void {
  db.prepare(`INSERT INTO discord_ingress_journal
    (created_at,target_thread_id,owner_id,state,phase,payload_json,outcome_json)
    VALUES (0,?,NULL,'pending','received',?,?)`).run(thread, payload, outcome);
}

test("unsettled leaf queries directly, accepts empty/astral IDs and preserves native errors", () => {
  database(db => {
    assert.throws(() => unsettled(db, "t"), /no such table/);
    db.exec("CREATE TABLE cdr_async_unsettled_obligations(thread_id TEXT)");
    for (const id of ["", "🌟", "t"]) {
      db.prepare("INSERT INTO cdr_async_unsettled_obligations VALUES (?)").run(id);
      assert.equal(unsettled(db, id), true);
    }
    assert.equal(unsettled(db, "T"), false);
    for (const id of [null, 1, "\ud800", "\udfff"]) {
      assert.throws(() => unsettled(db, id as string), TypeError);
    }
    db.close();
    assert.throws(() => unsettled(db, "t"), { code: "ERR_INVALID_STATE" });
  });
});

test("lifecycle missing obligations errors; unrepaired target skips journal", () => {
  database(db => {
    assert.throws(() => lifecycle(db, "t"), /no such table/);
    db.exec("CREATE TABLE cdr_async_execution_obligations(thread_id TEXT)");
    assert.equal(lifecycle(db, "t"), false);
    db.exec("INSERT INTO cdr_async_execution_obligations VALUES ('t')");
    assert.equal(lifecycle(db, "t"), false);
  });
});

test("ordinary skips invalid outcome conversion, while declared control does not", () => {
  for (const bad of [new Uint8Array([255]), 42, 1.5]) database(db => {
    schema(db); row(db, ordinary, bad);
    assert.equal(lifecycle(db, "t"), false);
    db.prepare("UPDATE discord_ingress_journal SET payload_json=?").run(control);
    assert.throws(() => lifecycle(db, "t"), StoreIntegrityError);
  });
  database(db => {
    schema(db); row(db);
    db.exec("UPDATE discord_ingress_journal SET outcome_json=CAST(X'FF' AS TEXT)");
    assert.equal(lifecycle(db, "t"), false);
    db.prepare("UPDATE discord_ingress_journal SET payload_json=?").run(control);
    assert.throws(() => lifecycle(db, "t"), /Invalid SQLite text encoding/);
  });
});

test("invalid payload SQL type/UTF8 errors, JSON failures and NULL hold", () => {
  for (const bad of [new Uint8Array([255]), 42, 1.5]) database(db => {
    schema(db); row(db, bad);
    assert.throws(() => lifecycle(db, "t"), StoreIntegrityError);
  });
  for (const payload of [null, "broken", "null", "[]", '"text"', "1", "{}"])
    database(db => { schema(db); row(db, payload); assert.equal(lifecycle(db, "t"), true); });
  database(db => {
    schema(db); row(db);
    db.exec("UPDATE discord_ingress_journal SET payload_json=CAST(X'C0AF' AS TEXT)");
    assert.throws(() => lifecycle(db, "t"), /Invalid SQLite text encoding/);
  });
});

test("129th row is held before either field decodes; earlier error and hold win", () => {
  for (const bad of [new Uint8Array([255]), "invalid-text", new Uint8Array(131073)]) database(db => {
    schema(db);
    for (let i = 0; i < 128; i++) row(db);
    assert.equal(lifecycle(db, "t"), false);
    row(db, bad);
    if (bad === "invalid-text") db.exec("UPDATE discord_ingress_journal SET payload_json=CAST(X'FF' AS TEXT) WHERE ingress_id=129");
    assert.equal(lifecycle(db, "t"), true);
    db.exec("UPDATE discord_ingress_journal SET payload_json=X'FF' WHERE ingress_id=1");
    assert.throws(() => lifecycle(db, "t"), StoreIntegrityError);
    db.exec("UPDATE discord_ingress_journal SET payload_json=NULL WHERE ingress_id=1");
    assert.equal(lifecycle(db, "t"), true);
  });
});

for (const encoding of ["UTF-8", "UTF-16le", "UTF-16be"]) {
  test(`SQL byte bounds and text decoding under ${encoding}`, () => database(db => {
    schema(db);
    const base = '{"version":1,"plan":{"Ignore":"한글🌟"}}';
    const unit = encoding === "UTF-8" ? 1 : 2;
    const bytes = Number(db.prepare("SELECT length(CAST(? AS BLOB)) AS n").get(base)?.n);
    const exact = base + " ".repeat((131072 - bytes) / unit);
    row(db, exact);
    assert.equal(lifecycle(db, "t"), false);
    db.prepare("UPDATE discord_ingress_journal SET payload_json=?").run(exact + " ");
    assert.equal(lifecycle(db, "t"), true);
    db.prepare("UPDATE discord_ingress_journal SET payload_json=?,outcome_json=?").run(control, refusal);
    assert.equal(lifecycle(db, "t"), false);
    db.prepare("UPDATE discord_ingress_journal SET outcome_json=?").run(refusal + " ".repeat(131073));
    assert.equal(lifecycle(db, "t"), true);
  }, encoding));
}

test("oversized BLOB becomes CASE NULL rather than a type error", () => database(db => {
  schema(db); row(db, new Uint8Array(131073));
  assert.equal(lifecycle(db, "t"), true);
  db.prepare("UPDATE discord_ingress_journal SET payload_json=?,outcome_json=?").run(control, new Uint8Array(131073));
  assert.equal(lifecycle(db, "t"), true);
}));

test("valid refusal disposes control; malformed or missing outcomes stay held", () => {
  for (const outcome of [null, "broken", "{}", refusal.replace('"version":1', '"version":1.0')])
    database(db => { schema(db); row(db, control, outcome); assert.equal(lifecycle(db, "t"), true); });
  database(db => { schema(db); row(db, control, refusal); assert.equal(lifecycle(db, "t"), false); });
});

test("row filters isolate threads, owners and already-disposed states", () => database(db => {
  schema(db); row(db, control, null, "other");
  row(db, control); db.exec("UPDATE discord_ingress_journal SET owner_id='owner' WHERE ingress_id=2");
  row(db, control); db.exec("UPDATE discord_ingress_journal SET state='completed' WHERE ingress_id=3");
  for (const phase of ["result_recorded", "stop_accepted"]) {
    row(db, control, "{}");
    db.prepare("UPDATE discord_ingress_journal SET phase=? WHERE ingress_id=last_insert_rowid()").run(phase);
  }
  assert.equal(lifecycle(db, "t"), false);
  row(db, control); assert.equal(lifecycle(db, "t"), true);
}));

test("parent preserves policy/unsettled/lifecycle/legacy short-circuit order", () => database(db => {
  assert.equal(held(db, REVIEWED_INCIDENT_THREAD), true);
  assert.equal(held(db, "t"), false);
  schema(db);
  db.exec("DROP VIEW cdr_async_unsettled_obligations");
  assert.throws(() => held(db, "t"), /no such table/);
  db.exec("CREATE TABLE cdr_async_recovery_policies(thread_id TEXT); INSERT INTO cdr_async_recovery_policies VALUES ('t')");
  assert.equal(held(db, "t"), true);
  db.exec("DELETE FROM cdr_async_recovery_policies; CREATE VIEW cdr_async_unsettled_obligations AS SELECT thread_id FROM cdr_async_execution_obligations");
  db.exec("DROP TABLE discord_ingress_journal; CREATE TABLE discord_ingress_journal(wrong TEXT)");
  assert.equal(held(db, "t"), true);
  db.exec("DROP VIEW cdr_async_unsettled_obligations; CREATE VIEW cdr_async_unsettled_obligations AS SELECT thread_id FROM cdr_async_execution_obligations WHERE 0");
  assert.throws(() => held(db, "t"), /no such column/);
}));

test("legacy fallback and borrowed transaction ownership are preserved", () => database(db => {
  schema(db);
  db.exec("CREATE TABLE cdr_async_questions(id TEXT,thread_id TEXT,state TEXT,dispatch_mode TEXT)");
  db.exec("BEGIN"); row(db);
  assert.equal(held(db, "t"), false);
  assert.equal(db.isTransaction, true);
  db.exec("INSERT INTO cdr_async_questions VALUES ('legacy','t','dispatching','steer')");
  assert.equal(held(db, "t"), true);
  db.exec("ROLLBACK");
  assert.equal(db.prepare("SELECT count(*) AS n FROM discord_ingress_journal").get()?.n, 0);
  db.exec("PRAGMA query_only=ON");
  assert.equal(held(db, "t"), false);
  assert.equal(db.isOpen, true);
}));

test("raw UTF16 lifecycle conversion matches the retained Rust oracle observations", () => {
  const oracle = JSON.parse(readFileSync(new URL(
    "../../migration/oracles/sqlite-utf16-0.40.2/decoded-results.json", import.meta.url), "utf8")) as {
      cases: { bytes: number[]; encoding: string; ok: boolean }[];
    };
  assert.equal(oracle.cases.length, 22);
  for (const observed of oracle.cases) database(db => {
    schema(db); row(db);
    const bytes = Buffer.from(observed.bytes);
    db.prepare("UPDATE discord_ingress_journal SET payload_json=CAST(? AS TEXT)").run(bytes);
    if (observed.ok) assert.equal(lifecycle(db, "t"), true); // Decoded non-object/invalid JSON.
    else assert.throws(() => lifecycle(db, "t"), /Invalid SQLite text encoding/);
    db.prepare("UPDATE discord_ingress_journal SET payload_json=?,outcome_json=CAST(? AS TEXT)").run(ordinary, bytes);
    assert.equal(lifecycle(db, "t"), false); // All unused outcomes stay undecoded.
  }, observed.encoding);
});
