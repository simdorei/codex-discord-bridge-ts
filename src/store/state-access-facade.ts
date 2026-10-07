import * as ObservedCompletion from "./observed-completion.ts";
import * as Delivery from "./delivery.ts";
import { CheckedRead } from "./owned-driver.ts";
import * as MutationAttempt from "./mutation-attempt.ts";
import * as QueueEnqueue from "./queue-enqueue.ts";
import * as QueueMarkRunning from "./queue-mark-running.ts";
import * as AsyncAdmission from "./async-resolution-admission.ts";
import * as QueueRead from "./queue-read.ts";
import * as ExecutionHold from "./execution-hold.ts";
import * as QueueClaims from "./queue-claims.ts";
import * as DeadGeneration from "./dead-generation-admission.ts";
import * as Preflight from "./queue-preflight-failure.ts";

export const recordObservedCompletionForResident: typeof ObservedCompletion.recordObservedCompletionForResident = ObservedCompletion.recordObservedCompletionForResident;

export const listPendingDeliveries: typeof Delivery.listPendingDeliveries = Delivery.listPendingDeliveries;
export const recordDeliveryFailure: typeof Delivery.recordDeliveryFailure = Delivery.recordDeliveryFailure;
export const completeDelivery: typeof Delivery.completeDelivery = Delivery.completeDelivery;

export const stageOwnedQueueCompletion: typeof Delivery.stageOwnedQueueCompletion = Delivery.stageOwnedQueueCompletion;

export const deadTargetHeld: typeof DeadGeneration.targetIsHeld = DeadGeneration.targetIsHeld;
export const recordPreflightFailure: typeof Preflight.recordPreflightFailure = Preflight.recordPreflightFailure;

export const holdStartingForAmbiguousCandidatesIfClaimed: typeof QueueClaims.holdStartingForAmbiguousCandidatesIfClaimed = QueueClaims.holdStartingForAmbiguousCandidatesIfClaimed;

export const tryBeginAttempt: typeof QueueClaims.tryBeginAttempt = QueueClaims.tryBeginAttempt;
export const recordStartFailureIfClaimed: typeof QueueClaims.recordStartFailureIfClaimed = QueueClaims.recordStartFailureIfClaimed;
export const markRunningIfClaimed: typeof QueueClaims.markRunningIfClaimed = QueueClaims.markRunningIfClaimed;
export const markRunningWithResidentIfClaimed: typeof QueueClaims.markRunningWithResidentIfClaimed = QueueClaims.markRunningWithResidentIfClaimed;

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
  readonly holdStartingForAmbiguousCandidatesIfClaimed: typeof QueueClaims.holdStartingForAmbiguousCandidatesIfClaimed;
  readonly listPendingDeliveries: typeof Delivery.listPendingDeliveries;
  readonly recordDeliveryFailure: typeof Delivery.recordDeliveryFailure;
  readonly completeDelivery: typeof Delivery.completeDelivery;
  readonly recordObservedCompletionForResident: typeof ObservedCompletion.recordObservedCompletionForResident;
  readonly stageOwnedQueueCompletion: typeof Delivery.stageOwnedQueueCompletion;
  readonly deadTargetHeld: typeof DeadGeneration.targetIsHeld;
  readonly recordPreflightFailure: typeof Preflight.recordPreflightFailure;
  readonly tryBeginAttempt: typeof QueueClaims.tryBeginAttempt;
  readonly recordStartFailureIfClaimed: typeof QueueClaims.recordStartFailureIfClaimed;
  readonly markRunningIfClaimed: typeof QueueClaims.markRunningIfClaimed;
  readonly markRunningWithResidentIfClaimed: typeof QueueClaims.markRunningWithResidentIfClaimed;
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
  holdStartingForAmbiguousCandidatesIfClaimed,
  listPendingDeliveries,
  recordDeliveryFailure,
  completeDelivery,
  recordObservedCompletionForResident,
  stageOwnedQueueCompletion,
  deadTargetHeld,
  recordPreflightFailure,
  tryBeginAttempt,
  recordStartFailureIfClaimed,
  markRunningIfClaimed,
  markRunningWithResidentIfClaimed,
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
