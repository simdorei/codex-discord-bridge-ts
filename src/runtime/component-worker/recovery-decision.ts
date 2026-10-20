import type {ComponentId} from '../../discord/components.ts';
import type {InboundInteractionWork} from '../discord-dispatch/interaction-work.ts';
import {readCustodyTimestamp} from '../discord-dispatch/staged-custody.ts';
import {ControlTurnVerifier} from '../action-executor/control-turn.ts';
import {NativeRecoveryDecisionOwner,NativeRecoveryDecisionUnknownError} from './recovery-decision-native.ts';
import type {RecoveryDecisionReceipt} from './recovery-decision-native-snapshot.ts';
import {ComponentWorkerError} from './errors.ts';
import {publicationIntentConfirmationPlan,abandonmentConfirmationPlan,type ConfirmationPlan} from './confirmation.ts';
/** Caller retains cloned admission and verified canonical database custody.
 * Each source read remains separate. No write runs until the shared target lock
 * is held and the repeated display and original ingress reads both joined. */
export async function handleNativeRecoveryDecision(work:InboundInteractionWork,component:ComponentId,owner:NativeRecoveryDecisionOwner,verifier:ControlTurnVerifier,now:()=>number):Promise<ConfirmationPlan> {
 try {
  if(work.sourceMessageId===null)throw new ComponentWorkerError('MissingSourceMessage');
  const handle=NativeRecoveryDecisionOwner.prototype.capture.call(owner,work,component);
  // Only a separate invocation with the exact original decoded click and live
  // admission can enter this branch. It never repeats Read/Ingress/Decide or
  // changes gateway duplicate handling, held ingress, or the unknown barrier.
  const recoveryTarget=NativeRecoveryDecisionOwner.prototype.recoveryTarget.call(owner,handle);
  const target=recoveryTarget??(await NativeRecoveryDecisionOwner.prototype.read.call(owner,handle,readCustodyTimestamp(now))).proposal.thread_id;
  const cancel=new AbortController(),timer=setTimeout(()=>cancel.abort(),2000);let lease;
  try{lease=await ControlTurnVerifier.prototype.lock.call(verifier,target,cancel.signal);}
  catch{throw new ComponentWorkerError('RecoveryDecisionHeld','target is busy; no new decision was submitted');}finally{clearTimeout(timer);}
  try{
   let receipt:RecoveryDecisionReceipt;
   if(recoveryTarget!==null){try{const recovered=await NativeRecoveryDecisionOwner.prototype.recover.call(owner,handle);if(recovered===null)throw new Error('Exact original recovery receipt is still unconfirmed');receipt=recovered;}catch(error){throw new ComponentWorkerError('RecoveryDecisionUnconfirmed',error);}}
   else {await NativeRecoveryDecisionOwner.prototype.read.call(owner,handle,readCustodyTimestamp(now));
    await NativeRecoveryDecisionOwner.prototype.ingress.call(owner,handle);
    receipt=await NativeRecoveryDecisionOwner.prototype.decide.call(owner,handle,readCustodyTimestamp(now));}
   if('RecoveryPublicationDecision'in component){if(receipt.decision==='AbandonOnly')throw new TypeError('Crossed recovery decision');return publicationIntentConfirmationPlan(component.RecoveryPublicationDecision.proposal_id,component.RecoveryPublicationDecision.revision,receipt.decision);}
   if('RecoveryAbandonDecision'in component){if(receipt.decision==='ApproveExact')throw new TypeError('Crossed recovery decision');return abandonmentConfirmationPlan(component.RecoveryAbandonDecision.proposal_id,component.RecoveryAbandonDecision.revision,receipt.decision);}
   throw new ComponentWorkerError('InvalidComponent');
  }finally{lease.release();}
 }catch(error){if(error instanceof NativeRecoveryDecisionUnknownError)throw new ComponentWorkerError('RecoveryDecisionUnconfirmed',error);throw error;}
}
