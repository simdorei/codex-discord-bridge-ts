import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, test } from "node:test";
import { getIn, type NewReply } from "../../src/store/new-reply-read.ts";
import { bindRunningIn } from "../../src/store/new-reply-bind.ts";
import {
  NewReplyIdentityParseError,
  type Identity,
} from "../../src/store/new-reply-identity.ts";
import { StoreIntegrityError } from "../../src/store/schema-assembly.ts";
import { migrateNewReply } from "../../src/store/schema-extensions-b2.ts";
import type { StoredQueueJob } from "../../src/store/queue-read.ts";

const I64_MIN = -9223372036854775808n;
const I64_MAX = 9223372036854775807n;

function serializeIdentity(overrides: Partial<Identity> = {}): string {
  const full = {
    ingress_id: "ing-default",
    job_id: "job-default",
    thread_id: "thread-default",
    cwd: "/workspace/project",
    state_db: "/workspace/project/state.sqlite",
    channel_id: 1000n,
    origin_channel_id: 2000n,
    event_id: 3000n as bigint | null,
    kind: "message" as const,
    creation_generation: 1n,
    prompt_sha256: "sha256-abc123def456",
    acknowledgement: "ack-token-xyz",
    ...overrides,
  };
  const eventPart = full.event_id === null ? "null" : full.event_id.toString();
  return `{"ingress_id":${JSON.stringify(full.ingress_id)},"job_id":${JSON.stringify(full.job_id)},"thread_id":${JSON.stringify(full.thread_id)},"cwd":${JSON.stringify(full.cwd)},"state_db":${JSON.stringify(full.state_db)},"channel_id":${full.channel_id.toString()},"origin_channel_id":${full.origin_channel_id.toString()},"event_id":${eventPart},"kind":${JSON.stringify(full.kind)},"creation_generation":${full.creation_generation.toString()},"prompt_sha256":${JSON.stringify(full.prompt_sha256)},"acknowledgement":${JSON.stringify(full.acknowledgement)}}`;
}

function makeJob(overrides: Partial<StoredQueueJob> = {}): StoredQueueJob {
  return {
    jobId: "job-default",
    targetThreadId: "thread-default",
    channelId: 1000n,
    ownerUserId: 101n,
    discordMessageId: 102n,
    appServerGeneration: 1n,
    executionGeneration: 1n,
    turnObservationGeneration: null,
    goalWaiting: false,
    prompt: "test prompt",
    queued: false,
    ackSent: true,
    state: "Running",
    attemptCount: 1n,
    turnId: "turn-job-1",
    baselineTurnIds: [],
    lastError: "",
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

function createMigratedDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  migrateNewReply(db);
  return db;
}

function createNoAffinityDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE codex_new_first_replies (
      job_id,
      ingress_id,
      identity_json,
      turn_id,
      accepted_at,
      state,
      version,
      scan_json,
      last_error,
      confirmation_delivered,
      warning_due,
      ack_recovery_allowed,
      checked_at
    );
  `);
  return db;
}

interface ReplyRowValues {
  job_id?: SQLInputValue;
  ingress_id?: SQLInputValue;
  identity_json?: SQLInputValue;
  turn_id?: SQLInputValue;
  accepted_at?: SQLInputValue;
  state?: SQLInputValue;
  version?: SQLInputValue;
  scan_json?: SQLInputValue;
  last_error?: SQLInputValue;
  confirmation_delivered?: SQLInputValue;
  warning_due?: SQLInputValue;
  ack_recovery_allowed?: SQLInputValue;
  checked_at?: SQLInputValue;
}

function insertRow(db: DatabaseSync, values: ReplyRowValues = {}): void {
  const stmt = db.prepare(`
    INSERT INTO codex_new_first_replies (
      job_id, ingress_id, identity_json, turn_id, accepted_at, state, version,
      scan_json, last_error, confirmation_delivered, warning_due, ack_recovery_allowed, checked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    values.job_id !== undefined ? values.job_id : "job-default",
    values.ingress_id !== undefined ? values.ingress_id : "ing-default",
    values.identity_json !== undefined ? values.identity_json : serializeIdentity(),
    values.turn_id !== undefined ? values.turn_id : null,
    values.accepted_at !== undefined ? values.accepted_at : null,
    values.state !== undefined ? values.state : "pending",
    values.version !== undefined ? values.version : 1n,
    values.scan_json !== undefined ? values.scan_json : "{}",
    values.last_error !== undefined ? values.last_error : "",
    values.confirmation_delivered !== undefined ? values.confirmation_delivered : 0n,
    values.warning_due !== undefined ? values.warning_due : 0n,
    values.ack_recovery_allowed !== undefined ? values.ack_recovery_allowed : 0n,
    values.checked_at !== undefined ? values.checked_at : 0,
  );
}

describe("migrateNewReply schema smoke and getIn baseline", () => {
  test("applied schema smoke: creates table and index, getIn returns null on missing row", () => {
    const db = createMigratedDb();
    try {
      const result = getIn(db, "nonexistent-job");
      assert.strictEqual(result, null);
    } finally {
      db.close();
    }
  });

  test("missing table throws SQLite error", () => {
    const db = new DatabaseSync(":memory:");
    try {
      assert.throws(() => {
        getIn(db, "job-1");
      });
    } finally {
      db.close();
    }
  });

  test("getIn decodes all 10 row fields with exact types", () => {
    const db = createMigratedDb();
    try {
      const idJson = serializeIdentity({
        ingress_id: "ing-smoke-1",
        job_id: "job-smoke-1",
        thread_id: "th-smoke-1",
        cwd: "/path/to/repo",
        state_db: "/path/to/state.sqlite",
        channel_id: 111111111111111111n,
        origin_channel_id: 222222222222222222n,
        event_id: 333333333333333333n,
        kind: "interaction",
        creation_generation: 444444444444444444n,
        prompt_sha256: "abcdef1234567890",
        acknowledgement: "ack-text-smoke",
      });

      insertRow(db, {
        job_id: "job-smoke-1",
        ingress_id: "ing-smoke-1",
        identity_json: idJson,
        turn_id: "turn-smoke-1",
        accepted_at: 1718000000.5,
        state: "verified",
        version: 42n,
        scan_json: '{"scanKey": "scanValue", "count": 99}',
        last_error: "smoke error message",
        confirmation_delivered: 1n,
        warning_due: 1718000500n,
        ack_recovery_allowed: 1n,
      });

      const record = getIn(db, "job-smoke-1");
      assert.ok(record !== null);
      assert.strictEqual(record.turnId, "turn-smoke-1");
      assert.strictEqual(record.acceptedAt, 1718000000.5);
      assert.strictEqual(record.state, "verified");
      assert.strictEqual(record.version, 42n);
      assert.deepStrictEqual(record.scan, { scanKey: "scanValue", count: 99n });
      assert.strictEqual(record.lastError, "smoke error message");
      assert.strictEqual(record.confirmationDelivered, true);
      assert.strictEqual(record.warningDue, 1718000500n);
      assert.strictEqual(record.acknowledgementRecoveryAllowed, true);

      assert.strictEqual(record.identity.ingress_id, "ing-smoke-1");
      assert.strictEqual(record.identity.job_id, "job-smoke-1");
      assert.strictEqual(record.identity.thread_id, "th-smoke-1");
      assert.strictEqual(record.identity.cwd, "/path/to/repo");
      assert.strictEqual(record.identity.state_db, "/path/to/state.sqlite");
      assert.strictEqual(record.identity.channel_id, 111111111111111111n);
      assert.strictEqual(record.identity.origin_channel_id, 222222222222222222n);
      assert.strictEqual(record.identity.event_id, 333333333333333333n);
      assert.strictEqual(record.identity.kind, "interaction");
      assert.strictEqual(record.identity.creation_generation, 444444444444444444n);
      assert.strictEqual(record.identity.prompt_sha256, "abcdef1234567890");
      assert.strictEqual(record.identity.acknowledgement, "ack-text-smoke");
    } finally {
      db.close();
    }
  });
});

