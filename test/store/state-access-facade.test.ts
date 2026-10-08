import * as QuestionDelivery from "../../src/store/async-question-delivery-state.ts";
import * as QuestionObservation from "../../src/store/async-question-observation.ts";
import * as QuestionRetention from "../../src/store/async-question-retention.ts";
import * as StopControlRead from "../../src/store/stop-control-read.ts";
import * as StopControlAdmission from "../../src/store/stop-control-admission.ts";
import * as StopAcceptance from "../../src/store/stop-acceptance.ts";
import * as ObservedFinalAnswer from "../../src/store/observed-final-answer.ts";
import * as AsyncGuards from "../../src/store/async-resolution-guards.ts";
import * as QuestionGuard from "../../src/store/async-question-guard.ts";
import * as StopDispatch from "../../src/store/stop-control-dispatch.ts";
import * as RuntimeFenceReads from "../../src/store/runtime-fence-reads.ts";
import * as QueueStartAuthority from "../../src/store/queue-start-authority.ts";
import * as ResponseCustody from "../../src/store/response-custody.ts";
import * as DeadCapture from "../../src/store/dead-generation-capture.ts";
import * as IdleReleaseStore from "../../src/store/idle-release-store.ts";
import * as ObservationProof from "../../src/store/observation-proof.ts";
import * as ObservationLedger from "../../src/store/observation-ledger.ts";
import * as FacadeExports from "../../src/store/state-access-facade.ts";
import * as DeliveryPreflight from "../../src/store/delivery-preflight.ts";
import * as DeliveryReceipts from "../../src/store/delivery-receipts.ts";
import * as NewReplyClaims from "../../src/store/new-reply-claims.ts";
import * as RecoveryCancellation from "../../src/store/queue-cancel-recovery.ts";
import * as PendingCancellation from "../../src/store/queue-cancel-pending.ts";
import * as RecoveryCustody from "../../src/store/ingress-recovery-custody.ts";
import * as IngressRecovery from "../../src/store/ingress-recovery.ts";
import * as IngressRead from "../../src/store/ingress-read.ts";
import * as BusyIngress from "../../src/store/ingress-busy.ts";
import * as IngressLifecycle from "../../src/store/ingress-lifecycle.ts";
import * as IngressAdmission from "../../src/store/ingress-admission.ts";
import * as NewPromptArm from "../../src/store/ingress-new-prompt-arm.ts";
import * as NewOrigin from "../../src/store/new-thread-origin.ts";
import * as StopRevision from "../../src/store/stop-revision-read.ts";
import * as PromptIntakeLease from "../../src/store/prompt-intake.ts";
import * as MirrorMapping from "../../src/store/busy-choice.ts";
import * as ForkBegin from "../../src/store/fork-begin.ts";
import * as ForkTarget from "../../src/store/fork-target.ts";
import * as ForkFailure from "../../src/store/fork-failure.ts";
import * as ForkCompleted from "../../src/store/fork-completed-target.ts";
import * as ForkManaged from "../../src/store/fork-managed-query.ts";
import * as PromptIntakeWrite from "../../src/store/prompt-intake-write.ts";
import * as PromptIntakePromotion from "../../src/store/prompt-intake-promotion.ts";
import * as AsyncHistory from "../../src/store/async-history.ts";
import * as ObservedCompletion from "../../src/store/observed-completion.ts";
import * as Delivery from "../../src/store/delivery.ts";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  StateAccessFacade,
  enqueue,
  enqueueIfMirrorMatches,
  enqueueInTransaction,
  markRunning,
  activate,
  beginChecked,
  finish,
  openCheckedRead,
} from "../../src/store/state-access-facade.ts";
import type { IStateAccessFacade } from "../../src/store/state-access-facade.ts";

import * as QueueEnqueue from "../../src/store/queue-enqueue.ts";
import * as QueueMarkRunning from "../../src/store/queue-mark-running.ts";
import * as MutationAttempt from "../../src/store/mutation-attempt.ts";
import { CheckedRead } from "../../src/store/owned-driver.ts";
import * as AsyncAdmission from "../../src/store/async-resolution-admission.ts";
import * as QueueRead from "../../src/store/queue-read.ts";
import * as ExecutionHold from "../../src/store/execution-hold.ts";
import * as QueueClaims from "../../src/store/queue-claims.ts";
import * as DeadGeneration from "../../src/store/dead-generation-admission.ts";
import * as Preflight from "../../src/store/queue-preflight-failure.ts";

