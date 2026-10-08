import * as StopControlAdmission from "./stop-control-admission.ts";
import * as StopAcceptance from "./stop-acceptance.ts";
import * as ObservedFinalAnswer from "./observed-final-answer.ts";
import * as AsyncGuards from "./async-resolution-guards.ts";
import * as QuestionGuard from "./async-question-guard.ts";
import * as StopDispatch from "./stop-control-dispatch.ts";
import * as RuntimeFenceReads from "./runtime-fence-reads.ts";
import * as QueueStartAuthority from "./queue-start-authority.ts";
import * as ResponseCustody from "./response-custody.ts";
import * as DeadCapture from "./dead-generation-capture.ts";
import * as IdleReleaseStore from "./idle-release-store.ts";
import * as ObservationProof from "./observation-proof.ts";
import * as ObservationLedger from "./observation-ledger.ts";
import * as CompletionPayload from "./completion-payload.ts";
import * as CompletionRound from "./completion-metadata-round.ts";
import * as CompletionMetadata from "./completion-metadata.ts";
import * as StartNoticeOutbox from "./start-notice-outbox.ts";
import * as CommentaryOutbox from "./commentary-outbox.ts";
import * as DeliveryPreflight from "./delivery-preflight.ts";
import * as DeliveryReceipts from "./delivery-receipts.ts";
import * as NewReplyClaims from "./new-reply-claims.ts";
import * as RecoveryCancellation from "./queue-cancel-recovery.ts";
import * as PendingCancellation from "./queue-cancel-pending.ts";
import * as RecoveryCustody from "./ingress-recovery-custody.ts";
import * as IngressRecovery from "./ingress-recovery.ts";
import * as IngressRead from "./ingress-read.ts";
import * as BusyIngress from "./ingress-busy.ts";
import * as IngressLifecycle from "./ingress-lifecycle.ts";
import * as IngressAdmission from "./ingress-admission.ts";
import * as NewPromptArm from "./ingress-new-prompt-arm.ts";
import * as NewOrigin from "./new-thread-origin.ts";
import * as StopRevision from "./stop-revision-read.ts";
import * as PromptIntakeLease from "./prompt-intake.ts";
import * as MirrorMapping from "./busy-choice.ts";
import * as ForkBegin from "./fork-begin.ts";
import * as ForkTarget from "./fork-target.ts";
import * as ForkFailure from "./fork-failure.ts";
import * as ForkCompleted from "./fork-completed-target.ts";
import * as ForkManaged from "./fork-managed-query.ts";
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

export const getIdleIntent: typeof IdleReleaseStore.getIdleIntent = IdleReleaseStore.getIdleIntent;
export const pendingIdleIntents: typeof IdleReleaseStore.pendingIdleIntents = IdleReleaseStore.pendingIdleIntents;
export const beforeIdleMutation: typeof IdleReleaseStore.beforeIdleMutation = IdleReleaseStore.beforeIdleMutation;
export const transitionIdleIntent: typeof IdleReleaseStore.transitionIdleIntent = IdleReleaseStore.transitionIdleIntent;
export const verifyIdleIntent: typeof IdleReleaseStore.verifyIdleIntent = IdleReleaseStore.verifyIdleIntent;
export const verifyIdleIntentWithObservations: typeof IdleReleaseStore.verifyIdleIntentWithObservations = IdleReleaseStore.verifyIdleIntentWithObservations;
export const settleExitedIdleOwner: typeof IdleReleaseStore.settleExitedIdleOwner = IdleReleaseStore.settleExitedIdleOwner;
export const certifyObservation: typeof ObservationProof.certifyObservation = ObservationProof.certifyObservation;
export const finishObservationPage: typeof ObservationProof.finishObservationPage = ObservationProof.finishObservationPage;
export const activateObservation: typeof ObservationLedger.activateObservation = ObservationLedger.activateObservation;
export const discoverObservation: typeof ObservationLedger.discoverObservation = ObservationLedger.discoverObservation;
export const markUnknownObservation: typeof ObservationLedger.markUnknownObservation = ObservationLedger.markUnknownObservation;
export const nextObservationGap: typeof ObservationLedger.nextObservationGap = ObservationLedger.nextObservationGap;
export const observationScopeVerified: typeof ObservationLedger.observationScopeVerified = ObservationLedger.observationScopeVerified;