describe("getIn integer, float, boolean and text boundary semantics", () => {
  test("signed version and warningDue decode exact at I64_MIN, I64_MAX, negative, and 0", () => {
    const db = createMigratedDb();
    try {
      const boundaries = [
        { id: "boundary-max", ver: I64_MAX, warn: I64_MAX },
        { id: "boundary-min", ver: I64_MIN, warn: I64_MIN },
        { id: "boundary-neg", ver: -123456789n, warn: -987654321n },
        { id: "boundary-zero", ver: 0n, warn: 0n },
      ];

      for (const b of boundaries) {
        insertRow(db, {
          job_id: b.id,
          ingress_id: `ing-${b.id}`,
          version: b.ver,
          warning_due: b.warn,
        });
        const res = getIn(db, b.id);
        assert.ok(res !== null);
        assert.strictEqual(res.version, b.ver);
        assert.strictEqual(res.warningDue, b.warn);
      }
    } finally {
      db.close();
    }
  });

  test("boolean SQL integer decode: 0n is false, nonzero (+/-1, +/-2, I64_MIN, I64_MAX) is true", () => {
    const db = createMigratedDb();
    try {
      const cases: Array<{ id: string; val: bigint; expected: boolean }> = [
        { id: "bool-0", val: 0n, expected: false },
        { id: "bool-1", val: 1n, expected: true },
        { id: "bool-neg-1", val: -1n, expected: true },
        { id: "bool-pos-2", val: 2n, expected: true },
        { id: "bool-neg-2", val: -2n, expected: true },
        { id: "bool-max", val: I64_MAX, expected: true },
        { id: "bool-min", val: I64_MIN, expected: true },
      ];

      for (const c of cases) {
        insertRow(db, {
          job_id: c.id,
          ingress_id: `ing-${c.id}`,
          confirmation_delivered: c.val,
          ack_recovery_allowed: c.val,
        });
        const res = getIn(db, c.id);
        assert.ok(res !== null);
        assert.strictEqual(res.confirmationDelivered, c.expected, `confirmation_delivered for ${c.id}`);
        assert.strictEqual(res.acknowledgementRecoveryAllowed, c.expected, `ack_recovery_allowed for ${c.id}`);
      }
    } finally {
      db.close();
    }
  });

  test("acceptedAt decodes null, finite INTEGER, finite REAL, +/-Infinity, and SQLite NaN binds as NULL", () => {
    const db = createMigratedDb();
    try {
      insertRow(db, { job_id: "acc-null", ingress_id: "ing-acc-null", accepted_at: null });
      const rowNull = getIn(db, "acc-null");
      assert.ok(rowNull !== null);
      assert.strictEqual(rowNull.acceptedAt, null);

      insertRow(db, { job_id: "acc-finite-real", ingress_id: "ing-acc-finite", accepted_at: 1718000000.75 });
      const rowFinite = getIn(db, "acc-finite-real");
      assert.ok(rowFinite !== null);
      assert.strictEqual(rowFinite.acceptedAt, 1718000000.75);

      insertRow(db, { job_id: "acc-pos-inf", ingress_id: "ing-acc-pos-inf", accepted_at: Infinity });
      const rowPosInf = getIn(db, "acc-pos-inf");
      assert.ok(rowPosInf !== null);
      assert.strictEqual(rowPosInf.acceptedAt, Infinity);

      insertRow(db, { job_id: "acc-neg-inf", ingress_id: "ing-acc-neg-inf", accepted_at: -Infinity });
      const rowNegInf = getIn(db, "acc-neg-inf");
      assert.ok(rowNegInf !== null);
      assert.strictEqual(rowNegInf.acceptedAt, -Infinity);

      insertRow(db, { job_id: "acc-nan", ingress_id: "ing-acc-nan", accepted_at: NaN });
      const rowNan = getIn(db, "acc-nan");
      assert.ok(rowNan !== null);
      assert.strictEqual(rowNan.acceptedAt, null);

      db.exec("INSERT INTO codex_new_first_replies (job_id, ingress_id, identity_json, accepted_at) VALUES ('acc-int', 'ing-acc-int', '" + serializeIdentity() + "', 1718000000)");
      const rowInt = getIn(db, "acc-int");
      assert.ok(rowInt !== null);
      assert.strictEqual(typeof rowInt.acceptedAt, "number");
      assert.strictEqual(rowInt.acceptedAt, 1718000000);
    } finally {
      db.close();
    }
  });

  test("optional turnId null vs empty string and required empty texts", () => {
    const db = createMigratedDb();
    try {
      insertRow(db, {
        job_id: "turn-null-job",
        ingress_id: "ing-turn-null",
        turn_id: null,
        last_error: "",
      });
      const resNull = getIn(db, "turn-null-job");
      assert.ok(resNull !== null);
      assert.strictEqual(resNull.turnId, null);
      assert.strictEqual(resNull.lastError, "");

      insertRow(db, {
        job_id: "turn-empty-job",
        ingress_id: "ing-turn-empty",
        turn_id: "",
        last_error: "non-empty-error",
      });
      const resEmpty = getIn(db, "turn-empty-job");
      assert.ok(resEmpty !== null);
      assert.strictEqual(resEmpty.turnId, "");
      assert.strictEqual(resEmpty.lastError, "non-empty-error");
    } finally {
      db.close();
    }
  });

  test("record SQL job key != identity.job_id works without equality check", () => {
    const db = createMigratedDb();
    try {
      const idJson = serializeIdentity({ job_id: "inner-identity-job-999" });
      insertRow(db, {
        job_id: "outer-sql-job-111",
        ingress_id: "ing-mismatch-job-id",
        identity_json: idJson,
      });
      const record = getIn(db, "outer-sql-job-111");
      assert.ok(record !== null);
      assert.strictEqual(record.identity.job_id, "inner-identity-job-999");
    } finally {
      db.close();
    }
  });
});

