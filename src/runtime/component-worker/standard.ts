import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {PortableResidentLifecycle} from '../../app-server/portable-resident-lifecycle.ts';
import {ServerRequestOccurrence} from '../../protocol/ids.ts';
import {type ComponentId, persistentComponentClaimKey} from '../../discord/components.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {gatewayOwnField} from '../../discord/gateway/values.ts';
import type {InboundInteractionWork} from '../discord-dispatch/interaction-work.ts';
import {snapshotComponentId} from '../discord-dispatch/delivery-identity.ts';
import {readCustodyTimestamp} from '../discord-dispatch/staged-custody.ts';
import {now as systemNow} from '../../store/queue-attach-goal.ts';
import {passiveErrorText} from '../../core/passive-error-text.ts';
import {verifyPromptAuthority} from '../server-prompt-authority.ts';
import {prepareComponentResponse} from './response.ts';
import {ComponentWorkerError} from './errors.ts';
import {retainOrReleaseComponentClaim} from './claim-failure.ts';
import {claimStandardAction, standardConfirmationPlan, standardReadyMarker, recordConfirmationReady, ConfirmationError, type ConfirmationPlan} from './confirmation.ts';
const ttl = 1800;
function id(value: unknown): asserts value is bigint {if (typeof value !== 'bigint' || value <= 0n || value >= 1n << 64n) throw new TypeError('Expected nonzero Discord identity');}
function recovery(error: unknown): ComponentWorkerError {return new ComponentWorkerError('Confirmation', new ConfirmationError('Recovery', passiveErrorText(error, 'confirmation recovery failed'), error));}
/** Bound approval/input branch only. Caller routes Busy, AsyncChoice and recovery
 * components separately and owns processing-mode/execution-custody admission. */
export async function prepareStandardComponentAction(work: Pick<InboundInteractionWork, 'sourceMessageId' | 'userId' | 'channelId'>,
  input: ComponentId, database: string, server: PortableResidentLifecycle, now: () => number = systemNow): Promise<ConfirmationPlan> {
  requireDiscordText(database); const component = snapshotComponentId(input);
  if ('Busy' in component) throw new ComponentWorkerError('BusyChoice');
  const message = gatewayOwnField(work, 'sourceMessageId'); if (message === null) throw new ComponentWorkerError('MissingSourceMessage'); id(message);
  if ('Approval' in component || 'Input' in component) throw new ComponentWorkerError('LegacyComponentExpired');
  if (!('BoundApproval' in component) && !('BoundInput' in component)) throw new ComponentWorkerError('InvalidComponent');
  const user = gatewayOwnField(work, 'userId'), channel = gatewayOwnField(work, 'channelId'); id(user); id(channel);
  const key = persistentComponentClaimKey(message, component); if (key === null) throw new ComponentWorkerError('InvalidComponent');
  const claimId = `actor-v1:${key}:${user}:${channel}`, plan = standardConfirmationPlan(component, claimId), marker = standardReadyMarker(claimId);
  let claimed: Awaited<ReturnType<typeof claimStandardAction>>;
  try {claimed = await claimStandardAction(database, claimId, marker, readCustodyTimestamp(now), ttl);}
  catch (error) {throw new ComponentWorkerError('Store', error);}
  if (claimed === 'DeliverConfirmation') return plan;
  if (claimed === 'ActionUnconfirmed') throw new ComponentWorkerError('ActionUnconfirmed');
  let response: ReturnType<typeof prepareComponentResponse>;
  const release = async () => {try {await state.releaseComponentClaim(database, claimId);} catch (error) {throw new ComponentWorkerError('Store', error);}};
  try {response = prepareComponentResponse(component, server);} catch (error) {await release(); throw error;}
  try {
    let requests;
    try {requests = PortableResidentLifecycle.prototype.pendingServerRequests.call(server, null);} catch (error) {throw new ComponentWorkerError('AppServer', error);}
    const occurrence = ServerRequestOccurrence.prototype.asBytes.call(response.occurrence);
    const request = requests.find(r => r.id === response.requestId && Buffer.compare(ServerRequestOccurrence.prototype.asBytes.call(r.occurrence), occurrence) === 0);
    if (request === undefined) throw new ComponentWorkerError('NoPendingRequest');
    try {const authority = await verifyPromptAuthority(database, server, request, response.generation); authority.requireActor(channel, user);}
    catch (error) {throw new ComponentWorkerError('Authority', error);}
  } catch (error) {await release(); throw error;}
  try {await PortableResidentLifecycle.prototype.respond.call(server, response.requestId, response.occurrence, response.payload, response.generation);}
  catch (error) {
    let disposition;
    try {disposition = await retainOrReleaseComponentClaim(database, claimId, error);} catch (storeError) {throw new ComponentWorkerError('Store', storeError);}
    if (disposition === 'RetainIndeterminate') throw new ComponentWorkerError('ActionOutcomeIndeterminate', passiveErrorText(error, 'app-server response outcome unknown'));
    throw new ComponentWorkerError('AppServer', error);
  }
  try {await recordConfirmationReady(database, marker, readCustodyTimestamp(now), ttl);} catch (error) {throw recovery(error);}
  return plan;
}
