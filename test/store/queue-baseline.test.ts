import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { matchingBaselineJsonIn } from "../../src/store/queue-baseline.ts";
import {
  migrateSchemaVersion,
  migrateSchemaExtensions,
  StoreIntegrityError,
} from "../../src/store/schema-assembly.ts";
import type { StoredQueueJob } from "../../src/store/queue-read.ts";

function migrateSchema(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  migrateSchemaVersion(db, 1n);
  migrateSchemaVersion(db, 2n);
  migrateSchemaExtensions(db);
  db.exec("PRAGMA user_version = 2");
  db.exec("COMMIT");
}

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  try {
    migrateSchema(db);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

type SqlParam = string | number | bigint | Uint8Array | null;

interface FixtureRow {
  job_id: SqlParam;
  target_thread_id: SqlParam;
  channel_id: SqlParam;
  owner_user_id: SqlParam;
  discord_message_id: SqlParam;
  app_server_generation: SqlParam;
  execution_generation: SqlParam;
  prompt: SqlParam;
  queued: SqlParam;
  ack_sent: SqlParam;
  state: SqlParam;
  attempt_count: SqlParam;
  turn_id: SqlParam;
  baseline_turn_ids: SqlParam;
  last_error: SqlParam;
  created_at: SqlParam;
  updated_at: SqlParam;
  goal_waiting: SqlParam;
  turn_observation_generation: SqlParam;
}

const INSERT_SQL = `
  INSERT INTO codex_turn_queue (
    job_id, target_thread_id, channel_id, owner_user_id,
    discord_message_id, app_server_generation, execution_generation,
    prompt, queued, ack_sent, state, attempt_count,
    turn_id, baseline_turn_ids, last_error, created_at,
    updated_at, goal_waiting, turn_observation_generation
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

function insertJob(db: DatabaseSync, overrides: Partial<FixtureRow> = {}): void {
  const row: FixtureRow = {
    job_id: "job-default-1",
    target_thread_id: "thread-default-1",
    channel_id: 1000n,
    owner_user_id: 2000n,
    discord_message_id: null,
    app_server_generation: 1n,
    execution_generation: 2n,
    prompt: "default prompt",
    queued: 1n,
    ack_sent: 0n,
    state: "pending",
    attempt_count: 0n,
    turn_id: null,
    baseline_turn_ids: "[]",
    last_error: "",
    created_at: 1712000000.5,
    updated_at: 1712000001.5,
    goal_waiting: 0n,
    turn_observation_generation: null,
    ...overrides,
  };
  db.prepare(INSERT_SQL).run(
    row.job_id,
    row.target_thread_id,
    row.channel_id,
    row.owner_user_id,
    row.discord_message_id,
    row.app_server_generation,
    row.execution_generation,
    row.prompt,
    row.queued,
    row.ack_sent,
    row.state,
    row.attempt_count,
    row.turn_id,
    row.baseline_turn_ids,
    row.last_error,
    row.created_at,
    row.updated_at,
    row.goal_waiting,
    row.turn_observation_generation,
  );
}

function createHostileClaimed(
  jobId: string,
  message: string = "Hostile baselineTurnIds getter must not be invoked",
): {
  readonly claimed: Pick<StoredQueueJob, "jobId" | "baselineTurnIds">;
  readonly getAccessCount: () => number;
} {
  let accesses = 0;
  const claimed: Pick<StoredQueueJob, "jobId" | "baselineTurnIds"> = {
    jobId,
    get baselineTurnIds(): string[] {
      accesses++;
      throw new Error(`HOSTILE_ACCESS: ${message}`);
    },
  };
  return {
    claimed,
    getAccessCount: () => accesses,
  };
}

describe("matchingBaselineJsonIn - contract authority and precedence", () => {
  describe("precedence: SELECT/decode occurs before expected baseline access", () => {
    it("returns null for absent row without accessing baselineTurnIds getter", () => {
      const db = createDb();
      try {
        insertJob(db, { job_id: "job-present-1" });

        const { claimed, getAccessCount } = createHostileClaimed(
          "job-absent-1",
          "getter must not be accessed on missing row",
        );

        const result = matchingBaselineJsonIn(db, claimed);
        assert.equal(result, null);
        assert.equal(getAccessCount(), 0, "baselineTurnIds getter counter must stay 0 on absent row");
      } finally {
        db.close();
      }
    });

    it("returns null for absent row without triggering proxy get traps on baselineTurnIds", () => {
      const db = createDb();
      try {
        let proxyTrapped = 0;

        const proxyClaimed = new Proxy(
          { jobId: "job-absent-proxy" },
          {
            get(target, prop, receiver) {
              if (prop === "baselineTurnIds") {
                proxyTrapped++;
                throw new Error("Proxy trap invoked for baselineTurnIds on missing row");
              }
              return Reflect.get(target, prop, receiver);
            },
          },
        ) as unknown as Pick<StoredQueueJob, "jobId" | "baselineTurnIds">;

        const result = matchingBaselineJsonIn(db, proxyClaimed);
        assert.equal(result, null);
        assert.equal(proxyTrapped, 0, "Proxy trap for baselineTurnIds must not fire on absent row");
      } finally {
        db.close();
      }
    });

    it("returns null for absent row even when baselineTurnIds is malformed or invalid type", () => {
      const db = createDb();
      try {
        const notArray = {
          jobId: "job-absent-not-array",
          baselineTurnIds: "not-an-array" as unknown as string[],
        };
        assert.equal(matchingBaselineJsonIn(db, notArray), null);

        const invalidElements = {
          jobId: "job-absent-invalid-elements",
          baselineTurnIds: [123, null] as unknown as string[],
        };
        assert.equal(matchingBaselineJsonIn(db, invalidElements), null);

        const loneSurrogate = {
          jobId: "job-absent-lone-surrogate",
          baselineTurnIds: ["\uD800"],
        };
        assert.equal(matchingBaselineJsonIn(db, loneSurrogate), null);
      } finally {
        db.close();
      }
    });

    it("fails on missing codex_turn_queue table before accessing baselineTurnIds", () => {
      const emptyDb = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
      try {
        const { claimed, getAccessCount } = createHostileClaimed(
          "job-missing-table",
          "getter must not be accessed when table is missing",
        );

        assert.throws(
          () => matchingBaselineJsonIn(emptyDb, claimed),
          (err: unknown) => {
            assert(err instanceof Error, `Expected Error, received ${String(err)}`);
            return true;
          },
        );
        assert.equal(
          getAccessCount(),
          0,
          "baselineTurnIds getter counter must stay 0 on missing table error",
        );
      } finally {
        emptyDb.close();
      }
    });

    it("fails on closed database connection before accessing baselineTurnIds", () => {
      const db = createDb();
      let closed = false;
      try {
        db.close();
        closed = true;

        const { claimed, getAccessCount } = createHostileClaimed(
          "job-closed-db",
          "getter must not be accessed when database connection is closed",
        );

        assert.throws(
          () => matchingBaselineJsonIn(db, claimed),
          (err: unknown) => {
            assert(err instanceof Error, `Expected Error, received ${String(err)}`);
            return true;
          },
        );
        assert.equal(
          getAccessCount(),
          0,
          "baselineTurnIds getter counter must stay 0 on closed database error",
        );
      } finally {
        if (!closed) {
          db.close();
        }
      }
    });

    it("fails with JSON SyntaxError on malformed stored JSON before accessing baselineTurnIds", () => {
      const db = createDb();
      try {
        insertJob(db, {
          job_id: "job-bad-json",
          baseline_turn_ids: "{ this is not valid json",
        });

        const { claimed, getAccessCount } = createHostileClaimed(
          "job-bad-json",
          "getter must not be accessed when stored JSON is malformed",
        );

        assert.throws(
          () => matchingBaselineJsonIn(db, claimed),
          (err: unknown) => {
            assert(err instanceof SyntaxError, `Expected SyntaxError, received ${String(err)}`);
            return true;
          },
        );
        assert.equal(
          getAccessCount(),
          0,
          "baselineTurnIds getter counter must stay 0 when stored JSON parsing fails",
        );
      } finally {
        db.close();
      }
    });

    it("fails with JSON SyntaxError on escaped lone surrogate in stored JSON before accessing baselineTurnIds", () => {
      const db = createDb();
      try {
        insertJob(db, {
          job_id: "job-surrogate-json",
          baseline_turn_ids: '["\\uD800"]',
        });

        const { claimed, getAccessCount } = createHostileClaimed(
          "job-surrogate-json",
          "getter must not be accessed when stored JSON has lone surrogates",
        );

        assert.throws(
          () => matchingBaselineJsonIn(db, claimed),
          (err: unknown) => {
            assert(err instanceof SyntaxError, `Expected SyntaxError, received ${String(err)}`);
            return true;
          },
        );
        assert.equal(
          getAccessCount(),
          0,
          "baselineTurnIds getter counter must stay 0 on escaped lone surrogate JSON error",
        );
      } finally {
        db.close();
      }
    });

    it("fails with StoreIntegrityError on SQL NULL stored column before accessing baselineTurnIds", () => {
      // EXPLICIT SCHEMA-BYPASSED FIXTURE:
      // Real migrated schema defines baseline_turn_ids as TEXT NOT NULL.
      // This test bypasses the constraint to prove SQL NULL decode error takes precedence over claimed baseline.
      const bypassedDb = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
      try {
        bypassedDb.exec(`
          CREATE TABLE codex_turn_queue (
            job_id TEXT PRIMARY KEY,
            baseline_turn_ids TEXT
          );
        `);
        bypassedDb
          .prepare("INSERT INTO codex_turn_queue (job_id, baseline_turn_ids) VALUES (?, ?)")
          .run("job-sql-null", null);

        const { claimed, getAccessCount } = createHostileClaimed(
          "job-sql-null",
          "getter must not be accessed when column is SQL NULL",
        );

        assert.throws(
          () => matchingBaselineJsonIn(bypassedDb, claimed),
          (err: unknown) => {
            assert(
              err instanceof StoreIntegrityError,
              `Expected StoreIntegrityError, received ${String(err)}`,
            );
            return true;
          },
        );
        assert.equal(
          getAccessCount(),
          0,
          "baselineTurnIds getter counter must stay 0 when stored column is SQL NULL",
        );
      } finally {
        bypassedDb.close();
      }
    });

    it("fails with StoreIntegrityError on invalid native UTF-8 bytes before accessing baselineTurnIds", () => {
      const db = createDb();
      try {
        db.exec(`
          INSERT INTO codex_turn_queue (
            job_id, target_thread_id, channel_id, prompt, queued, ack_sent, state, attempt_count,
            baseline_turn_ids, last_error, created_at, updated_at
          ) VALUES (
            'job-bad-utf8', 'thread-1', 1000, 'prompt', 1, 0, 'pending', 0,
            CAST(x'FF' AS TEXT), '', 1712000000.0, 1712000001.0
          );
        `);

        const { claimed, getAccessCount } = createHostileClaimed(
          "job-bad-utf8",
          "getter must not be accessed when native UTF-8 decode fails",
        );

        assert.throws(
          () => matchingBaselineJsonIn(db, claimed),
          (err: unknown) => {
            assert(
              err instanceof StoreIntegrityError,
              `Expected StoreIntegrityError, received ${String(err)}`,
            );
            return true;
          },
        );
        assert.equal(
          getAccessCount(),
          0,
          "baselineTurnIds getter counter must stay 0 on native text decode error",
        );
      } finally {
        db.close();
      }
    });

    it("fails with StoreIntegrityError when baseline_turn_ids is stored as BLOB in migrated schema", () => {
      const db = createDb();
      try {
        insertJob(db, {
          job_id: "job-blob",
          baseline_turn_ids: new Uint8Array([0x5b, 0x5d]),
        });

        const { claimed, getAccessCount } = createHostileClaimed(
          "job-blob",
          "getter must not be accessed when baseline_turn_ids is BLOB",
        );

        assert.throws(
          () => matchingBaselineJsonIn(db, claimed),
          (err: unknown) => {
            assert(
              err instanceof StoreIntegrityError,
              `Expected StoreIntegrityError, received ${String(err)}`,
            );
            return true;
          },
        );
        assert.equal(
          getAccessCount(),
          0,
          "baselineTurnIds getter counter must stay 0 on BLOB storage decode error",
        );
      } finally {
        db.close();
      }
    });

    it("accesses baselineTurnIds exactly once and validates domain when stored row exists and stored JSON is valid (TS boundary guarantee)", () => {
      const db = createDb();
      try {
        insertJob(db, {
          job_id: "job-valid-row",
          baseline_turn_ids: '["turn-1"]',
        });

        let accesses = 0;
        const claimed: Pick<StoredQueueJob, "jobId" | "baselineTurnIds"> = {
          jobId: "job-valid-row",
          get baselineTurnIds(): string[] {
            accesses++;
            return ["turn-1"];
          },
        };

        const result = matchingBaselineJsonIn(db, claimed);
        assert.equal(result, '["turn-1"]');
        assert.equal(
          accesses,
          1,
          "TS boundary guarantee: baselineTurnIds getter should be accessed exactly once for valid row and JSON",
        );
      } finally {
        db.close();
      }
    });
  });

  describe("input validation for claimed object and jobId", () => {
    it("rejects non-object claimed parameter", () => {
      const db = createDb();
      try {
        assert.throws(
          () => matchingBaselineJsonIn(db, null as unknown as Pick<StoredQueueJob, "jobId" | "baselineTurnIds">),
          TypeError,
        );
        assert.throws(
          () => matchingBaselineJsonIn(db, undefined as unknown as Pick<StoredQueueJob, "jobId" | "baselineTurnIds">),
          TypeError,
        );
        assert.throws(
          () => matchingBaselineJsonIn(db, "not-an-object" as unknown as Pick<StoredQueueJob, "jobId" | "baselineTurnIds">),
          TypeError,
        );
      } finally {
        db.close();
      }
    });

    it("rejects non-string or missing jobId", () => {
      const db = createDb();
      try {
        assert.throws(
          () => matchingBaselineJsonIn(db, { jobId: 123 as unknown as string, baselineTurnIds: [] }),
          TypeError,
        );
        assert.throws(
          () => matchingBaselineJsonIn(db, { jobId: null as unknown as string, baselineTurnIds: [] }),
          TypeError,
        );
        assert.throws(
          () => matchingBaselineJsonIn(db, { jobId: {} as unknown as string, baselineTurnIds: [] }),
          TypeError,
        );
      } finally {
        db.close();
      }
    });

    it("rejects jobId containing lone UTF-16 surrogates", () => {
      const db = createDb();
      try {
        assert.throws(
          () => matchingBaselineJsonIn(db, { jobId: "job-\uD800", baselineTurnIds: [] }),
          TypeError,
        );
        assert.throws(
          () => matchingBaselineJsonIn(db, { jobId: "job-\uDC00", baselineTurnIds: [] }),
          TypeError,
        );
        assert.throws(
          () => matchingBaselineJsonIn(db, { jobId: "job-\uD800\uD800", baselineTurnIds: [] }),
          TypeError,
        );
        assert.throws(
          () => matchingBaselineJsonIn(db, { jobId: "\uDC00job", baselineTurnIds: [] }),
          TypeError,
        );
      } finally {
        db.close();
      }
    });

    it("validates Rust Vec<String> domain on baselineTurnIds when row exists and stored JSON is valid", () => {
      const db = createDb();
      try {
        insertJob(db, {
          job_id: "job-domain-check",
          baseline_turn_ids: '["turn-1"]',
        });

        assert.throws(
          () => matchingBaselineJsonIn(db, {
            jobId: "job-domain-check",
            baselineTurnIds: null as unknown as string[],
          }),
          TypeError,
        );

        assert.throws(
          () => matchingBaselineJsonIn(db, {
            jobId: "job-domain-check",
            baselineTurnIds: "not-an-array" as unknown as string[],
          }),
          TypeError,
        );

        assert.throws(
          () => matchingBaselineJsonIn(db, {
            jobId: "job-domain-check",
            baselineTurnIds: [123 as unknown as string],
          }),
          TypeError,
        );

        assert.throws(
          () => matchingBaselineJsonIn(db, {
            jobId: "job-domain-check",
            baselineTurnIds: ["turn-1", null as unknown as string],
          }),
          TypeError,
        );

        assert.throws(
          () => matchingBaselineJsonIn(db, {
            jobId: "job-domain-check",
            baselineTurnIds: ["\uD800"],
          }),
          TypeError,
        );

        assert.throws(
          () => matchingBaselineJsonIn(db, {
            jobId: "job-domain-check",
            baselineTurnIds: ["turn-1", "\uDC00"],
          }),
          TypeError,
        );
      } finally {
        db.close();
      }
    });

    it("evaluates jobId getter exactly once before SQL binding, preventing changing jobId from binding a different row (TS boundary guarantee)", () => {
      const db = createDb();
      try {
        insertJob(db, {
          job_id: "job-bound-1",
          baseline_turn_ids: '["turn-1"]',
        });
        insertJob(db, {
          job_id: "job-bound-2",
          baseline_turn_ids: '["turn-2"]',
        });

        let jobIdAccesses = 0;
        let currentJobId = "job-bound-1";
        const claimed = {
          get jobId(): string {
            jobIdAccesses++;
            const id = currentJobId;
            currentJobId = "job-bound-2";
            return id;
          },
          baselineTurnIds: ["turn-1"],
        };

        const result = matchingBaselineJsonIn(db, claimed);
        assert.equal(result, '["turn-1"]');
        assert.equal(
          jobIdAccesses,
          1,
          "TS boundary guarantee: jobId getter must be accessed exactly once before SQL binding",
        );
      } finally {
        db.close();
      }
    });

    it("evaluates baselineTurnIds getter once after parse and changing getter compares first snapshot only (TS boundary guarantee)", () => {
      const db = createDb();
      try {
        insertJob(db, {
          job_id: "job-snapshot-test",
          baseline_turn_ids: '["turn-alpha"]',
        });

        let baselineAccessCount = 0;
        const claimed = {
          jobId: "job-snapshot-test",
          get baselineTurnIds(): string[] {
            baselineAccessCount++;
            if (baselineAccessCount === 1) {
              return ["turn-alpha"];
            }
            return ["turn-mutated-on-second-access"];
          },
        };

        const result = matchingBaselineJsonIn(db, claimed);
        assert.equal(result, '["turn-alpha"]');
        assert.equal(
          baselineAccessCount,
          1,
          "TS boundary guarantee: baselineTurnIds getter must be accessed exactly once after parse",
        );
      } finally {
        db.close();
      }
    });

    it("prevents safe-key to lone-surrogate replacement alias (TS single-read boundary)", () => {
      const db = createDb();
      try {
        insertJob(db, {
          job_id: "job-\uFFFD",
          baseline_turn_ids: '["alias-turn"]',
        });

        let jobIdAccesses = 0;
        const claimed = {
          get jobId(): string {
            jobIdAccesses++;
            if (jobIdAccesses === 1) {
              return "job-safe-absent";
            }
            return "job-\uD800";
          },
          baselineTurnIds: ["alias-turn"],
        };

        const result = matchingBaselineJsonIn(db, claimed);
        assert.equal(result, null);
        assert.equal(
          jobIdAccesses,
          1,
          "TS boundary contract: jobId getter must be accessed exactly once (not Rust getter parity)",
        );

        const row = db
          .prepare("SELECT job_id, baseline_turn_ids FROM codex_turn_queue WHERE job_id = ?")
          .get("job-\uFFFD") as { job_id: string; baseline_turn_ids: string } | undefined;
        assert.notEqual(row, undefined);
        assert.equal(row?.job_id, "job-\uFFFD");
        assert.equal(row?.baseline_turn_ids, '["alias-turn"]');
      } finally {
        db.close();
      }
    });
  });

  describe("equality matching and exact raw string preservation", () => {
    it("returns exact raw string preserving formatting, indentation, and newlines", () => {
      const db = createDb();
      try {
        const rawStored = '[\n  "turn-alpha" ,\n  "turn-beta"\n]';
        insertJob(db, {
          job_id: "job-raw-preserve",
          baseline_turn_ids: rawStored,
        });

        const matched = matchingBaselineJsonIn(db, {
          jobId: "job-raw-preserve",
          baselineTurnIds: ["turn-alpha", "turn-beta"],
        });

        assert.equal(matched, rawStored, "Returned raw string must match stored bytes, not serializer output");
      } finally {
        db.close();
      }
    });

    it("returns exact raw string preserving escape sequences", () => {
      const db = createDb();
      try {
        const rawStored = '["turn\\/with\\/slashes", "turn\\"with\\"quotes"]';
        insertJob(db, {
          job_id: "job-escapes-preserve",
          baseline_turn_ids: rawStored,
        });

        const matched = matchingBaselineJsonIn(db, {
          jobId: "job-escapes-preserve",
          baselineTurnIds: ["turn/with/slashes", 'turn"with"quotes'],
        });

        assert.equal(matched, rawStored);
      } finally {
        db.close();
      }
    });

    it("matches empty string arrays", () => {
      const db = createDb();
      try {
        const rawStored = "[  ]";
        insertJob(db, {
          job_id: "job-empty-array",
          baseline_turn_ids: rawStored,
        });

        const matched = matchingBaselineJsonIn(db, {
          jobId: "job-empty-array",
          baselineTurnIds: [],
        });

        assert.equal(matched, rawStored);
      } finally {
        db.close();
      }
    });

    it("returns null when array order differs", () => {
      const db = createDb();
      try {
        insertJob(db, {
          job_id: "job-order-check",
          baseline_turn_ids: '["turn-1", "turn-2"]',
        });

        const matched = matchingBaselineJsonIn(db, {
          jobId: "job-order-check",
          baselineTurnIds: ["turn-2", "turn-1"],
        });

        assert.equal(matched, null);
      } finally {
        db.close();
      }
    });

    it("returns null when length differs (claimed is subset or superset)", () => {
      const db = createDb();
      try {
        insertJob(db, {
          job_id: "job-length-check",
          baseline_turn_ids: '["turn-1", "turn-2"]',
        });

        assert.equal(
          matchingBaselineJsonIn(db, {
            jobId: "job-length-check",
            baselineTurnIds: ["turn-1"],
          }),
          null,
        );

        assert.equal(
          matchingBaselineJsonIn(db, {
            jobId: "job-length-check",
            baselineTurnIds: ["turn-1", "turn-2", "turn-3"],
          }),
          null,
        );
      } finally {
        db.close();
      }
    });

    it("matches duplicate strings when counts and positions are identical", () => {
      const db = createDb();
      try {
        const rawStored = '["dup", "dup"]';
        insertJob(db, {
          job_id: "job-dup-check",
          baseline_turn_ids: rawStored,
        });

        const matched = matchingBaselineJsonIn(db, {
          jobId: "job-dup-check",
          baselineTurnIds: ["dup", "dup"],
        });
        assert.equal(matched, rawStored);

        const mismatched = matchingBaselineJsonIn(db, {
          jobId: "job-dup-check",
          baselineTurnIds: ["dup"],
        });
        assert.equal(mismatched, null);
      } finally {
        db.close();
      }
    });

    it("handles NUL characters, UTF-8 BOM, and supplementary code points", () => {
      const db = createDb();
      try {
        const rawStored = '["\\u0000", "\\uFEFF", "\\uD83D\\uDE00"]';
        insertJob(db, {
          job_id: "job-special-unicode",
          baseline_turn_ids: rawStored,
        });

        const matched = matchingBaselineJsonIn(db, {
          jobId: "job-special-unicode",
          baselineTurnIds: ["\0", "\uFEFF", "😀"],
        });

        assert.equal(matched, rawStored);
      } finally {
        db.close();
      }
    });

    it("does not normalize Unicode: NFC and NFD strings do not match", () => {
      const db = createDb();
      try {
        const nfc = "\u00e9";
        const nfd = "e\u0301";

        assert.notEqual(nfc, nfd);
        assert.equal(nfc.normalize("NFD"), nfd);

        insertJob(db, {
          job_id: "job-unicode-norm",
          baseline_turn_ids: JSON.stringify([nfc]),
        });

        const result = matchingBaselineJsonIn(db, {
          jobId: "job-unicode-norm",
          baselineTurnIds: [nfd],
        });

        assert.equal(
          result,
          null,
          "NFC and NFD strings must not match (Rust serde_json equality is byte-exact)",
        );
      } finally {
        db.close();
      }
    });
  });

  describe("non-string and non-array stored JSON values", () => {
    it("returns null against any non-string scalar or object without coercion", () => {
      const db = createDb();
      try {
        const testCases: Array<{ id: string; raw: string }> = [
          { id: "case-int-1", raw: "1" },
          { id: "case-float-1", raw: "1.0" },
          { id: "case-sci-1", raw: "1e0" },
          { id: "case-neg-0", raw: "-0" },
          { id: "case-u64max", raw: "18446744073709551615" },
          { id: "case-large-float", raw: "1e308" },
          { id: "case-null", raw: "null" },
          { id: "case-true", raw: "true" },
          { id: "case-false", raw: "false" },
          { id: "case-bare-string", raw: '"turn-1"' },
          { id: "case-object", raw: '{"0": "turn-1"}' },
          { id: "case-nested-arr", raw: '[["turn-1"]]' },
          { id: "case-arr-int", raw: "[1, 2]" },
          { id: "case-arr-mixed-int", raw: '["turn-1", 2]' },
          { id: "case-arr-null", raw: '["turn-1", null]' },
          { id: "case-arr-bool", raw: '["turn-1", true]' },
          { id: "case-arr-obj", raw: '["turn-1", {"id": "turn-2"}]' },
        ];

        for (const tc of testCases) {
          insertJob(db, {
            job_id: tc.id,
            baseline_turn_ids: tc.raw,
          });

          const res = matchingBaselineJsonIn(db, {
            jobId: tc.id,
            baselineTurnIds: ["turn-1"],
          });

          assert.equal(
            res,
            null,
            `Stored JSON '${tc.raw}' must fail against string array without type coercion`,
          );
        }
      } finally {
        db.close();
      }
    });

    it("returns null for same-length array with non-string elements (per-element type distinction)", () => {
      const db = createDb();
      try {
        const sameLengthCases: Array<{ id: string; raw: string; claimed: string[] }> = [
          { id: "same-len-int", raw: "[1]", claimed: ["1"] },
          { id: "same-len-float", raw: "[1.0]", claimed: ["1"] },
          { id: "same-len-sci", raw: "[1e0]", claimed: ["1"] },
          { id: "same-len-neg-zero", raw: "[-0]", claimed: ["1"] },
          { id: "same-len-u64max", raw: "[18446744073709551615]", claimed: ["1"] },
          { id: "same-len-large-float", raw: "[1e308]", claimed: ["1"] },
          { id: "same-len-null", raw: "[null]", claimed: ["1"] },
          { id: "same-len-true", raw: "[true]", claimed: ["1"] },
          { id: "same-len-empty-obj", raw: "[{}]", claimed: ["1"] },
          { id: "same-len-nested-arr", raw: '[["1"]]', claimed: ["1"] },
          { id: "same-len-zero-vs-neg-zero", raw: "[-0]", claimed: ["0"] },
          { id: "same-len-u64max-string-vs-num", raw: "[18446744073709551615]", claimed: ["18446744073709551615"] },
        ];

        for (const tc of sameLengthCases) {
          insertJob(db, {
            job_id: tc.id,
            baseline_turn_ids: tc.raw,
          });

          const res = matchingBaselineJsonIn(db, {
            jobId: tc.id,
            baselineTurnIds: tc.claimed,
          });

          assert.equal(
            res,
            null,
            `Stored array '${tc.raw}' must not match claimed string array ${JSON.stringify(tc.claimed)} (per-element type distinction)`,
          );
        }
      } finally {
        db.close();
      }
    });
  });

  describe("database environment and transaction invariants", () => {
    it("works correctly on UTF-16le encoded SQLite database with escaped supplementary, NUL, and BOM inputs", () => {
      const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
      try {
        db.exec("PRAGMA encoding = 'UTF-16le'");
        migrateSchema(db);

        const pragmaEncoding = (db.prepare("PRAGMA encoding").get() as { encoding?: string })?.encoding;
        assert.equal(pragmaEncoding, "UTF-16le");

        const raw = '["\\u0000", "\\uFEFF", "\\uD83D\\uDE00", "turn-utf16le-2"]';
        insertJob(db, {
          job_id: "job-utf16le",
          baseline_turn_ids: raw,
        });

        const res = matchingBaselineJsonIn(db, {
          jobId: "job-utf16le",
          baselineTurnIds: ["\0", "\uFEFF", "😀", "turn-utf16le-2"],
        });
        assert.equal(res, raw, "Must return exact raw string from UTF-16le storage");
      } finally {
        db.close();
      }
    });

    it("works correctly on UTF-16be encoded SQLite database with escaped supplementary, NUL, and BOM inputs", () => {
      const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
      try {
        db.exec("PRAGMA encoding = 'UTF-16be'");
        migrateSchema(db);

        const pragmaEncoding = (db.prepare("PRAGMA encoding").get() as { encoding?: string })?.encoding;
        assert.equal(pragmaEncoding, "UTF-16be");

        const raw = '["\\u0000", "\\uFEFF", "\\uD83D\\uDE00", "turn-utf16be-2"]';
        insertJob(db, {
          job_id: "job-utf16be",
          baseline_turn_ids: raw,
        });

        const res = matchingBaselineJsonIn(db, {
          jobId: "job-utf16be",
          baselineTurnIds: ["\0", "\uFEFF", "😀", "turn-utf16be-2"],
        });
        assert.equal(res, raw, "Must return exact raw string from UTF-16be storage");
      } finally {
        db.close();
      }
    });

    it("throws appropriate error on missing codex_turn_queue table", () => {
      const emptyDb = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
      try {
        assert.throws(
          () => matchingBaselineJsonIn(emptyDb, { jobId: "job-1", baselineTurnIds: [] }),
          (err: unknown) => {
            assert(err instanceof Error);
            assert(/no such table: codex_turn_queue/i.test(err.message));
            return true;
          },
        );
      } finally {
        emptyDb.close();
      }
    });

    it("throws appropriate error on closed database connection", () => {
      const db = createDb();
      let closed = false;
      try {
        db.close();
        closed = true;
        assert.throws(
          () => matchingBaselineJsonIn(db, { jobId: "job-1", baselineTurnIds: [] }),
          (err: unknown) => {
            assert(err instanceof Error);
            return true;
          },
        );
      } finally {
        if (!closed) {
          db.close();
        }
      }
    });

    it("caller-owned BEGIN IMMEDIATE: helper makes no mutations, db remains open, snapshot unchanged and caller rollback works", () => {
      const db = createDb();
      try {
        insertJob(db, {
          job_id: "job-tx-active",
          baseline_turn_ids: '["turn-tx-1"]',
        });

        db.exec("BEGIN IMMEDIATE");

        const selectStmt = db.prepare("SELECT * FROM codex_turn_queue ORDER BY job_id");
        selectStmt.setReadBigInts(true);
        const rowsBefore = selectStmt.all();

        const result = matchingBaselineJsonIn(db, {
          jobId: "job-tx-active",
          baselineTurnIds: ["turn-tx-1"],
        });
        assert.equal(result, '["turn-tx-1"]');

        const rowsAfter = selectStmt.all();
        assert.deepEqual(
          rowsAfter,
          rowsBefore,
          "Full rows before and after helper call must be deepEqual with setReadBigInts(true)",
        );

        // Verify caller transaction remains open and active: insert temporary row
        insertJob(db, {
          job_id: "job-tx-temporary",
          baseline_turn_ids: '["turn-tx-2"]',
        });
        const countStmt = db.prepare("SELECT COUNT(*) AS count FROM codex_turn_queue");
        const countDuring = (countStmt.get() as { count: number | bigint }).count;
        assert.equal(Number(countDuring), 2);

        // Rollback caller transaction
        db.exec("ROLLBACK");

        // Verify rollback succeeded and snapshot is intact
        const rowsFinal = selectStmt.all();
        assert.deepEqual(
          rowsFinal,
          rowsBefore,
          "Full rows after ROLLBACK must match rowsBefore",
        );

        const tempCheck = db
          .prepare("SELECT job_id FROM codex_turn_queue WHERE job_id = 'job-tx-temporary'")
          .get();
        assert.equal(tempCheck, undefined);

        const origCheck = db
          .prepare("SELECT baseline_turn_ids FROM codex_turn_queue WHERE job_id = 'job-tx-active'")
          .get() as { baseline_turn_ids: string } | undefined;
        assert.equal(origCheck?.baseline_turn_ids, '["turn-tx-1"]');
      } finally {
        db.close();
      }
    });
  });
});
