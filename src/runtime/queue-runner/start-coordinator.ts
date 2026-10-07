import { AdmissionGate, DrainGateError } from "../../admission/drain-gate.ts";
import type { AdmissionPermit } from "../../admission/drain-gate.ts";
import { StateAccessFacade } from "../../store/state-access-facade.ts";
import type { IStateAccessFacade } from "../../store/state-access-facade.ts";
import type { StoredQueueJob } from "../../store/queue-read.ts";
import { I64_MAX } from "../../protocol/ids.ts";
import { SystemTimeError, DeadGenerationTargetHeldError } from "../../store/queue-mark-running.ts";
import { TargetLocks } from "./target-locks.ts";
import { QueueReadCoordinator } from "./read-coordinator.ts";
import type { QueueReadBackend } from "./read-coordinator.ts";
import { EXECUTION_HOLD_PREFIX, legacyOrCurrentError } from "./saved-submission.ts";
import type { BackendFailure } from "./saved-submission.ts";
import { rustDebugString } from "../../core/rust-debug.ts";
import { randomUUID } from "node:crypto";
import { presentSavedSubmission, withTargetHold } from "./saved-submission-presentation.ts";
import type { Submission } from "./saved-submission.ts";

export type QueueAttemptClaim = Readonly<Omit<StoredQueueJob, "baselineTurnIds">> & {
  readonly baselineTurnIds: readonly string[];
};

export interface QueueStartBackend extends QueueReadBackend {
  generation(): bigint;
  residentInstanceId(): string | null;
  resumeThread(target: string): Promise<void>;
  readTurns(target: string): Promise<readonly {readonly turnId: string}[]>;
  startClaimedTurn(claim: QueueAttemptClaim): Promise<string>;
}

/** Adapters wrap known backend outcomes; unknown exceptions stay unknown/held. */
export class BackendFailureError extends Error {
  readonly kind = "Backend";
  readonly failure: BackendFailure;
  constructor(failure: BackendFailure) {
    super(`Codex turn backend failed: ${failure.message}`); this.name = "BackendFailureError";
    this.failure = Object.freeze({...failure});
  }
}
export class AttemptClaimLostError extends Error {
  readonly kind = "AttemptClaimLost";
  readonly jobId: string;
  readonly observedTurnId: string | null;
  constructor(jobId: string, observedTurnId: string | null) {
    super(`durable queue attempt ownership changed for job ${jobId} after backend start observation ${observedTurnId === null ? "None" : `Some(${rustDebugString(observedTurnId)})`}; automatic replay is blocked`);
    this.name = "AttemptClaimLostError";
    this.jobId = jobId; this.observedTurnId = observedTurnId;
  }
}
export class QueueIntegerRangeError extends RangeError {
  readonly kind = "IntegerRange";
  constructor() {
    super("Discord or app-server generation does not fit the SQLite integer contract");
    this.name = "QueueIntegerRangeError";
  }
}

export function retryDelaySeconds(count: bigint): number {
  return count <= 0n ? 0 : count >= 6n ? 900 : [0, 30, 60, 120, 240, 480][Number(count)]!;
}
export function pendingRetryDueAt(count: bigint, error: string, updatedAt: number): number | null {
  if (count <= 0n || error === "" || !Number.isFinite(updatedAt)) return null;
  const due = updatedAt + retryDelaySeconds(count);
  return Number.isFinite(due) ? due : null;
}
export function pendingRetryIsDue(count: bigint, error: string, updatedAt: number, now: number): boolean {
  const due = pendingRetryDueAt(count, error, updatedAt);
  return due === null || (Number.isFinite(now) && now >= due);
}

type StartState = Pick<IStateAccessFacade, "asyncTargetDispatchHeld" | "deadTargetHeld" |
  "listFiltered" | "eligibleJobs" | "recordPreflightFailure" | "tryBeginAttempt" |
  "recordStartFailureIfClaimed" | "markRunningWithResidentIfClaimed" | "enqueue" | "enqueueIfMirrorMatches">;

/** Direct/mirrored submission and starts; intake promotion/recovery/transport stay separate. */
export class QueueStartCoordinator {
  readonly reads: QueueReadCoordinator;
  readonly locks: TargetLocks;
  readonly #path: string;
  readonly #backend: QueueStartBackend;
  readonly #state: StartState;
  readonly #gate: AdmissionGate | null;
  readonly #clock: () => number;
  readonly #notify: () => void;

