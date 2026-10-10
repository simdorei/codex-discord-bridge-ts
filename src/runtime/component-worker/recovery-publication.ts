import {realpath} from 'node:fs/promises';
import {AdmissionPermit} from '../../admission/drain-gate.ts';
import type {ComponentId} from '../../discord/components.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {serdeValueEqual} from '../../core/serde-value-equal.ts';
import {serdeField} from '../../app-server/value.ts';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {now as systemNow} from '../../store/queue-attach-goal.ts';
import {ControlTurnVerifier} from '../action-executor/control-turn.ts';
import {snapshotInboundInteractionWork, type InboundInteractionWork} from '../discord-dispatch/interaction-work.ts';
import {snapshotComponentId} from '../discord-dispatch/delivery-identity.ts';
import {readCustodyTimestamp} from '../discord-dispatch/staged-custody.ts';
import {ComponentWorkerError} from './errors.ts';
import {publicationIntentConfirmationPlan, type ConfirmationPlan} from './confirmation.ts';

function invalid(message: string): never {throw new ComponentWorkerError('PublicationConsent', message);}
function sqlId(value: bigint): bigint {
  if (value < 0n || value >= 1n << 63n) throw new ComponentWorkerError('Store', 'Discord ID exceeds SQLite range');
  return value;
}

/** Dedicated intent sink. The caller supplies the SAME shared target-lock owner
 * used by execution. No server, start, replay or publisher API is reachable here.
 * A cloned admission permit pins maintenance custody until all I/O has joined. */
export async function handleRecoveryPublication(input: InboundInteractionWork, componentInput: ComponentId,
  database: string, verifier: ControlTurnVerifier, now: () => number = systemNow): Promise<ConfirmationPlan> {
  requireDiscordText(database);
  const work = snapshotInboundInteractionWork(input), component = snapshotComponentId(componentInput);
  if (!('RecoveryPublicationDecision' in component)) throw new ComponentWorkerError('InvalidComponent');
  if (work.admissionPermit === null || work.processingMode !== 'Execute'
    || !serdeValueEqual(work.work, {Component: component})) return invalid('publication intent has no matching live admission');
  let permit: AdmissionPermit;
  try {permit = AdmissionPermit.prototype.clone.call(work.admissionPermit);}
  catch {return invalid('publication intent has no matching live admission');}
  try {
    if (await realpath(database) !== await realpath(work.custodyDatabase)) return invalid('publication intent custody database changed');
    const {proposal_id: id, revision} = component.RecoveryPublicationDecision;
    const authorized = () => {
      const bound = state.deliveredPublicationProposal(database, id, revision);
      if (work.sourceMessageId === null) throw new ComponentWorkerError('MissingSourceMessage');
      bound.requireActor(sqlId(work.applicationId), sqlId(work.channelId), sqlId(work.userId), sqlId(work.sourceMessageId));
      return bound;
    };
    const before = authorized(), cancel = new AbortController();
    const timer = setTimeout(() => cancel.abort(), 2000);
    let lease;
    try {lease = await ControlTurnVerifier.prototype.lock.call(verifier, before.proposal.thread_id, cancel.signal);}
    catch {return invalid('publication intent target is busy; nothing was started');}
    finally {clearTimeout(timer);}
    try {
      const current = authorized();
      if (before.message_id !== current.message_id || !serdeValueEqual(before.proposal, current.proposal))
        return invalid('publication delivery changed while waiting for target lock');
      const ingress = await state.getIngress(database, work.custodyIngressId);
      if (ingress === null) return invalid('publication intent ingress is missing');
      if (ingress.eventId !== sqlId(work.interactionId) || ingress.applicationId !== sqlId(work.applicationId)
        || ingress.channelId !== sqlId(work.channelId) || ingress.ownerUserId !== sqlId(work.userId)
        || ingress.sourceMessageId !== (work.sourceMessageId === null ? null : sqlId(work.sourceMessageId))
        || ingress.targetThreadId !== current.proposal.thread_id || !serdeValueEqual(serdeField(ingress.payload, 'work'), work.work))
        return invalid('publication intent differs from original durable ingress');
      const receipt = await state.recordPublicationConsent(database, {
        proposal_id: id, revision, ingress_id: work.custodyIngressId, now: readCustodyTimestamp(now),
      });
      return publicationIntentConfirmationPlan(id, revision, receipt.decision);
    } finally {lease.release();}
  } finally {AdmissionPermit.prototype.release.call(permit);}
}
