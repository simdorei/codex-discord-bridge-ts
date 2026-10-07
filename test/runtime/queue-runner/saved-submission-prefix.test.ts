import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SourceQueueJob } from "../../../src/runtime/queue-runner/saved-submission.ts";
import {
  AUTO_RESERVE_HOLD_PREFIX,
  EXECUTION_HOLD_PREFIX,
  STARTING_CANDIDATE_HOLD_PREFIX,
  UNRESOLVED_FORK_ERROR_PREFIX,
  replayExisting,
} from "../../../src/runtime/queue-runner/saved-submission.ts";

function createJob(lastError: string, turnId: string | null = null): SourceQueueJob {
  return {
    jobId: "job-prefix-test", targetThreadId: "thread-prefix-test",
    channelId: 100n, ownerUserId: null, discordMessageId: null,
    appServerGeneration: 1n, executionGeneration: null, turnObservationGeneration: null,
    goalWaiting: false, prompt: "test-prompt", queued: true, ackSent: false,
    state: "Pending", attemptCount: 0n, turnId, baselineTurnIds: [],
    lastError, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000,
  };
}

describe("saved-submission prefix constants and retry classification", () => {
  it("exported prefix constants match exact Rust definition strings with trailing space", () => {
    assert.strictEqual(UNRESOLVED_FORK_ERROR_PREFIX, "[cdr-rust:app-server-fork-unresolved:v1] ");
    assert.strictEqual(STARTING_CANDIDATE_HOLD_PREFIX, "[cdr-rust:turn-start-candidates-ambiguous:v1] ");
    assert.strictEqual(EXECUTION_HOLD_PREFIX, "[cdr-rust:execution-held:v1] ");
    assert.strictEqual(AUTO_RESERVE_HOLD_PREFIX, "[cdr-rust:auto-reserve-hold:v1] ");
  });

  interface PrefixCase {
    readonly name: string;
    readonly input: string;
    readonly queued: boolean;
    readonly warning: {
      readonly message: string;
      readonly ambiguous: boolean;
      readonly kind: "Other" | "ForkFenced" | "StartingCandidatesHeld" | "ExecutionHeld";
    };
  }

  const cases: readonly PrefixCase[] = [
    {
      name: "unresolved fork missing final space => Other",
      input: "[cdr-rust:app-server-fork-unresolved:v1]",
      queued: true,
      warning: { message: "[cdr-rust:app-server-fork-unresolved:v1]", ambiguous: false, kind: "Other" },
    },
    {
      name: "unresolved fork changed case => Other",
      input: "[CDR-RUST:APP-SERVER-FORK-UNRESOLVED:V1] ",
      queued: true,
      warning: { message: "[CDR-RUST:APP-SERVER-FORK-UNRESOLVED:V1] ", ambiguous: false, kind: "Other" },
    },
    {
      name: "unresolved fork leading text => Other",
      input: "error: [cdr-rust:app-server-fork-unresolved:v1] ",
      queued: true,
      warning: { message: "error: [cdr-rust:app-server-fork-unresolved:v1] ", ambiguous: false, kind: "Other" },
    },
    {
      name: "unresolved fork alone with space => ForkFenced",
      input: "[cdr-rust:app-server-fork-unresolved:v1] ",
      queued: true,
      warning: { message: "[cdr-rust:app-server-fork-unresolved:v1] ", ambiguous: true, kind: "ForkFenced" },
    },
    {
      name: "starting candidates held missing final space => Other",
      input: "[cdr-rust:turn-start-candidates-ambiguous:v1]",
      queued: true,
      warning: { message: "[cdr-rust:turn-start-candidates-ambiguous:v1]", ambiguous: false, kind: "Other" },
    },
    {
      name: "starting candidates held changed case => Other",
      input: "[CDR-RUST:TURN-START-CANDIDATES-AMBIGUOUS:V1] ",
      queued: true,
      warning: { message: "[CDR-RUST:TURN-START-CANDIDATES-AMBIGUOUS:V1] ", ambiguous: false, kind: "Other" },
    },
    {
      name: "starting candidates held leading text => Other",
      input: "error: [cdr-rust:turn-start-candidates-ambiguous:v1] ",
      queued: true,
      warning: { message: "error: [cdr-rust:turn-start-candidates-ambiguous:v1] ", ambiguous: false, kind: "Other" },
    },
    {
      name: "starting candidates held alone with space => StartingCandidatesHeld and queued=false",
      input: "[cdr-rust:turn-start-candidates-ambiguous:v1] ",
      queued: false,
      warning: { message: "[cdr-rust:turn-start-candidates-ambiguous:v1] ", ambiguous: true, kind: "StartingCandidatesHeld" },
    },
    {
      name: "execution held missing final space => Other",
      input: "[cdr-rust:execution-held:v1]",
      queued: true,
      warning: { message: "[cdr-rust:execution-held:v1]", ambiguous: false, kind: "Other" },
    },
    {
      name: "execution held changed case => Other",
      input: "[CDR-RUST:EXECUTION-HELD:V1] ",
      queued: true,
      warning: { message: "[CDR-RUST:EXECUTION-HELD:V1] ", ambiguous: false, kind: "Other" },
    },
    {
      name: "execution held leading text => Other",
      input: "error: [cdr-rust:execution-held:v1] ",
      queued: true,
      warning: { message: "error: [cdr-rust:execution-held:v1] ", ambiguous: false, kind: "Other" },
    },
    {
      name: "execution held alone with space => modern prefix duplicated",
      input: "[cdr-rust:execution-held:v1] ",
      queued: true,
      warning: { message: "[cdr-rust:execution-held:v1] [cdr-rust:execution-held:v1] ", ambiguous: false, kind: "ExecutionHeld" },
    },
    {
      name: "execution held with detail => modern prefix duplicated",
      input: "[cdr-rust:execution-held:v1] failure detail",
      queued: true,
      warning: { message: "[cdr-rust:execution-held:v1] [cdr-rust:execution-held:v1] failure detail", ambiguous: false, kind: "ExecutionHeld" },
    },
    {
      name: "auto reserve hold missing final space => Other",
      input: "[cdr-rust:auto-reserve-hold:v1]",
      queued: true,
      warning: { message: "[cdr-rust:auto-reserve-hold:v1]", ambiguous: false, kind: "Other" },
    },
    {
      name: "auto reserve hold changed case => Other",
      input: "[CDR-RUST:AUTO-RESERVE-HOLD:V1] ",
      queued: true,
      warning: { message: "[CDR-RUST:AUTO-RESERVE-HOLD:V1] ", ambiguous: false, kind: "Other" },
    },
    {
      name: "auto reserve hold leading text => Other",
      input: "error: [cdr-rust:auto-reserve-hold:v1] ",
      queued: true,
      warning: { message: "error: [cdr-rust:auto-reserve-hold:v1] ", ambiguous: false, kind: "Other" },
    },
    {
      name: "auto reserve hold alone with space => modern + legacy preserved",
      input: "[cdr-rust:auto-reserve-hold:v1] ",
      queued: true,
      warning: { message: "[cdr-rust:execution-held:v1] [cdr-rust:auto-reserve-hold:v1] ", ambiguous: false, kind: "ExecutionHeld" },
    },
    {
      name: "auto reserve hold with detail => modern + legacy preserved",
      input: "[cdr-rust:auto-reserve-hold:v1] legacy detail",
      queued: true,
      warning: { message: "[cdr-rust:execution-held:v1] [cdr-rust:auto-reserve-hold:v1] legacy detail", ambiguous: false, kind: "ExecutionHeld" },
    },
  ];

  for (const tc of cases) {
    it(tc.name, () => {
      const sub = replayExisting(createJob(tc.input));
      assert.deepStrictEqual(sub, {
        jobId: "job-prefix-test",
        queued: tc.queued,
        turnId: null,
        warning: tc.warning,
      });
    });
  }

  it("empty lastError produces queued=true, turnId=null and no warning", () => {
    const sub = replayExisting(createJob(""));
    assert.deepStrictEqual(sub, { jobId: "job-prefix-test", queued: true, turnId: null });
  });
});
