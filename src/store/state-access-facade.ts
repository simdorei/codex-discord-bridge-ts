import * as PromptIntakeWrite from "./prompt-intake-write.ts";
import * as PromptIntakePromotion from "./prompt-intake-promotion.ts";
import * as GoalWaiting from "./queue-goal-waiting.ts";
import * as GoalAttach from "./queue-attach-goal.ts";
import * as GoalProgress from "./goal-progress.ts";
import * as ForkRepair from "./fork-legacy-repair.ts";
import * as ForkRetirement from "./fork-retirement.ts";
import * as ForkRead from "./fork-unresolved-read.ts";
import * as Generation from "./queue-generation.ts";
import * as AsyncHistory from "./async-history.ts";
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

export const captureAsyncHistorySnapshot: typeof AsyncHistory.captureAsyncHistorySnapshot = AsyncHistory.captureAsyncHistorySnapshot;
export const retainAsyncHistoryCandidate: typeof AsyncHistory.retainAsyncHistoryCandidate = AsyncHistory.retainAsyncHistoryCandidate;
export const captureTerminalHistorySnapshot: typeof AsyncHistory.captureTerminalHistorySnapshot = AsyncHistory.captureTerminalHistorySnapshot;
export const settleTerminalHistory: typeof AsyncHistory.settleTerminalHistory = AsyncHistory.settleTerminalHistory;

export const pendingObservedCompletions: typeof ObservedCompletion.pendingObservedCompletions = ObservedCompletion.pendingObservedCompletions;
export const hasObservedCompletion: typeof ObservedCompletion.hasObservedCompletion = ObservedCompletion.hasObservedCompletion;
export const recordObservedCompletionError: typeof ObservedCompletion.recordObservedCompletionError = ObservedCompletion.recordObservedCompletionError;
export const finishObservedCompletion: typeof ObservedCompletion.finishObservedCompletion = ObservedCompletion.finishObservedCompletion;

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

export const canonicalizePromptIntakeTarget: typeof PromptIntakeWrite.canonicalizePromptIntakeTarget = PromptIntakeWrite.canonicalizePromptIntakeTarget;
export const promotePromptIntakeToQueue: typeof PromptIntakePromotion.promotePromptIntakeToQueue = PromptIntakePromotion.promotePromptIntakeToQueue;

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

export const adoptTargetGeneration: typeof Generation.adoptTargetGeneration = Generation.adoptTargetGeneration;

export const unresolvedAppServerForkHandoffForSource: typeof ForkRead.unresolvedAppServerForkHandoffForSource = ForkRead.unresolvedAppServerForkHandoffForSource;

export const retireCopyOnlyHandoffs: typeof ForkRetirement.retireCopyOnlyHandoffs = ForkRetirement.retireCopyOnlyHandoffs;

export const repairLegacyDefiniteForkFailures: typeof ForkRepair.repairLegacyDefiniteForkFailures = ForkRepair.repairLegacyDefiniteForkFailures;

export const stageOwnedGoalProgress: typeof GoalProgress.stageOwnedGoalProgress = GoalProgress.stageOwnedGoalProgress;

export const pendingGoalProgress: typeof GoalProgress.pendingGoalProgress = GoalProgress.pendingGoalProgress;

export const recordGoalProgressError: typeof GoalProgress.recordGoalProgressError = GoalProgress.recordGoalProgressError;

export const completeGoalProgress: typeof GoalProgress.completeGoalProgress = GoalProgress.completeGoalProgress;

export const hasPendingGoalProgress: typeof GoalProgress.hasPendingGoalProgress = GoalProgress.hasPendingGoalProgress;

export const attachGoalTurnObservedIfOwned: typeof GoalAttach.attachGoalTurnObservedIfOwned = GoalAttach.attachGoalTurnObservedIfOwned;

export const markGoalWaiting: typeof GoalWaiting.markGoalWaiting = GoalWaiting.markGoalWaiting;

export interface IStateAccessFacade {
  readonly markGoalWaiting: typeof GoalWaiting.markGoalWaiting;
  readonly attachGoalTurnObservedIfOwned: typeof GoalAttach.attachGoalTurnObservedIfOwned;
  readonly hasPendingGoalProgress: typeof GoalProgress.hasPendingGoalProgress;
  readonly completeGoalProgress: typeof GoalProgress.completeGoalProgress;
  readonly recordGoalProgressError: typeof GoalProgress.recordGoalProgressError;
  readonly pendingGoalProgress: typeof GoalProgress.pendingGoalProgress;
  readonly stageOwnedGoalProgress: typeof GoalProgress.stageOwnedGoalProgress;
  readonly repairLegacyDefiniteForkFailures: typeof ForkRepair.repairLegacyDefiniteForkFailures;
  readonly retireCopyOnlyHandoffs: typeof ForkRetirement.retireCopyOnlyHandoffs;
  readonly unresolvedAppServerForkHandoffForSource: typeof ForkRead.unresolvedAppServerForkHandoffForSource;
  readonly adoptTargetGeneration: typeof Generation.adoptTargetGeneration;
  readonly captureAsyncHistorySnapshot: typeof AsyncHistory.captureAsyncHistorySnapshot;
  readonly retainAsyncHistoryCandidate: typeof AsyncHistory.retainAsyncHistoryCandidate;
  readonly captureTerminalHistorySnapshot: typeof AsyncHistory.captureTerminalHistorySnapshot;
  readonly settleTerminalHistory: typeof AsyncHistory.settleTerminalHistory;
  readonly pendingObservedCompletions: typeof ObservedCompletion.pendingObservedCompletions;
  readonly hasObservedCompletion: typeof ObservedCompletion.hasObservedCompletion;
  readonly recordObservedCompletionError: typeof ObservedCompletion.recordObservedCompletionError;
  readonly finishObservedCompletion: typeof ObservedCompletion.finishObservedCompletion;
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
  readonly canonicalizePromptIntakeTarget: typeof PromptIntakeWrite.canonicalizePromptIntakeTarget;
  readonly promotePromptIntakeToQueue: typeof PromptIntakePromotion.promotePromptIntakeToQueue;
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
  markGoalWaiting,
  attachGoalTurnObservedIfOwned,
  hasPendingGoalProgress,
  completeGoalProgress,
  recordGoalProgressError,
  pendingGoalProgress,
  stageOwnedGoalProgress,
  repairLegacyDefiniteForkFailures,
  retireCopyOnlyHandoffs,
  unresolvedAppServerForkHandoffForSource,
  adoptTargetGeneration,
  captureAsyncHistorySnapshot,
  retainAsyncHistoryCandidate,
  captureTerminalHistorySnapshot,
  settleTerminalHistory,
  pendingObservedCompletions,
  hasObservedCompletion,
  recordObservedCompletionError,
  finishObservedCompletion,
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
  canonicalizePromptIntakeTarget,
  promotePromptIntakeToQueue,
  enqueue,
  enqueueIfMirrorMatches,
  enqueueInTransaction,
  markRunning,
  activate,
  beginChecked,
  finish,
  openCheckedRead,
};
