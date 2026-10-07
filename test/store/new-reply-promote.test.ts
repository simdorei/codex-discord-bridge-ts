import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { parseSerdeValue } from "../../src/core/serde-json-parse.ts";
import {
  type Identity,
  NewReplyIdentityParseError,
  parseNewReplyIdentity,
} from "../../src/store/new-reply-identity.ts";
import {
  promoteIn,
  type NewReplyPromotionIngress,
} from "../../src/store/new-reply-promote.ts";
import { getIn } from "../../src/store/new-reply-read.ts";
import type { NewQueueJob } from "../../src/store/queue-enqueue.ts";
import { StoreIntegrityError } from "../../src/store/schema-assembly.ts";
import { migrateNewReply } from "../../src/store/schema-extensions-b2.ts";

const I64_MIN = -9223372036854775808n;
const I64_MAX = 9223372036854775807n;
const U64_MAX = 18446744073709551615n;
const VALID_DIGEST = "a".repeat(64);

function withDb(fn: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(":memory:");
  try {
    migrateNewReply(db);
    fn(db);
  } finally {
    db.close();
  }
}

function withUnmigratedDb(fn: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(":memory:");
  try {
    fn(db);
  } finally {
    db.close();
  }
}

function createValidSaved(
  modify?: ((s: NewReplyPromotionIngress) => void) | Partial<NewReplyPromotionIngress>,
): NewReplyPromotionIngress {
  const saved: NewReplyPromotionIngress = {
    ingressId: "ing-1",
    kind: "message",
    eventId: 1001n,
    channelId: 2001n,
    sourceMessageId: null,
    outcome: {
      new_reply_seed: {
        state_db: "/path/to/state.db",
        acknowledgement: "acknowledged-text",
      },
      new_creation: {
        version: 1n,
        origin_channel_id: 2001n,
        cwd: "/workspace/project",
      },
      thread_start_generation: 10n,
    },
  };
  if (typeof modify === "function") {
    modify(saved);
  } else if (modify) {
    Object.assign(saved, modify);
  }
  return saved;
}

function createValidJob(
  modify?: ((j: NewQueueJob) => void) | Partial<NewQueueJob>,
): NewQueueJob {
  const job: NewQueueJob = {
    jobId: "job-1",
    targetThreadId: "thread-1",
    channelId: 3001n,
    ownerUserId: 4001n,
    discordMessageId: 5001n,
    appServerGeneration: 10n,
    prompt: "test prompt",
    queued: true,
    ackSent: true,
    createdAt: 1700000000.0,
  };
  if (typeof modify === "function") {
    modify(job);
  } else if (modify) {
    Object.assign(job, modify);
  }
  return job;
}

describe("promoteIn: missing seed short-circuit and early return semantics", () => {
  it("returns immediately on outcome: null without querying DB on unmigrated database", () => {
    withUnmigratedDb((db) => {
      const saved = createValidSaved((s) => {
        s.outcome = null;
      });
      const job = createValidJob();
      assert.equal(promoteIn(db, saved, job, VALID_DIGEST), undefined);
    });
  });

  it("returns immediately on outcome: undefined without querying DB on unmigrated database", () => {
    withUnmigratedDb((db) => {
      const saved = createValidSaved((s) => {
        s.outcome = undefined;
      });
      const job = createValidJob();
      assert.equal(promoteIn(db, saved, job, VALID_DIGEST), undefined);
    });
  });

  it("returns immediately on scalar or array outcome without querying DB", () => {
    withUnmigratedDb((db) => {
      const job = createValidJob();
      for (const badOutcome of [123, "scalar string", false, ["item"]] as unknown[]) {
        const saved = createValidSaved((s) => {
          s.outcome = badOutcome;
        });
        assert.equal(promoteIn(db, saved, job, VALID_DIGEST), undefined);
      }
    });
  });

  it("returns immediately on empty object outcome {} without checking seed or querying DB", () => {
    withUnmigratedDb((db) => {
      const saved = createValidSaved((s) => {
        s.outcome = {};
      });
      const job = createValidJob();
      assert.equal(promoteIn(db, saved, job, VALID_DIGEST), undefined);
    });
  });

  it("returns immediately on outcome lacking new_reply_seed and does not validate unused job or digest", () => {
    withUnmigratedDb((db) => {
      const saved = createValidSaved((s) => {
        s.outcome = { unrelated_field: "value", new_creation: { cwd: "/a" } };
      });
      const job = createValidJob();
      // Invalid digest with lone surrogate should not be evaluated when seed is missing
      const badDigest = "invalid\ud800digest";
      assert.equal(promoteIn(db, saved, job, badDigest), undefined);
    });
  });

  it("leaves getters on unused job and saved fields uninvoked when outcome has no seed", () => {
    withUnmigratedDb((db) => {
      const saved = createValidSaved((s) => {
        s.outcome = {};
      });
      let jobGetterCount = 0;
      let savedGetterCount = 0;
      const job = createValidJob();
      Object.defineProperty(job, "jobId", {
        get() {
          jobGetterCount++;
          return "job-1";
        },
        enumerable: true,
      });
      Object.defineProperty(saved, "ingressId", {
        get() {
          savedGetterCount++;
          return "ing-1";
        },
        enumerable: true,
      });
      promoteIn(db, saved, job, VALID_DIGEST);
      assert.equal(jobGetterCount, 0);
      assert.equal(savedGetterCount, 0);
    });
  });

  it("leaves non-enumerable and setter-only unused fields uninvoked when outcome has no seed", () => {
    withUnmigratedDb((db) => {
      const saved = createValidSaved((s) => {
        s.outcome = {};
      });
      let jobSetterCount = 0;
      let savedSetterCount = 0;
      const job = createValidJob();
      Object.defineProperty(job, "jobId", {
        set(_v: string) {
          jobSetterCount++;
        },
        enumerable: false,
        configurable: true,
      });
      Object.defineProperty(saved, "ingressId", {
        set(_v: string) {
          savedSetterCount++;
        },
        enumerable: false,
        configurable: true,
      });
      assert.equal(promoteIn(db, saved, job, VALID_DIGEST), undefined);
      assert.equal(jobSetterCount, 0);
      assert.equal(savedSetterCount, 0);
    });
  });
});