describe("StateAccessFacade runtime function identity (no database)", () => {
  it("exposes exact direct function references on StateAccessFacade", () => {
    assert.strictEqual(StateAccessFacade.recordAsyncQuestionObservation, QuestionObservation.recordAsyncQuestionObservation);
    assert.strictEqual(FacadeExports.recordAsyncQuestionObservation, QuestionObservation.recordAsyncQuestionObservation);
    assert.strictEqual(StateAccessFacade.reconcileAsyncQuestionObservations, QuestionObservation.reconcileAsyncQuestionObservations);
    assert.strictEqual(FacadeExports.reconcileAsyncQuestionObservations, QuestionObservation.reconcileAsyncQuestionObservations);
    assert.strictEqual(StateAccessFacade.observeAsyncQuestion, QuestionObservation.observeAsyncQuestion);
    assert.strictEqual(FacadeExports.observeAsyncQuestion, QuestionObservation.observeAsyncQuestion);
    assert.strictEqual(StateAccessFacade.retireOldAsyncQuestionOwner, QuestionRetention.retireOldAsyncQuestionOwner);
    assert.strictEqual(FacadeExports.retireOldAsyncQuestionOwner, QuestionRetention.retireOldAsyncQuestionOwner);
    assert.strictEqual(StateAccessFacade.supersedeAsyncQuestions, QuestionRetention.supersedeAsyncQuestions);
    assert.strictEqual(FacadeExports.supersedeAsyncQuestions, QuestionRetention.supersedeAsyncQuestions);
    assert.strictEqual(StateAccessFacade.compactTerminalAsyncQuestions, QuestionRetention.compactTerminalAsyncQuestions);
    assert.strictEqual(FacadeExports.compactTerminalAsyncQuestions, QuestionRetention.compactTerminalAsyncQuestions);
    assert.strictEqual(StateAccessFacade.getAsyncQuestion,QuestionDelivery.getAsyncQuestion);
    assert.strictEqual(FacadeExports.getAsyncQuestion,QuestionDelivery.getAsyncQuestion);
    assert.strictEqual(StateAccessFacade.pendingAsyncQuestions,QuestionDelivery.pendingAsyncQuestions);
    assert.strictEqual(FacadeExports.pendingAsyncQuestions,QuestionDelivery.pendingAsyncQuestions);
    assert.strictEqual(StateAccessFacade.confirmAsyncQuestionOwner,QuestionDelivery.confirmAsyncQuestionOwner);
    assert.strictEqual(FacadeExports.confirmAsyncQuestionOwner,QuestionDelivery.confirmAsyncQuestionOwner);
    assert.strictEqual(StateAccessFacade.requireCurrentAsyncQuestionMapping,QuestionDelivery.requireCurrentAsyncQuestionMapping);
    assert.strictEqual(FacadeExports.requireCurrentAsyncQuestionMapping,QuestionDelivery.requireCurrentAsyncQuestionMapping);
    assert.strictEqual(StateAccessFacade.bindAsyncQuestionReceipt,QuestionDelivery.bindAsyncQuestionReceipt);
    assert.strictEqual(FacadeExports.bindAsyncQuestionReceipt,QuestionDelivery.bindAsyncQuestionReceipt);
    assert.strictEqual(StateAccessFacade.getIdleIntent, IdleReleaseStore.getIdleIntent);
    assert.strictEqual(FacadeExports.getIdleIntent, IdleReleaseStore.getIdleIntent);
    assert.strictEqual(StateAccessFacade.pendingIdleIntents, IdleReleaseStore.pendingIdleIntents);
    assert.strictEqual(FacadeExports.pendingIdleIntents, IdleReleaseStore.pendingIdleIntents);
    assert.strictEqual(StateAccessFacade.beforeIdleMutation, IdleReleaseStore.beforeIdleMutation);
    assert.strictEqual(FacadeExports.beforeIdleMutation, IdleReleaseStore.beforeIdleMutation);
    assert.strictEqual(StateAccessFacade.transitionIdleIntent, IdleReleaseStore.transitionIdleIntent);
    assert.strictEqual(FacadeExports.transitionIdleIntent, IdleReleaseStore.transitionIdleIntent);
    assert.strictEqual(StateAccessFacade.verifyIdleIntent, IdleReleaseStore.verifyIdleIntent);
    assert.strictEqual(FacadeExports.verifyIdleIntent, IdleReleaseStore.verifyIdleIntent);
    assert.strictEqual(StateAccessFacade.verifyIdleIntentWithObservations, IdleReleaseStore.verifyIdleIntentWithObservations);
    assert.strictEqual(FacadeExports.verifyIdleIntentWithObservations, IdleReleaseStore.verifyIdleIntentWithObservations);
    assert.strictEqual(StateAccessFacade.settleExitedIdleOwner, IdleReleaseStore.settleExitedIdleOwner);
    assert.strictEqual(FacadeExports.settleExitedIdleOwner, IdleReleaseStore.settleExitedIdleOwner);

    assert.strictEqual(StateAccessFacade.certifyObservation, ObservationProof.certifyObservation);
    assert.strictEqual(FacadeExports.certifyObservation, ObservationProof.certifyObservation);
    assert.strictEqual(StateAccessFacade.finishObservationPage, ObservationProof.finishObservationPage);
    assert.strictEqual(FacadeExports.finishObservationPage, ObservationProof.finishObservationPage);

    assert.strictEqual(StateAccessFacade.activateObservation, ObservationLedger.activateObservation);
    assert.strictEqual(FacadeExports.activateObservation, ObservationLedger.activateObservation);
    assert.strictEqual(StateAccessFacade.discoverObservation, ObservationLedger.discoverObservation);
    assert.strictEqual(FacadeExports.discoverObservation, ObservationLedger.discoverObservation);
    assert.strictEqual(StateAccessFacade.markUnknownObservation, ObservationLedger.markUnknownObservation);
    assert.strictEqual(FacadeExports.markUnknownObservation, ObservationLedger.markUnknownObservation);
    assert.strictEqual(StateAccessFacade.nextObservationGap, ObservationLedger.nextObservationGap);
    assert.strictEqual(FacadeExports.nextObservationGap, ObservationLedger.nextObservationGap);
    assert.strictEqual(StateAccessFacade.observationScopeVerified, ObservationLedger.observationScopeVerified);
    assert.strictEqual(FacadeExports.observationScopeVerified, ObservationLedger.observationScopeVerified);

    assert.strictEqual(StateAccessFacade.captureAsyncHistorySnapshot, AsyncHistory.captureAsyncHistorySnapshot);
    assert.strictEqual(StateAccessFacade.retainAsyncHistoryCandidate, AsyncHistory.retainAsyncHistoryCandidate);
    assert.strictEqual(StateAccessFacade.captureTerminalHistorySnapshot, AsyncHistory.captureTerminalHistorySnapshot);
    assert.strictEqual(StateAccessFacade.settleTerminalHistory, AsyncHistory.settleTerminalHistory);
    assert.strictEqual(StateAccessFacade.recordObservedFinalAnswer, ObservedFinalAnswer.recordObservedFinalAnswer);
    assert.strictEqual(FacadeExports.recordObservedFinalAnswer, ObservedFinalAnswer.recordObservedFinalAnswer);
    assert.strictEqual(StateAccessFacade.getObservedFinalAnswer, ObservedFinalAnswer.getObservedFinalAnswer);
    assert.strictEqual(FacadeExports.getObservedFinalAnswer, ObservedFinalAnswer.getObservedFinalAnswer);
    assert.strictEqual(StateAccessFacade.hasObservedCompletionResidentEvidence, ObservedCompletion.hasObservedCompletionResidentEvidence);
    assert.strictEqual(FacadeExports.hasObservedCompletionResidentEvidence, ObservedCompletion.hasObservedCompletionResidentEvidence);
    assert.strictEqual(StateAccessFacade.pendingObservedCompletions, ObservedCompletion.pendingObservedCompletions);
    assert.strictEqual(StateAccessFacade.hasObservedCompletion, ObservedCompletion.hasObservedCompletion);
    assert.strictEqual(StateAccessFacade.recordObservedCompletionError, ObservedCompletion.recordObservedCompletionError);
    assert.strictEqual(StateAccessFacade.finishObservedCompletion, ObservedCompletion.finishObservedCompletion);
    assert.strictEqual(StateAccessFacade.recordObservedCompletionForResident, ObservedCompletion.recordObservedCompletionForResident);
    assert.strictEqual(StateAccessFacade.listPendingDeliveries, Delivery.listPendingDeliveries);
    assert.strictEqual(StateAccessFacade.recordDeliveryFailure, Delivery.recordDeliveryFailure);
    assert.strictEqual(StateAccessFacade.completeDelivery, Delivery.completeDelivery);
    assert.strictEqual(StateAccessFacade.stageOwnedQueueCompletion, Delivery.stageOwnedQueueCompletion);
    assert.strictEqual(StateAccessFacade.beginAppServerForkHandoff, ForkBegin.beginAppServerForkHandoff);
    assert.strictEqual(StateAccessFacade.stageAppServerForkTarget, ForkTarget.stageAppServerForkTarget);
    assert.strictEqual(StateAccessFacade.finalizeAppServerForkHandoff, ForkTarget.finalizeAppServerForkHandoff);
    assert.strictEqual(StateAccessFacade.recordAppServerForkFailure, ForkFailure.recordAppServerForkFailure);
    assert.strictEqual(StateAccessFacade.recordAppServerForkFinalizeFailure, ForkFailure.recordAppServerForkFinalizeFailure);
    assert.strictEqual(StateAccessFacade.recordAndCancelDefiniteForkFailure, ForkFailure.recordAndCancelDefiniteForkFailure);
    assert.strictEqual(StateAccessFacade.completedAppServerForkTargetForSource, ForkCompleted.completedAppServerForkTargetForSource);
    assert.strictEqual(StateAccessFacade.isAppServerManagedTarget, ForkManaged.isAppServerManagedTarget);
    assert.strictEqual(StateAccessFacade.acknowledgeIngress, IngressLifecycle.acknowledgeIngress);
    assert.strictEqual(StateAccessFacade.beginIngressConfirmation, IngressLifecycle.beginIngressConfirmation);
    assert.strictEqual(StateAccessFacade.beginIngressExecution, IngressLifecycle.beginIngressExecution);
    assert.strictEqual(StateAccessFacade.beginIngressThreadStart, IngressLifecycle.beginIngressThreadStart);
    assert.strictEqual(StateAccessFacade.recordIngressCreatedThread, IngressLifecycle.recordIngressCreatedThread);
    assert.strictEqual(StateAccessFacade.recordIngressResult, IngressLifecycle.recordIngressResult);
    assert.strictEqual(StateAccessFacade.confirmIngress, IngressLifecycle.confirmIngress);
    assert.strictEqual(StateAccessFacade.recordIngressProcessingMode, IngressLifecycle.recordIngressProcessingMode);
    assert.strictEqual(StateAccessFacade.admitMappedSlashIngress, IngressAdmission.admitMappedSlashIngress);
    assert.strictEqual(StateAccessFacade.recordIngressNewCreation, IngressLifecycle.recordIngressNewCreation);
    assert.strictEqual(StateAccessFacade.admitBusyInteraction, BusyIngress.admitBusyInteraction);
    assert.strictEqual(StateAccessFacade.holdIngress, IngressRecovery.holdIngress);
    assert.strictEqual(StateAccessFacade.recoverPriorRuntimeIngress, IngressRecovery.recoverPriorRuntimeIngress);
    assert.strictEqual(StateAccessFacade.getIngress, IngressRead.getIngress);
    assert.strictEqual(StateAccessFacade.getIngressForOwnerReadonly, IngressRead.getIngressForOwnerReadonly);
    assert.strictEqual(StateAccessFacade.listIngressesForOwner, IngressRead.listIngressesForOwner);
    assert.strictEqual(StateAccessFacade.claimIngressRecovery, RecoveryCustody.claimIngressRecovery);
    assert.strictEqual(StateAccessFacade.validateIngressRecovery, RecoveryCustody.validateIngressRecovery);
    assert.strictEqual(StateAccessFacade.cancelLatestPending, PendingCancellation.cancelLatestPending);
    assert.strictEqual(StateAccessFacade.cancelForRecovery, RecoveryCancellation.cancelForRecovery);
    assert.strictEqual(StateAccessFacade.beginDeliveryReceipt, DeliveryReceipts.beginDeliveryReceipt);
    assert.strictEqual(StateAccessFacade.confirmDeliveryReceipt, DeliveryReceipts.confirmDeliveryReceipt);
    assert.strictEqual(StateAccessFacade.releaseRejectedDelivery, DeliveryReceipts.releaseRejectedDelivery);
    assert.strictEqual(StateAccessFacade.blockRejectedDelivery, DeliveryReceipts.blockRejectedDelivery);
    assert.strictEqual(StateAccessFacade.unknownDeliveryReceiptCount, DeliveryReceipts.unknownDeliveryReceiptCount);
    assert.strictEqual(StateAccessFacade.blockedDeliveryReceiptCount, DeliveryReceipts.blockedDeliveryReceiptCount);
    assert.strictEqual(StateAccessFacade.newReplyOutputHold, NewReplyClaims.newReplyOutputHold);
    assert.strictEqual(StateAccessFacade.newReplyAcknowledgementSendable, NewReplyClaims.newReplyAcknowledgementSendable);
    assert.strictEqual(StateAccessFacade.releaseNewReplyAcknowledgement, NewReplyClaims.releaseNewReplyAcknowledgement);
    assert.strictEqual(StateAccessFacade.finalDeliveryPreflight, DeliveryPreflight.finalDeliveryPreflight);
    assert.strictEqual(StateAccessFacade.pendingFirstReply, DeliveryPreflight.pendingFirstReply);
    assert.strictEqual(StateAccessFacade.admitIngress, IngressAdmission.admitIngress);
    assert.strictEqual(StateAccessFacade.pendingNewPrompt, NewPromptArm.pendingNewPrompt);
    assert.strictEqual(StateAccessFacade.newThreadOrigin, NewOrigin.newThreadOrigin);
    assert.strictEqual(StateAccessFacade.pendingStopControlsAfter, StopControlRead.pendingStopControlsAfter);
    assert.strictEqual(FacadeExports.pendingStopControlsAfter, StopControlRead.pendingStopControlsAfter);
    assert.strictEqual(StateAccessFacade.stopControlPhase, StopControlRead.stopControlPhase);
    assert.strictEqual(FacadeExports.stopControlPhase, StopControlRead.stopControlPhase);
    assert.strictEqual(StateAccessFacade.acceptRunningStop, StopControlAdmission.acceptRunningStop);
    assert.strictEqual(FacadeExports.acceptRunningStop, StopControlAdmission.acceptRunningStop);
    assert.strictEqual(StateAccessFacade.acceptNonrunningStop, StopAcceptance.acceptNonrunningStop);
    assert.strictEqual(FacadeExports.acceptNonrunningStop, StopAcceptance.acceptNonrunningStop);
    assert.strictEqual(StateAccessFacade.acceptUnresolvedStop, StopAcceptance.acceptUnresolvedStop);
    assert.strictEqual(FacadeExports.acceptUnresolvedStop, StopAcceptance.acceptUnresolvedStop);
    assert.strictEqual(StateAccessFacade.captureStopOrigin, StopRevision.captureStopOrigin);
    assert.strictEqual(StateAccessFacade.mirroredThreadId, MirrorMapping.mirroredThreadId);
    assert.strictEqual(StateAccessFacade.renewPromptIntakeClaimIfCurrent, PromptIntakeLease.renewPromptIntakeClaimIfCurrent);
    assert.strictEqual(StateAccessFacade.promptIntakeHasDurableOwner, PromptIntakeLease.promptIntakeHasDurableOwner);
    assert.strictEqual(StateAccessFacade.admitPromptIntake, PromptIntakeWrite.admitPromptIntake);
    assert.strictEqual(StateAccessFacade.getPromptIntake, PromptIntakeLease.getPromptIntake);
    assert.strictEqual(StateAccessFacade.tryClaimPromptIntake, PromptIntakeLease.tryClaimPromptIntake);
    assert.strictEqual(StateAccessFacade.removePromptIntakeIfQueued, PromptIntakeWrite.removePromptIntakeIfQueued);
    assert.strictEqual(StateAccessFacade.recordPromptIntakeFailureIfClaimed, PromptIntakeLease.recordPromptIntakeFailureIfClaimed);
    assert.strictEqual(StateAccessFacade.listPromptIntakes, PromptIntakeLease.listPromptIntakes);
    assert.strictEqual(StateAccessFacade.executionHoldReason, ExecutionHold.executionHoldReason);
    assert.strictEqual(StateAccessFacade.canonicalizePromptIntakeTarget, PromptIntakeWrite.canonicalizePromptIntakeTarget);
    assert.strictEqual(StateAccessFacade.promotePromptIntakeToQueue, PromptIntakePromotion.promotePromptIntakeToQueue);
    assert.strictEqual(StateAccessFacade.enqueue, QueueEnqueue.enqueue);
    assert.strictEqual(
      StateAccessFacade.enqueueIfMirrorMatches,
      QueueEnqueue.enqueueIfMirrorMatches,
    );
    assert.strictEqual(
      StateAccessFacade.enqueueInTransaction,
      QueueEnqueue.enqueueInTransaction,
    );
    assert.strictEqual(StateAccessFacade.markRunning, QueueMarkRunning.markRunning);
    assert.strictEqual(StateAccessFacade.activate, MutationAttempt.activate);
    assert.strictEqual(StateAccessFacade.beginChecked, MutationAttempt.beginChecked);
    assert.strictEqual(StateAccessFacade.finish, MutationAttempt.finish);
    assert.strictEqual(StateAccessFacade.openCheckedRead, CheckedRead.open);
    assert.strictEqual(StateAccessFacade.asyncAdmissionHeld, AsyncAdmission.asyncResolutionAdmissionHeld);
    assert.strictEqual(StateAccessFacade.asyncTargetDispatchHeld, AsyncAdmission.asyncQuestionTargetDispatchHeld);
    assert.strictEqual(StateAccessFacade.listFiltered, QueueRead.listFiltered);
    assert.strictEqual(StateAccessFacade.eligibleJobs, ExecutionHold.eligibleJobs);
    assert.strictEqual(StateAccessFacade.holdStartingForAmbiguousCandidatesIfClaimed, QueueClaims.holdStartingForAmbiguousCandidatesIfClaimed);
    assert.strictEqual(StateAccessFacade.tryBeginAttempt, QueueClaims.tryBeginAttempt);
    assert.strictEqual(StateAccessFacade.recordStartFailureIfClaimed, QueueClaims.recordStartFailureIfClaimed);
    assert.strictEqual(StateAccessFacade.markRunningIfClaimed, QueueClaims.markRunningIfClaimed);
    assert.strictEqual(StateAccessFacade.markRunningWithResidentIfClaimed, QueueClaims.markRunningWithResidentIfClaimed);
    assert.strictEqual(StateAccessFacade.activateDeadGenerationRuntime, DeadCapture.activateDeadGenerationRuntime);
    assert.strictEqual(StateAccessFacade.captureDeadGeneration, DeadCapture.captureDeadGeneration);
    assert.strictEqual(StateAccessFacade.captureResponseCustody, ResponseCustody.captureResponseCustody);
    assert.strictEqual(StateAccessFacade.beginResponseCustody, ResponseCustody.beginResponseCustody);
    assert.strictEqual(StateAccessFacade.finishResponseCustody, ResponseCustody.finishResponseCustody);
    assert.strictEqual(StateAccessFacade.checkResponseCustody, ResponseCustody.checkResponseCustody);
    assert.strictEqual(StateAccessFacade.checkAllResponseCustody, ResponseCustody.checkAllResponseCustody);
    assert.strictEqual(StateAccessFacade.validateQueueStartAuthorityIn, QueueStartAuthority.validateQueueStartAuthorityIn);
    assert.strictEqual(StateAccessFacade.validateStopRequestIn, StopRevision.validateStopRequestIn);
    assert.strictEqual(StateAccessFacade.checkMutationCustody, MutationAttempt.check);
    assert.strictEqual(StateAccessFacade.requireResponseUnheldIn, ResponseCustody.requireResponseUnheldIn);
    assert.strictEqual(StateAccessFacade.requireAllResponsesResolvedIn, ResponseCustody.requireAllResponsesResolvedIn);
    assert.strictEqual(StateAccessFacade.requireStopControlUnheldIn, RuntimeFenceReads.requireStopControlUnheldIn);
    assert.strictEqual(StateAccessFacade.stopControlTargetHeldExisting, RuntimeFenceReads.stopControlTargetHeldExisting);
    assert.strictEqual(StateAccessFacade.deadGenerationTargetHeldExisting, RuntimeFenceReads.deadGenerationTargetHeldExisting);
    assert.strictEqual(StateAccessFacade.deadGenerationSealedExisting, RuntimeFenceReads.deadGenerationSealedExisting);
    assert.strictEqual(StateAccessFacade.claimStopControl, StopDispatch.claimStopControl);
    assert.strictEqual(StateAccessFacade.validateStopClaimIn, StopDispatch.validateStopClaimIn);
    assert.strictEqual(StateAccessFacade.beginStopWire, StopDispatch.beginStopWire);
    assert.strictEqual(StateAccessFacade.finishStopWire, StopDispatch.finishStopWire);
    assert.strictEqual(StateAccessFacade.recordStopControlError, StopDispatch.recordStopControlError);
    assert.strictEqual(StateAccessFacade.captureDeadGenerationExisting, DeadCapture.captureDeadGenerationExisting);
    assert.strictEqual(StateAccessFacade.guardAsyncMutationIn, AsyncGuards.guardAsyncMutationIn);
    assert.strictEqual(StateAccessFacade.certifiedAsyncSuccessorIn, AsyncGuards.certifiedAsyncSuccessorIn);
    assert.strictEqual(StateAccessFacade.sealAsyncQuestionIn, QuestionGuard.sealAsyncQuestionIn);
    assert.strictEqual(StateAccessFacade.verifyAsyncQuestionIdentityIn, QuestionGuard.verifyAsyncQuestionIdentityIn);
    assert.strictEqual(StateAccessFacade.validateAsyncDispatchGuardsIn, QuestionGuard.validateAsyncDispatchGuardsIn);
    assert.strictEqual(StateAccessFacade.validateAsyncDispatchGuardsExisting, QuestionGuard.validateAsyncDispatchGuardsExisting);
    assert.strictEqual(StateAccessFacade.validateAsyncDispatchGuards, QuestionGuard.validateAsyncDispatchGuards);
    assert.strictEqual(StateAccessFacade.activateObservationExisting, ObservationLedger.activateObservationExisting);
    assert.strictEqual(StateAccessFacade.discoverObservationExisting, ObservationLedger.discoverObservationExisting);
    assert.strictEqual(StateAccessFacade.markUnknownObservationExisting, ObservationLedger.markUnknownObservationExisting);
    assert.strictEqual(StateAccessFacade.observationScopeVerifiedExisting, ObservationLedger.observationScopeVerifiedExisting);
    assert.strictEqual(StateAccessFacade.getIdleIntentExisting, IdleReleaseStore.getIdleIntentExisting);
    assert.strictEqual(StateAccessFacade.pendingIdleIntentsExisting, IdleReleaseStore.pendingIdleIntentsExisting);
    assert.strictEqual(StateAccessFacade.beforeIdleMutationExisting, IdleReleaseStore.beforeIdleMutationExisting);
    assert.strictEqual(StateAccessFacade.transitionIdleIntentExisting, IdleReleaseStore.transitionIdleIntentExisting);
    assert.strictEqual(StateAccessFacade.verifyIdleIntentWithObservationsExisting, IdleReleaseStore.verifyIdleIntentWithObservationsExisting);
    assert.strictEqual(StateAccessFacade.settleExitedIdleOwnerExisting, IdleReleaseStore.settleExitedIdleOwnerExisting);
    assert.strictEqual(StateAccessFacade.deadTargetHeld, DeadGeneration.targetIsHeld);
    assert.strictEqual(StateAccessFacade.recordPreflightFailure, Preflight.recordPreflightFailure);
  });

  it("exposes exact direct function references via named whole-function aliases", () => {
    assert.strictEqual(enqueue, QueueEnqueue.enqueue);
    assert.strictEqual(
      enqueueIfMirrorMatches,
      QueueEnqueue.enqueueIfMirrorMatches,
    );
    assert.strictEqual(
      enqueueInTransaction,
      QueueEnqueue.enqueueInTransaction,
    );
    assert.strictEqual(markRunning, QueueMarkRunning.markRunning);
    assert.strictEqual(activate, MutationAttempt.activate);
    assert.strictEqual(beginChecked, MutationAttempt.beginChecked);
    assert.strictEqual(finish, MutationAttempt.finish);
    assert.strictEqual(openCheckedRead, CheckedRead.open);
  });

  it("contains only the supplied writes, checked reads, async admission and observation ledger APIs", () => {
    const expected = [
      "getIdleIntent",
      "pendingIdleIntents",
      "beforeIdleMutation",
      "transitionIdleIntent",
      "verifyIdleIntent",
      "verifyIdleIntentWithObservations",
      "settleExitedIdleOwner",

      "certifyObservation",
      "finishObservationPage",

      "activateObservation",
      "discoverObservation",
      "markUnknownObservation",
      "nextObservationGap",
      "observationScopeVerified",

      "loadCompletionPayload",
      "readCompletionMetadataRound",
      "completionPage", "completionHeadsForTarget",
      "pendingStartNotices", "completeStartNotice",
      "stageCommentary", "pendingCommentary", "hasPendingCommentary", "completeCommentary",
      "activate",
      "admitPromptIntake",
      "adoptTargetGeneration",
      "asyncAdmissionHeld",
      "asyncTargetDispatchHeld",
      "attachGoalTurnObservedIfOwned",
      "beginAppServerForkHandoff",
      "beginChecked",
      "canonicalizePromptIntakeTarget",
      "captureAsyncHistorySnapshot",
      "captureTerminalHistorySnapshot",
      "completeDelivery",
      "completeGoalProgress",
      "completedAppServerForkTargetForSource",
      "activateDeadGenerationRuntime",
      "captureDeadGeneration",
      "captureResponseCustody",
      "beginResponseCustody",
      "finishResponseCustody",
      "checkResponseCustody",
      "checkAllResponseCustody",
      "validateQueueStartAuthorityIn",
      "validateStopRequestIn",
      "checkMutationCustody",
      "requireResponseUnheldIn",
      "requireAllResponsesResolvedIn",
      "requireStopControlUnheldIn",
      "stopControlTargetHeldExisting",
      "deadGenerationTargetHeldExisting",
      "deadGenerationSealedExisting",
      "claimStopControl",
      "validateStopClaimIn",
      "beginStopWire",
      "finishStopWire",
      "recordStopControlError",
      "captureDeadGenerationExisting",
      "guardAsyncMutationIn",
      "certifiedAsyncSuccessorIn",
      "sealAsyncQuestionIn",
      "verifyAsyncQuestionIdentityIn",
      "validateAsyncDispatchGuardsIn",
      "validateAsyncDispatchGuardsExisting",
      "validateAsyncDispatchGuards",
      "activateObservationExisting",
      "discoverObservationExisting",
      "markUnknownObservationExisting",
      "observationScopeVerifiedExisting",
      "getIdleIntentExisting",
      "pendingIdleIntentsExisting",
      "beforeIdleMutationExisting",
      "transitionIdleIntentExisting",
      "verifyIdleIntentWithObservationsExisting",
      "settleExitedIdleOwnerExisting",
      "deadTargetHeld",
      "eligibleJobs",
      "enqueue",
      "enqueueIfMirrorMatches",
      "enqueueInTransaction",
      "executionHoldReason",
      "finalizeAppServerForkHandoff",
      "finish",
      "finishObservedCompletion",
      "getPromptIntake",
      "hasObservedCompletion",
      "hasPendingGoalProgress",
      "holdStartingForAmbiguousCandidatesIfClaimed",
      "isAppServerManagedTarget",
      "listFiltered",
      "listPendingDeliveries",
      "listPromptIntakes",
      "markGoalWaiting",
      "markRunning",
      "markRunningIfClaimed",
      "markRunningWithResidentIfClaimed",
      "mirroredThreadId",
      "newThreadOrigin",
      "acknowledgeIngress",
      "beginIngressConfirmation",
      "beginIngressExecution",
      "beginIngressThreadStart",
      "recordIngressCreatedThread",
      "recordIngressResult",
      "confirmIngress",
      "recordIngressProcessingMode",
      "admitMappedSlashIngress",
      "recordIngressNewCreation",
      "admitBusyInteraction",
      "holdIngress",
      "recoverPriorRuntimeIngress",
      "getIngress",
      "getIngressForOwnerReadonly",
      "listIngressesForOwner",
      "claimIngressRecovery",
      "validateIngressRecovery",
      "cancelLatestPending",
      "cancelForRecovery",
      "beginDeliveryReceipt",
      "confirmDeliveryReceipt",
      "releaseRejectedDelivery",
      "blockRejectedDelivery",
      "unknownDeliveryReceiptCount",
      "blockedDeliveryReceiptCount",
      "newReplyOutputHold",
      "newReplyAcknowledgementSendable",
      "releaseNewReplyAcknowledgement",
      "finalDeliveryPreflight",
      "pendingFirstReply",
      "admitIngress",
      "pendingNewPrompt",
      "pendingStopControlsAfter",
      "stopControlPhase",
      "acceptRunningStop",
      "acceptNonrunningStop",
      "acceptUnresolvedStop",
      "captureStopOrigin",
      "openCheckedRead",
      "pendingGoalProgress",
      "recordAsyncQuestionObservation",
      "reconcileAsyncQuestionObservations",
      "observeAsyncQuestion",
      "retireOldAsyncQuestionOwner",
      "supersedeAsyncQuestions",
      "compactTerminalAsyncQuestions",
      "getAsyncQuestion",
      "pendingAsyncQuestions",
      "confirmAsyncQuestionOwner",
      "requireCurrentAsyncQuestionMapping",
      "bindAsyncQuestionReceipt",
      "recordObservedFinalAnswer",
      "getObservedFinalAnswer",
      "hasObservedCompletionResidentEvidence",
      "pendingObservedCompletions",
      "promotePromptIntakeToQueue",
      "promptIntakeHasDurableOwner",
      "recordAndCancelDefiniteForkFailure",
      "recordAppServerForkFailure",
      "recordAppServerForkFinalizeFailure",
      "recordDeliveryFailure",
      "recordGoalProgressError",
      "recordObservedCompletionError",
      "recordObservedCompletionForResident",
      "recordPreflightFailure",
      "recordPromptIntakeFailureIfClaimed",
      "recordStartFailureIfClaimed",
      "removePromptIntakeIfQueued",
      "renewPromptIntakeClaimIfCurrent",
      "repairLegacyDefiniteForkFailures",
      "retainAsyncHistoryCandidate",
      "retireCopyOnlyHandoffs",
      "settleTerminalHistory",
      "stageAppServerForkTarget",
      "stageOwnedGoalProgress",
      "stageOwnedQueueCompletion",
      "tryBeginAttempt",
      "tryClaimPromptIntake",
      "unresolvedAppServerForkHandoffForSource",
    ];
    const actual = Object.keys(StateAccessFacade).sort();
    assert.deepStrictEqual(actual, expected.sort());
    assert.strictEqual(actual.length, 180);
  });

  it("does not expose unsupplied readPendingAuthority on the facade", () => {
    assert.strictEqual("readPendingAuthority" in StateAccessFacade, false);
  });

  it("does not apply new freezes to StateAccessFacade", () => {
    assert.strictEqual(Object.isFrozen(StateAccessFacade), false);
  });
});

