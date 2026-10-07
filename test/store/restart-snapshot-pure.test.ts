import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  compareUtf8Bytes,
  computeRestartSnapshotPure,
  InvalidAppServerManagedTargetError,
  InvalidQueueStateError,
  QUARANTINED_ERROR_PREFIX,
  QUARANTINED_TURN_PREFIX,
  rustTrim,
  snapshotEquals,
  STARTING_CANDIDATE_HOLD_PREFIX,
  StoreIntegrityError,
  validateTarget,
} from "../../src/store/restart-snapshot-pure.ts";

describe("restart-snapshot-pure target validation and rustTrim", () => {
  it("validates valid target thread ids", () => {
    assert.doesNotThrow(() => validateTarget("valid_target_123"));
    assert.doesNotThrow(() => validateTarget("th:sub-thread:01"));
  });

  it("rejects empty targets with InvalidAppServerManagedTargetError", () => {
    assert.throws(
      () => validateTarget(""),
      (err: unknown) => {
        assert(err instanceof InvalidAppServerManagedTargetError);
        assert.equal(err.kind, "InvalidAppServerManagedTarget");
        return true;
      },
    );
  });

  it("rejects leading and trailing ASCII whitespace", () => {
    assert.throws(
      () => validateTarget(" target"),
      InvalidAppServerManagedTargetError,
    );
    assert.throws(
      () => validateTarget("target "),
      InvalidAppServerManagedTargetError,
    );
    assert.throws(
      () => validateTarget("\ttarget"),
      InvalidAppServerManagedTargetError,
    );
    assert.throws(
      () => validateTarget("target\n"),
      InvalidAppServerManagedTargetError,
    );
    assert.throws(
      () => validateTarget("target\r"),
      InvalidAppServerManagedTargetError,
    );
  });

  it("rejects leading and trailing NEL (U+0085)", () => {
    assert.throws(
      () => validateTarget("\u0085target"),
      InvalidAppServerManagedTargetError,
    );
    assert.throws(
      () => validateTarget("target\u0085"),
      InvalidAppServerManagedTargetError,
    );
  });

  it("preserves BOM (U+FEFF) and internal spaces/NUL", () => {
    assert.doesNotThrow(() => validateTarget("\uFEFFtarget"));
    assert.doesNotThrow(() => validateTarget("target\uFEFF"));
    assert.doesNotThrow(() => validateTarget("target with interior spaces"));
    assert.doesNotThrow(() => validateTarget("target\0with\0nul"));
  });

  it("rustTrim matches Rust whitespace semantics", () => {
    assert.equal(rustTrim("\u0085trimmed\u0085"), "trimmed");
    assert.equal(rustTrim("\uFEFFbom\uFEFF"), "\uFEFFbom\uFEFF");
    assert.equal(rustTrim("   a\0b   "), "a\0b");
  });
});

describe("restart-snapshot-pure UTF-8 byte ordering vs UTF-16", () => {
  it("orders U+E000 before U+10000 strictly by UTF-8 bytes", () => {
    const uE000 = "\uE000";
    const u10000 = "\u{10000}";

    assert.equal(compareUtf8Bytes(uE000, u10000) < 0, true);

    const snapshot = computeRestartSnapshotPure({
      mirrorThreads: [u10000, uE000],
      turnQueue: [],
    });
    assert.deepEqual(snapshot.targetThreadIds, [uE000, u10000]);
  });

  it("sorts blockers and observations by UTF-8 byte comparison", () => {
    const snapshot = computeRestartSnapshotPure({
      mirrorThreads: [],
      turnQueue: [
        ["job-2", "t1", "starting", null, "err2"],
        ["job-1", "t1", "starting", null, "err1"],
      ],
    });
    assert.deepEqual(snapshot.blockers, [
      "queue job job-1 is starting",
      "queue job job-2 is starting",
    ]);
    assert.deepEqual(snapshot.observations, [
      "queue:job-1:t1:starting",
      "queue:job-2:t1:starting",
    ]);
  });
});

