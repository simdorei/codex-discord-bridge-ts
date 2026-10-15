import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import type {ComponentId} from '../../discord/components.ts';
import {snapshotComponentId} from '../discord-dispatch/delivery-identity.ts';
import type {InboundInteractionWork} from '../discord-dispatch/interaction-work.ts';
import {gatewayOwnField} from '../../discord/gateway/values.ts';
import {authorizedBusyChoice, validateBusyChoice} from './busy-preflight.ts';
import {busyConfirmationPlan, busyReadyMarker, confirmationReady, recordConfirmationReady, ConfirmationError, type ConfirmationPlan} from './confirmation.ts';
import {BusyComponentError} from './busy-errors.ts';
import {retainOrReleaseBusyClaim,busyActionClaimFailure} from './claim-failure.ts';
import {NativeBusyClaimOwner,type NativeBusyClaim} from './busy-claim-native.ts';
import {executeBusyAction, type NativeBusySteerServices} from './busy-control.ts';
import {captureSteerOriginAdmission} from '../action-executor/steer-origin-snapshot.ts';
import {BusyQueueExecutor} from '../action-executor/busy-queue.ts';
import type {PortableResidentLifecycle} from '../../app-server/portable-resident-lifecycle.ts';
import type {ControlTurnVerifier} from '../action-executor/control-turn.ts';
import {readCustodyTimestamp} from '../discord-dispatch/staged-custody.ts';
import {now as systemNow} from '../../store/queue-attach-goal.ts';
import {passiveErrorText} from '../../core/passive-error-text.ts';
async function stored<T>(run: () => Promise<T> | T): Promise<T> {try {return await run();} catch (error) {throw new BusyComponentError('Store', error);}}
async function confirmationIfReady(database: string, marker: string, now: number, plan: ConfirmationPlan): Promise<ConfirmationPlan> {
  if (!await stored(() => confirmationReady(database, marker, now))) throw new BusyComponentError('ActionUnconfirmed'); return plan;
}
/** Original pre-ACK choice only. Queue uses atomic intake+receipt without a prior
 * button claim. Other actions retain their claim unless failure is definitely
 * pre-dispatch/rejected. Caller owns ingress custody and subsequent notification. */
export async function handleBusyComponent(work: Pick<InboundInteractionWork, 'authorizedBusyChoice' | 'userId' | 'channelId'> & Partial<Pick<InboundInteractionWork, 'custodyIngressId' | 'interactionId'>>, input: ComponentId,
  database: string, queue: BusyQueueExecutor, server: PortableResidentLifecycle, verifier: ControlTurnVerifier, now: () => number = systemNow, nativeSteer?: NativeBusySteerServices, nativeClaims?: NativeBusyClaimOwner): Promise<ConfirmationPlan> {
  const component = snapshotComponentId(input); if (!('Busy' in component)) throw new BusyComponentError('Missing');
  const {choice_id: choiceId, action} = component.Busy, choice = authorizedBusyChoice(work, choiceId);
  const user = gatewayOwnField(work, 'userId') as bigint, channel = gatewayOwnField(work, 'channelId') as bigint;
  validateBusyChoice(choice, action, user, channel);
  // The click identity is correlation only. The existing busy claim remains the
  // authority; capture before any await and never substitute its prompt message.
  const ingress = nativeSteer === undefined || action !== 'Steer' ? undefined : Object.freeze({...captureSteerOriginAdmission({
    ingressKey: gatewayOwnField(work, 'custodyIngressId') as string, eventId: gatewayOwnField(work, 'interactionId') as bigint, ownerUserId: user,
  }), channelId: channel});
  let at:number;try {at=readCustodyTimestamp(now);} catch(error) {throw new BusyComponentError('Store',error);}
  const plan = busyConfirmationPlan(choiceId), marker = busyReadyMarker(choiceId, user, channel);
  let nativeClaim:NativeBusyClaim|undefined;
  if(nativeClaims!==undefined){
    // Capture routed click and original choice before the first asynchronous step.
    const result=await stored(()=>{NativeBusyClaimOwner.prototype.requireDatabase.call(nativeClaims,database);return NativeBusyClaimOwner.prototype.claim.call(nativeClaims,work as InboundInteractionWork,component,at);});
    if(result.kind==='DeliverConfirmation')return plan;
    if(result.kind==='ActionUnconfirmed'||result.kind==='Missing')throw new BusyComponentError(result.kind);
    if(result.kind==='ExecuteAction')nativeClaim=result.claim;
  }else if (await stored(() => confirmationReady(database, marker, at))) return plan;
  if (action === 'Queue') {
    try {await BusyQueueExecutor.prototype.enqueueBusyChoice.call(queue, choice);} catch (error) {throw new BusyComponentError('Action', error);}
    return plan;
  }
  if(nativeClaims===undefined){
    const current = await stored(() => state.readBusyChoiceState(database, choiceId, at));
    if (current?.claimed) return confirmationIfReady(database, marker, at, plan);
    if (current === null) throw new BusyComponentError('Missing');
    if (!await stored(() => state.claimBusyChoice(database, choiceId, at))) return confirmationIfReady(database, marker, at, plan);
  }
  try {await executeBusyAction(choice, action, server, database, verifier, now, nativeSteer, ingress);}
  catch (error) {
    const disposition=await stored(async()=>{if(nativeClaims===undefined)return retainOrReleaseBusyClaim(database,choiceId,error);const result=busyActionClaimFailure(error);if(result==='Release')await NativeBusyClaimOwner.prototype.release.call(nativeClaims,nativeClaim!);return result;});
    if (disposition === 'RetainIndeterminate') throw new BusyComponentError('ActionOutcomeIndeterminate', passiveErrorText(error, 'busy control outcome unknown'));
    throw error;
  }
  try {if(nativeClaims===undefined)await recordConfirmationReady(database, marker, readCustodyTimestamp(now), 1800);else await NativeBusyClaimOwner.prototype.ready.call(nativeClaims,nativeClaim!,readCustodyTimestamp(now));}
  catch (error) {throw new BusyComponentError('Confirmation', new ConfirmationError('Recovery', passiveErrorText(error, 'busy confirmation recovery failed'), error));}
  return plan;
}
