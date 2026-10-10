import {realpath} from 'node:fs/promises';
import {AdmissionPermit} from '../../admission/drain-gate.ts';
import type {ComponentId} from '../../discord/components.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {serdeValueEqual} from '../../core/serde-value-equal.ts';
import {serdeField} from '../../app-server/value.ts';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {now as systemNow} from '../../store/queue-attach-goal.ts';
import {ControlTurnVerifier} from '../action-executor/control-turn.ts';
import {snapshotInboundInteractionWork,type InboundInteractionWork} from '../discord-dispatch/interaction-work.ts';
import {snapshotComponentId} from '../discord-dispatch/delivery-identity.ts';
import {readCustodyTimestamp} from '../discord-dispatch/staged-custody.ts';
import {ComponentWorkerError} from './errors.ts';
import {abandonmentConfirmationPlan,type ConfirmationPlan} from './confirmation.ts';
function invalid(message:string):never {throw new ComponentWorkerError('Abandonment',message);}
function sqlId(value:bigint):bigint {
 if(value<0n||value>=1n<<63n)throw new ComponentWorkerError('Store','Discord ID exceeds SQLite range');return value;
}
/** Dedicated local disposition. No native approval, start or replay API is
 * reachable. The same shared target lock and a cloned admission permit span all
 * awaits and the synchronous atomic store decision. */
export async function handleRecoveryAbandonment(input:InboundInteractionWork,componentInput:ComponentId,database:string,
 verifier:ControlTurnVerifier,now:()=>number=systemNow):Promise<ConfirmationPlan> {
 requireDiscordText(database);const work=snapshotInboundInteractionWork(input),component=snapshotComponentId(componentInput);
 if(!('RecoveryAbandonDecision' in component))throw new ComponentWorkerError('InvalidComponent');
 if(work.admissionPermit===null||work.processingMode!=='Execute'||!serdeValueEqual(work.work,{Component:component})
  ||work.custodyIngressId!==`interaction:${work.interactionId}`)return invalid('no matching live normal admission');
 let permit:AdmissionPermit;try{permit=AdmissionPermit.prototype.clone.call(work.admissionPermit);}catch{return invalid('no matching live normal admission');}
 try{
  if(await realpath(database)!==await realpath(work.custodyDatabase))return invalid('custody database changed');
  const {proposal_id:id,revision,decision}=component.RecoveryAbandonDecision;
  const authorize=()=>{
   if(work.sourceMessageId===null)throw new ComponentWorkerError('MissingSourceMessage');
   return state.authorizeAbandonmentDecision(database,{proposal_id:id,revision,decision,interaction_id:sqlId(work.interactionId),application_id:sqlId(work.applicationId),channel_id:sqlId(work.channelId),owner_user_id:sqlId(work.userId),source_message_id:sqlId(work.sourceMessageId),now:readCustodyTimestamp(now)});
  };
  const before=authorize(),cancel=new AbortController(),timer=setTimeout(()=>cancel.abort(),2000);let lease;
  try{lease=await ControlTurnVerifier.prototype.lock.call(verifier,before.proposal.thread_id,cancel.signal);}
  catch{return invalid('target is busy; no disposition was applied');}finally{clearTimeout(timer);}
  try{
   const current=authorize();if(!serdeValueEqual(current,before))return invalid('displayed proposal changed while waiting');
   const saved=await state.getIngress(database,work.custodyIngressId);if(saved===null)return invalid('original ingress is unavailable');
   if(saved.eventId!==sqlId(work.interactionId)||saved.applicationId!==sqlId(work.applicationId)||saved.channelId!==sqlId(work.channelId)||saved.ownerUserId!==sqlId(work.userId)
    ||saved.sourceMessageId!==(work.sourceMessageId===null?null:sqlId(work.sourceMessageId))||saved.targetThreadId!==current.proposal.thread_id||!serdeValueEqual(serdeField(saved.payload,'work'),work.work))
    return invalid('work differs from original durable ingress');
   const receipt=state.recordAbandonmentDecision(database,{proposal_id:id,revision,ingress_id:work.custodyIngressId,decision,now:readCustodyTimestamp(now)});
   return abandonmentConfirmationPlan(id,revision,receipt.decision);
  }finally{lease.release();}
 }finally{AdmissionPermit.prototype.release.call(permit);}
}
