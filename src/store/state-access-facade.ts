import { CheckedRead } from "./owned-driver.ts";
import * as MutationAttempt from "./mutation-attempt.ts";
import * as QueueEnqueue from "./queue-enqueue.ts";
import * as QueueMarkRunning from "./queue-mark-running.ts";
import * as AsyncAdmission from "./async-resolution-admission.ts";
import * as QueueRead from "./queue-read.ts";
import * as ExecutionHold from "./execution-hold.ts";

export const listFiltered: typeof QueueRead.listFiltered = QueueRead.listFiltered;
export const eligibleJobs: typeof ExecutionHold.eligibleJobs = ExecutionHold.eligibleJobs;

export const asyncAdmissionHeld: typeof AsyncAdmission.asyncResolutionAdmissionHeld =
  AsyncAdmission.asyncResolutionAdmissionHeld;
export const asyncTargetDispatchHeld: typeof AsyncAdmission.asyncQuestionTargetDispatchHeld =
  AsyncAdmission.asyncQuestionTargetDispatchHeld;

export const enqueue: typeof QueueEnqueue.enqueue = QueueEnqueue.enqueue;
export const enqueueIfMirrorMatches: typeof QueueEnqueue.enqueueIfMirrorMatches =
  QueueEnqueue.enqueueIfMirrorMatches;
export const enqueueInTransaction: typeof QueueEnqueue.enqueueInTransaction =
  QueueEnqueue.enqueueInTransaction;
export const markRunning: typeof QueueMarkRunning.markRunning =
  QueueMarkRunning.markRunning;
export const activate: typeof MutationAttempt.activate =
  MutationAttempt.activate;
export const beginChecked: typeof MutationAttempt.beginChecked =
  MutationAttempt.beginChecked;
export const finish: typeof MutationAttempt.finish =
  MutationAttempt.finish;
export const openCheckedRead: typeof CheckedRead.open =
  CheckedRead.open;

export interface IStateAccessFacade {
  readonly listFiltered: typeof QueueRead.listFiltered;
  readonly eligibleJobs: typeof ExecutionHold.eligibleJobs;
  readonly asyncAdmissionHeld: typeof AsyncAdmission.asyncResolutionAdmissionHeld;
  readonly asyncTargetDispatchHeld: typeof AsyncAdmission.asyncQuestionTargetDispatchHeld;
  readonly enqueue: typeof QueueEnqueue.enqueue;
  readonly enqueueIfMirrorMatches: typeof QueueEnqueue.enqueueIfMirrorMatches;
  readonly enqueueInTransaction: typeof QueueEnqueue.enqueueInTransaction;
  readonly markRunning: typeof QueueMarkRunning.markRunning;
  readonly activate: typeof MutationAttempt.activate;
  readonly beginChecked: typeof MutationAttempt.beginChecked;
  readonly finish: typeof MutationAttempt.finish;
  readonly openCheckedRead: typeof CheckedRead.open;
}

export type StateAccessFacade = IStateAccessFacade;

export const StateAccessFacade: IStateAccessFacade = {
  listFiltered,
  eligibleJobs,
  asyncAdmissionHeld,
  asyncTargetDispatchHeld,
  enqueue,
  enqueueIfMirrorMatches,
  enqueueInTransaction,
  markRunning,
  activate,
  beginChecked,
  finish,
  openCheckedRead,
};