describe("StateAccessFacade type signature fidelity (compile-time)", () => {
  it("preserves exact whole-function types matching adapter functions", () => {
    type AssertEqual<T, U> = [T] extends [U]
      ? [U] extends [T]
        ? true
        : false
      : false;

    const eq1: AssertEqual<typeof StateAccessFacade.enqueue, typeof QueueEnqueue.enqueue> = true;
    const eq2: AssertEqual<typeof StateAccessFacade.enqueueIfMirrorMatches, typeof QueueEnqueue.enqueueIfMirrorMatches> = true;
    const eq3: AssertEqual<typeof StateAccessFacade.enqueueInTransaction, typeof QueueEnqueue.enqueueInTransaction> = true;
    const eq4: AssertEqual<typeof StateAccessFacade.markRunning, typeof QueueMarkRunning.markRunning> = true;
    const eq5: AssertEqual<typeof StateAccessFacade.activate, typeof MutationAttempt.activate> = true;
    const eq6: AssertEqual<typeof StateAccessFacade.beginChecked, typeof MutationAttempt.beginChecked> = true;
    const eq7: AssertEqual<typeof StateAccessFacade.finish, typeof MutationAttempt.finish> = true;
    const eq8: AssertEqual<typeof StateAccessFacade.openCheckedRead, typeof CheckedRead.open> = true;

    assert.strictEqual(eq1, true);
    assert.strictEqual(eq2, true);
    assert.strictEqual(eq3, true);
    assert.strictEqual(eq4, true);
    assert.strictEqual(eq5, true);
    assert.strictEqual(eq6, true);
    assert.strictEqual(eq7, true);
    assert.strictEqual(eq8, true);
  });

  it("strictly conforms to IStateAccessFacade interface", () => {
    const facade: IStateAccessFacade = StateAccessFacade;
    assert.strictEqual(typeof facade.enqueue, "function");
    assert.strictEqual(typeof facade.enqueueIfMirrorMatches, "function");
    assert.strictEqual(typeof facade.enqueueInTransaction, "function");
    assert.strictEqual(typeof facade.markRunning, "function");
    assert.strictEqual(typeof facade.activate, "function");
    assert.strictEqual(typeof facade.beginChecked, "function");
    assert.strictEqual(typeof facade.finish, "function");
    assert.strictEqual(typeof facade.openCheckedRead, "function");
  });

  it("documents bounded review scope without overclaiming runtime integration", () => {
    // Note: Identity and signature fidelity only; no databases, live transactions, or data mutations invoked.
    assert.strictEqual(typeof StateAccessFacade, "object");
  });
});
