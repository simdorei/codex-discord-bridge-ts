import test, { describe, it } from "node:test";
import assert from "node:assert/strict";

import replayExisting, {
  replay_existing,
  projectSavedSubmission,
  savedSubmission,
  UNRESOLVED_FORK_ERROR_PREFIX,
  STARTING_CANDIDATE_HOLD_PREFIX,
  EXECUTION_HOLD_PREFIX,
  AUTO_RESERVE_HOLD_PREFIX,
  legacyOrCurrentError,
  isActiveWriterMessage,
  BackendFailureConstructors,
  type BackendFailure,
  type BackendFailureKind,
  type Submission,
  type StoredQueueJob,
} from "../../../src/runtime/queue-runner/saved-submission.ts";

interface JobFixtureOverrides {
  readonly jobId?: string;
  readonly targetThreadId?: string;
  readonly channelId?: bigint;
  readonly ownerUserId?: bigint | null;
  readonly discordMessageId?: bigint | null;
  readonly appServerGeneration?: bigint;
  readonly executionGeneration?: bigint | null;
  readonly turnObservationGeneration?: bigint | null;
  readonly goalWaiting?: boolean;
  readonly prompt?: string;
  readonly queued?: boolean;
  readonly ackSent?: boolean;
  readonly state?: "Pending" | "Starting" | "Running" | "Quarantined";
  readonly attemptCount?: bigint;
  readonly turnId?: string | null;
  readonly baselineTurnIds?: string[];
  readonly lastError?: string;
  readonly createdAt?: number;
  readonly updatedAt?: number;
}

function createJobFixture(overrides: JobFixtureOverrides = {}): StoredQueueJob {
  return {
    jobId: overrides.jobId ?? "job-fixture-0001",
    targetThreadId: overrides.targetThreadId ?? "thread-target-100",
    channelId: overrides.channelId ?? 100000000000000001n,
    ownerUserId:
      overrides.ownerUserId !== undefined ? overrides.ownerUserId : 200000000000000002n,
    discordMessageId:
      overrides.discordMessageId !== undefined
        ? overrides.discordMessageId
        : 300000000000000003n,
    appServerGeneration: overrides.appServerGeneration ?? 10n,
    executionGeneration:
      overrides.executionGeneration !== undefined ? overrides.executionGeneration : 20n,
    turnObservationGeneration:
      overrides.turnObservationGeneration !== undefined
        ? overrides.turnObservationGeneration
        : 30n,
    goalWaiting: overrides.goalWaiting ?? false,
    prompt: overrides.prompt ?? "execute test queue task",
    queued: overrides.queued ?? true,
    ackSent: overrides.ackSent ?? true,
    state: overrides.state ?? "Pending",
    attemptCount: overrides.attemptCount ?? 1n,
    turnId: overrides.turnId !== undefined ? overrides.turnId : null,
    baselineTurnIds: overrides.baselineTurnIds ?? [],
    lastError: overrides.lastError ?? "",
    createdAt: overrides.createdAt ?? 1710000000.123,
    updatedAt: overrides.updatedAt ?? 1710000001.456,
  };
}

interface ExpectedSubmission {
  readonly jobId: string;
  readonly queued: boolean;
  readonly turnId: string | null;
  readonly warning?: BackendFailure;
}

// pending: computeContractExpectation branched matrix oracle retained to keep patch bounded <=15000 bytes; prefix assertions do not make entire oracle independent.
function computeContractExpectation(
  state: "Pending" | "Starting" | "Running" | "Quarantined",
  turnId: string | null,
  lastError: string,
  jobId: string,
): ExpectedSubmission {
  const isQuarantined = state === "Quarantined";
  const isFork = lastError.startsWith(UNRESOLVED_FORK_ERROR_PREFIX);
  const isStartingHeld = lastError.startsWith(STARTING_CANDIDATE_HOLD_PREFIX);
  const isExecutionHeld =
    lastError.startsWith(EXECUTION_HOLD_PREFIX) ||
    lastError.startsWith(AUTO_RESERVE_HOLD_PREFIX);

  let warning: BackendFailure | undefined;

  if (isQuarantined) {
    warning = {
      message: lastError,
      ambiguous: true,
      kind: "Quarantined",
    };
  } else if (isFork) {
    warning = {
      message: lastError,
      ambiguous: true,
      kind: "ForkFenced",
    };
  } else if (isStartingHeld) {
    warning = {
      message: lastError,
      ambiguous: true,
      kind: "StartingCandidatesHeld",
    };
  } else if (isExecutionHeld) {
    warning = {
      message: `${EXECUTION_HOLD_PREFIX}${lastError}`,
      ambiguous: false,
      kind: "ExecutionHeld",
    };
  } else if (lastError !== "") {
    const isStarting = state === "Starting";
    const isActiveWriter =
      !isStarting &&
      lastError.includes("thread/resume") &&
      lastError.includes("already has an active writer");
    warning = {
      message: lastError,
      ambiguous: isStarting,
      kind: isActiveWriter ? "ActiveWriter" : "Other",
    };
  }

  const expectedQueued = !isQuarantined && !isStartingHeld && turnId === null;
  const expectedTurnId = isQuarantined || isStartingHeld ? null : turnId;

  if (warning !== undefined) {
    return {
      jobId,
      queued: expectedQueued,
      turnId: expectedTurnId,
      warning,
    };
  }

  return {
    jobId,
    queued: expectedQueued,
    turnId: expectedTurnId,
  };
}