describe("decode order, error precedence, and encoding edge cases", () => {
  test("[schema-bypassed] all 10 SQL columns decode BEFORE identity parsing: malformed identity + invalid later column throws StoreIntegrityError", () => {
    const db = createNoAffinityDb();
    try {
      const malformedIdentityText = "NOT_VALID_JSON_IDENTITY";

      const wrongTypeCases: Array<{
        col: string;
        values: ReplyRowValues;
        expectedMatch: RegExp;
      }> = [
        { col: "turn_id", values: { turn_id: 12345n }, expectedMatch: /column turn_id/ },
        { col: "accepted_at", values: { accepted_at: "not-a-number" }, expectedMatch: /column accepted_at/ },
        { col: "state", values: { state: 999n }, expectedMatch: /column state/ },
        { col: "version", values: { version: "string-not-bigint" }, expectedMatch: /column version/ },
        { col: "scan_json", values: { scan_json: 888n }, expectedMatch: /column scan_json/ },
        { col: "last_error", values: { last_error: 777n }, expectedMatch: /column last_error/ },
        { col: "confirmation_delivered", values: { confirmation_delivered: "string-not-bigint" }, expectedMatch: /column confirmation_delivered/ },
        { col: "warning_due", values: { warning_due: "string-not-bigint" }, expectedMatch: /column warning_due/ },
        { col: "ack_recovery_allowed", values: { ack_recovery_allowed: "string-not-bigint" }, expectedMatch: /column ack_recovery_allowed/ },
      ];

      for (const tc of wrongTypeCases) {
        const jobId = `job-wrong-${tc.col}`;
        insertRow(db, {
          job_id: jobId,
          ingress_id: `ing-${jobId}`,
          identity_json: malformedIdentityText,
          ...tc.values,
        });

        assert.throws(
          () => {
            getIn(db, jobId);
          },
          (err: unknown) => {
            assert.ok(err instanceof StoreIntegrityError, `Expected StoreIntegrityError for ${tc.col}, got ${String(err)}`);
            assert.match((err as Error).message, tc.expectedMatch);
            return true;
          },
          `Failed for column ${tc.col}: should throw StoreIntegrityError before parsing identity`,
        );
      }
    } finally {
      db.close();
    }
  });

  test("typed identity parsed before generic scan: invalid identity + malformed scan throws NewReplyIdentityParseError first", () => {
    const db = createMigratedDb();
    try {
      insertRow(db, {
        job_id: "id-err-first",
        ingress_id: "ing-id-err-first",
        identity_json: '{"invalid": "identity"}',
        scan_json: "{ malformed scan JSON ",
      });

      assert.throws(
        () => {
          getIn(db, "id-err-first");
        },
        (err: unknown) => {
          assert.ok(err instanceof NewReplyIdentityParseError, `Expected NewReplyIdentityParseError, got ${String(err)}`);
          return true;
        },
      );
    } finally {
      db.close();
    }
  });

  test("typed identity parsed before generic scan: valid identity + malformed scan throws generic scan error", () => {
    const db = createMigratedDb();
    try {
      insertRow(db, {
        job_id: "scan-err-second",
        ingress_id: "ing-scan-err-second",
        identity_json: serializeIdentity(),
        scan_json: "{ malformed scan JSON ",
      });

      assert.throws(
        () => {
          getIn(db, "scan-err-second");
        },
        (err: unknown) => {
          assert.ok(!(err instanceof NewReplyIdentityParseError));
          assert.ok(!(err instanceof StoreIntegrityError));
          assert.ok(err instanceof SyntaxError);
          return true;
        },
      );
    } finally {
      db.close();
    }
  });

  test("generic scan preserves large i64 as lossless bigint", () => {
    const db = createMigratedDb();
    try {
      const scanPayload = '{"max": 9223372036854775807, "min": -9223372036854775808}';
      insertRow(db, {
        job_id: "job-large-i64-scan",
        ingress_id: "ing-large-i64-scan",
        scan_json: scanPayload,
      });

      const record = getIn(db, "job-large-i64-scan");
      assert.ok(record !== null);
      const scanObj = record.scan as { max: bigint; min: bigint };
      assert.strictEqual(scanObj.max, 9223372036854775807n);
      assert.strictEqual(scanObj.min, -9223372036854775808n);
    } finally {
      db.close();
    }
  });

  test("typed identity unknown field accepts 1e999 while same scan 1e999 is rejected", () => {
    const db = createMigratedDb();
    try {
      const idWithHugeNumber = serializeIdentity().replace(
        /\}$/,
        ',"unknown_huge_prop": 1e999}',
      );
      insertRow(db, {
        job_id: "job-id-huge-ok",
        ingress_id: "ing-id-huge-ok",
        identity_json: idWithHugeNumber,
        scan_json: '{"valid": 1}',
      });

      const record = getIn(db, "job-id-huge-ok");
      assert.ok(record !== null);
      assert.strictEqual(record.identity.job_id, "job-default");

      insertRow(db, {
        job_id: "job-scan-huge-reject",
        ingress_id: "ing-scan-huge-reject",
        identity_json: serializeIdentity(),
        scan_json: '{"huge_float": 1e999}',
      });

      assert.throws(
        () => {
          getIn(db, "job-scan-huge-reject");
        },
        (err: unknown) => {
          assert.ok(err instanceof RangeError);
          assert.match((err as Error).message, /out of range/);
          return true;
        },
      );
    } finally {
      db.close();
    }
  });

  test("stored identity unnormalized raw strings and null event_id are preserved", () => {
    const db = createMigratedDb();
    try {
      const rawDecomposedPrompt = "cafe\u0301-unnormalized";
      const rawAck = "token_with_surrogate_escape_\\uD83D\\uDE00";
      const idRaw = `{"ingress_id":"ing-raw","job_id":"job-raw","thread_id":"th-raw","cwd":"/cwd","state_db":"/db","channel_id":100,"origin_channel_id":200,"event_id":null,"kind":"message","creation_generation":1,"prompt_sha256":"${rawDecomposedPrompt}","acknowledgement":"${rawAck}"}`;

      insertRow(db, {
        job_id: "job-unnormalized",
        ingress_id: "ing-unnormalized",
        identity_json: idRaw,
      });

      const record = getIn(db, "job-unnormalized");
      assert.ok(record !== null);
      assert.strictEqual(record.identity.event_id, null);
      assert.strictEqual(record.identity.prompt_sha256, "cafe\u0301-unnormalized");
      assert.strictEqual(record.identity.acknowledgement, "token_with_surrogate_escape_\uD83D\uDE00");
    } finally {
      db.close();
    }
  });

  test("[schema-bypassed] UTF-8 invalid TEXT via CAST blob yields StoreIntegrityError, no accidental replacement", () => {
    const db = createNoAffinityDb();
    try {
      db.exec(
        "INSERT INTO codex_new_first_replies (job_id, ingress_id, identity_json, turn_id, state, version, scan_json, last_error, confirmation_delivered, warning_due, ack_recovery_allowed) " +
        "VALUES ('job-invalid-utf8', 'ing-invalid-utf8', '" + serializeIdentity() + "', CAST(X'C328' AS TEXT), 'pending', 1, '{}', '', 0, 0, 0)",
      );

      assert.throws(
        () => {
          getIn(db, "job-invalid-utf8");
        },
        (err: unknown) => {
          assert.ok(err instanceof StoreIntegrityError);
          assert.match((err as Error).message, /Invalid text encoding in column turn_id/);
          return true;
        },
      );
    } finally {
      db.close();
    }
  });
});

