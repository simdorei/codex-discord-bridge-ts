import {PortableResidentLifecycle} from '../../app-server/portable-resident-lifecycle.ts';
import {steerTurn, interruptTurn} from '../../app-server/requests.ts';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {snapshotBusyChoice, type BusyChoice} from '../../store/busy-choice.ts';
import type {BusyAction} from '../../discord/components.ts';
import {isProCommand} from '../../pro/prompt.ts';
import {ControlTurnVerifier} from '../action-executor/control-turn.ts';
import {ActionThreadSelection} from '../action-executor/thread-selection.ts';
import {InvalidActionRequestError} from '../action-executor/errors.ts';
import {NativeBridgeStateOwner} from '../bridge-state-native.ts';
import {NativeSteerOriginWriter, NativeSteerOriginUnknownError} from '../action-executor/steer-origin-native.ts';
import {captureSteerOriginAdmission, type SteerOriginAdmission} from '../action-executor/steer-origin-snapshot.ts';
import {gatewayOwnField} from '../../discord/gateway/values.ts';
import {NativeBusyClaimOwner, NativeBusyClaimUnknownError, type NativeBusyClaim} from './busy-claim-native.ts';
import {BusyComponentError} from './busy-errors.ts';
import {passiveErrorText} from '../../core/passive-error-text.ts';
import {readCustodyTimestamp} from '../discord-dispatch/staged-custody.ts';
import {now as systemNow} from '../../store/queue-attach-goal.ts';
export interface NativeBusySteerServices {
  readonly writer: NativeSteerOriginWriter; readonly selection: ActionThreadSelection; readonly bridge: NativeBridgeStateOwner;
}
export function captureNativeBusySteerServices(input: NativeBusySteerServices, database: string): NativeBusySteerServices {
  const writer = gatewayOwnField(input, 'writer') as NativeSteerOriginWriter, selection = gatewayOwnField(input, 'selection') as ActionThreadSelection,
    bridge = gatewayOwnField(input, 'bridge') as NativeBridgeStateOwner;
  NativeSteerOriginWriter.prototype.assertPath.call(writer, database); NativeBridgeStateOwner.prototype.path.call(bridge);
  return Object.freeze({writer, selection, bridge});
}
type BusySteerAdmission = SteerOriginAdmission & {readonly channelId: bigint};
async function beforeDispatch<T>(operation: () => Promise<T> | T): Promise<T> {
  try {return await operation();} catch (error) {
    // A submitted origin or resolution may have committed without a control.
    // Never release the claim or record a retry-enabling preflight receipt.
    if (error instanceof NativeSteerOriginUnknownError || error instanceof NativeBusyClaimUnknownError) throw error;
    throw new BusyComponentError('ControlNotDispatched', passiveErrorText(error, 'control preflight failed'));
  }
}
/** Non-Queue busy action only. The caller has claimed the original busy choice
 * and keeps it through uncertainty. Ignore is local; no target is discovered or
 * resumed. Shared ControlTurnVerifier locks serialize exact target controls.
 * Installed Steer shares the ordinary writer's unresolved-origin barrier. */