describe("restart-snapshot-pure row formats and deduplication", () => {
  it("accepts tuple, object, and primitive rows across all row groups", () => {
    const snapshot = computeRestartSnapshotPure({
      mirrorThreads: [
        "m1",
        ["m2"],
        { codex_thread_id: "m3" },
        { codexThreadId: "m4" },
      ],
      turnQueue: [
        ["j1", "m1", "pending", null, ""],
        {
          jobId: "j2",
          targetThreadId: "m2",
          state: "pending",
          turnId: null,
          lastError: "",
        },
      ],
      promptIntakes: [
        ["p1", "p-target1", null],
        { jobId: "p2", targetThreadId: "p-target2", claimToken: "tok" },
      ],
      appServerManagedTargets: [
        "app-target1",
        ["app-target2"],
        { thread_id: "app-target3" },
      ],
      threadForkHandoffs: [
        ["h1", "fork-src1", "fork-obs1", "fork-tgt1"],
        {
          handoffId: "h2",
          sourceThreadId: "fork-src2",
          observedTargetThreadId: null,
          targetThreadId: null,
        },
      ],
    });

    assert.deepEqual(snapshot.targetThreadIds, [
      "app-target1",
      "app-target2",
      "app-target3",
      "fork-obs1",
      "fork-src1",
      "fork-src2",
      "fork-tgt1",
      "m1",
      "m2",
      "m3",
      "m4",
      "p-target1",
      "p-target2",
    ]);
    assert.deepEqual(snapshot.blockers, ["prompt intake p2 is claimed"]);
    assert.deepEqual(snapshot.observations, [
      "fork:h1:fork-src1:observed=fork-obs1:target=fork-tgt1",
      "fork:h2:fork-src2:observed=none:target=none",
      "intake:p1:p-target1:claimed=false",
      "intake:p2:p-target2:claimed=true",
      "queue:j1:m1:pending",
      "queue:j2:m2:pending",
    ]);
  });

  it("deduplicates targets while preserving duplicate blockers and observations", () => {
    const snapshot = computeRestartSnapshotPure({
      mirrorThreads: ["dup-target", "dup-target"],
      turnQueue: [
        ["job-1", "dup-target", "starting", null, "err"],
        ["job-1", "dup-target", "starting", null, "err"],
      ],
    });
    assert.deepEqual(snapshot.targetThreadIds, ["dup-target"]);
    assert.equal(snapshot.blockers.length, 2);
    assert.equal(snapshot.observations.length, 2);
    assert.equal(snapshot.blockers[0], snapshot.blockers[1]);
    assert.equal(snapshot.observations[0], snapshot.observations[1]);
  });
});

describe("restart-snapshot-pure fork target order and first error", () => {
  it("validates candidates in exact source, observed, target order", () => {
    assert.throws(
      () =>
        computeRestartSnapshotPure({
          mirrorThreads: [],
          turnQueue: [],
          threadForkHandoffs: [["h1", " bad-src", "valid-obs", "valid-tgt"]],
        }),
      (err: unknown) => {
        assert(err instanceof InvalidAppServerManagedTargetError);
        assert(err.message.includes(" bad-src"));
        return true;
      },
    );

    assert.throws(
      () =>
        computeRestartSnapshotPure({
          mirrorThreads: [],
          turnQueue: [],
          threadForkHandoffs: [["h1", "valid-src", "bad-obs\u0085", "valid-tgt"]],
        }),
      (err: unknown) => {
        assert(err instanceof InvalidAppServerManagedTargetError);
        assert(err.message.includes("bad-obs\u0085"));
        return true;
      },
    );

    assert.throws(
      () =>
        computeRestartSnapshotPure({
          mirrorThreads: [],
          turnQueue: [],
          threadForkHandoffs: [["h1", "valid-src", "valid-obs", "bad-tgt "]],
        }),
      (err: unknown) => {
        assert(err instanceof InvalidAppServerManagedTargetError);
        assert(err.message.includes("bad-tgt "));
        return true;
      },
    );
  });

  it("reports same-row later typed field error before target validation", () => {
    assert.throws(
      () =>
        computeRestartSnapshotPure({
          mirrorThreads: [],
          turnQueue: [
            [
              "job-1",
              " leading-space-target",
              "pending",
              null,
              12345 as unknown as string,
            ],
          ],
        }),
      (err: unknown) => {
        assert(err instanceof StoreIntegrityError);
        assert(
          err.message.includes("codex_turn_queue last_error must be a string"),
        );
        return true;
      },
    );

    assert.throws(
      () =>
        computeRestartSnapshotPure({
          mirrorThreads: [],
          turnQueue: [
            {
              jobId: "job-2",
              targetThreadId: " leading-space-target",
              state: "pending",
              lastError: 12345 as unknown as string,
            },
          ],
        }),
      (err: unknown) => {
        assert(err instanceof StoreIntegrityError);
        assert(
          err.message.includes("codex_turn_queue last_error must be a string"),
        );
        return true;
      },
    );
  });

  it("reports earlier row error before later row error", () => {
    assert.throws(
      () =>
        computeRestartSnapshotPure({
          mirrorThreads: [" bad-target-0", " bad-target-1"],
          turnQueue: [],
        }),
      (err: unknown) => {
        assert(err instanceof InvalidAppServerManagedTargetError);
        assert(err.message.includes(" bad-target-0"));
        return true;
      },
    );

    assert.throws(
      () =>
        computeRestartSnapshotPure({
          mirrorThreads: [12345 as unknown as string, " bad-target-1"],
          turnQueue: [],
        }),
      (err: unknown) => {
        assert(err instanceof StoreIntegrityError);
        assert(
          err.message.includes(
            "Invalid mirror_threads row",
          ),
        );
        return true;
      },
    );
  });
});