describe("promoteIn: outcome and seed presence, creation evidence presence", () => {
  it("treats present seed JSON null as Some: missing creation fails first with new creation evidence is missing", () => {
    withDb((db) => {
      const saved = createValidSaved((s) => {
        s.outcome = { new_reply_seed: null };
      });
      const job = createValidJob();
      assert.throws(
        () => promoteIn(db, saved, job, VALID_DIGEST),
        /new creation evidence is missing/,
      );
    });
  });

  it("treats present seed JSON null with valid creation as failing on state_db missing", () => {
    withDb((db) => {
      const saved = createValidSaved((s) => {
        s.outcome = {
          new_reply_seed: null,
          new_creation: {
            version: 1n,
            origin_channel_id: 2001n,
            cwd: "/workspace/project",
          },
          thread_start_generation: 10n,
        };
      });
      const job = createValidJob();
      assert.throws(
        () => promoteIn(db, saved, job, VALID_DIGEST),
        /new evidence field missing: state_db/,
      );
    });
  });

  it("differentiates missing creation vs creation null: missing throws evidence is missing, null throws cwd missing", () => {
    withDb((db) => {
      const job = createValidJob();
      // Missing new_creation property entirely
      const savedMissingCreation = createValidSaved((s) => {
        s.outcome = {
          new_reply_seed: {
            state_db: "/path/to/state.db",
            acknowledgement: "ack",
          },
          thread_start_generation: 10n,
        };
      });
      assert.throws(
        () => promoteIn(db, savedMissingCreation, job, VALID_DIGEST),
        /new creation evidence is missing/,
      );

      // new_creation present as null
      const savedNullCreation = createValidSaved((s) => {
        s.outcome = {
          new_reply_seed: {
            state_db: "/path/to/state.db",
            acknowledgement: "ack",
          },
          new_creation: null,
          thread_start_generation: 10n,
        };
      });
      assert.throws(
        () => promoteIn(db, savedNullCreation, job, VALID_DIGEST),
        /new evidence field missing: cwd/,
      );
    });
  });

  it("fails with missing creation before validating evidence cwd or state_db", () => {
    withDb((db) => {
      const saved = createValidSaved((s) => {
        s.outcome = {
          new_reply_seed: { state_db: "" }, // empty state_db
          // new_creation missing entirely
        };
      });
      const job = createValidJob();
      assert.throws(
        () => promoteIn(db, saved, job, VALID_DIGEST),
        /new creation evidence is missing/,
      );
    });
  });

  it("rejects Proxy outcome objects with TypeError", () => {
    withDb((db) => {
      const trapCounts = {
        get: 0,
        getPrototypeOf: 0,
        getOwnPropertyDescriptor: 0,
        ownKeys: 0,
      };
      const outcomeTarget = {};
      const proxyOutcome = new Proxy(outcomeTarget, {
        get(t, p, r) {
          trapCounts.get++;
          return Reflect.get(t, p, r);
        },
        getPrototypeOf(t) {
          trapCounts.getPrototypeOf++;
          return Reflect.getPrototypeOf(t);
        },
        getOwnPropertyDescriptor(t, p) {
          trapCounts.getOwnPropertyDescriptor++;
          return Reflect.getOwnPropertyDescriptor(t, p);
        },
        ownKeys(t) {
          trapCounts.ownKeys++;
          return Reflect.ownKeys(t);
        },
      });
      const saved = createValidSaved((s) => {
        s.outcome = proxyOutcome;
      });
      const job = createValidJob();
      assert.throws(
        () => promoteIn(db, saved, job, VALID_DIGEST),
        TypeError,
      );
      assert.equal(trapCounts.get, 0);
      assert.equal(trapCounts.getPrototypeOf, 0);
      assert.equal(trapCounts.getOwnPropertyDescriptor, 0);
      assert.equal(trapCounts.ownKeys, 0);
    });
  });

  it("rejects outcome with non-plain prototype with TypeError", () => {
    withDb((db) => {
      class CustomOutcome {}
      const saved = createValidSaved((s) => {
        s.outcome = new CustomOutcome();
      });
      const job = createValidJob();
      assert.throws(
        () => promoteIn(db, saved, job, VALID_DIGEST),
        TypeError,
      );
    });
  });

  it("rejects accessor property for new_reply_seed with TypeError without getter execution", () => {
    withDb((db) => {
      let getterCalled = 0;
      const outcomeObj = {};
      Object.defineProperty(outcomeObj, "new_reply_seed", {
        get() {
          getterCalled++;
          return { state_db: "/s.db", acknowledgement: "ack" };
        },
        enumerable: true,
      });
      const saved = createValidSaved((s) => {
        s.outcome = outcomeObj;
      });
      const job = createValidJob();
      assert.throws(
        () => promoteIn(db, saved, job, VALID_DIGEST),
        TypeError,
      );
      assert.equal(getterCalled, 0);
    });
  });
});

describe("promoteIn: evidence fields validation (cwd, state_db, acknowledgement)", () => {
  it("rejects missing, null, non-string, and empty cwd, but accepts whitespace cwd", () => {
    withDb((db) => {
      const job = createValidJob();

      for (const badCwd of [undefined, null, 123, true, "", []] as unknown[]) {
        const saved = createValidSaved((s) => {
          (s.outcome as { new_creation: Record<string, unknown> }).new_creation["cwd"] = badCwd;
        });
        assert.throws(
          () => promoteIn(db, saved, job, VALID_DIGEST),
          /new evidence field missing: cwd/,
        );
      }

      // Whitespace cwd is accepted
      const savedWhitespace = createValidSaved((s) => {
        (s.outcome as { new_creation: { cwd: string } }).new_creation.cwd = "   ";
      });
      assert.equal(promoteIn(db, savedWhitespace, job, VALID_DIGEST), undefined);
      const record = getIn(db, job.jobId);
      assert.ok(record !== null);
      assert.equal(record.identity.cwd, "   ");
    });
  });

  it("rejects missing, null, non-string, and empty state_db, but accepts whitespace state_db", () => {
    withDb((db) => {
      const job = createValidJob();

      for (const badStateDb of [undefined, null, 456, false, "", {}] as unknown[]) {
        const saved = createValidSaved((s) => {
          (s.outcome as { new_reply_seed: Record<string, unknown> }).new_reply_seed["state_db"] = badStateDb;
        });
        assert.throws(
          () => promoteIn(db, saved, job, VALID_DIGEST),
          /new evidence field missing: state_db/,
        );
      }

      // Whitespace state_db is accepted
      const savedWhitespace = createValidSaved((s) => {
        (s.outcome as { new_reply_seed: { state_db: string } }).new_reply_seed.state_db = " \t ";
      });
      assert.equal(promoteIn(db, savedWhitespace, job, VALID_DIGEST), undefined);
      const record = getIn(db, job.jobId);
      assert.ok(record !== null);
      assert.equal(record.identity.state_db, " \t ");
    });
  });

  it("rejects missing, null, non-string, and empty acknowledgement, but accepts whitespace acknowledgement", () => {
    withDb((db) => {
      const job = createValidJob();

      for (const badAck of [undefined, null, 789n, "", {}] as unknown[]) {
        const saved = createValidSaved((s) => {
          (s.outcome as { new_reply_seed: Record<string, unknown> }).new_reply_seed["acknowledgement"] = badAck;
        });
        assert.throws(
          () => promoteIn(db, saved, job, VALID_DIGEST),
          /new evidence field missing: acknowledgement/,
        );
      }

      // Whitespace acknowledgement is accepted
      const savedWhitespace = createValidSaved((s) => {
        (s.outcome as { new_reply_seed: { acknowledgement: string } }).new_reply_seed.acknowledgement = " \n ";
      });
      assert.equal(promoteIn(db, savedWhitespace, job, VALID_DIGEST), undefined);
      const record = getIn(db, job.jobId);
      assert.ok(record !== null);
      assert.equal(record.identity.acknowledgement, " \n ");
    });
  });

  it("validates cwd before stateDb in field evaluation order", () => {
    withDb((db) => {
      const saved = createValidSaved((s) => {
        (s.outcome as { new_creation: { cwd: string } }).new_creation.cwd = "";
        (s.outcome as { new_reply_seed: { state_db: string } }).new_reply_seed.state_db = "";
      });
      const job = createValidJob();
      assert.throws(
        () => promoteIn(db, saved, job, VALID_DIGEST),
        /new evidence field missing: cwd/,
      );
    });
  });
});