export async function executeBusyAction(input: BusyChoice, action: BusyAction, server: PortableResidentLifecycle, database: string,
  verifier: ControlTurnVerifier, now: () => number = systemNow, nativeSteer?: NativeBusySteerServices, ingress?: BusySteerAdmission, nativeClaim?: {readonly owner: NativeBusyClaimOwner; readonly claim: NativeBusyClaim}): Promise<void> {
  const choice = snapshotBusyChoice(input);
  if (action === 'Ignore') return;
  if (action !== 'Steer' && action !== 'Stop') throw new TypeError('Queue acceptance belongs to the atomic enqueue branch');
  if (action === 'Steer' && isProCommand(choice.prompt)) throw new BusyComponentError('ControlNotDispatched', 'Pro requests cannot be steered; choose Queue next to run Pro connection checks');
  const thread = choice.targetThreadId; if (thread === null) throw new BusyComponentError('NoTarget');
  // All native dependencies and original actor identity are captured before lock
  // acquisition. Compatibility and Stop retain their original dispatch path.
  const native = action === 'Steer' && nativeSteer !== undefined ? captureNativeBusySteerServices(nativeSteer, database) : undefined;
  const original = native === undefined ? undefined : (() => {
    if (ingress === undefined || gatewayOwnField(ingress, 'channelId') !== choice.channelId) throw new TypeError('Original busy Steer click identity is required');
    const admission = captureSteerOriginAdmission({ingressKey: gatewayOwnField(ingress, 'ingressKey') as string,
      eventId: gatewayOwnField(ingress, 'eventId') as bigint, ownerUserId: gatewayOwnField(ingress, 'ownerUserId') as bigint});
    if (admission.ownerUserId !== choice.ownerUserId) throw new TypeError('Original busy Steer actor changed');
    return admission;
  })();
  const resolution = nativeClaim === undefined ? undefined : Object.freeze({owner: gatewayOwnField(nativeClaim, 'owner') as NativeBusyClaimOwner, claim: gatewayOwnField(nativeClaim, 'claim') as NativeBusyClaim});
  if (resolution !== undefined) NativeBusyClaimOwner.prototype.requireDatabase.call(resolution.owner, database);
  if (native !== undefined) NativeSteerOriginWriter.prototype.assertReady.call(native.writer);
  const lease = await beforeDispatch(() => ControlTurnVerifier.prototype.lock.call(verifier, thread));
  try {
    const expected = await beforeDispatch(() => resolution === undefined ? state.resolveBusyControl(database, choice.choiceId, thread)
      : NativeBusyClaimOwner.prototype.resolve.call(resolution.owner, resolution.claim, choice, action));
    if (expected === null) throw new BusyComponentError('ControlNotDispatched', 'this choice has no confirmed original turn yet; retry when its preceding task starts, or send a new request');
    const channel = await beforeDispatch(() => {if (choice.channelId < 0n) throw new RangeError('out of range integral type conversion attempted'); return choice.channelId;});
    // Detect the route without consulting Selected for a mapped room. Capture an
    // authentic Selected epoch before initial verification and never refresh it.
    const selected = native === undefined ? null : await beforeDispatch(async () => {
      const [target, source] = await ActionThreadSelection.prototype.target.call(native.selection, channel);
      if (target !== thread) throw new InvalidActionRequestError('control target changed; select the current thread again');
      const snapshot = source === 'selected' ? await NativeBridgeStateOwner.prototype.captureSelected.call(native.bridge) : null;
      if (snapshot !== null) NativeBridgeStateOwner.prototype.validateSelected.call(native.bridge, snapshot, thread);
      return snapshot;
    });
    const [turn, generation] = await beforeDispatch(() => ControlTurnVerifier.prototype.control.call(verifier, channel, thread, expected));
    const check = () => {
      if (selected !== null) NativeBridgeStateOwner.prototype.validateSelected.call(native!.bridge, selected, thread);
      const current = PortableResidentLifecycle.prototype.lifecycleSnapshot.call(server);
      if (current.generation !== generation || !current.healthy || current.quarantined || current.restartPending || PortableResidentLifecycle.prototype.activeTurnId.call(server, thread) !== turn)
        throw new InvalidActionRequestError('original busy Steer turn or connection changed; no control was sent');
    };
    if (action === 'Steer') await beforeDispatch(async () => {
      if (native !== undefined) check();
      const at = readCustodyTimestamp(now);
      if (native === undefined) await state.recordUserOrigin(database, thread, turn, choice.prompt, at);
      else {
        await NativeSteerOriginWriter.prototype.execute.call(native.writer, {...original!, channelId: channel, thread, turn, generation, prompt: choice.prompt, now: at});
        const [, currentGeneration] = await ControlTurnVerifier.prototype.control.call(verifier, channel, thread, turn);
        if (currentGeneration !== generation) throw new InvalidActionRequestError('connection changed while recording busy Steer origin; no control was sent');
        check();
      }
    });
    try {
      if (native !== undefined) await PortableResidentLifecycle.prototype.executeSteerControl.call(server, steerTurn(thread, choice.prompt, turn), generation, check);
      else await PortableResidentLifecycle.prototype.execute.call(server, action === 'Steer' ? steerTurn(thread, choice.prompt, turn) : interruptTurn(thread, turn), generation);
    } catch (error) {throw new BusyComponentError('AppServer', error);}
  } finally {lease.release();}
}
