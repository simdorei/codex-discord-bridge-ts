import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { seedIn } from "../../src/store/new-reply-seed.ts";
import { StoreIntegrityError } from "../../src/store/schema-assembly.ts";
import { migrateIngress } from "../../src/store/schema-extensions-b2.ts";
import type { WindowsNativePathInput } from "../../src/core/windows-native-path.ts";

interface ObservedFixtureRow {
  readonly id: string;
  readonly platform: string;
  readonly units?: readonly number[];
  readonly bytes?: readonly number[];
  readonly host_os?: string;
  readonly status: string;
  readonly seed_json?: string;
}

interface IngressOverrides {
  ingress_id?: string;
  kind?: string;
  channel_id?: number;
  owner_user_id?: number;
  payload_json?: string;
  state?: string;
  phase?: string;
  owner_kind?: string | null;
  owner_id?: string | null;
  outcome_json?: string | null;
  created_at?: number;
  updated_at?: number;
}

const DEFAULT_PATH: WindowsNativePathInput = {
  platform: "windows-utf16",
  units: [67, 58, 92, 100, 98, 46, 115, 113, 108, 105, 116, 101],
};

function createMigratedDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  migrateIngress(db);
  return db;
}

function insertIngress(db: DatabaseSync, overrides?: IngressOverrides): void {
  const stmt = db.prepare(`
    INSERT INTO discord_ingress_journal (
      ingress_id, kind, channel_id, owner_user_id, payload_json,
      state, phase, owner_kind, owner_id, outcome_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    overrides?.ingress_id ?? "ing-test-1",
    overrides?.kind ?? "message",
    overrides?.channel_id ?? 10001,
    overrides?.owner_user_id ?? 20002,
    overrides?.payload_json ?? "{}",
    overrides?.state ?? "staged",
    overrides?.phase ?? "phase-ready",
    overrides?.owner_kind !== undefined ? overrides.owner_kind : "prompt",
    overrides?.owner_id !== undefined ? overrides.owner_id : "job-test-1",
    overrides?.outcome_json !== undefined ? overrides.outcome_json : '{"new_creation":{"version":1}}',
    overrides?.created_at ?? 1700000000.0,
    overrides?.updated_at ?? 1700000000.0
  );
}

const fixtureUrl = new URL("../fixtures/windows-native-path-observed.ndjson", import.meta.url);
const fixtureRows: readonly ObservedFixtureRow[] = readFileSync(fixtureUrl, "utf8")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line.length > 0)
  .map((line) => JSON.parse(line) as ObservedFixtureRow);

const windowsObserved = fixtureRows.filter(
  (row) => row.platform === "windows-utf16" && row.status === "observed"
);
const unixUnobserved = fixtureRows.filter(
  (row) => row.platform === "unix-bytes" && row.status === "not-observed-on-this-platform"
);

describe("seedIn - observed Windows vectors and Unix rejection", () => {
  it("verifies fixture counts match expectations (32 Windows observed, 11 Unix)", () => {
    assert.equal(windowsObserved.length, 32);
    assert.equal(unixUnobserved.length, 11);
  });

  it("applies each of the 32 observed Windows path vectors and freezes exact seed_json", () => {
    const db = createMigratedDb();
    try {
      for (const vector of windowsObserved) {
        const units = vector.units;
        const expectedSeedJson = vector.seed_json;
        if (!units || expectedSeedJson === undefined) {
          throw new Error(`Invalid observed vector: ${vector.id}`);
        }
        const parsedSeed = JSON.parse(expectedSeedJson) as {
          acknowledgement: string;
          state_db: string;
        };

        const ingressId = `ing-${vector.id}`;
        const jobId = `job-${vector.id}`;
        insertIngress(db, { ingress_id: ingressId, owner_id: jobId });

        const pathInput: WindowsNativePathInput = {
          platform: "windows-utf16",
          units,
        };

        seedIn(db, ingressId, jobId, pathInput, parsedSeed.acknowledgement);

        const row = db
          .prepare(
            "SELECT json_extract(outcome_json, '$.new_reply_seed') AS seed FROM discord_ingress_journal WHERE ingress_id = ?"
          )
          .get(ingressId) as { seed: string } | undefined;

        assert.ok(row, `Row missing for ${vector.id}`);
        assert.equal(row.seed, expectedSeedJson, `Seed JSON mismatch for vector ${vector.id}`);
        assert.ok(
          row.seed.startsWith('{"acknowledgement":'),
          `Key ordering must place acknowledgement first for ${vector.id}`
        );
      }
    } finally {
      db.close();
    }
  });

  it("rejects Unix platform input before attempting database access", () => {
    const db = createMigratedDb();
    try {
      for (const vector of unixUnobserved) {
        const unixPath = {
          platform: vector.platform,
          bytes: vector.bytes ?? [],
        };
        assert.throws(
          () => seedIn(db, "nonexistent-ing", "nonexistent-job", unixPath, "ack"),
          TypeError
        );
      }
    } finally {
      db.close();
    }
  });
});

describe("seedIn - argument guard order and input validation", () => {
  it("rejects proxy objects for stateDb before any other validation", () => {
    const db = createMigratedDb();
    try {
      const proxyPath = new Proxy({ platform: "windows-utf16" as const, units: [] }, {});
      assert.throws(
        () => seedIn(db, "ing-1", "job-1", proxyPath, "ack"),
        { name: "TypeError", message: "Proxy objects are not supported" }
      );
    } finally {
      db.close();
    }
  });

  it("evaluates guards in strict order: stateDb -> acknowledgement -> ingress -> job", () => {
    const db = createMigratedDb();
    try {
      const proxyPath = new Proxy({ platform: "windows-utf16" as const, units: [] }, {});
      assert.throws(
        () => seedIn(db, "\uD800", "\uD800", proxyPath, 123 as unknown as string),
        { name: "TypeError", message: "Proxy objects are not supported" }
      );

      assert.throws(
        () => seedIn(db, "\uD800", "\uD800", DEFAULT_PATH, "\uD800"),
        { name: "TypeError", message: "Expected acknowledgement to be a valid Unicode scalar string" }
      );

      assert.throws(
        () => seedIn(db, "\uD800", "\uD800", DEFAULT_PATH, "valid-ack"),
        { name: "TypeError", message: "Expected ingress to be a valid Unicode scalar string" }
      );

      assert.throws(
        () => seedIn(db, "valid-ing", "\uD800", DEFAULT_PATH, "valid-ack"),
        { name: "TypeError", message: "Expected job to be a valid Unicode scalar string" }
      );
    } finally {
      db.close();
    }
  });

  it("rejects non-string primitives and objects without coercion", () => {
    const db = createMigratedDb();
    try {
      insertIngress(db, { ingress_id: "ing-type", owner_id: "job-type" });
      const nonStrings = [42, true, null, undefined, {}, { toString: () => "valid" }, Symbol("id")];

      for (const val of nonStrings) {
        assert.throws(
          () => seedIn(db, "ing-type", "job-type", DEFAULT_PATH, val as unknown as string),
          { name: "TypeError", message: "Expected acknowledgement to be a valid Unicode scalar string" }
        );
        assert.throws(
          () => seedIn(db, val as unknown as string, "job-type", DEFAULT_PATH, "ack"),
          { name: "TypeError", message: "Expected ingress to be a valid Unicode scalar string" }
        );
        assert.throws(
          () => seedIn(db, "ing-type", val as unknown as string, DEFAULT_PATH, "ack"),
          { name: "TypeError", message: "Expected job to be a valid Unicode scalar string" }
        );
      }
    } finally {
      db.close();
    }
  });

  it("permits valid empty and embedded-NUL scalar strings for ingress, job, and acknowledgement", () => {
    const db = createMigratedDb();
    try {
      insertIngress(db, { ingress_id: "", owner_id: "" });
      seedIn(db, "", "", DEFAULT_PATH, "");
      const emptyRow = db
        .prepare("SELECT json_extract(outcome_json, '$.new_reply_seed.acknowledgement') AS ack FROM discord_ingress_journal WHERE ingress_id = ''")
        .get() as { ack: string } | undefined;
      assert.equal(emptyRow?.ack, "");

      const nulIngress = "ing\u0000id";
      const nulJob = "job\u0000id";
      const nulAck = "ack\u0000text";
      insertIngress(db, { ingress_id: nulIngress, owner_id: nulJob });
      seedIn(db, nulIngress, nulJob, DEFAULT_PATH, nulAck);
      const nulRow = db
        .prepare("SELECT json_extract(outcome_json, '$.new_reply_seed.acknowledgement') AS ack FROM discord_ingress_journal WHERE ingress_id = ?")
        .get(nulIngress) as { ack: string } | undefined;
      assert.equal(nulRow?.ack, nulAck);
    } finally {
      db.close();
    }
  });

  it("throws validation errors unconditionally even when target row is absent (no early no-op)", () => {
    const db = createMigratedDb();
    try {
      assert.throws(
        () => seedIn(db, "\uD800", "job-none", DEFAULT_PATH, "ack"),
        { name: "TypeError", message: "Expected ingress to be a valid Unicode scalar string" }
      );
      assert.throws(
        () => seedIn(db, "ing-none", "\uDFFF", DEFAULT_PATH, "ack"),
        { name: "TypeError", message: "Expected job to be a valid Unicode scalar string" }
      );
      assert.throws(
        () => seedIn(db, "ing-none", "job-none", DEFAULT_PATH, "\uD800"),
        { name: "TypeError", message: "Expected acknowledgement to be a valid Unicode scalar string" }
      );
    } finally {
      db.close();
    }
  });
});

describe("seedIn - WHERE predicate guards and StoreIntegrityError", () => {
  it("throws StoreIntegrityError when row is absent", () => {
    const db = createMigratedDb();
    try {
      assert.throws(
        () => seedIn(db, "missing-ing", "job-1", DEFAULT_PATH, "ack"),
        (err: unknown) => {
          assert.ok(err instanceof StoreIntegrityError);
          assert.equal(err.result, "new acknowledgement seed has no unique original owner");
          return true;
        }
      );
    } finally {
      db.close();
    }
  });

  it("throws StoreIntegrityError when owner_kind is not 'prompt'", () => {
    const db = createMigratedDb();
    try {
      insertIngress(db, { ingress_id: "ing-kind", owner_kind: "action", owner_id: "job-kind" });
      assert.throws(() => seedIn(db, "ing-kind", "job-kind", DEFAULT_PATH, "ack"), StoreIntegrityError);

      insertIngress(db, { ingress_id: "ing-null-kind", owner_kind: null, owner_id: "job-kind" });
      assert.throws(() => seedIn(db, "ing-null-kind", "job-kind", DEFAULT_PATH, "ack"), StoreIntegrityError);
    } finally {
      db.close();
    }
  });

  it("throws StoreIntegrityError when owner_id mismatches", () => {
    const db = createMigratedDb();
    try {
      insertIngress(db, { ingress_id: "ing-mismatch", owner_id: "job-real" });
      assert.throws(() => seedIn(db, "ing-mismatch", "job-wrong", DEFAULT_PATH, "ack"), StoreIntegrityError);
    } finally {
      db.close();
    }
  });

  it("throws StoreIntegrityError when ingress_id mismatches", () => {
    const db = createMigratedDb();
    try {
      insertIngress(db, { ingress_id: "ing-real", owner_id: "job-1" });
      assert.throws(() => seedIn(db, "ing-wrong", "job-1", DEFAULT_PATH, "ack"), StoreIntegrityError);
    } finally {
      db.close();
    }
  });

  it("throws StoreIntegrityError when outcome_json is SQL NULL", () => {
    const db = createMigratedDb();
    try {
      insertIngress(db, { ingress_id: "ing-null", owner_id: "job-1", outcome_json: null });
      assert.throws(() => seedIn(db, "ing-null", "job-1", DEFAULT_PATH, "ack"), StoreIntegrityError);
    } finally {
      db.close();
    }
  });

  it("throws StoreIntegrityError when outcome_json lacks new_creation or version", () => {
    const db = createMigratedDb();
    try {
      insertIngress(db, { ingress_id: "ing-no-creation", owner_id: "job-1", outcome_json: "{}" });
      assert.throws(() => seedIn(db, "ing-no-creation", "job-1", DEFAULT_PATH, "ack"), StoreIntegrityError);

      insertIngress(db, { ingress_id: "ing-no-ver", owner_id: "job-1", outcome_json: '{"new_creation":{}}' });
      assert.throws(() => seedIn(db, "ing-no-ver", "job-1", DEFAULT_PATH, "ack"), StoreIntegrityError);
    } finally {
      db.close();
    }
  });

  it("throws StoreIntegrityError when outcome_json contains non-1 version", () => {
    const db = createMigratedDb();
    try {
      const wrongVersions = ['{"new_creation":{"version":2}}', '{"new_creation":{"version":0}}', '{"new_creation":{"version":-1}}'];
      for (const [idx, json] of wrongVersions.entries()) {
        const id = `ing-ver-${idx}`;
        insertIngress(db, { ingress_id: id, owner_id: "job-1", outcome_json: json });
        assert.throws(() => seedIn(db, id, "job-1", DEFAULT_PATH, "ack"), StoreIntegrityError);
      }
    } finally {
      db.close();
    }
  });

  it("throws StoreIntegrityError when new_reply_seed is already present (object, scalar, or JSON null)", () => {
    const db = createMigratedDb();
    try {
      insertIngress(db, {
        ingress_id: "ing-obj",
        owner_id: "job-1",
        outcome_json: '{"new_creation":{"version":1},"new_reply_seed":{"state_db":"","acknowledgement":""}}',
      });
      assert.throws(() => seedIn(db, "ing-obj", "job-1", DEFAULT_PATH, "ack"), StoreIntegrityError);

      insertIngress(db, {
        ingress_id: "ing-scalar",
        owner_id: "job-1",
        outcome_json: '{"new_creation":{"version":1},"new_reply_seed":"done"}',
      });
      assert.throws(() => seedIn(db, "ing-scalar", "job-1", DEFAULT_PATH, "ack"), StoreIntegrityError);

      insertIngress(db, {
        ingress_id: "ing-json-null",
        owner_id: "job-1",
        outcome_json: '{"new_creation":{"version":1},"new_reply_seed":null}',
      });
      assert.throws(() => seedIn(db, "ing-json-null", "job-1", DEFAULT_PATH, "ack"), StoreIntegrityError);
    } finally {
      db.close();
    }
  });

  it("succeeds on first seed, but subsequent identical or different seed calls fail leaving raw row unchanged", () => {
    const db = createMigratedDb();
    try {
      insertIngress(db, { ingress_id: "ing-repeat", owner_id: "job-repeat" });

      seedIn(db, "ing-repeat", "job-repeat", DEFAULT_PATH, "first-ack");

      const afterFirst = db
        .prepare("SELECT outcome_json FROM discord_ingress_journal WHERE ingress_id = 'ing-repeat'")
        .get() as { outcome_json: string };

      assert.throws(
        () => seedIn(db, "ing-repeat", "job-repeat", DEFAULT_PATH, "first-ack"),
        StoreIntegrityError
      );
      const afterSecond = db
        .prepare("SELECT outcome_json FROM discord_ingress_journal WHERE ingress_id = 'ing-repeat'")
        .get() as { outcome_json: string };
      assert.equal(afterSecond.outcome_json, afterFirst.outcome_json);

      assert.throws(
        () => seedIn(db, "ing-repeat", "job-repeat", DEFAULT_PATH, "second-ack"),
        StoreIntegrityError
      );
      const afterThird = db
        .prepare("SELECT outcome_json FROM discord_ingress_journal WHERE ingress_id = 'ing-repeat'")
        .get() as { outcome_json: string };
      assert.equal(afterThird.outcome_json, afterFirst.outcome_json);
    } finally {
      db.close();
    }
  });
});

describe("seedIn - SQLite json_extract version evaluation", () => {
  it("matches integer 1, float 1.0, and boolean true under SQLite json_extract semantics", () => {
    const db = createMigratedDb();
    try {
      insertIngress(db, { ingress_id: "ing-int1", outcome_json: '{"new_creation":{"version":1}}' });
      seedIn(db, "ing-int1", "job-test-1", DEFAULT_PATH, "ack-int1");

      insertIngress(db, { ingress_id: "ing-float1", outcome_json: '{"new_creation":{"version":1.0}}' });
      seedIn(db, "ing-float1", "job-test-1", DEFAULT_PATH, "ack-float1");

      insertIngress(db, { ingress_id: "ing-booltrue", outcome_json: '{"new_creation":{"version":true}}' });
      seedIn(db, "ing-booltrue", "job-test-1", DEFAULT_PATH, "ack-booltrue");

      const rowInt = db.prepare("SELECT json_extract(outcome_json, '$.new_reply_seed.acknowledgement') AS ack FROM discord_ingress_journal WHERE ingress_id = 'ing-int1'").get() as { ack: string };
      const rowFloat = db.prepare("SELECT json_extract(outcome_json, '$.new_reply_seed.acknowledgement') AS ack FROM discord_ingress_journal WHERE ingress_id = 'ing-float1'").get() as { ack: string };
      const rowBool = db.prepare("SELECT json_extract(outcome_json, '$.new_reply_seed.acknowledgement') AS ack FROM discord_ingress_journal WHERE ingress_id = 'ing-booltrue'").get() as { ack: string };

      assert.equal(rowInt.ack, "ack-int1");
      assert.equal(rowFloat.ack, "ack-float1");
      assert.equal(rowBool.ack, "ack-booltrue");
    } finally {
      db.close();
    }
  });

  it("rejects string '1', boolean false, and null version values under SQLite json_extract semantics", () => {
    const db = createMigratedDb();
    try {
      insertIngress(db, { ingress_id: "ing-str1", outcome_json: '{"new_creation":{"version":"1"}}' });
      assert.throws(() => seedIn(db, "ing-str1", "job-test-1", DEFAULT_PATH, "ack"), StoreIntegrityError);

      insertIngress(db, { ingress_id: "ing-boolfalse", outcome_json: '{"new_creation":{"version":false}}' });
      assert.throws(() => seedIn(db, "ing-boolfalse", "job-test-1", DEFAULT_PATH, "ack"), StoreIntegrityError);

      insertIngress(db, { ingress_id: "ing-nullver", outcome_json: '{"new_creation":{"version":null}}' });
      assert.throws(() => seedIn(db, "ing-nullver", "job-test-1", DEFAULT_PATH, "ack"), StoreIntegrityError);
    } finally {
      db.close();
    }
  });
});

describe("seedIn - error shape and unwrapped native SQLite error propagation", () => {
  it("verifies exact StoreIntegrityError result, kind, and message structure", () => {
    const db = createMigratedDb();
    try {
      assert.throws(
        () => seedIn(db, "no-such-id", "job-1", DEFAULT_PATH, "ack"),
        (err: unknown) => {
          assert.ok(err instanceof StoreIntegrityError);
          assert.equal(err.name, "StoreIntegrityError");
          assert.equal(err.kind, "Integrity");
          assert.equal(err.result, "new acknowledgement seed has no unique original owner");
          assert.equal(
            err.message,
            "SQLite integrity check failed: new acknowledgement seed has no unique original owner"
          );
          return true;
        }
      );
    } finally {
      db.close();
    }
  });

  it("propagates native SQLite error when table is absent without wrapping", () => {
    const db = new DatabaseSync(":memory:");
    try {
      assert.throws(
        () => seedIn(db, "ing-1", "job-1", DEFAULT_PATH, "ack"),
        (err: unknown) => {
          assert.ok(!(err instanceof StoreIntegrityError));
          assert.ok(err instanceof Error);
          assert.match(err.message, /no such table: discord_ingress_journal/);
          return true;
        }
      );
    } finally {
      db.close();
    }
  });

  it("propagates native SQLite error when outcome_json contains malformed JSON", () => {
    const db = createMigratedDb();
    try {
      insertIngress(db, { ingress_id: "ing-malformed", outcome_json: "{unquoted_key: invalid" });
      assert.throws(
        () => seedIn(db, "ing-malformed", "job-test-1", DEFAULT_PATH, "ack"),
        (err: unknown) => {
          assert.ok(!(err instanceof StoreIntegrityError));
          assert.ok(err instanceof Error);
          assert.match(err.message, /malformed JSON/i);
          return true;
        }
      );
    } finally {
      db.close();
    }
  });

  it("propagates native SQLite error when database connection is closed", () => {
    const db = createMigratedDb();
    db.close();
    assert.throws(
      () => seedIn(db, "ing-1", "job-1", DEFAULT_PATH, "ack"),
      (err: unknown) => {
        assert.ok(!(err instanceof StoreIntegrityError));
        assert.ok(err instanceof Error);
        return true;
      }
    );
  });
});

describe("seedIn - snapshot verification and field preservation", () => {
  it("preserves large integer raw lexemes (>2^53 and U64_MAX) and all unrelated columns without mutation", () => {
    const db = createMigratedDb();
    try {
      const initialOutcome =
        '{"new_creation":{"version":1},"large_int":9007199254740993,"u64_max":18446744073709551615,"nested":{"tag":"test","count":7},"scalar":"retain"}';

      db.prepare(`
        INSERT INTO discord_ingress_journal (
          ingress_id, version, kind, event_id, application_id, channel_id,
          owner_user_id, source_message_id, payload_json, runtime_id,
          state, phase, target_thread_id, canonical_owner, owner_kind,
          owner_id, outcome_json, confirmation_delivered, hold_reason,
          notice_staged, created_at, updated_at
        ) VALUES (
          ?, 1, 'message', 101, 202, 303,
          404, 505, '{"event":"raw"}', 'rt-alpha',
          'staged', 'p-initial', 'thread-target', 'canon-owner', 'prompt',
          'job-snapshot', ?, 0, 'none',
          0, 1710000000.5, 1710000010.5
        )
      `).run("ing-snapshot", initialOutcome);

      const before = db
        .prepare("SELECT * FROM discord_ingress_journal WHERE ingress_id = ?")
        .get("ing-snapshot") as Record<string, unknown>;

      seedIn(db, "ing-snapshot", "job-snapshot", DEFAULT_PATH, "ack-snapshot");

      const after = db
        .prepare("SELECT * FROM discord_ingress_journal WHERE ingress_id = ?")
        .get("ing-snapshot") as Record<string, unknown>;

      for (const [col, beforeVal] of Object.entries(before)) {
        if (col === "outcome_json") {
          const outcome = after[col];
          assert.equal(typeof outcome, "string");
          const outcomeStr = outcome as string;
          assert.ok(outcomeStr.includes("9007199254740993"), "large_int lexeme 9007199254740993 must survive");
          assert.ok(outcomeStr.includes("18446744073709551615"), "u64_max lexeme 18446744073709551615 must survive");
          assert.ok(outcomeStr.includes('"nested":{"tag":"test","count":7}'), "nested structure must survive");
          assert.ok(outcomeStr.includes('"scalar":"retain"'), "unrelated scalar must survive");
          assert.ok(outcomeStr.includes('"new_reply_seed"'), "new_reply_seed must be inserted");
        } else {
          assert.strictEqual(after[col], beforeVal, `Column '${col}' must remain strictly unmodified`);
        }
      }
    } finally {
      db.close();
    }
  });
});

describe("seedIn - transactions and trigger behaviors", () => {
  it("allows caller to ROLLBACK seeded changes completely", () => {
    const db = createMigratedDb();
    try {
      insertIngress(db, { ingress_id: "ing-tx-rollback", owner_id: "job-tx" });

      db.exec("BEGIN IMMEDIATE");
      seedIn(db, "ing-tx-rollback", "job-tx", DEFAULT_PATH, "ack-tx");

      const midRow = db
        .prepare("SELECT json_extract(outcome_json, '$.new_reply_seed.acknowledgement') AS ack FROM discord_ingress_journal WHERE ingress_id = 'ing-tx-rollback'")
        .get() as { ack: string } | undefined;
      assert.equal(midRow?.ack, "ack-tx");

      db.exec("ROLLBACK");

      const afterRow = db
        .prepare("SELECT json_extract(outcome_json, '$.new_reply_seed') AS seed FROM discord_ingress_journal WHERE ingress_id = 'ing-tx-rollback'")
        .get() as { seed: unknown } | undefined;
      assert.equal(afterRow?.seed, null);
    } finally {
      db.close();
    }
  });

  it("allows caller to COMMIT seeded changes without helper interference", () => {
    const db = createMigratedDb();
    try {
      insertIngress(db, { ingress_id: "ing-tx-commit", owner_id: "job-tx" });

      db.exec("BEGIN IMMEDIATE");
      seedIn(db, "ing-tx-commit", "job-tx", DEFAULT_PATH, "ack-commit");
      db.exec("COMMIT");

      const afterRow = db
        .prepare("SELECT json_extract(outcome_json, '$.new_reply_seed.acknowledgement') AS ack FROM discord_ingress_journal WHERE ingress_id = 'ing-tx-commit'")
        .get() as { ack: string } | undefined;
      assert.equal(afterRow?.ack, "ack-commit");
    } finally {
      db.close();
    }
  });

  it("handles RAISE(IGNORE) trigger by producing changed 0 and throwing StoreIntegrityError with unchanged row", () => {
    const db = createMigratedDb();
    try {
      insertIngress(db, { ingress_id: "ing-ignore", owner_id: "job-1" });
      const initialRow = db
        .prepare("SELECT outcome_json FROM discord_ingress_journal WHERE ingress_id = 'ing-ignore'")
        .get() as { outcome_json: string };

      db.exec(`
        CREATE TRIGGER test_trigger_raise_ignore
        BEFORE UPDATE ON discord_ingress_journal
        BEGIN
          SELECT RAISE(IGNORE);
        END;
      `);

      assert.throws(
        () => seedIn(db, "ing-ignore", "job-1", DEFAULT_PATH, "ack-ignored"),
        StoreIntegrityError
      );

      const afterRow = db
        .prepare("SELECT outcome_json FROM discord_ingress_journal WHERE ingress_id = 'ing-ignore'")
        .get() as { outcome_json: string };
      assert.equal(afterRow.outcome_json, initialRow.outcome_json);
    } finally {
      db.close();
    }
  });

  it("handles RAISE(ABORT) trigger by surfacing native error while caller retains transaction ownership", () => {
    const db = createMigratedDb();
    try {
      insertIngress(db, { ingress_id: "ing-abort", owner_id: "job-1" });

      db.exec(`
        CREATE TRIGGER test_trigger_raise_abort
        BEFORE UPDATE ON discord_ingress_journal
        BEGIN
          SELECT RAISE(ABORT, 'aborted by test trigger');
        END;
      `);

      db.exec("BEGIN IMMEDIATE");
      assert.throws(
        () => seedIn(db, "ing-abort", "job-1", DEFAULT_PATH, "ack-abort"),
        (err: unknown) => {
          assert.ok(!(err instanceof StoreIntegrityError));
          assert.ok(err instanceof Error);
          assert.match(err.message, /aborted by test trigger/);
          return true;
        }
      );

      db.exec("ROLLBACK");
    } finally {
      db.close();
    }
  });

  it("proves changed === 2 throws StoreIntegrityError and leaves updates for caller rollback in duplicate fixture", () => {
    const dupDb = new DatabaseSync(":memory:");
    try {
      dupDb.exec(`
        CREATE TABLE discord_ingress_journal (
          ingress_id TEXT,
          owner_kind TEXT,
          owner_id TEXT,
          outcome_json TEXT
        );
      `);

      const insertStmt = dupDb.prepare(`
        INSERT INTO discord_ingress_journal VALUES (?, 'prompt', 'job-dup', '{"new_creation":{"version":1}}')
      `);
      insertStmt.run("ing-dup");
      insertStmt.run("ing-dup");

      dupDb.exec("BEGIN IMMEDIATE");
      assert.throws(
        () => seedIn(dupDb, "ing-dup", "job-dup", DEFAULT_PATH, "ack-dup"),
        (err: unknown) => {
          assert.ok(err instanceof StoreIntegrityError);
          assert.equal(err.result, "new acknowledgement seed has no unique original owner");
          return true;
        }
      );

      const updatedRows = dupDb
        .prepare("SELECT json_extract(outcome_json, '$.new_reply_seed.acknowledgement') AS ack FROM discord_ingress_journal")
        .all() as Array<{ ack: string }>;
      assert.equal(updatedRows.length, 2);
      assert.equal(updatedRows[0]?.ack, "ack-dup");
      assert.equal(updatedRows[1]?.ack, "ack-dup");

      dupDb.exec("ROLLBACK");

      const rolledBackRows = dupDb
        .prepare("SELECT json_extract(outcome_json, '$.new_reply_seed') AS seed FROM discord_ingress_journal")
        .all() as Array<{ seed: unknown }>;
      assert.equal(rolledBackRows.length, 2);
      assert.equal(rolledBackRows[0]?.seed, null);
      assert.equal(rolledBackRows[1]?.seed, null);
    } finally {
      dupDb.close();
    }
  });
});