describe("promoteIn: SerdeValue numbers and BigInt validation", () => {
  it("accepts creation.version 1n, but rejects JS number 1, 1.0, float, negative, or overflow", () => {
    withDb((db) => {
      const job = createValidJob();

      for (const badVersion of [1, 1.0, 1.5, -1n, 0n, 2n, U64_MAX + 1n, "1"] as unknown[]) {
        const saved = createValidSaved((s) => {
          (s.outcome as { new_creation: Record<string, unknown> }).new_creation["version"] = badVersion;
        });
        assert.throws(
          () => promoteIn(db, saved, job, VALID_DIGEST),
          /new creation identity changed/,
        );
      }
    });
  });

  it("rejects creation.origin_channel_id if string, float, out of i64 bounds, or mismatched", () => {
    withDb((db) => {
      const job = createValidJob();
      for (const badOrigin of ["2001", 2001, 2001.0, I64_MAX + 1n, I64_MIN - 1n, 9999n] as unknown[]) {
        const saved = createValidSaved((s) => {
          (s.outcome as { new_creation: Record<string, unknown> }).new_creation["origin_channel_id"] = badOrigin;
        });
        assert.throws(
          () => promoteIn(db, saved, job, VALID_DIGEST),
          /new creation identity changed/,
        );
      }
    });
  });

  it("validates outcome.thread_start_generation: requires signed i64 BigInt and rejects missing/float/overflow", () => {
    withDb((db) => {
      const job = createValidJob();
      for (const badGen of [undefined, 10, 10.0, 10.5, "10", I64_MAX + 1n, I64_MIN - 1n] as unknown[]) {
        const saved = createValidSaved((s) => {
          (s.outcome as Record<string, unknown>)["thread_start_generation"] = badGen;
        });
        assert.throws(
          () => promoteIn(db, saved, job, VALID_DIGEST),
          /new creation generation missing/,
        );
      }
    });
  });

  it("accepts signed creation generation: 0n, negative BigInt, I64_MIN, I64_MAX", () => {
    for (const validGen of [0n, -10n, -500n, I64_MIN, I64_MAX]) {
      withDb((db) => {
        const saved = createValidSaved((s) => {
          (s.outcome as { thread_start_generation: bigint }).thread_start_generation = validGen;
        });
        const job = createValidJob();
        promoteIn(db, saved, job, VALID_DIGEST);
        const record = getIn(db, job.jobId);
        assert.ok(record !== null);
        assert.equal(record.identity.creation_generation, validGen);
      });
    }
  });

  it("validates generation before acknowledgement in evaluation order", () => {
    withDb((db) => {
      const saved = createValidSaved((s) => {
        (s.outcome as Record<string, unknown>)["thread_start_generation"] = undefined;
        (s.outcome as { new_reply_seed: { acknowledgement: string } }).new_reply_seed.acknowledgement = "";
      });
      const job = createValidJob();
      assert.throws(
        () => promoteIn(db, saved, job, VALID_DIGEST),
        /new creation generation missing/,
      );
    });
  });

  it("performs creation version and origin_channel_id check AFTER all 12 identity fields are built", () => {
    withDb((db) => {
      // Version is wrong (2n), but acknowledgement is empty (invalid)
      // Acknowledgement check in identity construction must run before creation version check
      const saved = createValidSaved((s) => {
        (s.outcome as { new_creation: { version: bigint } }).new_creation.version = 2n;
        (s.outcome as { new_reply_seed: { acknowledgement: string } }).new_reply_seed.acknowledgement = "";
      });
      const job = createValidJob();
      assert.throws(
        () => promoteIn(db, saved, job, VALID_DIGEST),
        /new evidence field missing: acknowledgement/,
      );
    });
  });

  it("proves lexical 1 vs 1.0 rejection using parsed serdeValue baseline", () => {
    withDb((db) => {
      const parsedInteger = parseSerdeValue<Record<string, unknown>>(
        '{"version":1,"origin_channel_id":2001,"cwd":"/workspace/project"}',
      );
      assert.equal(typeof parsedInteger["version"], "bigint");
      const savedValid = createValidSaved((s) => {
        (s.outcome as Record<string, unknown>)["new_creation"] = parsedInteger;
      });
      const job = createValidJob();
      promoteIn(db, savedValid, job, VALID_DIGEST);
      assert.ok(getIn(db, job.jobId) !== null);

      const parsedFloat = parseSerdeValue<Record<string, unknown>>(
        '{"version":1.0,"origin_channel_id":2001,"cwd":"/workspace/project"}',
      );
      assert.equal(typeof parsedFloat["version"], "number");
      const savedFloat = createValidSaved((s) => {
        (s.outcome as Record<string, unknown>)["new_creation"] = parsedFloat;
      });
      const job2 = createValidJob((j) => {
        j.jobId = "job-float";
      });
      assert.throws(
        () => promoteIn(db, savedFloat, job2, VALID_DIGEST),
        /new creation identity changed/,
      );
    });
  });
});