const MATRIX_STATES = ["Pending", "Starting", "Running", "Quarantined"] as const;
const MATRIX_TURNS = [null, "turn-matrix-uuid-1234"] as const;
const MATRIX_PERSISTED_QUEUED = [true, false] as const;

interface MatrixWarningProfile {
  readonly name: string;
  readonly error: string;
}

const MATRIX_WARNING_PROFILES: readonly MatrixWarningProfile[] = [
  { name: "empty", error: "" },
  { name: "ordinary", error: "ordinary queue failure" },
  {
    name: "fork",
    error: `${UNRESOLVED_FORK_ERROR_PREFIX}sub-process crashed`,
  },
  {
    name: "starting",
    error: `${STARTING_CANDIDATE_HOLD_PREFIX}multiple active candidates`,
  },
  {
    name: "modernheld",
    error: `${EXECUTION_HOLD_PREFIX}manual operator pause`,
  },
  {
    name: "legacyheld",
    error: `${AUTO_RESERVE_HOLD_PREFIX}capacity exhaustion hold`,
  },
  {
    name: "activewriter",
    error: "thread/resume failed: thread already has an active writer lease",
  },
  {
    name: "collision",
    error: `${UNRESOLVED_FORK_ERROR_PREFIX}${STARTING_CANDIDATE_HOLD_PREFIX}nested collision`,
  },
];

describe("savedSubmission 128 matrix cases (4 states x 2 turns x 8 warning profiles x 2 persisted queued flags)", () => {
  let caseIndex = 0;
  for (const state of MATRIX_STATES) {
    for (const turnId of MATRIX_TURNS) {
      for (const persistedQueued of MATRIX_PERSISTED_QUEUED) {
        for (const profile of MATRIX_WARNING_PROFILES) {
          caseIndex++;
          const currentCaseIndex = caseIndex;
          const turnDesc = turnId === null ? "null" : `\"${turnId}\"`;
          const title = `[case ${currentCaseIndex}/128] state=${state}, turnId=${turnDesc}, persistedQueued=${persistedQueued}, warningProfile=${profile.name}`;

          it(title, () => {
            const jobId = `job-matrix-${currentCaseIndex}`;
            const job = createJobFixture({
              jobId,
              state,
              turnId,
              queued: persistedQueued,
              lastError: profile.error,
            });

            const expected = computeContractExpectation(
              state,
              turnId,
              profile.error,
              jobId,
            );
            const actual = replayExisting(job);

            assert.deepStrictEqual(actual, expected);
            if (expected.warning === undefined) {
              assert.strictEqual(Object.hasOwn(actual, "warning"), false);
              assert.strictEqual("warning" in actual, false);
            } else {
              assert.strictEqual(Object.hasOwn(actual, "warning"), true);
            }
          });
        }
      }
    }
  }

  it("executes exactly 128 distinct matrix test combinations", () => {
    assert.strictEqual(caseIndex, 128);
  });
});