export const acknowledgeIngress: typeof IngressLifecycle.acknowledgeIngress = IngressLifecycle.acknowledgeIngress;
export const beginIngressConfirmation: typeof IngressLifecycle.beginIngressConfirmation = IngressLifecycle.beginIngressConfirmation;
export const beginIngressExecution: typeof IngressLifecycle.beginIngressExecution = IngressLifecycle.beginIngressExecution;
export const beginIngressThreadStart: typeof IngressLifecycle.beginIngressThreadStart = IngressLifecycle.beginIngressThreadStart;
export const recordIngressCreatedThread: typeof IngressLifecycle.recordIngressCreatedThread = IngressLifecycle.recordIngressCreatedThread;
export const recordIngressResult: typeof IngressLifecycle.recordIngressResult = IngressLifecycle.recordIngressResult;
export const confirmIngress: typeof IngressLifecycle.confirmIngress = IngressLifecycle.confirmIngress;
export const recordIngressProcessingMode: typeof IngressLifecycle.recordIngressProcessingMode = IngressLifecycle.recordIngressProcessingMode;

export const admitMappedSlashIngress: typeof IngressAdmission.admitMappedSlashIngress = IngressAdmission.admitMappedSlashIngress;
export const recordIngressNewCreation: typeof IngressLifecycle.recordIngressNewCreation = IngressLifecycle.recordIngressNewCreation;

export const admitBusyInteraction: typeof BusyIngress.admitBusyInteraction = BusyIngress.admitBusyInteraction;

export const holdIngress: typeof IngressRecovery.holdIngress = IngressRecovery.holdIngress;
export const recoverPriorRuntimeIngress: typeof IngressRecovery.recoverPriorRuntimeIngress = IngressRecovery.recoverPriorRuntimeIngress;
export const getIngress: typeof IngressRead.getIngress = IngressRead.getIngress;
export const getIngressForOwnerReadonly: typeof IngressRead.getIngressForOwnerReadonly = IngressRead.getIngressForOwnerReadonly;
export const listIngressesForOwner: typeof IngressRead.listIngressesForOwner = IngressRead.listIngressesForOwner;

export const claimIngressRecovery: typeof RecoveryCustody.claimIngressRecovery = RecoveryCustody.claimIngressRecovery;
export const validateIngressRecovery: typeof RecoveryCustody.validateIngressRecovery = RecoveryCustody.validateIngressRecovery;

export const cancelLatestPending: typeof PendingCancellation.cancelLatestPending = PendingCancellation.cancelLatestPending;

export const cancelForRecovery: typeof RecoveryCancellation.cancelForRecovery = RecoveryCancellation.cancelForRecovery;

export const beginDeliveryReceipt: typeof DeliveryReceipts.beginDeliveryReceipt = DeliveryReceipts.beginDeliveryReceipt;
export const confirmDeliveryReceipt: typeof DeliveryReceipts.confirmDeliveryReceipt = DeliveryReceipts.confirmDeliveryReceipt;
export const releaseRejectedDelivery: typeof DeliveryReceipts.releaseRejectedDelivery = DeliveryReceipts.releaseRejectedDelivery;
export const blockRejectedDelivery: typeof DeliveryReceipts.blockRejectedDelivery = DeliveryReceipts.blockRejectedDelivery;
export const unknownDeliveryReceiptCount: typeof DeliveryReceipts.unknownDeliveryReceiptCount = DeliveryReceipts.unknownDeliveryReceiptCount;
export const blockedDeliveryReceiptCount: typeof DeliveryReceipts.blockedDeliveryReceiptCount = DeliveryReceipts.blockedDeliveryReceiptCount;
export const newReplyOutputHold: typeof NewReplyClaims.newReplyOutputHold = NewReplyClaims.newReplyOutputHold;
export const newReplyAcknowledgementSendable: typeof NewReplyClaims.newReplyAcknowledgementSendable = NewReplyClaims.newReplyAcknowledgementSendable;
export const releaseNewReplyAcknowledgement: typeof NewReplyClaims.releaseNewReplyAcknowledgement = NewReplyClaims.releaseNewReplyAcknowledgement;

export const stageCommentary: typeof CommentaryOutbox.stageCommentary = CommentaryOutbox.stageCommentary;
export const pendingCommentary: typeof CommentaryOutbox.pendingCommentary = CommentaryOutbox.pendingCommentary;
export const hasPendingCommentary: typeof CommentaryOutbox.hasPendingCommentary = CommentaryOutbox.hasPendingCommentary;
export const completeCommentary: typeof CommentaryOutbox.completeCommentary = CommentaryOutbox.completeCommentary;
export const pendingStartNotices: typeof StartNoticeOutbox.pendingStartNotices = StartNoticeOutbox.pendingStartNotices;
export const completeStartNotice: typeof StartNoticeOutbox.completeStartNotice = StartNoticeOutbox.completeStartNotice;
export const completionPage: typeof CompletionMetadata.completionPage = CompletionMetadata.completionPage;
export const completionHeadsForTarget: typeof CompletionMetadata.completionHeadsForTarget = CompletionMetadata.completionHeadsForTarget;
export const readCompletionMetadataRound: typeof CompletionRound.readCompletionMetadataRound = CompletionRound.readCompletionMetadataRound;
export const loadCompletionPayload: typeof CompletionPayload.loadCompletionPayload = CompletionPayload.loadCompletionPayload;
export const finalDeliveryPreflight: typeof DeliveryPreflight.finalDeliveryPreflight = DeliveryPreflight.finalDeliveryPreflight;
export const pendingFirstReply: typeof DeliveryPreflight.pendingFirstReply = DeliveryPreflight.pendingFirstReply;