describe("promoteIn: eventId fallback and channel bounds", () => {
  it("preserves eventId Some 0n over fallback and does not read sourceMessageId", () => {
    withDb((db) => {
      let srcGetterCount = 0;
      const saved = createValidSaved((s) => {
        s.eventId = 0n;
      });
      Object.defineProperty(saved, "sourceMessageId", {
        get() {
          srcGetterCount++;
          return 9999n;
        },
        enumerable: true,
      });
      const job = createValidJob();
      promoteIn(db, saved, job, VALID_DIGEST);
      assert.equal(srcGetterCount, 0);
      const record = getIn(db, job.jobId);
      assert.ok(record !== null);
      assert.equal(record.identity.event_id, 0n);
    });
  });

  it("preserves negative eventId over fallback and keeps getter untouched", () => {
    withDb((db) => {
      let srcGetterCount = 0;
      const saved = createValidSaved((s) => {
        s.eventId = -42n;
      });
      Object.defineProperty(saved, "sourceMessageId", {
        get() {
          srcGetterCount++;
          return 9999n;
        },
        enumerable: true,
      });
      const job = createValidJob();
      promoteIn(db, saved, job, VALID_DIGEST);
      assert.equal(srcGetterCount, 0);
      const record = getIn(db, job.jobId);
      assert.ok(record !== null);
      assert.equal(record.identity.event_id, -42n);
    });
  });

  it("falls back to sourceMessageId when eventId is null", () => {
    withDb((db) => {
      const saved = createValidSaved((s) => {
        s.eventId = null;
        s.sourceMessageId = 8888n;
      });
      const job = createValidJob();
      promoteIn(db, saved, job, VALID_DIGEST);
      const record = getIn(db, job.jobId);
      assert.ok(record !== null);
      assert.equal(record.identity.event_id, 8888n);
    });
  });

  it("persists null event_id when both eventId and sourceMessageId are null", () => {
    withDb((db) => {
      const saved = createValidSaved((s) => {
        s.eventId = null;
        s.sourceMessageId = null;
      });
      const job = createValidJob();
      promoteIn(db, saved, job, VALID_DIGEST);
      const record = getIn(db, job.jobId);
      assert.ok(record !== null);
      assert.equal(record.identity.event_id, null);
    });
  });

  it("rejects out of signed i64 range for fallback sourceMessageId when eventId is null", () => {
    withDb((db) => {
      const saved = createValidSaved((s) => {
        s.eventId = null;
        s.sourceMessageId = I64_MAX + 1n;
      });
      const job = createValidJob();
      assert.throws(
        () => promoteIn(db, saved, job, VALID_DIGEST),
        TypeError,
      );
    });
  });

  it("accepts 0n, negative values, I64_MIN, and I64_MAX for channelId and originChannelId", () => {
    for (const chan of [0n, -100n, I64_MIN, I64_MAX]) {
      withDb((db) => {
        const saved = createValidSaved((s) => {
          s.channelId = chan;
          (s.outcome as { new_creation: { origin_channel_id: bigint } }).new_creation.origin_channel_id = chan;
        });
        const job = createValidJob((j) => {
          j.channelId = chan;
        });
        promoteIn(db, saved, job, VALID_DIGEST);
        const record = getIn(db, job.jobId);
        assert.ok(record !== null);
        assert.equal(record.identity.channel_id, chan);
        assert.equal(record.identity.origin_channel_id, chan);
      });
    }
  });
});

describe("promoteIn: Unicode strings and edge values", () => {
  it("rejects lone high surrogate in saved.ingressId before SQL normalization", () => {
    withDb((db) => {
      const saved = createValidSaved((s) => {
        s.ingressId = "bad\ud800id";
      });
      const job = createValidJob();
      assert.throws(
        () => promoteIn(db, saved, job, VALID_DIGEST),
        TypeError,
      );
    });
  });

  it("rejects lone low surrogate in job.jobId and job.targetThreadId before SQL normalization", () => {
    withDb((db) => {
      const saved = createValidSaved();
      const jobBadId = createValidJob((j) => {
        j.jobId = "bad\udc00job";
      });
      assert.throws(
        () => promoteIn(db, saved, jobBadId, VALID_DIGEST),
        TypeError,
      );

      const jobBadThread = createValidJob((j) => {
        j.targetThreadId = "bad\udc00thread";
      });
      assert.throws(
        () => promoteIn(db, saved, jobBadThread, VALID_DIGEST),
        TypeError,
      );
    });
  });

  it("rejects lone surrogate in digest before SQL normalization", () => {
    withDb((db) => {
      const saved = createValidSaved();
      const job = createValidJob();
      assert.throws(
        () => promoteIn(db, saved, job, "bad\ud800digest"),
        TypeError,
      );
    });
  });

  it("rejects lone surrogate in evidence fields cwd, state_db, acknowledgement with StoreIntegrityError", () => {
    withDb((db) => {
      const job = createValidJob();

      const savedBadCwd = createValidSaved((s) => {
        (s.outcome as { new_creation: { cwd: string } }).new_creation.cwd = "/cwd/\ud800";
      });
      assert.throws(
        () => promoteIn(db, savedBadCwd, job, VALID_DIGEST),
        /new evidence field missing: cwd/,
      );

      const savedBadDb = createValidSaved((s) => {
        (s.outcome as { new_reply_seed: { state_db: string } }).new_reply_seed.state_db = "/db/\udc00";
      });
      assert.throws(
        () => promoteIn(db, savedBadDb, job, VALID_DIGEST),
        /new evidence field missing: state_db/,
      );

      const savedBadAck = createValidSaved((s) => {
        (s.outcome as { new_reply_seed: { acknowledgement: string } }).new_reply_seed.acknowledgement = "ack\ud800";
      });
      assert.throws(
        () => promoteIn(db, savedBadAck, job, VALID_DIGEST),
        /new evidence field missing: acknowledgement/,
      );
    });
  });

  it("permits and preserves valid surrogate pairs (emoji) across strings", () => {
    withDb((db) => {
      const emoji = "\uD83D\uDE00";
      const saved = createValidSaved((s) => {
        s.ingressId = `ing-${emoji}`;
        (s.outcome as { new_creation: { cwd: string } }).new_creation.cwd = `/project/${emoji}`;
        (s.outcome as { new_reply_seed: { state_db: string } }).new_reply_seed.state_db = `/db/${emoji}`;
        (s.outcome as { new_reply_seed: { acknowledgement: string } }).new_reply_seed.acknowledgement = `ack-${emoji}`;
      });
      const job = createValidJob((j) => {
        j.jobId = `job-${emoji}`;
        j.targetThreadId = `thread-${emoji}`;
      });
      promoteIn(db, saved, job, `digest-${emoji}`);
      const record = getIn(db, job.jobId);
      assert.ok(record !== null);
      assert.equal(record.identity.ingress_id, `ing-${emoji}`);
      assert.equal(record.identity.job_id, `job-${emoji}`);
      assert.equal(record.identity.cwd, `/project/${emoji}`);
      assert.equal(record.identity.state_db, `/db/${emoji}`);
      assert.equal(record.identity.acknowledgement, `ack-${emoji}`);
    });
  });

  it("permits and preserves CJK characters across strings", () => {
    withDb((db) => {
      const cjk = "안녕-한국어-測試";
      const saved = createValidSaved((s) => {
        s.ingressId = `ing-${cjk}`;
        (s.outcome as { new_creation: { cwd: string } }).new_creation.cwd = `/경로/${cjk}`;
        (s.outcome as { new_reply_seed: { state_db: string } }).new_reply_seed.state_db = `/데이터/${cjk}`;
        (s.outcome as { new_reply_seed: { acknowledgement: string } }).new_reply_seed.acknowledgement = `확인-${cjk}`;
      });
      const job = createValidJob((j) => {
        j.jobId = `job-${cjk}`;
        j.targetThreadId = `thread-${cjk}`;
      });
      promoteIn(db, saved, job, `digest-${cjk}`);
      const record = getIn(db, job.jobId);
      assert.ok(record !== null);
      assert.equal(record.identity.cwd, `/경로/${cjk}`);
      assert.equal(record.identity.acknowledgement, `확인-${cjk}`);
    });
  });

  it("permits empty strings in non-evidence strings (ingressId, jobId, targetThreadId, digest)", () => {
    withDb((db) => {
      const saved = createValidSaved((s) => {
        s.ingressId = "";
      });
      const job = createValidJob((j) => {
        j.jobId = "";
        j.targetThreadId = "";
      });
      promoteIn(db, saved, job, "");
      const record = getIn(db, "");
      assert.ok(record !== null);
      assert.equal(record.identity.ingress_id, "");
      assert.equal(record.identity.job_id, "");
      assert.equal(record.identity.thread_id, "");
      assert.equal(record.identity.prompt_sha256, "");
    });
  });
});