describe("collision precedence", () => {
  it("quarantine dominates unresolved fork prefix and preserves raw error", () => {
    const rawError = `${UNRESOLVED_FORK_ERROR_PREFIX}sub-process failed unexpectedly`;
    const job = createJobFixture({
      jobId: "job-prec-1",
      state: "Quarantined",
      turnId: "turn-surviving-1",
      queued: true,
      lastError: rawError,
    });

    const actual = replayExisting(job);
    assert.deepStrictEqual(actual, {
      jobId: "job-prec-1",
      queued: false,
      turnId: null,
      warning: {
        message: rawError,
        ambiguous: true,
        kind: "Quarantined",
      },
    });
  });

  it("quarantine dominates starting candidates hold prefix", () => {
    const rawError = `${STARTING_CANDIDATE_HOLD_PREFIX}multiple starting branches found`;
    const job = createJobFixture({
      jobId: "job-prec-2",
      state: "Quarantined",
      turnId: "turn-surviving-2",
      queued: true,
      lastError: rawError,
    });

    const actual = replayExisting(job);
    assert.deepStrictEqual(actual, {
      jobId: "job-prec-2",
      queued: false,
      turnId: null,
      warning: {
        message: rawError,
        ambiguous: true,
        kind: "Quarantined",
      },
    });
  });

  it("quarantine dominates modern execution hold prefix without prefix prepending", () => {
    const rawError = `${EXECUTION_HOLD_PREFIX}manual hold active`;
    const job = createJobFixture({
      jobId: "job-prec-3",
      state: "Quarantined",
      turnId: "turn-surviving-3",
      queued: true,
      lastError: rawError,
    });

    const actual = replayExisting(job);
    assert.deepStrictEqual(actual, {
      jobId: "job-prec-3",
      queued: false,
      turnId: null,
      warning: {
        message: rawError,
        ambiguous: true,
        kind: "Quarantined",
      },
    });
  });

  it("quarantine dominates legacy auto-reserve hold prefix without prefix prepending", () => {
    const rawError = `${AUTO_RESERVE_HOLD_PREFIX}reserve exhausted`;
    const job = createJobFixture({
      jobId: "job-prec-4",
      state: "Quarantined",
      turnId: "turn-surviving-4",
      queued: true,
      lastError: rawError,
    });

    const actual = replayExisting(job);
    assert.deepStrictEqual(actual, {
      jobId: "job-prec-4",
      queued: false,
      turnId: null,
      warning: {
        message: rawError,
        ambiguous: true,
        kind: "Quarantined",
      },
    });
  });

  it("quarantine dominates active writer failure text", () => {
    const rawError = "thread/resume call failed: target thread already has an active writer lease";
    const job = createJobFixture({
      jobId: "job-prec-5",
      state: "Quarantined",
      turnId: "turn-surviving-5",
      queued: true,
      lastError: rawError,
    });

    const actual = replayExisting(job);
    assert.deepStrictEqual(actual, {
      jobId: "job-prec-5",
      queued: false,
      turnId: null,
      warning: {
        message: rawError,
        ambiguous: true,
        kind: "Quarantined",
      },
    });
  });

  it("unresolved fork prefix dominates nested starting candidates hold prefix", () => {
    const rawError = `${UNRESOLVED_FORK_ERROR_PREFIX}${STARTING_CANDIDATE_HOLD_PREFIX}chained warning`;
    const job = createJobFixture({
      jobId: "job-prec-6",
      state: "Pending",
      turnId: "turn-surviving-6",
      queued: true,
      lastError: rawError,
    });

    const actual = replayExisting(job);
    assert.deepStrictEqual(actual, {
      jobId: "job-prec-6",
      queued: false,
      turnId: "turn-surviving-6",
      warning: {
        message: rawError,
        ambiguous: true,
        kind: "ForkFenced",
      },
    });
  });

  it("unresolved fork prefix dominates nested modern execution hold prefix", () => {
    const rawError = `${UNRESOLVED_FORK_ERROR_PREFIX}${EXECUTION_HOLD_PREFIX}fenced during hold`;
    const job = createJobFixture({
      jobId: "job-prec-7",
      state: "Pending",
      turnId: null,
      queued: false,
      lastError: rawError,
    });

    const actual = replayExisting(job);
    assert.deepStrictEqual(actual, {
      jobId: "job-prec-7",
      queued: true,
      turnId: null,
      warning: {
        message: rawError,
        ambiguous: true,
        kind: "ForkFenced",
      },
    });
  });

  it("starting candidates hold prefix dominates nested execution hold prefix", () => {
    const rawError = `${STARTING_CANDIDATE_HOLD_PREFIX}${EXECUTION_HOLD_PREFIX}conflict resolution`;
    const job = createJobFixture({
      jobId: "job-prec-8",
      state: "Pending",
      turnId: "turn-hidden-8",
      queued: true,
      lastError: rawError,
    });

    const actual = replayExisting(job);
    assert.deepStrictEqual(actual, {
      jobId: "job-prec-8",
      queued: false,
      turnId: null,
      warning: {
        message: rawError,
        ambiguous: true,
        kind: "StartingCandidatesHeld",
      },
    });
  });

  it("starting candidates hold prefix dominates nested auto-reserve hold prefix", () => {
    const rawError = `${STARTING_CANDIDATE_HOLD_PREFIX}${AUTO_RESERVE_HOLD_PREFIX}nested reserve hold`;
    const job = createJobFixture({
      jobId: "job-prec-9",
      state: "Running",
      turnId: "turn-hidden-9",
      queued: true,
      lastError: rawError,
    });

    const actual = replayExisting(job);
    assert.deepStrictEqual(actual, {
      jobId: "job-prec-9",
      queued: false,
      turnId: null,
      warning: {
        message: rawError,
        ambiguous: true,
        kind: "StartingCandidatesHeld",
      },
    });
  });

  it("exact prefix anchoring: middle-of-string fork prefix is classified as Other", () => {
    const rawError = `wrapper error: ${UNRESOLVED_FORK_ERROR_PREFIX}nested failure`;
    const job = createJobFixture({
      jobId: "job-prec-10",
      state: "Pending",
      turnId: "turn-keep-10",
      queued: true,
      lastError: rawError,
    });

    const actual = replayExisting(job);
    assert.deepStrictEqual(actual, {
      jobId: "job-prec-10",
      queued: false,
      turnId: "turn-keep-10",
      warning: {
        message: rawError,
        ambiguous: false,
        kind: "Other",
      },
    });
  });

  it("exact prefix anchoring: middle-of-string starting prefix does not clear turnId", () => {
    const rawError = `wrapper log: ${STARTING_CANDIDATE_HOLD_PREFIX}detail text`;
    const job = createJobFixture({
      jobId: "job-prec-11",
      state: "Pending",
      turnId: "turn-keep-11",
      queued: true,
      lastError: rawError,
    });

    const actual = replayExisting(job);
    assert.deepStrictEqual(actual, {
      jobId: "job-prec-11",
      queued: false,
      turnId: "turn-keep-11",
      warning: {
        message: rawError,
        ambiguous: false,
        kind: "Other",
      },
    });
  });

  it("exact prefix anchoring: leading whitespace prevents execution hold classification", () => {
    const rawError = ` ${EXECUTION_HOLD_PREFIX}indented message`;
    const job = createJobFixture({
      jobId: "job-prec-12",
      state: "Pending",
      turnId: null,
      queued: false,
      lastError: rawError,
    });

    const actual = replayExisting(job);
    assert.deepStrictEqual(actual, {
      jobId: "job-prec-12",
      queued: true,
      turnId: null,
      warning: {
        message: rawError,
        ambiguous: false,
        kind: "Other",
      },
    });
  });
});