export const admitIngress: typeof IngressAdmission.admitIngress = IngressAdmission.admitIngress;
export const pendingNewPrompt: typeof NewPromptArm.pendingNewPrompt = NewPromptArm.pendingNewPrompt;

export const newThreadOrigin: typeof NewOrigin.newThreadOrigin = NewOrigin.newThreadOrigin;
export const acceptRunningStop: typeof StopControlAdmission.acceptRunningStop = StopControlAdmission.acceptRunningStop;
export const acceptNonrunningStop: typeof StopAcceptance.acceptNonrunningStop = StopAcceptance.acceptNonrunningStop;
export const acceptUnresolvedStop: typeof StopAcceptance.acceptUnresolvedStop = StopAcceptance.acceptUnresolvedStop;
export const captureStopOrigin: typeof StopRevision.captureStopOrigin = StopRevision.captureStopOrigin;

export const captureAsyncHistorySnapshot: typeof AsyncHistory.captureAsyncHistorySnapshot = AsyncHistory.captureAsyncHistorySnapshot;
export const retainAsyncHistoryCandidate: typeof AsyncHistory.retainAsyncHistoryCandidate = AsyncHistory.retainAsyncHistoryCandidate;
export const captureTerminalHistorySnapshot: typeof AsyncHistory.captureTerminalHistorySnapshot = AsyncHistory.captureTerminalHistorySnapshot;
export const settleTerminalHistory: typeof AsyncHistory.settleTerminalHistory = AsyncHistory.settleTerminalHistory;

export const recordObservedFinalAnswer: typeof ObservedFinalAnswer.recordObservedFinalAnswer = ObservedFinalAnswer.recordObservedFinalAnswer;
export const getObservedFinalAnswer: typeof ObservedFinalAnswer.getObservedFinalAnswer = ObservedFinalAnswer.getObservedFinalAnswer;
export const hasObservedCompletionResidentEvidence: typeof ObservedCompletion.hasObservedCompletionResidentEvidence = ObservedCompletion.hasObservedCompletionResidentEvidence;
export const pendingObservedCompletions: typeof ObservedCompletion.pendingObservedCompletions = ObservedCompletion.pendingObservedCompletions;
export const hasObservedCompletion: typeof ObservedCompletion.hasObservedCompletion = ObservedCompletion.hasObservedCompletion;
export const recordObservedCompletionError: typeof ObservedCompletion.recordObservedCompletionError = ObservedCompletion.recordObservedCompletionError;
export const finishObservedCompletion: typeof ObservedCompletion.finishObservedCompletion = ObservedCompletion.finishObservedCompletion;

export const recordObservedCompletionForResident: typeof ObservedCompletion.recordObservedCompletionForResident = ObservedCompletion.recordObservedCompletionForResident;

export const listPendingDeliveries: typeof Delivery.listPendingDeliveries = Delivery.listPendingDeliveries;
export const recordDeliveryFailure: typeof Delivery.recordDeliveryFailure = Delivery.recordDeliveryFailure;
export const completeDelivery: typeof Delivery.completeDelivery = Delivery.completeDelivery;

export const stageOwnedQueueCompletion: typeof Delivery.stageOwnedQueueCompletion = Delivery.stageOwnedQueueCompletion;

export const activateDeadGenerationRuntime: typeof DeadCapture.activateDeadGenerationRuntime = DeadCapture.activateDeadGenerationRuntime;
export const captureDeadGeneration: typeof DeadCapture.captureDeadGeneration = DeadCapture.captureDeadGeneration;

export const captureResponseCustody: typeof ResponseCustody.captureResponseCustody = ResponseCustody.captureResponseCustody;
export const beginResponseCustody: typeof ResponseCustody.beginResponseCustody = ResponseCustody.beginResponseCustody;
export const finishResponseCustody: typeof ResponseCustody.finishResponseCustody = ResponseCustody.finishResponseCustody;
export const checkResponseCustody: typeof ResponseCustody.checkResponseCustody = ResponseCustody.checkResponseCustody;
export const checkAllResponseCustody: typeof ResponseCustody.checkAllResponseCustody = ResponseCustody.checkAllResponseCustody;