describe("bindRunningIn exact branch order with REAL DB", () => {
  test("each non-Running state returns immediately without query or checking missing table", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const nonRunningStates: Array<"Pending" | "Starting" | "Quarantined"> = [
        "Pending",
        "Starting",
        "Quarantined",
      ];
      for (const st of nonRunningStates) {
        assert.doesNotThrow(() => {
          bindRunningIn(db, makeJob({ state: st }));
        });
      }
    } finally {
      db.close();
    }
  });

  test("Running state on missing table throws SQLite error even if job.turnId is null", () => {
    const db = new DatabaseSync(":memory:");
    try {
      assert.throws(() => {
        bindRunningIn(db, makeJob({ state: "Running", turnId: null }));
      });

      assert.throws(() => {
        bindRunningIn(db, makeJob({ state: "Running", turnId: "turn-valid" }));
      });
    } finally {
      db.close();
    }
  });

  test("missing record returns cleanly even if targetThreadId or channelId mismatch", () => {
    const db = createMigratedDb();
    try {
      assert.doesNotThrow(() => {
        bindRunningIn(db, makeJob({
          jobId: "job-nonexistent",
          targetThreadId: "wrong-thread",
          channelId: 999999n,
          turnId: "turn-1",
          state: "Running",
        }));
      });
    } finally {
      db.close();
    }
  });

  test("[schema-bypassed] malformed record propagates error before null job turn and before existing record turn check", () => {
    const db = createNoAffinityDb();
    try {
      insertRow(db, {
        job_id: "job-malformed-rec",
        ingress_id: "ing-malformed-rec",
        turn_id: "already-bound-turn",
        version: "not-a-bigint",
      });

      assert.throws(
        () => {
          bindRunningIn(db, makeJob({
            jobId: "job-malformed-rec",
            state: "Running",
            turnId: null,
          }));
        },
        (err: unknown) => {
          assert.ok(err instanceof StoreIntegrityError);
          assert.match((err as Error).message, /column version/);
          return true;
        },
      );

      assert.throws(
        () => {
          bindRunningIn(db, makeJob({
            jobId: "job-malformed-rec",
            state: "Running",
            turnId: "turn-to-bind",
          }));
        },
        (err: unknown) => {
          assert.ok(err instanceof StoreIntegrityError);
          assert.match((err as Error).message, /column version/);
          return true;
        },
      );
    } finally {
      db.close();
    }
  });

  test("full row invalid scan propagates SyntaxError before null turn return", () => {
    const db = createMigratedDb();
    try {
      insertRow(db, {
        job_id: "job-bad-scan",
        ingress_id: "ing-bad-scan",
        scan_json: "{ not valid json ",
      });

      assert.throws(
        () => {
          bindRunningIn(db, makeJob({
            jobId: "job-bad-scan",
            state: "Running",
            turnId: null,
          }));
        },
        (err: unknown) => {
          assert.ok(err instanceof SyntaxError);
          return true;
        },
      );
    } finally {
      db.close();
    }
  });

  test("null job turn only returns AFTER full record decode: mismatched destination returns without error after decode", () => {
    const db = createMigratedDb();
    try {
      insertRow(db, {
        job_id: "job-null-turn-mismatch",
        ingress_id: "ing-null-turn-mismatch",
        identity_json: serializeIdentity({
          thread_id: "thread-expected",
          channel_id: 1000n,
        }),
      });

      assert.doesNotThrow(() => {
        bindRunningIn(db, makeJob({
          jobId: "job-null-turn-mismatch",
          targetThreadId: "thread-DIFFERENT",
          channelId: 9999n,
          turnId: null,
          state: "Running",
        }));
      });
    } finally {
      db.close();
    }
  });

  test("empty job turn ('') binds successfully", () => {
    const db = createMigratedDb();
    try {
      insertRow(db, {
        job_id: "job-bind-empty-turn",
        ingress_id: "ing-bind-empty-turn",
        turn_id: null,
        version: 1n,
      });

      bindRunningIn(db, makeJob({
        jobId: "job-bind-empty-turn",
        turnId: "",
        updatedAt: 1234.5,
        state: "Running",
      }));

      const record = getIn(db, "job-bind-empty-turn");
      assert.ok(record !== null);
      assert.strictEqual(record.turnId, "");
      assert.strictEqual(record.acceptedAt, 1234.5);
      assert.strictEqual(record.version, 2n);
    } finally {
      db.close();
    }
  });

  test("mismatched destination thread OR channel throws exact error even if record is already bound", () => {
    const db = createMigratedDb();
    try {
      insertRow(db, {
        job_id: "job-already-bound",
        ingress_id: "ing-already-bound",
        turn_id: "existing-turn-123",
        identity_json: serializeIdentity({
          thread_id: "thread-alpha",
          channel_id: 5000n,
        }),
      });

      assert.throws(
        () => {
          bindRunningIn(db, makeJob({
            jobId: "job-already-bound",
            targetThreadId: "thread-BETA",
            channelId: 5000n,
            turnId: "new-turn-456",
            state: "Running",
          }));
        },
        (err: unknown) => {
          assert.ok(err instanceof StoreIntegrityError);
          assert.ok((err as Error).message.includes("new first-turn binding changed its destination"));
          return true;
        },
      );

      assert.throws(
        () => {
          bindRunningIn(db, makeJob({
            jobId: "job-already-bound",
            targetThreadId: "thread-alpha",
            channelId: 9999n,
            turnId: "new-turn-456",
            state: "Running",
          }));
        },
        (err: unknown) => {
          assert.ok(err instanceof StoreIntegrityError);
          assert.ok((err as Error).message.includes("new first-turn binding changed its destination"));
          return true;
        },
      );
    } finally {
      db.close();
    }
  });

  test("matching existing record turn retains first turn, acceptedAt, and version", () => {
    const db = createMigratedDb();
    try {
      insertRow(db, {
        job_id: "job-retain-first",
        ingress_id: "ing-retain-first",
        turn_id: "first-custody-turn",
        accepted_at: 1000.0,
        version: 5n,
      });

      bindRunningIn(db, makeJob({
        jobId: "job-retain-first",
        turnId: "second-goal-turn",
        updatedAt: 2000.0,
        state: "Running",
      }));

      const record = getIn(db, "job-retain-first");
      assert.ok(record !== null);
      assert.strictEqual(record.turnId, "first-custody-turn");
      assert.strictEqual(record.acceptedAt, 1000.0);
      assert.strictEqual(record.version, 5n);
    } finally {
      db.close();
    }
  });

  test("existing empty record turn ('') is treated as Some and noops", () => {
    const db = createMigratedDb();
    try {
      insertRow(db, {
        job_id: "job-empty-turn-custody",
        ingress_id: "ing-empty-turn-custody",
        turn_id: "",
        accepted_at: 500.0,
        version: 3n,
      });

      bindRunningIn(db, makeJob({
        jobId: "job-empty-turn-custody",
        turnId: "attempted-overwrite",
        updatedAt: 999.0,
        state: "Running",
      }));

      const record = getIn(db, "job-empty-turn-custody");
      assert.ok(record !== null);
      assert.strictEqual(record.turnId, "");
      assert.strictEqual(record.acceptedAt, 500.0);
      assert.strictEqual(record.version, 3n);
    } finally {
      db.close();
    }
  });

  test("normal binding updates turn_id, uses job.updatedAt, and increments SQL version exact", () => {
    const db = createMigratedDb();
    try {
      insertRow(db, {
        job_id: "job-normal-bind",
        ingress_id: "ing-normal-bind",
        turn_id: null,
        accepted_at: null,
        version: 17n,
      });

      bindRunningIn(db, makeJob({
        jobId: "job-normal-bind",
        turnId: "turn-fresh-100",
        updatedAt: 1718000555.25,
        state: "Running",
      }));

      const record = getIn(db, "job-normal-bind");
      assert.ok(record !== null);
      assert.strictEqual(record.turnId, "turn-fresh-100");
      assert.strictEqual(record.acceptedAt, 1718000555.25);
      assert.strictEqual(record.version, 18n);
    } finally {
      db.close();
    }
  });

  test("BEFORE UPDATE trigger RAISE(IGNORE) returns normally without changes assertion", () => {
    const db = createMigratedDb();
    try {
      insertRow(db, {
        job_id: "job-raise-ignore",
        ingress_id: "ing-raise-ignore",
        turn_id: null,
        version: 10n,
      });

      db.exec("CREATE TRIGGER trigger_ignore_update BEFORE UPDATE ON codex_new_first_replies BEGIN SELECT RAISE(IGNORE); END;");

      assert.doesNotThrow(() => {
        bindRunningIn(db, makeJob({
          jobId: "job-raise-ignore",
          turnId: "turn-ignored",
          state: "Running",
        }));
      });

      const record = getIn(db, "job-raise-ignore");
      assert.ok(record !== null);
      assert.strictEqual(record.turnId, null);
      assert.strictEqual(record.version, 10n);
    } finally {
      db.close();
    }
  });

  test("borrowed caller BEGIN / ROLLBACK undoes binding without transaction ownership", () => {
    const db = createMigratedDb();
    try {
      insertRow(db, {
        job_id: "job-tx-test",
        ingress_id: "ing-tx-test",
        turn_id: null,
        version: 1n,
      });

      db.exec("BEGIN IMMEDIATE;");
      bindRunningIn(db, makeJob({
        jobId: "job-tx-test",
        turnId: "turn-in-tx",
        updatedAt: 777.0,
        state: "Running",
      }));

      const inTxRecord = getIn(db, "job-tx-test");
      assert.ok(inTxRecord !== null);
      assert.strictEqual(inTxRecord.turnId, "turn-in-tx");
      assert.strictEqual(inTxRecord.version, 2n);

      db.exec("ROLLBACK;");

      const rolledBackRecord = getIn(db, "job-tx-test");
      assert.ok(rolledBackRecord !== null);
      assert.strictEqual(rolledBackRecord.turnId, null);
      assert.strictEqual(rolledBackRecord.version, 1n);
    } finally {
      db.close();
    }
  });

  test("destination negative channel permitted with exact matching and no positivity fence", () => {
    const db = createMigratedDb();
    try {
      insertRow(db, {
        job_id: "job-neg-chan",
        ingress_id: "ing-neg-chan",
        identity_json: serializeIdentity({ channel_id: -100500n }),
        turn_id: null,
      });

      bindRunningIn(db, makeJob({
        jobId: "job-neg-chan",
        channelId: -100500n,
        turnId: "turn-neg-chan-bound",
        state: "Running",
      }));

      const record = getIn(db, "job-neg-chan");
      assert.ok(record !== null);
      assert.strictEqual(record.turnId, "turn-neg-chan-bound");
      assert.strictEqual(record.identity.channel_id, -100500n);
    } finally {
      db.close();
    }
  });

  test("identity.job_id mismatch is not checked during binding", () => {
    const db = createMigratedDb();
    try {
      insertRow(db, {
        job_id: "outer-sql-key",
        ingress_id: "ing-id-mismatch",
        identity_json: serializeIdentity({ job_id: "inner-different-key" }),
        turn_id: null,
      });

      bindRunningIn(db, makeJob({
        jobId: "outer-sql-key",
        turnId: "turn-bound-with-diff-identity-job",
        state: "Running",
      }));

      const record = getIn(db, "outer-sql-key");
      assert.ok(record !== null);
      assert.strictEqual(record.turnId, "turn-bound-with-diff-identity-job");
      assert.strictEqual(record.identity.job_id, "inner-different-key");
    } finally {
      db.close();
    }
  });
});