describe("modern prefix duplication and modern+legacy preservation", () => {
  it("prepends modern prefix to already prefixed modern error (duplication preserved)", () => {
    const rawError = `${EXECUTION_HOLD_PREFIX}database lock held by transaction`;
    const job = createJobFixture({
      jobId: "job-dup-1",
      state: "Pending",
      turnId: "turn-dup-1",
      queued: true,
      lastError: rawError,
    });

    const actual = replayExisting(job);
    assert.deepStrictEqual(actual, {
      jobId: "job-dup-1",
      queued: false,
      turnId: "turn-dup-1",
      warning: {
        message: `${EXECUTION_HOLD_PREFIX}${rawError}`,
        ambiguous: false,
        kind: "ExecutionHeld",
      },
    });
  });

  it("prepends modern prefix to legacy auto-reserve hold prefix (modern+legacy combination preserved)", () => {
    const rawError = `${AUTO_RESERVE_HOLD_PREFIX}quota capacity exhausted`;
    const job = createJobFixture({
      jobId: "job-dup-2",
      state: "Running",
      turnId: null,
      queued: false,
      lastError: rawError,
    });

    const actual = replayExisting(job);
    assert.deepStrictEqual(actual, {
      jobId: "job-dup-2",
      queued: true,
      turnId: null,
      warning: {
        message: `${EXECUTION_HOLD_PREFIX}${rawError}`,
        ambiguous: false,
        kind: "ExecutionHeld",
      },
    });
  });

  it("preserves multiple chained modern prefixes without stripping duplicates", () => {
    const rawError = `${EXECUTION_HOLD_PREFIX}${EXECUTION_HOLD_PREFIX}deeply nested hold`;
    const job = createJobFixture({
      jobId: "job-dup-3",
      state: "Pending",
      turnId: null,
      queued: true,
      lastError: rawError,
    });

    const actual = replayExisting(job);
    assert.deepStrictEqual(actual, {
      jobId: "job-dup-3",
      queued: true,
      turnId: null,
      warning: {
        message: `${EXECUTION_HOLD_PREFIX}${rawError}`,
        ambiguous: false,
        kind: "ExecutionHeld",
      },
    });
  });
});

describe("empty quarantine warning", () => {
  it("emits Quarantined warning with empty string message and ambiguous=true when lastError is empty", () => {
    const job = createJobFixture({
      jobId: "job-empty-q-1",
      state: "Quarantined",
      turnId: "turn-lost-q1",
      queued: true,
      lastError: "",
    });

    const actual = replayExisting(job);
    assert.deepStrictEqual(actual, {
      jobId: "job-empty-q-1",
      queued: false,
      turnId: null,
      warning: {
        message: "",
        ambiguous: true,
        kind: "Quarantined",
      },
    });
    assert.strictEqual(Object.hasOwn(actual, "warning"), true);
  });

  it("sets queued=false and turnId=null on empty quarantine even if input turnId is null", () => {
    const job = createJobFixture({
      jobId: "job-empty-q-2",
      state: "Quarantined",
      turnId: null,
      queued: false,
      lastError: "",
    });

    const actual = replayExisting(job);
    assert.deepStrictEqual(actual, {
      jobId: "job-empty-q-2",
      queued: false,
      turnId: null,
      warning: {
        message: "",
        ambiguous: true,
        kind: "Quarantined",
      },
    });
  });
});