describe("restart-snapshot-pure claim token semantics", () => {
  it("evaluates null as unclaimed and empty string as claimed", () => {
    const snapshot = computeRestartSnapshotPure({
      mirrorThreads: [],
      turnQueue: [],
      promptIntakes: [
        ["p-null", "t1", null],
        ["p-empty", "t2", ""],
        ["p-val", "t3", "claim-token-123"],
      ],
    });

    assert.deepEqual(snapshot.blockers, [
      "prompt intake p-empty is claimed",
      "prompt intake p-val is claimed",
    ]);
    assert.deepEqual(snapshot.observations, [
      "intake:p-empty:t2:claimed=true",
      "intake:p-null:t1:claimed=false",
      "intake:p-val:t3:claimed=true",
    ]);
  });

  it("throws StoreIntegrityError on non-text claim_token", () => {
    assert.throws(
      () =>
        computeRestartSnapshotPure({
          mirrorThreads: [],
          turnQueue: [],
          promptIntakes: [["p1", "t1", 12345 as unknown as string]],
        }),
      StoreIntegrityError,
    );
  });
});

describe("restart-snapshot-pure starting hold and quarantine semantics", () => {
  it("recognizes starting hold with exact prefix", () => {
    const snapshot = computeRestartSnapshotPure({
      mirrorThreads: [],
      turnQueue: [
        [
          "job-held",
          "t1",
          "starting",
          null,
          `${STARTING_CANDIDATE_HOLD_PREFIX}candidate_count=2; candidate_turn_ids=["turn-1"]; candidate_ids_listed=1`,
        ],
        ["job-normal", "t2", "starting", null, "ordinary error"],
      ],
    });

    assert.deepEqual(snapshot.blockers, ["queue job job-normal is starting"]);
    assert.deepEqual(snapshot.observations, [
      "queue:job-held:t1:starting_hold",
      "queue:job-normal:t2:starting",
    ]);
  });

  it("recognizes quarantine encoding only when both turn and error prefixes are present", () => {
    const turnOnly = computeRestartSnapshotPure({
      mirrorThreads: [],
      turnQueue: [
        [
          "job-q1",
          "t1",
          "running",
          `${QUARANTINED_TURN_PREFIX}detail`,
          "normal-error",
        ],
      ],
    });
    assert.deepEqual(turnOnly.blockers, ["queue job job-q1 is running"]);
    assert.deepEqual(turnOnly.observations, [
      "queue:job-q1:t1:running",
    ]);

    const errorOnly = computeRestartSnapshotPure({
      mirrorThreads: [],
      turnQueue: [
        [
          "job-q2",
          "t2",
          "running",
          "turn-normal",
          `${QUARANTINED_ERROR_PREFIX}detail`,
        ],
      ],
    });
    assert.deepEqual(errorOnly.blockers, ["queue job job-q2 is running"]);
    assert.deepEqual(errorOnly.observations, [
      "queue:job-q2:t2:running",
    ]);

    const bothQuarantined = computeRestartSnapshotPure({
      mirrorThreads: [],
      turnQueue: [
        [
          "job-q3",
          "t3",
          "running",
          `${QUARANTINED_TURN_PREFIX}detail`,
          `${QUARANTINED_ERROR_PREFIX}detail`,
        ],
      ],
    });
    assert.deepEqual(bothQuarantined.blockers, []);
    assert.deepEqual(bothQuarantined.observations, [
      "queue:job-q3:t3:quarantined",
    ]);
  });

  it("does not hold starting job when starting prefix is missing trailing space", () => {
    const prefixWithoutTrailingSpace = STARTING_CANDIDATE_HOLD_PREFIX.trimEnd();
    const snapshot = computeRestartSnapshotPure({
      mirrorThreads: [],
      turnQueue: [
        [
          "job-held-no-space",
          "t1",
          "starting",
          null,
          `${prefixWithoutTrailingSpace}candidate_count=2; candidate_turn_ids=["turn-1"]; candidate_ids_listed=1`,
        ],
      ],
    });
    assert.deepEqual(snapshot.blockers, [
      "queue job job-held-no-space is starting",
    ]);
    assert.deepEqual(snapshot.observations, [
      "queue:job-held-no-space:t1:starting",
    ]);
  });

  it("throws InvalidQueueStateError on unknown state", () => {
    assert.throws(
      () =>
        computeRestartSnapshotPure({
          mirrorThreads: [],
          turnQueue: [["j1", "t1", "completed", null, ""]],
        }),
      InvalidQueueStateError,
    );
  });

  it("rejects raw queue state quarantined with InvalidQueueStateError", () => {
    assert.throws(
      () =>
        computeRestartSnapshotPure({
          mirrorThreads: [],
          turnQueue: [["j-raw-q", "t1", "quarantined", null, ""]],
        }),
      (err: unknown) => {
        assert(err instanceof InvalidQueueStateError);
        assert.equal(err.kind, "InvalidQueueState");
        assert(err.message.includes("quarantined"));
        return true;
      },
    );
  });
});