export const validateQueueStartAuthorityIn: typeof QueueStartAuthority.validateQueueStartAuthorityIn = QueueStartAuthority.validateQueueStartAuthorityIn;
export const validateStopRequestIn: typeof StopRevision.validateStopRequestIn = StopRevision.validateStopRequestIn;

export const checkMutationCustody: typeof MutationAttempt.check = MutationAttempt.check;
export const requireResponseUnheldIn: typeof ResponseCustody.requireResponseUnheldIn = ResponseCustody.requireResponseUnheldIn;
export const requireAllResponsesResolvedIn: typeof ResponseCustody.requireAllResponsesResolvedIn = ResponseCustody.requireAllResponsesResolvedIn;
export const requireStopControlUnheldIn: typeof RuntimeFenceReads.requireStopControlUnheldIn = RuntimeFenceReads.requireStopControlUnheldIn;
export const stopControlTargetHeldExisting: typeof RuntimeFenceReads.stopControlTargetHeldExisting = RuntimeFenceReads.stopControlTargetHeldExisting;
export const deadGenerationTargetHeldExisting: typeof RuntimeFenceReads.deadGenerationTargetHeldExisting = RuntimeFenceReads.deadGenerationTargetHeldExisting;
export const deadGenerationSealedExisting: typeof RuntimeFenceReads.deadGenerationSealedExisting = RuntimeFenceReads.deadGenerationSealedExisting;

export const claimStopControl: typeof StopDispatch.claimStopControl = StopDispatch.claimStopControl;
export const validateStopClaimIn: typeof StopDispatch.validateStopClaimIn = StopDispatch.validateStopClaimIn;
export const beginStopWire: typeof StopDispatch.beginStopWire = StopDispatch.beginStopWire;
export const finishStopWire: typeof StopDispatch.finishStopWire = StopDispatch.finishStopWire;
export const recordStopControlError: typeof StopDispatch.recordStopControlError = StopDispatch.recordStopControlError;

export const captureDeadGenerationExisting: typeof DeadCapture.captureDeadGenerationExisting = DeadCapture.captureDeadGenerationExisting;

export const guardAsyncMutationIn: typeof AsyncGuards.guardAsyncMutationIn = AsyncGuards.guardAsyncMutationIn;
export const certifiedAsyncSuccessorIn: typeof AsyncGuards.certifiedAsyncSuccessorIn = AsyncGuards.certifiedAsyncSuccessorIn;
export const sealAsyncQuestionIn: typeof QuestionGuard.sealAsyncQuestionIn = QuestionGuard.sealAsyncQuestionIn;
export const verifyAsyncQuestionIdentityIn: typeof QuestionGuard.verifyAsyncQuestionIdentityIn = QuestionGuard.verifyAsyncQuestionIdentityIn;
export const validateAsyncDispatchGuardsIn: typeof QuestionGuard.validateAsyncDispatchGuardsIn = QuestionGuard.validateAsyncDispatchGuardsIn;
export const validateAsyncDispatchGuardsExisting: typeof QuestionGuard.validateAsyncDispatchGuardsExisting = QuestionGuard.validateAsyncDispatchGuardsExisting;
export const validateAsyncDispatchGuards: typeof QuestionGuard.validateAsyncDispatchGuards = QuestionGuard.validateAsyncDispatchGuards;

export const activateObservationExisting: typeof ObservationLedger.activateObservationExisting = ObservationLedger.activateObservationExisting;
export const discoverObservationExisting: typeof ObservationLedger.discoverObservationExisting = ObservationLedger.discoverObservationExisting;
export const markUnknownObservationExisting: typeof ObservationLedger.markUnknownObservationExisting = ObservationLedger.markUnknownObservationExisting;
export const observationScopeVerifiedExisting: typeof ObservationLedger.observationScopeVerifiedExisting = ObservationLedger.observationScopeVerifiedExisting;
export const getIdleIntentExisting: typeof IdleReleaseStore.getIdleIntentExisting = IdleReleaseStore.getIdleIntentExisting;
export const pendingIdleIntentsExisting: typeof IdleReleaseStore.pendingIdleIntentsExisting = IdleReleaseStore.pendingIdleIntentsExisting;
export const beforeIdleMutationExisting: typeof IdleReleaseStore.beforeIdleMutationExisting = IdleReleaseStore.beforeIdleMutationExisting;
export const transitionIdleIntentExisting: typeof IdleReleaseStore.transitionIdleIntentExisting = IdleReleaseStore.transitionIdleIntentExisting;
export const verifyIdleIntentWithObservationsExisting: typeof IdleReleaseStore.verifyIdleIntentWithObservationsExisting = IdleReleaseStore.verifyIdleIntentWithObservationsExisting;
export const settleExitedIdleOwnerExisting: typeof IdleReleaseStore.settleExitedIdleOwnerExisting = IdleReleaseStore.settleExitedIdleOwnerExisting;

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

