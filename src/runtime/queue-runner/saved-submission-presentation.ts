import { StateAccessFacade } from "../../store/state-access-facade.ts";
import type { IStateAccessFacade } from "../../store/state-access-facade.ts";
import { BackendFailureConstructors, replayExisting } from "./saved-submission.ts";
import type { SourceQueueJob, Submission } from "./saved-submission.ts";

type AdmissionReads = Pick<IStateAccessFacade, "asyncTargetDispatchHeld">;
const PROTECTED = new Set(["Quarantined", "ForkFenced", "StartingCandidatesHeld", "ExecutionHeld"]);

/** Presentation only: never persists an error, changes attempts, or starts work. */
export async function withTargetHold(
  path: string, target: string, submission: Submission, starting: boolean,
  state: AdmissionReads = StateAccessFacade,
): Promise<Submission> {
  if (submission.turnId !== null
    || (submission.warning !== undefined && PROTECTED.has(submission.warning.kind))
    || !await state.asyncTargetDispatchHeld(path, target)) return submission;

  const previous = submission.warning === undefined ? "" : `; saved warning: ${submission.warning.message}`;
  const warning = BackendFailureConstructors.executionHeld(
    "target async execution or recovery authorization remains unresolved; saved request and attempts are unchanged; no automatic replay while this target is held" + previous,
  );
  return { ...submission, warning: {
    ...warning, ambiguous: starting || submission.warning?.ambiguous === true,
  } };
}

export async function presentSavedSubmission(
  path: string, job: SourceQueueJob, state: AdmissionReads = StateAccessFacade,
): Promise<Submission> {
  const submission = replayExisting(job);
  return job.state === "Pending" || job.state === "Starting"
    ? withTargetHold(path, job.targetThreadId, submission, job.state === "Starting", state)
    : submission;
}