describe("restart-snapshot-pure snapshotEquals equality contract", () => {
  it("compares snapshots element-wise and ignores empty optional table creation/deletion", () => {
    const s1 = computeRestartSnapshotPure({
      mirrorThreads: ["t1"],
      turnQueue: [["j1", "t1", "pending", null, ""]],
    });
    const s2 = computeRestartSnapshotPure({
      mirrorThreads: ["t1"],
      turnQueue: [["j1", "t1", "pending", null, ""]],
      promptIntakes: [],
      appServerManagedTargets: [],
      threadForkHandoffs: [],
    });

    assert.equal(snapshotEquals(s1, s2), true);
  });

  it("detects inequality when targets, blockers, or observations differ", () => {
    const base = computeRestartSnapshotPure({
      mirrorThreads: ["t1"],
      turnQueue: [["j1", "t1", "pending", null, ""]],
    });
    const diffTarget = computeRestartSnapshotPure({
      mirrorThreads: ["t2"],
      turnQueue: [["j1", "t2", "pending", null, ""]],
    });
    const diffBlocker = computeRestartSnapshotPure({
      mirrorThreads: ["t1"],
      turnQueue: [["j1", "t1", "starting", null, "err"]],
    });

    assert.equal(snapshotEquals(base, diffTarget), false);
    assert.equal(snapshotEquals(base, diffBlocker), false);
  });

  it("detects inequality when snapshots differ only in observations", () => {
    const s1 = computeRestartSnapshotPure({
      mirrorThreads: ["t1"],
      threadForkHandoffs: [["h1", "t1", null, null]],
    });
    const s2 = computeRestartSnapshotPure({
      mirrorThreads: ["t1"],
      threadForkHandoffs: [["h2", "t1", null, null]],
    });

    assert.deepEqual(s1.targetThreadIds, s2.targetThreadIds);
    assert.deepEqual(s1.blockers, s2.blockers);
    assert.notDeepEqual(s1.observations, s2.observations);
    assert.equal(snapshotEquals(s1, s2), false);
  });

  it("treats different non-null claim_token values as semantically equal", () => {
    const token1 = computeRestartSnapshotPure({
      mirrorThreads: [],
      turnQueue: [],
      promptIntakes: [["p1", "t1", "token-a"]],
    });
    const token2 = computeRestartSnapshotPure({
      mirrorThreads: [],
      turnQueue: [],
      promptIntakes: [["p1", "t1", "token-b"]],
    });

    assert.equal(snapshotEquals(token1, token2), true);
  });
});