describe("Integer and float boundaries in UPDATE and persistence", () => {
  test("UPDATE versionMAX increments SQLite to REAL without JS overflow guard and subsequent getIn rejects version REAL", () => {
    const db = createMigratedDb();
    try {
      insertRow(db, {
        job_id: "job-version-max",
        ingress_id: "ing-version-max",
        version: I64_MAX,
        turn_id: null,
      });

      assert.doesNotThrow(() => {
        bindRunningIn(db, makeJob({
          jobId: "job-version-max",
          turnId: "turn-overflown",
          state: "Running",
        }));
      });

      const checkStmt = db.prepare("SELECT typeof(version) AS col_type, version AS col_val FROM codex_new_first_replies WHERE job_id = ?");
      const row = checkStmt.get("job-version-max") as { col_type: string; col_val: number };
      assert.strictEqual(row.col_type, "real");
      assert.strictEqual(typeof row.col_val, "number");

      assert.throws(
        () => {
          getIn(db, "job-version-max");
        },
        (err: unknown) => {
          assert.ok(err instanceof StoreIntegrityError);
          assert.match((err as Error).message, /column version/);
          return true;
        },
      );
    } finally {
      db.close();
    }
  });

  test("job.updatedAt +/-Infinity persisted as REAL and NaN accepted as NULL without finite validation", () => {
    const db = createMigratedDb();
    try {
      insertRow(db, { job_id: "job-inf-bind", ingress_id: "ing-inf-bind", turn_id: null });
      bindRunningIn(db, makeJob({
        jobId: "job-inf-bind",
        turnId: "turn-inf",
        updatedAt: Infinity,
        state: "Running",
      }));
      const resInf = getIn(db, "job-inf-bind");
      assert.ok(resInf !== null);
      assert.strictEqual(resInf.acceptedAt, Infinity);

      insertRow(db, { job_id: "job-neg-inf-bind", ingress_id: "ing-neg-inf-bind", turn_id: null });
      bindRunningIn(db, makeJob({
        jobId: "job-neg-inf-bind",
        turnId: "turn-neg-inf",
        updatedAt: -Infinity,
        state: "Running",
      }));
      const resNegInf = getIn(db, "job-neg-inf-bind");
      assert.ok(resNegInf !== null);
      assert.strictEqual(resNegInf.acceptedAt, -Infinity);

      insertRow(db, { job_id: "job-nan-bind", ingress_id: "ing-nan-bind", turn_id: null });
      bindRunningIn(db, makeJob({
        jobId: "job-nan-bind",
        turnId: "turn-nan",
        updatedAt: NaN,
        state: "Running",
      }));
      const resNan = getIn(db, "job-nan-bind");
      assert.ok(resNan !== null);
      assert.strictEqual(resNan.acceptedAt, null);
    } finally {
      db.close();
    }
  });

  test("zero and negative versions increment exact", () => {
    const db = createMigratedDb();
    try {
      insertRow(db, { job_id: "job-ver-zero", ingress_id: "ing-ver-zero", version: 0n, turn_id: null });
      bindRunningIn(db, makeJob({ jobId: "job-ver-zero", turnId: "t-0", state: "Running" }));
      const resZero = getIn(db, "job-ver-zero");
      assert.ok(resZero !== null);
      assert.strictEqual(resZero.version, 1n);

      insertRow(db, { job_id: "job-ver-neg", ingress_id: "ing-ver-neg", version: -100n, turn_id: null });
      bindRunningIn(db, makeJob({ jobId: "job-ver-neg", turnId: "t-neg", state: "Running" }));
      const resNeg = getIn(db, "job-ver-neg");
      assert.ok(resNeg !== null);
      assert.strictEqual(resNeg.version, -99n);
    } finally {
      db.close();
    }
  });
});

