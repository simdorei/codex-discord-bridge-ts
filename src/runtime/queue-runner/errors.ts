import type {BackendFailure} from "./saved-submission.ts";
import {rustDebugString} from "../../core/rust-debug.ts";

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