  constructor(path: string, backend: QueueStartBackend, options: {
    state?: StartState; locks?: TargetLocks; admission?: AdmissionGate;
    clock?: () => number; notifyDeliveryReady?: () => void;
  } = {}) {
    this.#path = path; this.#backend = backend; this.#state = options.state ?? StateAccessFacade;
    this.locks = options.locks ?? new TargetLocks(); this.#gate = options.admission ?? null;
    this.#clock = options.clock ?? (() => Date.now() / 1000);
    this.#notify = options.notifyDeliveryReady ?? (() => {});
    this.reads = new QueueReadCoordinator(path, backend, this.#state, this.locks);
  }

  async kickTarget(target: string): Promise<void> {
    await this.locks.run(target, async () => {
      const generation = this.#backend.generation();
      if (typeof generation !== "bigint" || generation < 0n || generation > I64_MAX)
        throw new QueueIntegerRangeError();
      await this.#start(target, generation);
    });
  }

  submit(target: string, channel: bigint, owner: bigint, message: bigint | null, prompt: string): Promise<Submission> {
    return this.submitIdentified(randomUUID(), target, channel, owner, message, prompt);
  }

  submitIdentified(jobId: string, target: string, channel: bigint, owner: bigint,
    message: bigint | null, prompt: string): Promise<Submission> {
    return this.#submit(jobId, target, channel, owner, message, prompt, false);
  }

  submitMirrorIdentified(jobId: string, target: string, channel: bigint, owner: bigint,
    message: bigint | null, prompt: string): Promise<Submission> {
    return this.#submit(jobId, target, channel, owner, message, prompt, true);
  }

  async #submit(jobId: string, target: string, channel: bigint, owner: bigint,
    message: bigint | null, prompt: string, mirror: boolean): Promise<Submission> {
    for (const value of [jobId, target, prompt])
      if (typeof value !== "string" || /[\uD800-\uDFFF]/u.test(value)) throw new TypeError("Expected well-formed submission text");
    for (const value of [channel, owner, ...(message === null ? [] : [message])])
      if (typeof value !== "bigint" || value < 0n || value > I64_MAX) throw new QueueIntegerRangeError();
    return this.locks.run(target, async () => {
      const path = this.#path; const state = this.#state;
      if (await state.deadTargetHeld(path, target)) throw new DeadGenerationTargetHeldError(target);
      const generation = this.#backend.generation();
      if (typeof generation !== "bigint" || generation < 0n || generation > I64_MAX) throw new QueueIntegerRangeError();
      const existing = await state.eligibleJobs(path, await state.listFiltered(path, target, null));
      const queued = existing.some(job => job.state !== "Quarantined");
      const recovery = existing.some(job => job.state !== "Quarantined" && job.appServerGeneration !== generation);
      const createdAt = this.#now();
      const input = {jobId, targetThreadId: target, channelId: channel, ownerUserId: owner,
        discordMessageId: message, appServerGeneration: generation, prompt, queued, ackSent: true, createdAt};
      const enqueued = mirror
        ? await state.enqueueIfMirrorMatches(path, input, {discordChannelId: channel, targetThreadId: target})
        : await state.enqueue(path, input);
      if (!enqueued.created) return presentSavedSubmission(path, enqueued.job, state);
      if (recovery) return withTargetHold(path, target,
        {jobId: enqueued.job.jobId, queued: true, turnId: null}, false, state);
      let started: StoredQueueJob | null;
      try { started = await this.#start(target, generation); }
      catch (error) {
        if (!(error instanceof BackendFailureError)) throw error;
        const current = (await state.listFiltered(path, target, generation)).find(job => job.jobId === enqueued.job.jobId);
        if (current !== undefined && current.lastError !== "") return presentSavedSubmission(path, current, state);
        throw error;
      }
      const turnId = started?.jobId === enqueued.job.jobId ? started.turnId : null;
      return withTargetHold(path, target, {jobId: enqueued.job.jobId, queued: turnId === null, turnId}, false, state);
    });
  }

  #now(): number {
    const now = this.#clock();
    if (!Number.isFinite(now)) throw new TypeError("system clock must be finite");
    if (now < 0) throw new SystemTimeError(-now * 1000);
    return now;
  }

  async #start(target: string, generation: bigint): Promise<StoredQueueJob | null> {
    const state = this.#state; const path = this.#path;
    if (await state.asyncTargetDispatchHeld(path, target)) return null;
    let permit: AdmissionPermit | undefined;
    try {
      try { permit = this.#gate?.tryEnter(); }
      catch (error) { if (error instanceof DrainGateError && error.kind === "Sealed") return null; throw error; }
      if (await state.deadTargetHeld(path, target)) return null;
      const jobs = await state.eligibleJobs(path, await state.listFiltered(path, target, null));
      if (jobs.some(job => job.state === "Starting" || job.state === "Running")) return null;
      const job = jobs.find(job => job.state === "Pending" && !legacyOrCurrentError(job.lastError));
      if (job === undefined || job.appServerGeneration !== generation) return null;
      if (!pendingRetryIsDue(job.attemptCount, job.lastError, job.updatedAt, this.#now())) return null;
      if (await this.#backend.activeTurnId(target) !== null) return null;
      let baseline: string[];
      try {
        await this.#backend.resumeThread(target);
        baseline = (await this.#backend.readTurns(target)).map(turn => turn.turnId);
      } catch (error) {
        if (error instanceof BackendFailureError)
          await state.recordPreflightFailure(path, job.jobId, generation, error.failure.message);
        throw error;
      }
      const obtained = await state.tryBeginAttempt(path, job.jobId, baseline, generation);
      if (obtained === null) return null;
      const claim: StoredQueueJob = {...obtained, baselineTurnIds: [...obtained.baselineTurnIds]};
      const backendClaim: QueueAttemptClaim = Object.freeze({...claim,
        baselineTurnIds: Object.freeze([...claim.baselineTurnIds])});
      const resident = this.#backend.residentInstanceId(); // Capture before the dispatch await.
      if (resident !== null && (typeof resident !== "string" || /[\uD800-\uDFFF]/u.test(resident)))
        throw new TypeError("Expected a well-formed resident identity or null");
      let turn: string;
      try { turn = await this.#backend.startClaimedTurn(backendClaim); }
      catch (error) {
        if (!(error instanceof BackendFailureError)) throw error;
        const failure = error.failure;
        const message = failure.kind === "UsageLimit" ? EXECUTION_HOLD_PREFIX + failure.message : failure.message;
        if (await state.recordStartFailureIfClaimed(path, claim, message, failure.ambiguous) === null)
          throw new AttemptClaimLostError(job.jobId, null);
        if (failure.kind === "UsageLimit") this.#notify();
        throw error;
      }
      const running = await state.markRunningWithResidentIfClaimed(path, claim, turn, resident);
      if (running === null) throw new AttemptClaimLostError(job.jobId, turn);
      return running;
    } finally { permit?.release(); }
  }
}
