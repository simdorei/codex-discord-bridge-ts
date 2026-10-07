import type { enqueue } from "../../store/state-access-facade.ts";

export type SourceQueueJob = Awaited<ReturnType<typeof enqueue>>["job"];
export type StoredQueueJob = SourceQueueJob;

export type BackendFailureKind =
  | "Other"
  | "ActiveWriter"
  | "Quarantined"
  | "ForkFenced"
  | "StartingCandidatesHeld"
  | "UsageLimit"
  | "ExecutionHeld";

export interface BackendFailure {
  readonly message: string;
  readonly ambiguous: boolean;
  readonly kind: BackendFailureKind;
}

export interface Submission {
  readonly jobId: string;
  readonly queued: boolean;
  readonly turnId: string | null;
  readonly warning?: BackendFailure;
}

export const UNRESOLVED_FORK_ERROR_PREFIX = "[cdr-rust:app-server-fork-unresolved:v1] ";
export const STARTING_CANDIDATE_HOLD_PREFIX = "[cdr-rust:turn-start-candidates-ambiguous:v1] ";
export const EXECUTION_HOLD_PREFIX = "[cdr-rust:execution-held:v1] ";
export const AUTO_RESERVE_HOLD_PREFIX = "[cdr-rust:auto-reserve-hold:v1] ";

export function legacyOrCurrentError(error: string): boolean {
  return error.startsWith(EXECUTION_HOLD_PREFIX) || error.startsWith(AUTO_RESERVE_HOLD_PREFIX);
}

export function isActiveWriterMessage(message: string): boolean {
  return message.includes("thread/resume") && message.includes("already has an active writer");
}

export const BackendFailureConstructors = {
  quarantined: (message: string): BackendFailure => ({ message, ambiguous: true, kind: "Quarantined" }),
  forkFenced: (message: string): BackendFailure => ({ message, ambiguous: true, kind: "ForkFenced" }),
  startingCandidatesHeld: (message: string): BackendFailure => ({ message, ambiguous: true, kind: "StartingCandidatesHeld" }),
  executionHeld: (message: string): BackendFailure => ({
    message: `${EXECUTION_HOLD_PREFIX}${message}`,
    ambiguous: false,
    kind: "ExecutionHeld",
  }),
  persisted: (message: string, ambiguous: boolean): BackendFailure => {
    let kind: BackendFailureKind = "Other";
    if (message.startsWith(UNRESOLVED_FORK_ERROR_PREFIX)) kind = "ForkFenced";
    else if (message.startsWith(STARTING_CANDIDATE_HOLD_PREFIX)) kind = "StartingCandidatesHeld";
    else if (legacyOrCurrentError(message)) kind = "ExecutionHeld";
    else if (!ambiguous && isActiveWriterMessage(message)) kind = "ActiveWriter";
    return { message, ambiguous, kind };
  },
};

export function replayExisting(job: SourceQueueJob): Submission {
  const quarantined = job.state === "Quarantined";
  const forkFenced = job.lastError.startsWith(UNRESOLVED_FORK_ERROR_PREFIX);
  const startingCandidatesHeld = job.lastError.startsWith(STARTING_CANDIDATE_HOLD_PREFIX);
  const executionHeld = legacyOrCurrentError(job.lastError);

  let warning: BackendFailure | undefined;
  if (quarantined) {
    warning = BackendFailureConstructors.quarantined(job.lastError);
  } else if (forkFenced) {
    warning = BackendFailureConstructors.forkFenced(job.lastError);
  } else if (startingCandidatesHeld) {
    warning = BackendFailureConstructors.startingCandidatesHeld(job.lastError);
  } else if (executionHeld) {
    warning = BackendFailureConstructors.executionHeld(job.lastError);
  } else if (job.lastError !== "") {
    warning = BackendFailureConstructors.persisted(
      job.lastError,
      job.state === "Starting",
    );
  } else {
    warning = undefined;
  }

  const queued = !quarantined && !startingCandidatesHeld && job.turnId === null;
  const turnId = quarantined || startingCandidatesHeld ? null : job.turnId;

  if (warning !== undefined) {
    return {
      jobId: job.jobId,
      queued,
      turnId,
      warning,
    };
  }

  return {
    jobId: job.jobId,
    queued,
    turnId,
  };
}

export const replay_existing = replayExisting;
export const projectSavedSubmission = replayExisting;
export const savedSubmission = replayExisting;
export default replayExisting;