describe("active writer case-sensitive two substrings and Starting ambiguity exclusion", () => {
  it("classifies as ActiveWriter when both exact substrings are present in Pending state", () => {
    const rawError = "failed: thread/resume aborted because channel already has an active writer ongoing";
    const job = createJobFixture({
      jobId: "job-aw-1",
      state: "Pending",
      turnId: "turn-aw-1",
      queued: false,
      lastError: rawError,
    });

    const actual = replayExisting(job);
    assert.deepStrictEqual(actual, {
      jobId: "job-aw-1",
      queued: false,
      turnId: "turn-aw-1",
      warning: {
        message: rawError,
        ambiguous: false,
        kind: "ActiveWriter",
      },
    });
  });

  it("classifies as ActiveWriter when substrings are reversed in text order in Running state", () => {
    const rawError = "database lock: already has an active writer before thread/resume dispatch";
    const job = createJobFixture({
      jobId: "job-aw-2",
      state: "Running",
      turnId: null,
      queued: true,
      lastError: rawError,
    });

    const actual = replayExisting(job);
    assert.deepStrictEqual(actual, {
      jobId: "job-aw-2",
      queued: true,
      turnId: null,
      warning: {
        message: rawError,
        ambiguous: false,
        kind: "ActiveWriter",
      },
    });
  });

  it("excludes ActiveWriter classification in Starting state, returning Other with ambiguous=true", () => {
    const rawError = "thread/resume aborted: thread already has an active writer";
    const job = createJobFixture({
      jobId: "job-aw-3",
      state: "Starting",
      turnId: null,
      queued: false,
      lastError: rawError,
    });

    const actual = replayExisting(job);
    assert.deepStrictEqual(actual, {
      jobId: "job-aw-3",
      queued: true,
      turnId: null,
      warning: {
        message: rawError,
        ambiguous: true,
        kind: "Other",
      },
    });
  });

  it("rejects uppercase substring THREAD/RESUME as ActiveWriter and classifies as Other", () => {
    const rawError = "THREAD/RESUME target already has an active writer";
    const job = createJobFixture({
      jobId: "job-aw-4",
      state: "Pending",
      turnId: null,
      queued: true,
      lastError: rawError,
    });

    const actual = replayExisting(job);
    assert.deepStrictEqual(actual, {
      jobId: "job-aw-4",
      queued: true,
      turnId: null,
      warning: {
        message: rawError,
        ambiguous: false,
        kind: "Other",
      },
    });
  });

  it("rejects titlecase ALREADY HAS AN ACTIVE WRITER as ActiveWriter and classifies as Other", () => {
    const rawError = "thread/resume target Already Has An Active Writer";
    const job = createJobFixture({
      jobId: "job-aw-5",
      state: "Pending",
      turnId: null,
      queued: true,
      lastError: rawError,
    });

    const actual = replayExisting(job);
    assert.deepStrictEqual(actual, {
      jobId: "job-aw-5",
      queued: true,
      turnId: null,
      warning: {
        message: rawError,
        ambiguous: false,
        kind: "Other",
      },
    });
  });

  it("classifies as Other when only thread/resume is present", () => {
    const rawError = "error during thread/resume invocation with no further details";
    const job = createJobFixture({
      jobId: "job-aw-6",
      state: "Pending",
      turnId: null,
      queued: true,
      lastError: rawError,
    });

    const actual = replayExisting(job);
    assert.deepStrictEqual(actual, {
      jobId: "job-aw-6",
      queued: true,
      turnId: null,
      warning: {
        message: rawError,
        ambiguous: false,
        kind: "Other",
      },
    });
  });

  it("classifies as Other when only already has an active writer is present", () => {
    const rawError = "resource locked: target already has an active writer";
    const job = createJobFixture({
      jobId: "job-aw-7",
      state: "Pending",
      turnId: null,
      queued: true,
      lastError: rawError,
    });

    const actual = replayExisting(job);
    assert.deepStrictEqual(actual, {
      jobId: "job-aw-7",
      queued: true,
      turnId: null,
      warning: {
        message: rawError,
        ambiguous: false,
        kind: "Other",
      },
    });
  });
});

describe("warning absence property omission", () => {
  it("omits warning property completely for Pending state when lastError is empty", () => {
    const job = createJobFixture({
      jobId: "job-omit-1",
      state: "Pending",
      turnId: null,
      lastError: "",
    });

    const actual = replayExisting(job);
    assert.strictEqual("warning" in actual, false);
    assert.strictEqual(Object.hasOwn(actual, "warning"), false);
    assert.strictEqual(actual.warning, undefined);
    assert.deepStrictEqual(Object.keys(actual).sort(), ["jobId", "queued", "turnId"].sort());
  });

  it("omits warning property completely for Starting state when lastError is empty", () => {
    const job = createJobFixture({
      jobId: "job-omit-2",
      state: "Starting",
      turnId: "turn-omit-2",
      lastError: "",
    });

    const actual = replayExisting(job);
    assert.strictEqual("warning" in actual, false);
    assert.strictEqual(Object.hasOwn(actual, "warning"), false);
    assert.strictEqual(actual.warning, undefined);
    assert.deepStrictEqual(actual, {
      jobId: "job-omit-2",
      queued: false,
      turnId: "turn-omit-2",
    });
  });

  it("omits warning property completely for Running state when lastError is empty", () => {
    const job = createJobFixture({
      jobId: "job-omit-3",
      state: "Running",
      turnId: null,
      lastError: "",
    });

    const actual = replayExisting(job);
    assert.strictEqual("warning" in actual, false);
    assert.strictEqual(Object.hasOwn(actual, "warning"), false);
    assert.strictEqual(actual.warning, undefined);
    assert.deepStrictEqual(actual, {
      jobId: "job-omit-3",
      queued: true,
      turnId: null,
    });
  });
});