export const beginAppServerForkHandoff: typeof ForkBegin.beginAppServerForkHandoff = ForkBegin.beginAppServerForkHandoff;
export const stageAppServerForkTarget: typeof ForkTarget.stageAppServerForkTarget = ForkTarget.stageAppServerForkTarget;
export const finalizeAppServerForkHandoff: typeof ForkTarget.finalizeAppServerForkHandoff = ForkTarget.finalizeAppServerForkHandoff;
export const recordAppServerForkFailure: typeof ForkFailure.recordAppServerForkFailure = ForkFailure.recordAppServerForkFailure;
export const recordAppServerForkFinalizeFailure: typeof ForkFailure.recordAppServerForkFinalizeFailure = ForkFailure.recordAppServerForkFinalizeFailure;
export const recordAndCancelDefiniteForkFailure: typeof ForkFailure.recordAndCancelDefiniteForkFailure = ForkFailure.recordAndCancelDefiniteForkFailure;
export const completedAppServerForkTargetForSource: typeof ForkCompleted.completedAppServerForkTargetForSource = ForkCompleted.completedAppServerForkTargetForSource;
export const isAppServerManagedTarget: typeof ForkManaged.isAppServerManagedTarget = ForkManaged.isAppServerManagedTarget;
export const mirroredThreadId: typeof MirrorMapping.mirroredThreadId = MirrorMapping.mirroredThreadId;
export const renewPromptIntakeClaimIfCurrent: typeof PromptIntakeLease.renewPromptIntakeClaimIfCurrent = PromptIntakeLease.renewPromptIntakeClaimIfCurrent;
export const promptIntakeHasDurableOwner: typeof PromptIntakeLease.promptIntakeHasDurableOwner = PromptIntakeLease.promptIntakeHasDurableOwner;
export const admitPromptIntake: typeof PromptIntakeWrite.admitPromptIntake = PromptIntakeWrite.admitPromptIntake;
export const getPromptIntake: typeof PromptIntakeLease.getPromptIntake = PromptIntakeLease.getPromptIntake;
export const tryClaimPromptIntake: typeof PromptIntakeLease.tryClaimPromptIntake = PromptIntakeLease.tryClaimPromptIntake;
export const removePromptIntakeIfQueued: typeof PromptIntakeWrite.removePromptIntakeIfQueued = PromptIntakeWrite.removePromptIntakeIfQueued;
export const recordPromptIntakeFailureIfClaimed: typeof PromptIntakeLease.recordPromptIntakeFailureIfClaimed = PromptIntakeLease.recordPromptIntakeFailureIfClaimed;
export const listPromptIntakes: typeof PromptIntakeLease.listPromptIntakes = PromptIntakeLease.listPromptIntakes;
export const executionHoldReason: typeof ExecutionHold.executionHoldReason = ExecutionHold.executionHoldReason;
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
  readonly getIdleIntent: typeof IdleReleaseStore.getIdleIntent;
  readonly pendingIdleIntents: typeof IdleReleaseStore.pendingIdleIntents;
  readonly beforeIdleMutation: typeof IdleReleaseStore.beforeIdleMutation;
  readonly transitionIdleIntent: typeof IdleReleaseStore.transitionIdleIntent;
  readonly verifyIdleIntent: typeof IdleReleaseStore.verifyIdleIntent;
  readonly verifyIdleIntentWithObservations: typeof IdleReleaseStore.verifyIdleIntentWithObservations;
  readonly settleExitedIdleOwner: typeof IdleReleaseStore.settleExitedIdleOwner;

  readonly certifyObservation: typeof ObservationProof.certifyObservation;
  readonly finishObservationPage: typeof ObservationProof.finishObservationPage;

  readonly activateObservation: typeof ObservationLedger.activateObservation;
  readonly discoverObservation: typeof ObservationLedger.discoverObservation;
  readonly markUnknownObservation: typeof ObservationLedger.markUnknownObservation;
  readonly nextObservationGap: typeof ObservationLedger.nextObservationGap;
  readonly observationScopeVerified: typeof ObservationLedger.observationScopeVerified;

  readonly stageCommentary: typeof CommentaryOutbox.stageCommentary;
  readonly pendingCommentary: typeof CommentaryOutbox.pendingCommentary;
  readonly hasPendingCommentary: typeof CommentaryOutbox.hasPendingCommentary;
  readonly completeCommentary: typeof CommentaryOutbox.completeCommentary;
  readonly pendingStartNotices: typeof StartNoticeOutbox.pendingStartNotices;
  readonly completeStartNotice: typeof StartNoticeOutbox.completeStartNotice;
  readonly completionPage: typeof CompletionMetadata.completionPage;
  readonly completionHeadsForTarget: typeof CompletionMetadata.completionHeadsForTarget;
  readonly readCompletionMetadataRound: typeof CompletionRound.readCompletionMetadataRound;
  readonly loadCompletionPayload: typeof CompletionPayload.loadCompletionPayload;
  readonly finalDeliveryPreflight: typeof DeliveryPreflight.finalDeliveryPreflight;
  readonly pendingFirstReply: typeof DeliveryPreflight.pendingFirstReply;

  readonly beginDeliveryReceipt: typeof DeliveryReceipts.beginDeliveryReceipt;
  readonly confirmDeliveryReceipt: typeof DeliveryReceipts.confirmDeliveryReceipt;
  readonly releaseRejectedDelivery: typeof DeliveryReceipts.releaseRejectedDelivery;
  readonly blockRejectedDelivery: typeof DeliveryReceipts.blockRejectedDelivery;
  readonly unknownDeliveryReceiptCount: typeof DeliveryReceipts.unknownDeliveryReceiptCount;
  readonly blockedDeliveryReceiptCount: typeof DeliveryReceipts.blockedDeliveryReceiptCount;
  readonly newReplyOutputHold: typeof NewReplyClaims.newReplyOutputHold;
  readonly newReplyAcknowledgementSendable: typeof NewReplyClaims.newReplyAcknowledgementSendable;
  readonly releaseNewReplyAcknowledgement: typeof NewReplyClaims.releaseNewReplyAcknowledgement;

  readonly cancelForRecovery: typeof RecoveryCancellation.cancelForRecovery;
  readonly cancelLatestPending: typeof PendingCancellation.cancelLatestPending;
  readonly claimIngressRecovery: typeof RecoveryCustody.claimIngressRecovery;
  readonly validateIngressRecovery: typeof RecoveryCustody.validateIngressRecovery;

  readonly holdIngress: typeof IngressRecovery.holdIngress;
  readonly recoverPriorRuntimeIngress: typeof IngressRecovery.recoverPriorRuntimeIngress;
  readonly getIngress: typeof IngressRead.getIngress;
  readonly getIngressForOwnerReadonly: typeof IngressRead.getIngressForOwnerReadonly;
  readonly listIngressesForOwner: typeof IngressRead.listIngressesForOwner;

  readonly admitBusyInteraction: typeof BusyIngress.admitBusyInteraction;
  readonly admitMappedSlashIngress: typeof IngressAdmission.admitMappedSlashIngress;
  readonly recordIngressNewCreation: typeof IngressLifecycle.recordIngressNewCreation;

  readonly acknowledgeIngress: typeof IngressLifecycle.acknowledgeIngress;
  readonly beginIngressConfirmation: typeof IngressLifecycle.beginIngressConfirmation;
  readonly beginIngressExecution: typeof IngressLifecycle.beginIngressExecution;
  readonly beginIngressThreadStart: typeof IngressLifecycle.beginIngressThreadStart;
  readonly recordIngressCreatedThread: typeof IngressLifecycle.recordIngressCreatedThread;
  readonly recordIngressResult: typeof IngressLifecycle.recordIngressResult;
  readonly confirmIngress: typeof IngressLifecycle.confirmIngress;
  readonly recordIngressProcessingMode: typeof IngressLifecycle.recordIngressProcessingMode;
  readonly admitIngress: typeof IngressAdmission.admitIngress;
  readonly pendingNewPrompt: typeof NewPromptArm.pendingNewPrompt;
  readonly newThreadOrigin: typeof NewOrigin.newThreadOrigin;
  readonly acceptRunningStop: typeof StopControlAdmission.acceptRunningStop;
  readonly acceptNonrunningStop: typeof StopAcceptance.acceptNonrunningStop;
  readonly acceptUnresolvedStop: typeof StopAcceptance.acceptUnresolvedStop;
  readonly captureStopOrigin: typeof StopRevision.captureStopOrigin;
  readonly admitPromptIntake: typeof PromptIntakeWrite.admitPromptIntake;
  readonly getPromptIntake: typeof PromptIntakeLease.getPromptIntake;
  readonly tryClaimPromptIntake: typeof PromptIntakeLease.tryClaimPromptIntake;
  readonly removePromptIntakeIfQueued: typeof PromptIntakeWrite.removePromptIntakeIfQueued;
  readonly recordPromptIntakeFailureIfClaimed: typeof PromptIntakeLease.recordPromptIntakeFailureIfClaimed;
  readonly listPromptIntakes: typeof PromptIntakeLease.listPromptIntakes;
  readonly executionHoldReason: typeof ExecutionHold.executionHoldReason;

  readonly renewPromptIntakeClaimIfCurrent: typeof PromptIntakeLease.renewPromptIntakeClaimIfCurrent;
  readonly promptIntakeHasDurableOwner: typeof PromptIntakeLease.promptIntakeHasDurableOwner;

  readonly mirroredThreadId: typeof MirrorMapping.mirroredThreadId;
  readonly beginAppServerForkHandoff: typeof ForkBegin.beginAppServerForkHandoff;
  readonly stageAppServerForkTarget: typeof ForkTarget.stageAppServerForkTarget;
  readonly finalizeAppServerForkHandoff: typeof ForkTarget.finalizeAppServerForkHandoff;
  readonly recordAppServerForkFailure: typeof ForkFailure.recordAppServerForkFailure;
  readonly recordAppServerForkFinalizeFailure: typeof ForkFailure.recordAppServerForkFinalizeFailure;
  readonly recordAndCancelDefiniteForkFailure: typeof ForkFailure.recordAndCancelDefiniteForkFailure;
  readonly completedAppServerForkTargetForSource: typeof ForkCompleted.completedAppServerForkTargetForSource;
  readonly isAppServerManagedTarget: typeof ForkManaged.isAppServerManagedTarget;

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
  readonly recordObservedFinalAnswer: typeof ObservedFinalAnswer.recordObservedFinalAnswer;
  readonly getObservedFinalAnswer: typeof ObservedFinalAnswer.getObservedFinalAnswer;
  readonly hasObservedCompletionResidentEvidence: typeof ObservedCompletion.hasObservedCompletionResidentEvidence;
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
  readonly activateDeadGenerationRuntime: typeof DeadCapture.activateDeadGenerationRuntime;
  readonly captureDeadGeneration: typeof DeadCapture.captureDeadGeneration;
  readonly captureResponseCustody: typeof ResponseCustody.captureResponseCustody;
  readonly beginResponseCustody: typeof ResponseCustody.beginResponseCustody;
  readonly finishResponseCustody: typeof ResponseCustody.finishResponseCustody;
  readonly checkResponseCustody: typeof ResponseCustody.checkResponseCustody;
  readonly checkAllResponseCustody: typeof ResponseCustody.checkAllResponseCustody;
  readonly validateQueueStartAuthorityIn: typeof QueueStartAuthority.validateQueueStartAuthorityIn;
  readonly validateStopRequestIn: typeof StopRevision.validateStopRequestIn;
  readonly checkMutationCustody: typeof MutationAttempt.check;
  readonly requireResponseUnheldIn: typeof ResponseCustody.requireResponseUnheldIn;
  readonly requireAllResponsesResolvedIn: typeof ResponseCustody.requireAllResponsesResolvedIn;
  readonly requireStopControlUnheldIn: typeof RuntimeFenceReads.requireStopControlUnheldIn;
  readonly stopControlTargetHeldExisting: typeof RuntimeFenceReads.stopControlTargetHeldExisting;
  readonly deadGenerationTargetHeldExisting: typeof RuntimeFenceReads.deadGenerationTargetHeldExisting;
  readonly deadGenerationSealedExisting: typeof RuntimeFenceReads.deadGenerationSealedExisting;
  readonly claimStopControl: typeof StopDispatch.claimStopControl;
  readonly validateStopClaimIn: typeof StopDispatch.validateStopClaimIn;
  readonly beginStopWire: typeof StopDispatch.beginStopWire;
  readonly finishStopWire: typeof StopDispatch.finishStopWire;
  readonly recordStopControlError: typeof StopDispatch.recordStopControlError;
  readonly captureDeadGenerationExisting: typeof DeadCapture.captureDeadGenerationExisting;
  readonly guardAsyncMutationIn: typeof AsyncGuards.guardAsyncMutationIn;
  readonly certifiedAsyncSuccessorIn: typeof AsyncGuards.certifiedAsyncSuccessorIn;
  readonly sealAsyncQuestionIn: typeof QuestionGuard.sealAsyncQuestionIn;
  readonly verifyAsyncQuestionIdentityIn: typeof QuestionGuard.verifyAsyncQuestionIdentityIn;
  readonly validateAsyncDispatchGuardsIn: typeof QuestionGuard.validateAsyncDispatchGuardsIn;
  readonly validateAsyncDispatchGuardsExisting: typeof QuestionGuard.validateAsyncDispatchGuardsExisting;
  readonly validateAsyncDispatchGuards: typeof QuestionGuard.validateAsyncDispatchGuards;
  readonly activateObservationExisting: typeof ObservationLedger.activateObservationExisting;
  readonly discoverObservationExisting: typeof ObservationLedger.discoverObservationExisting;
  readonly markUnknownObservationExisting: typeof ObservationLedger.markUnknownObservationExisting;
  readonly observationScopeVerifiedExisting: typeof ObservationLedger.observationScopeVerifiedExisting;
  readonly getIdleIntentExisting: typeof IdleReleaseStore.getIdleIntentExisting;
  readonly pendingIdleIntentsExisting: typeof IdleReleaseStore.pendingIdleIntentsExisting;
  readonly beforeIdleMutationExisting: typeof IdleReleaseStore.beforeIdleMutationExisting;
  readonly transitionIdleIntentExisting: typeof IdleReleaseStore.transitionIdleIntentExisting;
  readonly verifyIdleIntentWithObservationsExisting: typeof IdleReleaseStore.verifyIdleIntentWithObservationsExisting;
  readonly settleExitedIdleOwnerExisting: typeof IdleReleaseStore.settleExitedIdleOwnerExisting;
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
  getIdleIntent,
  pendingIdleIntents,
  beforeIdleMutation,
  transitionIdleIntent,
  verifyIdleIntent,
  verifyIdleIntentWithObservations,
  settleExitedIdleOwner,

  certifyObservation,
  finishObservationPage,

  activateObservation,
  discoverObservation,
  markUnknownObservation,
  nextObservationGap,
  observationScopeVerified,

  admitPromptIntake,
  getPromptIntake,
  tryClaimPromptIntake,
  removePromptIntakeIfQueued,
  recordPromptIntakeFailureIfClaimed,
  listPromptIntakes,
  executionHoldReason,

  renewPromptIntakeClaimIfCurrent,
  promptIntakeHasDurableOwner,

  acknowledgeIngress,
  beginIngressConfirmation,
  beginIngressExecution,
  beginIngressThreadStart,
  recordIngressCreatedThread,
  recordIngressResult,
  confirmIngress,
  recordIngressProcessingMode,
  admitMappedSlashIngress,
  recordIngressNewCreation,
  admitBusyInteraction,
  holdIngress,
  recoverPriorRuntimeIngress,
  getIngress,
  getIngressForOwnerReadonly,
  listIngressesForOwner,
  claimIngressRecovery,
  validateIngressRecovery,
  cancelLatestPending,
  cancelForRecovery,
  beginDeliveryReceipt,
  confirmDeliveryReceipt,
  releaseRejectedDelivery,
  blockRejectedDelivery,
  unknownDeliveryReceiptCount,
  blockedDeliveryReceiptCount,
  newReplyOutputHold,
  newReplyAcknowledgementSendable,
  releaseNewReplyAcknowledgement,
  stageCommentary,
  pendingCommentary,
  hasPendingCommentary,
  completeCommentary,
  pendingStartNotices,
  completeStartNotice,
  completionPage,
  completionHeadsForTarget,
  readCompletionMetadataRound,
  loadCompletionPayload,
  finalDeliveryPreflight,
  pendingFirstReply,
  admitIngress,
  pendingNewPrompt,
  newThreadOrigin,
  acceptRunningStop,
  acceptNonrunningStop,
  acceptUnresolvedStop,
  captureStopOrigin,
  mirroredThreadId,
  beginAppServerForkHandoff,
  stageAppServerForkTarget,
  finalizeAppServerForkHandoff,
  recordAppServerForkFailure,
  recordAppServerForkFinalizeFailure,
  recordAndCancelDefiniteForkFailure,
  completedAppServerForkTargetForSource,
  isAppServerManagedTarget,

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
  recordObservedFinalAnswer,
  getObservedFinalAnswer,
  hasObservedCompletionResidentEvidence,
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
  activateDeadGenerationRuntime,
  captureDeadGeneration,
  captureResponseCustody,
  beginResponseCustody,
  finishResponseCustody,
  checkResponseCustody,
  checkAllResponseCustody,
  validateQueueStartAuthorityIn,
  validateStopRequestIn,
  checkMutationCustody,
  requireResponseUnheldIn,
  requireAllResponsesResolvedIn,
  requireStopControlUnheldIn,
  stopControlTargetHeldExisting,
  deadGenerationTargetHeldExisting,
  deadGenerationSealedExisting,
  claimStopControl,
  validateStopClaimIn,
  beginStopWire,
  finishStopWire,
  recordStopControlError,
  captureDeadGenerationExisting,
  guardAsyncMutationIn,
  certifiedAsyncSuccessorIn,
  sealAsyncQuestionIn,
  verifyAsyncQuestionIdentityIn,
  validateAsyncDispatchGuardsIn,
  validateAsyncDispatchGuardsExisting,
  validateAsyncDispatchGuards,
  activateObservationExisting,
  discoverObservationExisting,
  markUnknownObservationExisting,
  observationScopeVerifiedExisting,
  getIdleIntentExisting,
  pendingIdleIntentsExisting,
  beforeIdleMutationExisting,
  transitionIdleIntentExisting,
  verifyIdleIntentWithObservationsExisting,
  settleExitedIdleOwnerExisting,
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