describe("promoteIn: database insertion, default state, and JSON serialization", () => {
  it("inserts record with exact default state: pending, version 1, scan '{}', null turn_id/accepted_at", () => {
    withDb((db) => {
      const saved = createValidSaved();
      const job = createValidJob();
      promoteIn(db, saved, job, VALID_DIGEST);

      const row = db.prepare(
        "SELECT job_id, ingress_id, state, version, scan_json, turn_id, accepted_at, " +
        "last_error, confirmation_delivered, warning_due, checked_at, ack_recovery_allowed " +
        "FROM codex_new_first_replies WHERE job_id = ?",
      ).get(job.jobId) as Record<string, unknown> | undefined;

      assert.ok(row !== undefined);
      assert.equal(row.job_id, job.jobId);
      assert.equal(row.ingress_id, saved.ingressId);
      assert.equal(row.state, "pending");
      assert.equal(Number(row.version), 1);
      assert.equal(row.scan_json, "{}");
      assert.equal(row.turn_id, null);
      assert.equal(row.accepted_at, null);
      assert.equal(row.last_error, "");
      assert.equal(Number(row.confirmation_delivered), 0);
      assert.equal(Number(row.warning_due), 0);
      assert.equal(Number(row.checked_at), 0);
      assert.equal(Number(row.ack_recovery_allowed), 0);
    });
  });

  it("serializes identity raw JSON in EXACT 12-field struct declaration order", () => {
    withDb((db) => {
      const saved = createValidSaved();
      const job = createValidJob();
      promoteIn(db, saved, job, VALID_DIGEST);

      const row = db.prepare(
        "SELECT identity_json FROM codex_new_first_replies WHERE job_id = ?",
      ).get(job.jobId) as { identity_json: string } | undefined;
      assert.ok(row !== undefined);

      const expectedIdentityJson =
        "{" +
        '"ingress_id":"ing-1",' +
        '"job_id":"job-1",' +
        '"thread_id":"thread-1",' +
        '"cwd":"/workspace/project",' +
        '"state_db":"/path/to/state.db",' +
        '"channel_id":3001,' +
        '"origin_channel_id":2001,' +
        '"event_id":1001,' +
        '"kind":"message",' +
        '"creation_generation":10,' +
        `"prompt_sha256":"${VALID_DIGEST}",` +
        '"acknowledgement":"acknowledged-text"' +
        "}";

      assert.equal(row.identity_json, expectedIdentityJson);
      const parsed = parseNewReplyIdentity(row.identity_json);
      assert.equal(parsed.job_id, "job-1");
      assert.equal(parsed.creation_generation, 10n);
    });
  });

  it("throws on duplicate ingress_id uniqueness via plain INSERT and retains existing row", () => {
    withDb((db) => {
      const saved1 = createValidSaved();
      const job1 = createValidJob((j) => {
        j.jobId = "job-1";
      });
      promoteIn(db, saved1, job1, VALID_DIGEST);

      const savedDuplicateIngress = createValidSaved(); // same ingressId: "ing-1"
      const job2 = createValidJob((j) => {
        j.jobId = "job-2";
      });
      assert.throws(
        () => promoteIn(db, savedDuplicateIngress, job2, VALID_DIGEST),
        /UNIQUE constraint failed/,
      );

      assert.ok(getIn(db, "job-1") !== null);
      assert.equal(getIn(db, "job-2"), null);
    });
  });

  it("respects caller external transaction: ROLLBACK undoes new row without transaction ownership", () => {
    withDb((db) => {
      const saved = createValidSaved();
      const job = createValidJob();
      db.exec("BEGIN");
      promoteIn(db, saved, job, VALID_DIGEST);
      assert.ok(getIn(db, job.jobId) !== null);
      db.exec("ROLLBACK");
      assert.equal(getIn(db, job.jobId), null);
    });
  });

  it("does not auto-commit external transaction on promotion", () => {
    withDb((db) => {
      const saved = createValidSaved();
      const job = createValidJob();
      db.exec("BEGIN");
      promoteIn(db, saved, job, VALID_DIGEST);
      assert.equal(db.isTransaction, true);
      db.exec("COMMIT");
      assert.ok(getIn(db, job.jobId) !== null);
    });
  });

  it("propagates SQLite error when codex_new_first_replies table is missing with valid seed (no auto migration)", () => {
    withUnmigratedDb((db) => {
      const saved = createValidSaved();
      const job = createValidJob();
      assert.throws(
        () => promoteIn(db, saved, job, VALID_DIGEST),
        /no such table: codex_new_first_replies/,
      );
    });
  });
});