describe("queued vs persisted queued flag independence", () => {
  it("derives queued=true when turnId is null regardless of job.queued value", () => {
    const jobWithQueuedFalse = createJobFixture({
      jobId: "job-indep-1",
      state: "Pending",
      turnId: null,
      queued: false,
      lastError: "",
    });
    const jobWithQueuedTrue = createJobFixture({
      jobId: "job-indep-2",
      state: "Pending",
      turnId: null,
      queued: true,
      lastError: "",
    });

    assert.strictEqual(replayExisting(jobWithQueuedFalse).queued, true);
    assert.strictEqual(replayExisting(jobWithQueuedTrue).queued, true);
  });

  it("derives queued=false when turnId is non-null regardless of job.queued value", () => {
    const jobWithQueuedFalse = createJobFixture({
      jobId: "job-indep-3",
      state: "Pending",
      turnId: "turn-exists-3",
      queued: false,
      lastError: "",
    });
    const jobWithQueuedTrue = createJobFixture({
      jobId: "job-indep-4",
      state: "Pending",
      turnId: "turn-exists-4",
      queued: true,
      lastError: "",
    });

    assert.strictEqual(replayExisting(jobWithQueuedFalse).queued, false);
    assert.strictEqual(replayExisting(jobWithQueuedTrue).queued, false);
  });

  it("derives queued=false on Quarantined state even when turnId is null and job.queued is true", () => {
    const job = createJobFixture({
      jobId: "job-indep-5",
      state: "Quarantined",
      turnId: null,
      queued: true,
      lastError: "",
    });

    assert.strictEqual(replayExisting(job).queued, false);
  });

  it("derives queued=false on starting candidates held even when turnId is null and job.queued is true", () => {
    const job = createJobFixture({
      jobId: "job-indep-6",
      state: "Pending",
      turnId: null,
      queued: true,
      lastError: `${STARTING_CANDIDATE_HOLD_PREFIX}conflict`,
    });

    assert.strictEqual(replayExisting(job).queued, false);
  });
});

describe("non-null and empty turn exact preservation", () => {
  it("preserves exact non-null turn string when unheld", () => {
    const job = createJobFixture({
      jobId: "job-turn-1",
      state: "Pending",
      turnId: "turn-active-alpha-999",
      lastError: "",
    });

    const actual = replayExisting(job);
    assert.strictEqual(actual.turnId, "turn-active-alpha-999");
    assert.strictEqual(actual.queued, false);
  });

  it("preserves exact empty string turnId without coercing to null", () => {
    const job = createJobFixture({
      jobId: "job-turn-2",
      state: "Pending",
      turnId: "",
      lastError: "",
    });

    const actual = replayExisting(job);
    assert.strictEqual(actual.turnId, "");
    assert.strictEqual(actual.queued, false);
  });

  it("clears non-null turnId to null when job is Quarantined", () => {
    const job = createJobFixture({
      jobId: "job-turn-3",
      state: "Quarantined",
      turnId: "turn-quarantined-alpha",
      lastError: "quarantined worker",
    });

    const actual = replayExisting(job);
    assert.strictEqual(actual.turnId, null);
  });

  it("clears empty string turnId to null when job is Quarantined", () => {
    const job = createJobFixture({
      jobId: "job-turn-4",
      state: "Quarantined",
      turnId: "",
      lastError: "quarantined worker",
    });

    const actual = replayExisting(job);
    assert.strictEqual(actual.turnId, null);
  });

  it("clears non-null turnId to null when starting candidates hold prefix matches", () => {
    const job = createJobFixture({
      jobId: "job-turn-5",
      state: "Running",
      turnId: "turn-running-alpha",
      lastError: `${STARTING_CANDIDATE_HOLD_PREFIX}split candidate`,
    });

    const actual = replayExisting(job);
    assert.strictEqual(actual.turnId, null);
  });

  it("clears empty string turnId to null when starting candidates hold prefix matches", () => {
    const job = createJobFixture({
      jobId: "job-turn-6",
      state: "Running",
      turnId: "",
      lastError: `${STARTING_CANDIDATE_HOLD_PREFIX}split candidate`,
    });

    const actual = replayExisting(job);
    assert.strictEqual(actual.turnId, null);
  });

  it("preserves non-null turnId under unresolved fork prefix", () => {
    const job = createJobFixture({
      jobId: "job-turn-7",
      state: "Pending",
      turnId: "turn-surviving-fork",
      lastError: `${UNRESOLVED_FORK_ERROR_PREFIX}fenced`,
    });

    const actual = replayExisting(job);
    assert.strictEqual(actual.turnId, "turn-surviving-fork");
  });

  it("preserves non-null turnId under execution hold prefix", () => {
    const job = createJobFixture({
      jobId: "job-turn-8",
      state: "Pending",
      turnId: "turn-surviving-hold",
      lastError: `${EXECUTION_HOLD_PREFIX}held`,
    });

    const actual = replayExisting(job);
    assert.strictEqual(actual.turnId, "turn-surviving-hold");
  });
});

