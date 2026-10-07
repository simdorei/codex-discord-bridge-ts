import assert from "node:assert/strict";
import { test } from "node:test";
import {
  presentSavedSubmission, withTargetHold,
} from "../../../src/runtime/queue-runner/saved-submission-presentation.ts";
import { EXECUTION_HOLD_PREFIX, replayExisting } from "../../../src/runtime/queue-runner/saved-submission.ts";
import type { Submission, BackendFailureKind } from "../../../src/runtime/queue-runner/saved-submission.ts";
import { queueJob as job } from "../../helpers/queue-job.ts";

test("pending hold overlays presentation without mutating the job or attempts", async () => {
  const original = job(); const before = structuredClone(original);
  Object.freeze(original);
  const calls: string[][] = [];
  const result = await presentSavedSubmission("db", original, {
    asyncTargetDispatchHeld: async (path, target) => { calls.push([path, target]); return true; },
  });
  assert.deepEqual(calls, [["db", "target"]]);
  assert.equal(result.warning?.kind, "ExecutionHeld");
  assert.equal(result.warning?.ambiguous, false);
  assert.equal(result.warning?.message, EXECUTION_HOLD_PREFIX +
    "target async execution or recovery authorization remains unresolved; saved request and attempts are unchanged; no automatic replay while this target is held");
  assert.equal(result.queued, true); assert.equal(result.turnId, null);
  assert.deepEqual(original, before);
});

test("starting and prior ambiguity are preserved, including the saved warning text", async () => {
  const state = { asyncTargetDispatchHeld: async () => true };
  const result = await presentSavedSubmission("db", job({state: "Starting", lastError: "prior"}), state);
  assert.equal(result.warning?.ambiguous, true);
  assert.equal(result.warning?.message.endsWith("; saved warning: prior"), true);
  const prior: Submission = {jobId: "j", queued: false, turnId: null,
    warning: {kind: "Other", message: "uncertain", ambiguous: true}};
  const overlaid = await withTargetHold("db", "t", prior, false, state);
  assert.equal(overlaid.warning?.ambiguous, true);
  assert.equal(overlaid.queued, false);
  assert.equal(prior.warning?.kind, "Other");
});

test("turn IDs and protected warning kinds skip admission reads, even empty turn ID", async () => {
  const forbidden = { asyncTargetDispatchHeld: async () => { throw new Error("unexpected read"); } };
  for (const turnId of ["turn", ""]) {
    const submission: Submission = {jobId: "j", queued: true, turnId};
    assert.equal(await withTargetHold("db", "t", submission, false, forbidden), submission);
  }
  for (const kind of ["Quarantined", "ForkFenced", "StartingCandidatesHeld", "ExecutionHeld"] as BackendFailureKind[]) {
    const submission: Submission = {jobId: "j", queued: true, turnId: null,
      warning: {kind, ambiguous: true, message: "protected"}};
    assert.equal(await withTargetHold("db", "t", submission, false, forbidden), submission);
  }
});

test("non-pending saved states never perform an admission read", async () => {
  const forbidden = { asyncTargetDispatchHeld: async () => { throw new Error("unexpected read"); } };
  for (const state of ["Running", "Quarantined"] as const) {
    const original = job({state});
    assert.deepEqual(await presentSavedSubmission("db", original, forbidden), replayExisting(original));
  }
});

test("two target reads are isolated and false holds retain original projection", async () => {
  const state = { asyncTargetDispatchHeld: async (_path: string, target: string) => target === "held" };
  const a = job({targetThreadId: "held"}); const b = job({targetThreadId: "clear"});
  const [left, right] = await Promise.all([
    presentSavedSubmission("db", a, state), presentSavedSubmission("db", b, state),
  ]);
  assert.equal(left.warning?.kind, "ExecutionHeld");
  assert.deepEqual(right, replayExisting(b));
});

test("read errors propagate by identity and do not become permission or persisted errors", async () => {
  const sentinel = new Error("database failure"); const original = job();
  const before = structuredClone(original);
  await assert.rejects(presentSavedSubmission("db", original, {
    asyncTargetDispatchHeld: async () => { throw sentinel; },
  }), error => error === sentinel);
  assert.deepEqual(original, before);
});