describe("promoteIn: existing row idempotency and immutability", () => {
  it("is a complete no-op on identical existing record, leaving every persisted column unchanged", () => {
    withDb((db) => {
      const saved = createValidSaved();
      const job = createValidJob();
      promoteIn(db, saved, job, VALID_DIGEST);

      // Manually advance all state, turn_id, scan, version, etc.
      db.prepare(
        "UPDATE codex_new_first_replies SET " +
        "turn_id = 'turn-xyz', accepted_at = 12345.67, state = 'verified', version = 3, " +
        "scan_json = '{\"scanned\":true}', last_error = 'transient warning', " +
        "confirmation_delivered = 1, warning_due = 42, checked_at = 999.0, ack_recovery_allowed = 1 " +
        "WHERE job_id = ?",
      ).run(job.jobId);

      const beforeStmt = db.prepare("SELECT * FROM codex_new_first_replies WHERE job_id = ?");
      beforeStmt.setReadBigInts(true);
      const beforeRow = beforeStmt.get(job.jobId) as Record<string, unknown> | undefined;
      assert.ok(beforeRow !== undefined);

      // Re-run promotion with identical identity
      promoteIn(db, saved, job, VALID_DIGEST);

      const afterStmt = db.prepare("SELECT * FROM codex_new_first_replies WHERE job_id = ?");
      afterStmt.setReadBigInts(true);
      const afterRow = afterStmt.get(job.jobId) as Record<string, unknown> | undefined;
      assert.ok(afterRow !== undefined);

      // Compare all persisted columns unchanged, including checked_at and identity_json
      assert.deepEqual(afterRow, beforeRow);

      const current = getIn(db, job.jobId);
      assert.ok(current !== null);
      assert.equal(current.turnId, "turn-xyz");
      assert.equal(current.acceptedAt, 12345.67);
      assert.equal(current.state, "verified");
      assert.equal(current.version, 3n);
      assert.deepEqual(current.scan, { scanned: true });
      assert.equal(current.lastError, "transient warning");
      assert.equal(current.confirmationDelivered, true);
      assert.equal(current.warningDue, 42n);
      assert.equal(current.acknowledgementRecoveryAllowed, true);
    });
  });

  it("altering saved.ingressId on existing row throws immutable identity error and does not overwrite", () => {
    withDb((db) => {
      const saved = createValidSaved();
      const job = createValidJob();
      promoteIn(db, saved, job, VALID_DIGEST);

      const altered = createValidSaved((s) => {
        s.ingressId = "ing-altered";
      });
      assert.throws(
        () => promoteIn(db, altered, job, VALID_DIGEST),
        /immutable new first reply identity changed/,
      );
      const record = getIn(db, job.jobId);
      assert.ok(record !== null);
      assert.equal(record.identity.ingress_id, "ing-1");
    });
  });

  it("altering job.targetThreadId on existing row throws immutable identity error", () => {
    withDb((db) => {
      const saved = createValidSaved();
      const job = createValidJob();
      promoteIn(db, saved, job, VALID_DIGEST);

      const alteredJob = createValidJob((j) => {
        j.targetThreadId = "thread-altered";
      });
      assert.throws(
        () => promoteIn(db, saved, alteredJob, VALID_DIGEST),
        /immutable new first reply identity changed/,
      );
    });
  });

  it("altering creation.cwd on existing row throws immutable identity error", () => {
    withDb((db) => {
      const saved = createValidSaved();
      const job = createValidJob();
      promoteIn(db, saved, job, VALID_DIGEST);

      const altered = createValidSaved((s) => {
        (s.outcome as { new_creation: { cwd: string } }).new_creation.cwd = "/altered/cwd";
      });
      assert.throws(
        () => promoteIn(db, altered, job, VALID_DIGEST),
        /immutable new first reply identity changed/,
      );
    });
  });

  it("altering seed.state_db on existing row throws immutable identity error", () => {
    withDb((db) => {
      const saved = createValidSaved();
      const job = createValidJob();
      promoteIn(db, saved, job, VALID_DIGEST);

      const altered = createValidSaved((s) => {
        (s.outcome as { new_reply_seed: { state_db: string } }).new_reply_seed.state_db = "/altered/state.db";
      });
      assert.throws(
        () => promoteIn(db, altered, job, VALID_DIGEST),
        /immutable new first reply identity changed/,
      );
    });
  });

  it("altering job.channelId on existing row throws immutable identity error", () => {
    withDb((db) => {
      const saved = createValidSaved();
      const job = createValidJob();
      promoteIn(db, saved, job, VALID_DIGEST);

      const alteredJob = createValidJob((j) => {
        j.channelId = 9999n;
      });
      assert.throws(
        () => promoteIn(db, saved, alteredJob, VALID_DIGEST),
        /immutable new first reply identity changed/,
      );
    });
  });

  it("altering origin_channel_id on existing row throws immutable identity error", () => {
    withDb((db) => {
      const saved = createValidSaved();
      const job = createValidJob();
      promoteIn(db, saved, job, VALID_DIGEST);

      const altered = createValidSaved((s) => {
        s.channelId = 8888n;
        (s.outcome as { new_creation: { origin_channel_id: bigint } }).new_creation.origin_channel_id = 8888n;
      });
      assert.throws(
        () => promoteIn(db, altered, job, VALID_DIGEST),
        /immutable new first reply identity changed/,
      );
    });
  });

  it("altering event_id on existing row throws immutable identity error", () => {
    withDb((db) => {
      const saved = createValidSaved();
      const job = createValidJob();
      promoteIn(db, saved, job, VALID_DIGEST);

      const altered = createValidSaved((s) => {
        s.eventId = 9999n;
      });
      assert.throws(
        () => promoteIn(db, altered, job, VALID_DIGEST),
        /immutable new first reply identity changed/,
      );
    });
  });

  it("altering kind on existing row throws immutable identity error", () => {
    withDb((db) => {
      const saved = createValidSaved();
      const job = createValidJob();
      promoteIn(db, saved, job, VALID_DIGEST);

      const altered = createValidSaved((s) => {
        s.kind = "interaction";
      });
      assert.throws(
        () => promoteIn(db, altered, job, VALID_DIGEST),
        /immutable new first reply identity changed/,
      );
    });
  });

  it("altering thread_start_generation on existing row throws immutable identity error", () => {
    withDb((db) => {
      const saved = createValidSaved();
      const job = createValidJob();
      promoteIn(db, saved, job, VALID_DIGEST);

      const altered = createValidSaved((s) => {
        (s.outcome as { thread_start_generation: bigint }).thread_start_generation = 99n;
      });
      assert.throws(
        () => promoteIn(db, altered, job, VALID_DIGEST),
        /immutable new first reply identity changed/,
      );
    });
  });

  it("altering digest prompt_sha256 on existing row throws immutable identity error", () => {
    withDb((db) => {
      const saved = createValidSaved();
      const job = createValidJob();
      promoteIn(db, saved, job, VALID_DIGEST);

      assert.throws(
        () => promoteIn(db, saved, job, "b".repeat(64)),
        /immutable new first reply identity changed/,
      );
    });
  });

  it("altering seed.acknowledgement on existing row throws immutable identity error", () => {
    withDb((db) => {
      const saved = createValidSaved();
      const job = createValidJob();
      promoteIn(db, saved, job, VALID_DIGEST);

      const altered = createValidSaved((s) => {
        (s.outcome as { new_reply_seed: { acknowledgement: string } }).new_reply_seed.acknowledgement = "altered ack";
      });
      assert.throws(
        () => promoteIn(db, altered, job, VALID_DIGEST),
        /immutable new first reply identity changed/,
      );
    });
  });

  it("detects mismatched job_id in stored identity and throws immutable identity error", () => {
    withDb((db) => {
      const badIdentity: Identity = {
        ingress_id: "ing-1",
        job_id: "different-job-id",
        thread_id: "thread-1",
        cwd: "/workspace/project",
        state_db: "/path/to/state.db",
        channel_id: 3001n,
        origin_channel_id: 2001n,
        event_id: 1001n,
        kind: "message",
        creation_generation: 10n,
        prompt_sha256: VALID_DIGEST,
        acknowledgement: "acknowledged-text",
      };
      const rawJson = JSON.stringify({
        ...badIdentity,
        channel_id: Number(badIdentity.channel_id),
        origin_channel_id: Number(badIdentity.origin_channel_id),
        event_id: Number(badIdentity.event_id),
        creation_generation: Number(badIdentity.creation_generation),
      });
      db.prepare(
        "INSERT INTO codex_new_first_replies(job_id, ingress_id, identity_json) VALUES(?,?,?)",
      ).run("job-1", "ing-1", rawJson);

      const saved = createValidSaved();
      const job = createValidJob();
      assert.throws(
        () => promoteIn(db, saved, job, VALID_DIGEST),
        /immutable new first reply identity changed/,
      );
    });
  });

  it("propagates getIn bad SQL column type error (version text) before matching no-op", () => {
    withDb((db) => {
      const saved = createValidSaved();
      const job = createValidJob();
      promoteIn(db, saved, job, VALID_DIGEST);

      db.prepare("UPDATE codex_new_first_replies SET version = 'not_a_bigint' WHERE job_id = ?").run(job.jobId);

      assert.throws(
        () => promoteIn(db, saved, job, VALID_DIGEST),
        (err: unknown) => err instanceof StoreIntegrityError && err.message.includes("column version"),
      );
    });
  });

  it("propagates getIn bad SQL column type error (confirmation_delivered text) before matching no-op", () => {
    withDb((db) => {
      const saved = createValidSaved();
      const job = createValidJob();
      promoteIn(db, saved, job, VALID_DIGEST);

      db.prepare("UPDATE codex_new_first_replies SET confirmation_delivered = 'bad_bool' WHERE job_id = ?").run(job.jobId);

      assert.throws(
        () => promoteIn(db, saved, job, VALID_DIGEST),
        (err: unknown) => err instanceof StoreIntegrityError && err.message.includes("confirmation_delivered"),
      );
    });
  });

  it("propagates getIn malformed scan_json error before matching no-op", () => {
    withDb((db) => {
      const saved = createValidSaved();
      const job = createValidJob();
      promoteIn(db, saved, job, VALID_DIGEST);

      db.prepare("UPDATE codex_new_first_replies SET scan_json = '{invalid_scan_json' WHERE job_id = ?").run(job.jobId);

      assert.throws(
        () => promoteIn(db, saved, job, VALID_DIGEST),
        SyntaxError,
      );
    });
  });

  it("propagates getIn malformed identity_json error before matching no-op", () => {
    withDb((db) => {
      const saved = createValidSaved();
      const job = createValidJob();
      promoteIn(db, saved, job, VALID_DIGEST);

      db.prepare("UPDATE codex_new_first_replies SET identity_json = '{malformed' WHERE job_id = ?").run(job.jobId);

      assert.throws(
        () => promoteIn(db, saved, job, VALID_DIGEST),
        NewReplyIdentityParseError,
      );
    });
  });

  it("propagates getIn missing required field in identity_json before matching no-op", () => {
    withDb((db) => {
      const saved = createValidSaved();
      const job = createValidJob();
      promoteIn(db, saved, job, VALID_DIGEST);

      db.prepare("UPDATE codex_new_first_replies SET identity_json = '{\"ingress_id\":\"ing-1\"}' WHERE job_id = ?").run(job.jobId);

      assert.throws(
        () => promoteIn(db, saved, job, VALID_DIGEST),
        NewReplyIdentityParseError,
      );
    });
  });
});