describe("Unicode and special characters", () => {
  it("preserves multi-byte Unicode, emojis, escaped characters, and whitespace verbatim", () => {
    const unicodeJobId = "작업-id-#123-🚀-한글-测试-カタカナ";
    const unicodeTurnId = "턴-turn-🌟-uuid-456";
    const unicodePrompt = "멀티라인 프롬프트:\n\t 줄바꿈과 탭 및 따옴표 \" ' \\ 특수문자 🔥";
    const unicodeError = `${UNRESOLVED_FORK_ERROR_PREFIX}오류 발생: 💥 세부정보 (Line 1\nLine 2\tTab) \"인용구\"`;

    const job = createJobFixture({
      jobId: unicodeJobId,
      turnId: unicodeTurnId,
      prompt: unicodePrompt,
      lastError: unicodeError,
      state: "Pending",
    });

    const actual = replayExisting(job);
    assert.strictEqual(actual.jobId, unicodeJobId);
    assert.strictEqual(actual.turnId, unicodeTurnId);
    assert.strictEqual(actual.warning?.message, unicodeError);
    assert.strictEqual(actual.warning?.kind, "ForkFenced");
    assert.strictEqual(actual.warning?.ambiguous, true);
  });
});

describe("two independent owned records and source input unchanged / no shared mutable warning", () => {
  it("does not mutate any property on input StoredQueueJob fixture", () => {
    const initialJob = createJobFixture({
      jobId: "job-mut-check-1",
      state: "Pending",
      turnId: "turn-mut-1",
      lastError: `${EXECUTION_HOLD_PREFIX}lock held`,
      queued: true,
      prompt: "unchanged prompt",
    });

    const snapshot: StoredQueueJob = {
      jobId: initialJob.jobId,
      targetThreadId: initialJob.targetThreadId,
      channelId: initialJob.channelId,
      ownerUserId: initialJob.ownerUserId,
      discordMessageId: initialJob.discordMessageId,
      appServerGeneration: initialJob.appServerGeneration,
      executionGeneration: initialJob.executionGeneration,
      turnObservationGeneration: initialJob.turnObservationGeneration,
      goalWaiting: initialJob.goalWaiting,
      prompt: initialJob.prompt,
      queued: initialJob.queued,
      ackSent: initialJob.ackSent,
      state: initialJob.state,
      attemptCount: initialJob.attemptCount,
      turnId: initialJob.turnId,
      baselineTurnIds: [...initialJob.baselineTurnIds],
      lastError: initialJob.lastError,
      createdAt: initialJob.createdAt,
      updatedAt: initialJob.updatedAt,
    };

    replayExisting(initialJob);

    assert.deepStrictEqual(initialJob, snapshot);
  });

  it("succeeds cleanly when input StoredQueueJob is deeply frozen", () => {
    const frozenJob = Object.freeze(createJobFixture({
      jobId: "job-frozen-1",
      state: "Quarantined",
      turnId: "turn-frozen-1",
      lastError: "frozen error text",
      baselineTurnIds: Object.freeze([]) as unknown as string[],
    }));

    assert.doesNotThrow(() => {
      const actual = replayExisting(frozenJob);
      assert.strictEqual(actual.jobId, "job-frozen-1");
      assert.strictEqual(actual.turnId, null);
      assert.strictEqual(actual.queued, false);
      assert.strictEqual(actual.warning?.kind, "Quarantined");
    });
  });

  it("creates two independent owned records without shared mutable warning references", () => {
    const jobA = createJobFixture({
      jobId: "job-record-a",
      targetThreadId: "thread-a",
      state: "Pending",
      turnId: "turn-a",
      lastError: "common error detail",
    });
    const jobB = createJobFixture({
      jobId: "job-record-b",
      targetThreadId: "thread-b",
      state: "Pending",
      turnId: "turn-b",
      lastError: "common error detail",
    });

    const subA = replayExisting(jobA);
    const subB = replayExisting(jobB);

    assert.strictEqual(jobA.targetThreadId, "thread-a");
    assert.strictEqual(jobB.targetThreadId, "thread-b");
    assert.strictEqual(jobA.lastError, "common error detail");
    assert.strictEqual(jobB.lastError, "common error detail");

    assert.notStrictEqual(subA, subB);
    assert.strictEqual(subA.jobId, "job-record-a");
    assert.strictEqual(subB.jobId, "job-record-b");
    assert.notStrictEqual(subA.warning, subB.warning);
    assert.deepStrictEqual(subA.warning, subB.warning);

    if (subA.warning) {
      (subA.warning as { message: string }).message = "mutated-warning-a";
      assert.strictEqual(subB.warning?.message, "common error detail");
    }
  });
});

