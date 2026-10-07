import { snapshotStoredQueueJob } from "./queue-read.ts";
import type { DatabaseSync } from "node:sqlite";
import { types } from "node:util";
import { I64_MIN, I64_MAX } from "../protocol/ids.ts";
import { openInitialized } from "./owned-driver.ts";
import { ensureForkHandoffTable } from "./fork-handoff-admission.ts";
import { assertAsyncAdmissionIn } from "./async-resolution-admission.ts";
import { jobCanMutate } from "./dead-generation-admission.ts";
import { reasonIn, holdIn, legacyOrCurrentError, LEGACY_RESERVE_HOLD_PREFIX } from "./execution-hold.ts";
import { selectJob, QueueJobNotFoundError, serializeStoredQueueJob } from "./queue-read.ts";
import type { StoredQueueJob } from "./queue-read.ts";
import { bindRunningIn } from "./new-reply-bind.ts";
import { recordJobOrigin } from "./mirror-origin.ts";
import { SystemTimeError } from "./queue-mark-running.ts";
import { matchingBaselineJsonIn } from "./queue-baseline.ts";
import { trimUnicodeWhitespace, takeUnicodeScalarChars } from "./queue-preflight-failure.ts";
import { stageStartNoticeIn } from "./start-notice-stage.ts";
import { StoreIntegrityError } from "./schema-assembly.ts";
import { bindLateStartIn } from "./stop-late-start.ts";

interface Decision<T> { readonly value: T; readonly commit: boolean; }

async function withWriter<T>(path: string, work: (db: DatabaseSync) => Decision<T>): Promise<T> {
  const db = await openInitialized(path);
  let committed = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    const result = work(db);
    if (result.commit) { db.exec("COMMIT"); committed = true; }
    return result.value;
  } finally {
    if (!committed && db.isTransaction) {
      try { db.exec("ROLLBACK"); } catch { /* Closing also abandons the transaction. */ }
    }
    db.close();
  }
}

function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || /[\uD800-\uDFFF]/u.test(value))
    throw new TypeError("Expected a well-formed string");
}

function now(): number {
  const ms = Date.now();
  if (!Number.isFinite(ms)) throw new TypeError("system clock must be finite");
  if (ms < 0) throw new SystemTimeError(-ms);
  return ms / 1000;
}

const CLAIM_SQL = `UPDATE codex_turn_queue SET state='starting', execution_generation=?,
  turn_observation_generation=NULL, goal_waiting=0,
  attempt_count=CASE WHEN attempt_count<9223372036854775807 THEN attempt_count+1 ELSE attempt_count END,
  turn_id=NULL, baseline_turn_ids=?, last_error='', updated_at=?
  WHERE job_id=? AND app_server_generation=? AND state='pending'
  AND NOT EXISTS(SELECT 1 FROM codex_thread_fork_handoffs handoff
    WHERE handoff.source_thread_id=codex_turn_queue.target_thread_id AND handoff.target_thread_id IS NULL)`;

function baselineSnapshot(value: readonly string[]): string[] {
  if (!Array.isArray(value) || types.isProxy(value)) throw new TypeError("Expected a data array of baseline turn IDs");
  const snapshot: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const field = Object.getOwnPropertyDescriptor(value, String(i));
    if (field === undefined || !Object.hasOwn(field, "value")) throw new TypeError("Expected baseline data elements");
    text(field.value); snapshot.push(field.value);
  }
  return snapshot;
}


function claimedResult(db: DatabaseSync, jobId: string, changes: number | bigint): Decision<StoredQueueJob | null> {
  const job = changes === 1 || changes === 1n ? selectJob(db, jobId) : null;
  if (job !== null) { bindRunningIn(db, job); recordJobOrigin(db, job); }
  return {value: job, commit: true};
}

