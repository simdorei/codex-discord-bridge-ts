import type {BackendFailure} from "./saved-submission.ts";
type Base={sourceThreadId:string;handoffId:string};
export type ForkRuntimeFailure=
  |(Base&{kind:"ForkBackend";failure:BackendFailure})
  |(Base&{kind:"ForkFailureRecording";failure:BackendFailure;recording:unknown})
  |(Base&{kind:"ForkTargetStage";targetThreadId:string;staging:unknown})
  |(Base&{kind:"ForkFinalize";targetThreadId:string;failure:unknown})
  |(Base&{kind:"ForkFinalizeRecording";targetThreadId:string;failure:unknown;recording:unknown})
  |(Base&{kind:"UnresolvedForkHandoff";lastForkError:string})
  |{kind:"ForkTargetCycle";sourceThreadId:string};
const display=(value:unknown):string=>value instanceof Error?value.message:"unclassified failure";
function message(f:ForkRuntimeFailure):string{
  if(f.kind==="ForkTargetCycle")return `completed app-server fork targets form a cycle from ${f.sourceThreadId}`;
  if(f.kind==="UnresolvedForkHandoff")return `app-server fork handoff ${f.handoffId} for ${f.sourceThreadId} is unresolved; automatic retry is blocked to prevent a duplicate fork; last fork error: ${f.lastForkError}`;
  if(f.kind==="ForkBackend"||f.kind==="ForkFailureRecording")return `app-server thread/fork for ${f.sourceThreadId} failed after durable handoff ${f.handoffId}: ${f.failure.message}${f.kind==="ForkFailureRecording"?`; recording the fork failure also failed: ${display(f.recording)}`:""}`;
  if(f.kind==="ForkTargetStage")return `app-server thread/fork for ${f.sourceThreadId} returned target ${f.targetThreadId}, but could not durably stage it for handoff ${f.handoffId}: ${display(f.staging)}`;
  return `app-server fork target ${f.targetThreadId} for ${f.sourceThreadId} could not be finalized from durable handoff ${f.handoffId}: ${display(f.failure)}${f.kind==="ForkFinalizeRecording"?`; recording that finalization failure also failed: ${display(f.recording)}`:""}`;
}
export class ForkRuntimeError extends Error{
  readonly kind:ForkRuntimeFailure["kind"];readonly details:ForkRuntimeFailure;
  constructor(details:ForkRuntimeFailure){super(message(details));this.name="ForkRuntimeError";this.kind=details.kind;this.details=Object.freeze({...details});}
}