describe("promoteIn: RequiredOwnData boundary correction 002 (regression tests)", () => {
  it("saved.outcome missing as own property and inherited from prototype getter throws TypeError without calling getter", () => {
    withDb((db) => {
      let getterCalled = 0;
      const proto = {
        get outcome() {
          getterCalled++;
          return null;
        },
      };
      const saved = Object.create(proto) as NewReplyPromotionIngress;
      saved.ingressId = "ing-1";
      saved.kind = "message";
      saved.eventId = 1001n;
      saved.channelId = 2001n;
      saved.sourceMessageId = null;

      const job = createValidJob();
      assert.throws(
        () => promoteIn(db, saved, job, VALID_DIGEST),
        TypeError,
      );
      assert.equal(getterCalled, 0);
    });
  });

  it("saved.ingressId as an own getter throws TypeError without calling getter", () => {
    withDb((db) => {
      let getterCalled = 0;
      const saved = createValidSaved();
      Object.defineProperty(saved, "ingressId", {
        get() {
          getterCalled++;
          return "ing-1";
        },
        enumerable: true,
      });
      const job = createValidJob();
      assert.throws(
        () => promoteIn(db, saved, job, VALID_DIGEST),
        TypeError,
      );
      assert.equal(getterCalled, 0);
    });
  });

  it("saved.channelId as an own getter throws TypeError without calling getter", () => {
    withDb((db) => {
      let getterCalled = 0;
      const saved = createValidSaved();
      Object.defineProperty(saved, "channelId", {
        get() {
          getterCalled++;
          return 2001n;
        },
        enumerable: true,
      });
      const job = createValidJob();
      assert.throws(
        () => promoteIn(db, saved, job, VALID_DIGEST),
        TypeError,
      );
      assert.equal(getterCalled, 0);
    });
  });

  it("saved.kind as an own getter throws TypeError without calling getter", () => {
    withDb((db) => {
      let getterCalled = 0;
      const saved = createValidSaved();
      Object.defineProperty(saved, "kind", {
        get() {
          getterCalled++;
          return "message";
        },
        enumerable: true,
      });
      const job = createValidJob();
      assert.throws(
        () => promoteIn(db, saved, job, VALID_DIGEST),
        TypeError,
      );
      assert.equal(getterCalled, 0);
    });
  });

  it("saved.eventId as an own getter throws TypeError without calling getter", () => {
    withDb((db) => {
      let getterCalled = 0;
      const saved = createValidSaved();
      Object.defineProperty(saved, "eventId", {
        get() {
          getterCalled++;
          return 1001n;
        },
        enumerable: true,
      });
      const job = createValidJob();
      assert.throws(
        () => promoteIn(db, saved, job, VALID_DIGEST),
        TypeError,
      );
      assert.equal(getterCalled, 0);
    });
  });

  it("saved.eventId is null and saved.sourceMessageId is an own getter throws TypeError without calling getter", () => {
    withDb((db) => {
      let getterCalled = 0;
      const saved = createValidSaved((s) => {
        s.eventId = null;
      });
      Object.defineProperty(saved, "sourceMessageId", {
        get() {
          getterCalled++;
          return 2002n;
        },
        enumerable: true,
      });
      const job = createValidJob();
      assert.throws(
        () => promoteIn(db, saved, job, VALID_DIGEST),
        TypeError,
      );
      assert.equal(getterCalled, 0);
    });
  });

  it("job.jobId as an own getter throws TypeError without calling getter", () => {
    withDb((db) => {
      let getterCalled = 0;
      const saved = createValidSaved();
      const job = createValidJob();
      Object.defineProperty(job, "jobId", {
        get() {
          getterCalled++;
          return "job-1";
        },
        enumerable: true,
      });
      assert.throws(
        () => promoteIn(db, saved, job, VALID_DIGEST),
        TypeError,
      );
      assert.equal(getterCalled, 0);
    });
  });

  it("job.targetThreadId as an own getter throws TypeError without calling getter", () => {
    withDb((db) => {
      let getterCalled = 0;
      const saved = createValidSaved();
      const job = createValidJob();
      Object.defineProperty(job, "targetThreadId", {
        get() {
          getterCalled++;
          return "thread-1";
        },
        enumerable: true,
      });
      assert.throws(
        () => promoteIn(db, saved, job, VALID_DIGEST),
        TypeError,
      );
      assert.equal(getterCalled, 0);
    });
  });

  it("job.channelId as an own getter throws TypeError without calling getter", () => {
    withDb((db) => {
      let getterCalled = 0;
      const saved = createValidSaved();
      const job = createValidJob();
      Object.defineProperty(job, "channelId", {
        get() {
          getterCalled++;
          return 3001n;
        },
        enumerable: true,
      });
      assert.throws(
        () => promoteIn(db, saved, job, VALID_DIGEST),
        TypeError,
      );
      assert.equal(getterCalled, 0);
    });
  });

  it("job consumed field inherited from prototype throws TypeError without reading", () => {
    withDb((db) => {
      const proto = { jobId: "job-1" };
      const job = Object.create(proto) as NewQueueJob;
      job.targetThreadId = "thread-1";
      job.channelId = 3001n;
      job.ownerUserId = 4001n;
      job.discordMessageId = 5001n;
      job.appServerGeneration = 10n;
      job.prompt = "prompt";
      job.queued = true;
      job.ackSent = true;
      job.createdAt = 1700000000;

      const saved = createValidSaved();
      assert.throws(
        () => promoteIn(db, saved, job, VALID_DIGEST),
        TypeError,
      );
    });
  });

  it("job as Proxy throws TypeError without trap execution", () => {
    withDb((db) => {
      const target = createValidJob();
      const trapCounts = {
        get: 0,
        getPrototypeOf: 0,
        getOwnPropertyDescriptor: 0,
        ownKeys: 0,
      };
      const job = new Proxy(target, {
        get(t, p, r) {
          trapCounts.get++;
          return Reflect.get(t, p, r);
        },
        getPrototypeOf(t) {
          trapCounts.getPrototypeOf++;
          return Reflect.getPrototypeOf(t);
        },
        getOwnPropertyDescriptor(t, p) {
          trapCounts.getOwnPropertyDescriptor++;
          return Reflect.getOwnPropertyDescriptor(t, p);
        },
        ownKeys(t) {
          trapCounts.ownKeys++;
          return Reflect.ownKeys(t);
        },
      });
      const saved = createValidSaved();
      assert.throws(
        () => promoteIn(db, saved, job, VALID_DIGEST),
        TypeError,
      );
      assert.equal(trapCounts.get, 0);
      assert.equal(trapCounts.getPrototypeOf, 0);
      assert.equal(trapCounts.getOwnPropertyDescriptor, 0);
      assert.equal(trapCounts.ownKeys, 0);
    });
  });

  it("job unused fields with getters have 0 getter executions", () => {
    withDb((db) => {
      const saved = createValidSaved();
      const job = createValidJob();

      let promptCalled = 0;
      let ownerCalled = 0;
      let msgCalled = 0;
      let genCalled = 0;
      let queuedCalled = 0;
      let ackCalled = 0;
      let createdCalled = 0;

      Object.defineProperty(job, "prompt", { get() { promptCalled++; return "x"; }, enumerable: true });
      Object.defineProperty(job, "ownerUserId", { get() { ownerCalled++; return null; }, enumerable: true });
      Object.defineProperty(job, "discordMessageId", { get() { msgCalled++; return null; }, enumerable: true });
      Object.defineProperty(job, "appServerGeneration", { get() { genCalled++; return 1n; }, enumerable: true });
      Object.defineProperty(job, "queued", { get() { queuedCalled++; return true; }, enumerable: true });
      Object.defineProperty(job, "ackSent", { get() { ackCalled++; return true; }, enumerable: true });
      Object.defineProperty(job, "createdAt", { get() { createdCalled++; return 123; }, enumerable: true });

      promoteIn(db, saved, job, VALID_DIGEST);

      assert.equal(promptCalled, 0);
      assert.equal(ownerCalled, 0);
      assert.equal(msgCalled, 0);
      assert.equal(genCalled, 0);
      assert.equal(queuedCalled, 0);
      assert.equal(ackCalled, 0);
      assert.equal(createdCalled, 0);
    });
  });

  it("saved.ingressId as an own non-enumerable property throws TypeError", () => {
    withDb((db) => {
      const saved = createValidSaved();
      Object.defineProperty(saved, "ingressId", {
        value: "ing-1",
        enumerable: false,
        configurable: true,
        writable: true,
      });
      const job = createValidJob();
      assert.throws(
        () => promoteIn(db, saved, job, VALID_DIGEST),
        TypeError,
      );
    });
  });

  it("job.jobId as an own non-enumerable property throws TypeError", () => {
    withDb((db) => {
      const saved = createValidSaved();
      const job = createValidJob();
      Object.defineProperty(job, "jobId", {
        value: "job-1",
        enumerable: false,
        configurable: true,
        writable: true,
      });
      assert.throws(
        () => promoteIn(db, saved, job, VALID_DIGEST),
        TypeError,
      );
    });
  });

  it("saved.ingressId as an own setter-only property throws TypeError without calling setter", () => {
    withDb((db) => {
      let setterCalled = 0;
      const saved = createValidSaved();
      Object.defineProperty(saved, "ingressId", {
        set(_v: string) {
          setterCalled++;
        },
        enumerable: true,
        configurable: true,
      });
      const job = createValidJob();
      assert.throws(
        () => promoteIn(db, saved, job, VALID_DIGEST),
        TypeError,
      );
      assert.equal(setterCalled, 0);
    });
  });

  it("job.jobId as an own setter-only property throws TypeError without calling setter", () => {
    withDb((db) => {
      let setterCalled = 0;
      const saved = createValidSaved();
      const job = createValidJob();
      Object.defineProperty(job, "jobId", {
        set(_v: string) {
          setterCalled++;
        },
        enumerable: true,
        configurable: true,
      });
      assert.throws(
        () => promoteIn(db, saved, job, VALID_DIGEST),
        TypeError,
      );
      assert.equal(setterCalled, 0);
    });
  });
});