/** Atomic pending→starting claim. A failed comparison never becomes a new attempt. */
export async function tryBeginAttempt(
  path: string, jobId: string, baselineTurnIds: readonly string[], generation: bigint,
): Promise<StoredQueueJob | null> {
  text(path); text(jobId);
  if (typeof generation !== "bigint" || generation < I64_MIN || generation > I64_MAX)
    throw new TypeError("Expected a signed i64 generation");
  const baseline = JSON.stringify(baselineSnapshot(baselineTurnIds));
  return withWriter(path, db => {
    ensureForkHandoffTable(db);
    let candidate: StoredQueueJob;
    try { candidate = selectJob(db, jobId); }
    catch (error) {
      if (error instanceof QueueJobNotFoundError) return {value: null, commit: false};
      throw error;
    }
    assertAsyncAdmissionIn(db, candidate.targetThreadId);
    if (!jobCanMutate(db, candidate) || reasonIn(db, jobId) !== null
      || candidate.lastError.startsWith(LEGACY_RESERVE_HOLD_PREFIX)) return {value: null, commit: false};
    const updated = db.prepare(CLAIM_SQL).run(generation, baseline, now(), jobId, generation);
    return claimedResult(db, jobId, updated.changes);
  });
}

const CLAIMED_WHERE = `WHERE job_id=? AND target_thread_id=? AND app_server_generation=? AND attempt_count=?
    AND updated_at=? AND baseline_turn_ids=? AND state='starting' AND turn_id IS NULL
    AND NOT EXISTS(SELECT 1 FROM codex_thread_fork_handoffs handoff
      WHERE handoff.source_thread_id=codex_turn_queue.target_thread_id AND handoff.target_thread_id IS NULL)`;
const FAILURE_SQL = `UPDATE codex_turn_queue SET state=?, last_error=?, updated_at=? ${CLAIMED_WHERE}`;

export async function recordStartFailureIfClaimed(
  path: string, claimed: StoredQueueJob, error: string, ambiguous: boolean,
): Promise<StoredQueueJob | null> {
  text(path); text(error);
  if (typeof ambiguous !== "boolean") throw new TypeError("Expected ambiguity boolean");
  const claim = snapshotStoredQueueJob(claimed);
  const bounded = takeUnicodeScalarChars(trimUnicodeWhitespace(error), 1000);
  return withWriter(path, db => {
    ensureForkHandoffTable(db);
    if (!jobCanMutate(db, claim)) return {value: null, commit: false};
    const baseline = matchingBaselineJsonIn(db, claim);
    if (baseline === null) return {value: null, commit: false};
    const updated = db.prepare(FAILURE_SQL).run(ambiguous ? "starting" : "pending", bounded, now(),
      claim.jobId, claim.targetThreadId, claim.appServerGeneration, claim.attemptCount, claim.updatedAt, baseline);
    if ((updated.changes === 1 || updated.changes === 1n) && !ambiguous && legacyOrCurrentError(error)) {
      holdIn(db, claim.jobId, claim.targetThreadId, bounded, serializeStoredQueueJob(claim));
      stageStartNoticeIn(db, claim, bounded);
    }
    return claimedResult(db, claim.jobId, updated.changes);
  });
}

/** Non-resident Rust mark_running_if_claimed only; never substitutes for resident stop binding. */
export async function markRunningIfClaimed(
  path: string, claimed: StoredQueueJob, turnId: string,
): Promise<StoredQueueJob | null> {
  return markRunningWithResidentIfClaimed(path, claimed, turnId, null);
}

export async function markRunningWithResidentIfClaimed(
  path: string, claimed: StoredQueueJob, turnId: string, resident: string | null,
): Promise<StoredQueueJob | null> {
  text(path); text(turnId);
  if (resident !== null) text(resident);
  const claim = snapshotStoredQueueJob(claimed);
  return withWriter(path, db => {
    ensureForkHandoffTable(db);
    if (!jobCanMutate(db, claim)) return {value: null, commit: false};
    const baseline = matchingBaselineJsonIn(db, claim);
    if (baseline === null) return {value: null, commit: false};
    const updated = db.prepare(`UPDATE codex_turn_queue SET state='running',
      turn_observation_generation=app_server_generation, goal_waiting=0,
      turn_id=?, updated_at=? ${CLAIMED_WHERE}`).run(turnId, now(), claim.jobId,
      claim.targetThreadId, claim.appServerGeneration, claim.attemptCount, claim.updatedAt, baseline);
    if (updated.changes === 1 || updated.changes === 1n) {
      const running = selectJob(db, claim.jobId);
      if (running.turnId !== turnId) throw new StoreIntegrityError("queue ACK turn differs from backend response; original Starting preserved");
      if (resident !== null) bindLateStartIn(db, claim, running, resident);
    }
    return claimedResult(db, claim.jobId, updated.changes);
  });
}