describe("Unicode regression and boundary-order checks", () => {
  test("getIn malformed high/low jobId throws StoreIntegrityError without aliasing U+FFFD key row", () => {
    const db = createMigratedDb();
    try {
      insertRow(db, {
        job_id: "job-\uFFFD",
        ingress_id: "ing-replacement-row",
        turn_id: "turn-replacement-target",
        accepted_at: 1234.0,
        version: 7n,
      });

      assert.throws(
        () => {
          getIn(db, "job-\uD800");
        },
        (err: unknown) => {
          assert.ok(err instanceof StoreIntegrityError);
          assert.match((err as Error).message, /malformed Unicode scalar in jobId/);
          return true;
        },
      );

      assert.throws(
        () => {
          getIn(db, "job-\uDC00");
        },
        (err: unknown) => {
          assert.ok(err instanceof StoreIntegrityError);
          assert.match((err as Error).message, /malformed Unicode scalar in jobId/);
          return true;
        },
      );

      const replacementRecord = getIn(db, "job-\uFFFD");
      assert.ok(replacementRecord !== null);
      assert.strictEqual(replacementRecord.turnId, "turn-replacement-target");
      assert.strictEqual(replacementRecord.acceptedAt, 1234.0);
      assert.strictEqual(replacementRecord.version, 7n);
    } finally {
      db.close();
    }
  });

  test("Running bind malformed jobId throws StoreIntegrityError and does not modify U+FFFD alias row, even if turnId is null", () => {
    const db = createMigratedDb();
    try {
      insertRow(db, {
        job_id: "job-\uFFFD",
        ingress_id: "ing-replacement-row-bind",
        turn_id: null,
        accepted_at: null,
        version: 1n,
      });

      assert.throws(
        () => {
          bindRunningIn(db, makeJob({
            jobId: "job-\uD800",
            state: "Running",
            turnId: null,
          }));
        },
        (err: unknown) => {
          assert.ok(err instanceof StoreIntegrityError);
          assert.match((err as Error).message, /malformed Unicode scalar in jobId/);
          return true;
        },
      );

      assert.throws(
        () => {
          bindRunningIn(db, makeJob({
            jobId: "job-\uDC00",
            state: "Running",
            turnId: "turn-valid",
          }));
        },
        (err: unknown) => {
          assert.ok(err instanceof StoreIntegrityError);
          assert.match((err as Error).message, /malformed Unicode scalar in jobId/);
          return true;
        },
      );

      const row = getIn(db, "job-\uFFFD");
      assert.ok(row !== null);
      assert.strictEqual(row.turnId, null);
      assert.strictEqual(row.acceptedAt, null);
      assert.strictEqual(row.version, 1n);
    } finally {
      db.close();
    }
  });

  test("non-Running states with malformed jobId and malformed turnId on missing table remain no-op", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const nonRunningStates: Array<"Pending" | "Starting" | "Quarantined"> = [
        "Pending",
        "Starting",
        "Quarantined",
      ];
      for (const st of nonRunningStates) {
        assert.doesNotThrow(() => {
          bindRunningIn(db, makeJob({
            jobId: "job-\uD800",
            turnId: "turn-\uDC00",
            state: st,
          }));
        });
      }
    } finally {
      db.close();
    }
  });

  test("malformed high/low turn on valid Running matching unbound record throws StoreIntegrityError turnId before UPDATE, leaving NULL turn unchanged", () => {
    const db = createMigratedDb();
    try {
      insertRow(db, {
        job_id: "job-valid-unbound",
        ingress_id: "ing-valid-unbound",
        turn_id: null,
        accepted_at: null,
        version: 1n,
      });

      assert.throws(
        () => {
          bindRunningIn(db, makeJob({
            jobId: "job-valid-unbound",
            turnId: "turn-\uD800",
            state: "Running",
            updatedAt: 5555,
          }));
        },
        (err: unknown) => {
          assert.ok(err instanceof StoreIntegrityError);
          assert.match((err as Error).message, /malformed Unicode scalar in turnId/);
          return true;
        },
      );

      assert.throws(
        () => {
          bindRunningIn(db, makeJob({
            jobId: "job-valid-unbound",
            turnId: "turn-\uDC00",
            state: "Running",
            updatedAt: 6666,
          }));
        },
        (err: unknown) => {
          assert.ok(err instanceof StoreIntegrityError);
          assert.match((err as Error).message, /malformed Unicode scalar in turnId/);
          return true;
        },
      );

      const record = getIn(db, "job-valid-unbound");
      assert.ok(record !== null);
      assert.strictEqual(record.turnId, null);
      assert.strictEqual(record.acceptedAt, null);
      assert.strictEqual(record.version, 1n);
    } finally {
      db.close();
    }
  });

  test("distinguish U+FFFD as valid character allowed in jobId and turnId", () => {
    const db = createMigratedDb();
    try {
      insertRow(db, {
        job_id: "job-valid-\uFFFD-test",
        ingress_id: "ing-valid-fffd",
        turn_id: null,
        version: 1n,
      });

      assert.doesNotThrow(() => {
        bindRunningIn(db, makeJob({
          jobId: "job-valid-\uFFFD-test",
          turnId: "turn-\uFFFD-bound",
          updatedAt: 8888.5,
          state: "Running",
        }));
      });

      const record = getIn(db, "job-valid-\uFFFD-test");
      assert.ok(record !== null);
      assert.strictEqual(record.turnId, "turn-\uFFFD-bound");
      assert.strictEqual(record.acceptedAt, 8888.5);
      assert.strictEqual(record.version, 2n);
    } finally {
      db.close();
    }
  });

  test("unused malformed turn branch matrix: missing record noops, matching existing first turn noops retaining all values, destination mismatch throws destination error, malformed SQL row/scan throws decode error", () => {
    const db = createMigratedDb();
    try {
      assert.doesNotThrow(() => {
        bindRunningIn(db, makeJob({
          jobId: "job-nonexistent-matrix",
          turnId: "turn-\uD800",
          state: "Running",
        }));
      });

      insertRow(db, {
        job_id: "job-matrix-retained",
        ingress_id: "ing-matrix-retained",
        turn_id: "existing-custody-turn",
        accepted_at: 1000.0,
        version: 5n,
      });

      assert.doesNotThrow(() => {
        bindRunningIn(db, makeJob({
          jobId: "job-matrix-retained",
          turnId: "turn-\uD800",
          updatedAt: 9999.0,
          state: "Running",
        }));
      });

      const recRetained = getIn(db, "job-matrix-retained");
      assert.ok(recRetained !== null);
      assert.strictEqual(recRetained.turnId, "existing-custody-turn");
      assert.strictEqual(recRetained.acceptedAt, 1000.0);
      assert.strictEqual(recRetained.version, 5n);

      insertRow(db, {
        job_id: "job-matrix-empty-turn",
        ingress_id: "ing-matrix-empty-turn",
        turn_id: "",
        accepted_at: 500.0,
        version: 9n,
      });

      assert.doesNotThrow(() => {
        bindRunningIn(db, makeJob({
          jobId: "job-matrix-empty-turn",
          turnId: "turn-\uDC00",
          updatedAt: 9999.0,
          state: "Running",
        }));
      });

      const recEmpty = getIn(db, "job-matrix-empty-turn");
      assert.ok(recEmpty !== null);
      assert.strictEqual(recEmpty.turnId, "");
      assert.strictEqual(recEmpty.acceptedAt, 500.0);
      assert.strictEqual(recEmpty.version, 9n);

      insertRow(db, {
        job_id: "job-matrix-dest-mismatch",
        ingress_id: "ing-matrix-dest-mismatch",
        identity_json: serializeIdentity({
          thread_id: "thread-exact",
          channel_id: 1000n,
        }),
        turn_id: null,
      });

      assert.throws(
        () => {
          bindRunningIn(db, makeJob({
            jobId: "job-matrix-dest-mismatch",
            targetThreadId: "thread-DIFFERENT",
            channelId: 1000n,
            turnId: "turn-\uD800",
            state: "Running",
          }));
        },
        (err: unknown) => {
          assert.ok(err instanceof StoreIntegrityError);
          assert.ok((err as Error).message.includes("new first-turn binding changed its destination"));
          return true;
        },
      );

      assert.throws(
        () => {
          bindRunningIn(db, makeJob({
            jobId: "job-matrix-dest-mismatch",
            targetThreadId: "thread-exact",
            channelId: 9999n,
            turnId: "turn-\uDC00",
            state: "Running",
          }));
        },
        (err: unknown) => {
          assert.ok(err instanceof StoreIntegrityError);
          assert.ok((err as Error).message.includes("new first-turn binding changed its destination"));
          return true;
        },
      );
    } finally {
      db.close();
    }

    const noAffinityDb = createNoAffinityDb();
    try {
      insertRow(noAffinityDb, {
        job_id: "job-matrix-bad-col",
        ingress_id: "ing-matrix-bad-col",
        turn_id: null,
        version: "not-a-bigint",
      });

      assert.throws(
        () => {
          bindRunningIn(noAffinityDb, makeJob({
            jobId: "job-matrix-bad-col",
            turnId: "turn-\uD800",
            state: "Running",
          }));
        },
        (err: unknown) => {
          assert.ok(err instanceof StoreIntegrityError);
          assert.match((err as Error).message, /column version/);
          return true;
        },
      );
    } finally {
      noAffinityDb.close();
    }

    const migratedBadScanDb = createMigratedDb();
    try {
      insertRow(migratedBadScanDb, {
        job_id: "job-matrix-bad-scan",
        ingress_id: "ing-matrix-bad-scan",
        turn_id: null,
        scan_json: "{ broken scan json ",
      });

      assert.throws(
        () => {
          bindRunningIn(migratedBadScanDb, makeJob({
            jobId: "job-matrix-bad-scan",
            turnId: "turn-\uD800",
            state: "Running",
          }));
        },
        (err: unknown) => {
          assert.ok(err instanceof SyntaxError);
          return true;
        },
      );
    } finally {
      migratedBadScanDb.close();
    }
  });

  test("valid Unicode surrogate pairs and CJK characters preserved exactly in jobId and turnId", () => {
    const db = createMigratedDb();
    try {
      const validJobId = "job-\uD83D\uDE80-\u4E16\u754C";
      const validTurnId = "turn-\uD83D\uDD25-\u6771\u4EAC";

      insertRow(db, {
        job_id: validJobId,
        ingress_id: "ing-unicode-pair",
        turn_id: null,
        version: 1n,
      });

      bindRunningIn(db, makeJob({
        jobId: validJobId,
        turnId: validTurnId,
        state: "Running",
        updatedAt: 7777,
      }));

      const record = getIn(db, validJobId);
      assert.ok(record !== null);
      assert.strictEqual(record.turnId, validTurnId);
      assert.strictEqual(record.acceptedAt, 7777);
      assert.strictEqual(record.version, 2n);
    } finally {
      db.close();
    }
  });

  test("empty jobId selects valid record and empty turnId binds cleanly preserving Rust String domain", () => {
    const db = createMigratedDb();
    try {
      insertRow(db, {
        job_id: "",
        ingress_id: "ing-empty-job-key",
        identity_json: serializeIdentity({ job_id: "" }),
        turn_id: null,
        version: 1n,
      });

      const before = getIn(db, "");
      assert.ok(before !== null);
      assert.strictEqual(before.turnId, null);
      assert.strictEqual(before.identity.job_id, "");

      bindRunningIn(db, makeJob({
        jobId: "",
        turnId: "",
        state: "Running",
        updatedAt: 1234.0,
      }));

      const after = getIn(db, "");
      assert.ok(after !== null);
      assert.strictEqual(after.turnId, "");
      assert.strictEqual(after.acceptedAt, 1234.0);
      assert.strictEqual(after.version, 2n);
    } finally {
      db.close();
    }
  });
});