describe("helper functions and re-exported aliases", () => {
  it("legacyOrCurrentError matches modern and legacy hold prefixes and rejects others", () => {
    assert.strictEqual(legacyOrCurrentError(`${EXECUTION_HOLD_PREFIX}details`), true);
    assert.strictEqual(legacyOrCurrentError(`${AUTO_RESERVE_HOLD_PREFIX}details`), true);
    assert.strictEqual(legacyOrCurrentError(`${UNRESOLVED_FORK_ERROR_PREFIX}details`), false);
    assert.strictEqual(legacyOrCurrentError(`${STARTING_CANDIDATE_HOLD_PREFIX}details`), false);
    assert.strictEqual(legacyOrCurrentError("standard error message"), false);
    assert.strictEqual(legacyOrCurrentError(""), false);
  });

  it("isActiveWriterMessage verifies conjunction of thread/resume and already has an active writer", () => {
    assert.strictEqual(
      isActiveWriterMessage("prefix thread/resume mid already has an active writer suffix"),
      true,
    );
    assert.strictEqual(
      isActiveWriterMessage("already has an active writer and thread/resume"),
      true,
    );
    assert.strictEqual(isActiveWriterMessage("thread/resume only"), false);
    assert.strictEqual(isActiveWriterMessage("already has an active writer only"), false);
    assert.strictEqual(isActiveWriterMessage("Thread/Resume already has an active writer"), false);
    assert.strictEqual(isActiveWriterMessage(""), false);
  });

  it("BackendFailureConstructors builds expected structures for all kinds", () => {
    assert.deepStrictEqual(BackendFailureConstructors.quarantined("q-msg"), {
      message: "q-msg",
      ambiguous: true,
      kind: "Quarantined",
    });
    assert.deepStrictEqual(BackendFailureConstructors.forkFenced("fork-msg"), {
      message: "fork-msg",
      ambiguous: true,
      kind: "ForkFenced",
    });
    assert.deepStrictEqual(
      BackendFailureConstructors.startingCandidatesHeld("starting-msg"),
      {
        message: "starting-msg",
        ambiguous: true,
        kind: "StartingCandidatesHeld",
      },
    );
    assert.deepStrictEqual(BackendFailureConstructors.executionHeld("exec-msg"), {
      message: `${EXECUTION_HOLD_PREFIX}exec-msg`,
      ambiguous: false,
      kind: "ExecutionHeld",
    });

    assert.deepStrictEqual(
      BackendFailureConstructors.persisted(`${UNRESOLVED_FORK_ERROR_PREFIX}fork`, false),
      {
        message: `${UNRESOLVED_FORK_ERROR_PREFIX}fork`,
        ambiguous: false,
        kind: "ForkFenced",
      },
    );
    assert.deepStrictEqual(
      BackendFailureConstructors.persisted(`${STARTING_CANDIDATE_HOLD_PREFIX}start`, false),
      {
        message: `${STARTING_CANDIDATE_HOLD_PREFIX}start`,
        ambiguous: false,
        kind: "StartingCandidatesHeld",
      },
    );
    assert.deepStrictEqual(
      BackendFailureConstructors.persisted(`${EXECUTION_HOLD_PREFIX}hold`, false),
      {
        message: `${EXECUTION_HOLD_PREFIX}hold`,
        ambiguous: false,
        kind: "ExecutionHeld",
      },
    );
    assert.deepStrictEqual(
      BackendFailureConstructors.persisted(`${AUTO_RESERVE_HOLD_PREFIX}hold`, false),
      {
        message: `${AUTO_RESERVE_HOLD_PREFIX}hold`,
        ambiguous: false,
        kind: "ExecutionHeld",
      },
    );
    assert.deepStrictEqual(
      BackendFailureConstructors.persisted(
        "thread/resume target already has an active writer",
        false,
      ),
      {
        message: "thread/resume target already has an active writer",
        ambiguous: false,
        kind: "ActiveWriter",
      },
    );
    assert.deepStrictEqual(
      BackendFailureConstructors.persisted(
        "thread/resume target already has an active writer",
        true,
      ),
      {
        message: "thread/resume target already has an active writer",
        ambiguous: true,
        kind: "Other",
      },
    );
    assert.deepStrictEqual(BackendFailureConstructors.persisted("ordinary text", false), {
      message: "ordinary text",
      ambiguous: false,
      kind: "Other",
    });
    assert.deepStrictEqual(BackendFailureConstructors.persisted("ordinary text", true), {
      message: "ordinary text",
      ambiguous: true,
      kind: "Other",
    });
  });

  it("re-exported aliases are identical references to replayExisting", () => {
    assert.strictEqual(replay_existing, replayExisting);
    assert.strictEqual(projectSavedSubmission, replayExisting);
    assert.strictEqual(savedSubmission, replayExisting);
  });
});