describe("additional identity and SQL type contract tests", () => {
  test("stored typed identity rejects duplicate known fields and duplicate event_id even if first was null", () => {
    const db = createMigratedDb();
    try {
      const duplicateNullEventIdJson = serializeIdentity({ event_id: null }).replace(
        /\}$/,
        ',"event_id": 1234}',
      );
      insertRow(db, {
        job_id: "job-dup-event-id",
        ingress_id: "ing-dup-event-id",
        identity_json: duplicateNullEventIdJson,
      });

      assert.throws(
        () => {
          getIn(db, "job-dup-event-id");
        },
        (err: unknown) => {
          assert.ok(err instanceof NewReplyIdentityParseError);
          assert.match((err as Error).message, /duplicate field event_id/);
          return true;
        },
      );

      const escapedDuplicateJobIdJson = serializeIdentity().replace(
        /^{"ingress_id":/,
        '{"\\u006a\\u006fb_id": "job-first", "ingress_id":',
      );
      insertRow(db, {
        job_id: "job-dup-escaped-key",
        ingress_id: "ing-dup-escaped-key",
        identity_json: escapedDuplicateJobIdJson,
      });

      assert.throws(
        () => {
          getIn(db, "job-dup-escaped-key");
        },
        (err: unknown) => {
          assert.ok(err instanceof NewReplyIdentityParseError);
          assert.match((err as Error).message, /duplicate field job_id/);
          return true;
        },
      );
    } finally {
      db.close();
    }
  });

  test("typed identity ignores extra field with escaped lone surrogate while scan_json rejects escaped lone surrogate", () => {
    const db = createMigratedDb();
    try {
      const identityWithEscapedLoneSurrogate = serializeIdentity().replace(
        /\}$/,
        ',"extra_ignored": "escaped \\uD800 lone surrogate"}',
      );
      insertRow(db, {
        job_id: "job-id-lone-surrogate-ok",
        ingress_id: "ing-id-lone-surrogate-ok",
        identity_json: identityWithEscapedLoneSurrogate,
        scan_json: '{"ok": 1}',
      });

      const record = getIn(db, "job-id-lone-surrogate-ok");
      assert.ok(record !== null);
      assert.strictEqual(record.identity.job_id, "job-default");

      insertRow(db, {
        job_id: "job-scan-lone-surrogate-reject",
        ingress_id: "ing-scan-lone-surrogate-reject",
        identity_json: serializeIdentity(),
        scan_json: '{"extra_scan": "escaped \\uD800 lone surrogate"}',
      });

      assert.throws(
        () => {
          getIn(db, "job-scan-lone-surrogate-reject");
        },
        (err: unknown) => {
          assert.ok(err instanceof SyntaxError);
          assert.match((err as Error).message, /Lone UTF-16 surrogate/);
          return true;
        },
      );
    } finally {
      db.close();
    }
  });

  test("[schema-bypassed] noaffinity SQL REAL fractions for version, warning_due, and booleans are rejected with StoreIntegrityError", () => {
    const db = createNoAffinityDb();
    try {
      insertRow(db, {
        job_id: "job-real-version",
        ingress_id: "ing-real-version",
        version: 1.5,
      });
      assert.throws(
        () => {
          getIn(db, "job-real-version");
        },
        (err: unknown) => {
          assert.ok(err instanceof StoreIntegrityError);
          assert.match((err as Error).message, /column version/);
          return true;
        },
      );

      insertRow(db, {
        job_id: "job-real-warning",
        ingress_id: "ing-real-warning",
        warning_due: 100.5,
      });
      assert.throws(
        () => {
          getIn(db, "job-real-warning");
        },
        (err: unknown) => {
          assert.ok(err instanceof StoreIntegrityError);
          assert.match((err as Error).message, /column warning_due/);
          return true;
        },
      );

      insertRow(db, {
        job_id: "job-real-conf",
        ingress_id: "ing-real-conf",
        confirmation_delivered: 0.5,
      });
      assert.throws(
        () => {
          getIn(db, "job-real-conf");
        },
        (err: unknown) => {
          assert.ok(err instanceof StoreIntegrityError);
          assert.match((err as Error).message, /boolean column confirmation_delivered/);
          return true;
        },
      );

      insertRow(db, {
        job_id: "job-real-ack",
        ingress_id: "ing-real-ack",
        ack_recovery_allowed: 1.25,
      });
      assert.throws(
        () => {
          getIn(db, "job-real-ack");
        },
        (err: unknown) => {
          assert.ok(err instanceof StoreIntegrityError);
          assert.match((err as Error).message, /boolean column ack_recovery_allowed/);
          return true;
        },
      );
    } finally {
      db.close();
    }
  });

  test("[schema-bypassed] required TEXT NULL/BLOB wrong types rejected, but empty required state and lastError allowed where Rust permits", () => {
    const db = createNoAffinityDb();
    try {
      insertRow(db, {
        job_id: "job-null-id-json",
        ingress_id: "ing-null-id-json",
        identity_json: null,
      });
      assert.throws(
        () => {
          getIn(db, "job-null-id-json");
        },
        (err: unknown) => {
          assert.ok(err instanceof StoreIntegrityError);
          assert.match((err as Error).message, /column identity_json/);
          return true;
        },
      );

      insertRow(db, {
        job_id: "job-blob-id-json",
        ingress_id: "ing-blob-id-json",
        identity_json: new Uint8Array([1, 2, 3]),
      });
      assert.throws(
        () => {
          getIn(db, "job-blob-id-json");
        },
        (err: unknown) => {
          assert.ok(err instanceof StoreIntegrityError);
          assert.match((err as Error).message, /column identity_json/);
          return true;
        },
      );

      insertRow(db, {
        job_id: "job-null-state",
        ingress_id: "ing-null-state",
        state: null,
      });
      assert.throws(
        () => {
          getIn(db, "job-null-state");
        },
        (err: unknown) => {
          assert.ok(err instanceof StoreIntegrityError);
          assert.match((err as Error).message, /column state/);
          return true;
        },
      );

      insertRow(db, {
        job_id: "job-null-last-error",
        ingress_id: "ing-null-last-error",
        last_error: null,
      });
      assert.throws(
        () => {
          getIn(db, "job-null-last-error");
        },
        (err: unknown) => {
          assert.ok(err instanceof StoreIntegrityError);
          assert.match((err as Error).message, /column last_error/);
          return true;
        },
      );

      insertRow(db, {
        job_id: "job-null-scan-json",
        ingress_id: "ing-null-scan-json",
        scan_json: null,
      });
      assert.throws(
        () => {
          getIn(db, "job-null-scan-json");
        },
        (err: unknown) => {
          assert.ok(err instanceof StoreIntegrityError);
          assert.match((err as Error).message, /column scan_json/);
          return true;
        },
      );

      insertRow(db, {
        job_id: "job-empty-state-and-error",
        ingress_id: "ing-empty-state-and-error",
        identity_json: serializeIdentity(),
        state: "",
        last_error: "",
        scan_json: "{}",
      });
      const record = getIn(db, "job-empty-state-and-error");
      assert.ok(record !== null);
      assert.strictEqual(record.state, "");
      assert.strictEqual(record.lastError, "");
    } finally {
      db.close();
    }
  });

  test("acceptedAt decodes SQL i64 integers as Number(BigInt) including I64_MAX and I64_MIN", () => {
    const db = createMigratedDb();
    try {
      db.exec("INSERT INTO codex_new_first_replies (job_id, ingress_id, identity_json, accepted_at) VALUES ('acc-i64-max', 'ing-acc-max', '" + serializeIdentity() + "', 9223372036854775807)");
      const rowMax = getIn(db, "acc-i64-max");
      assert.ok(rowMax !== null);
      assert.strictEqual(typeof rowMax.acceptedAt, "number");
      assert.strictEqual(rowMax.acceptedAt, Number(I64_MAX));

      db.exec("INSERT INTO codex_new_first_replies (job_id, ingress_id, identity_json, accepted_at) VALUES ('acc-i64-min', 'ing-acc-min', '" + serializeIdentity() + "', -9223372036854775808)");
      const rowMin = getIn(db, "acc-i64-min");
      assert.ok(rowMin !== null);
      assert.strictEqual(typeof rowMin.acceptedAt, "number");
      assert.strictEqual(rowMin.acceptedAt, Number(I64_MIN));

      db.exec("INSERT INTO codex_new_first_replies (job_id, ingress_id, identity_json, accepted_at) VALUES ('acc-i64-norm', 'ing-acc-norm', '" + serializeIdentity() + "', 1718000000)");
      const rowNorm = getIn(db, "acc-i64-norm");
      assert.ok(rowNorm !== null);
      assert.strictEqual(typeof rowNorm.acceptedAt, "number");
      assert.strictEqual(rowNorm.acceptedAt, 1718000000);
    } finally {
      db.close();
    }
  });
});
