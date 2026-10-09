import {types} from 'node:util';
import {StateAccessFacade as state} from '../store/state-access-facade.ts';
import {now as systemNow} from '../store/queue-attach-goal.ts';
import {requireDiscordText} from '../discord/text.ts';
import {passiveErrorText} from '../core/passive-error-text.ts';
import {readCustodyTimestamp} from './discord-dispatch/staged-custody.ts';
const hold = state.holdIngress, token = Symbol('CleanupNotificationFailure');
const stages = Object.freeze({delivery: 'notification delivery unconfirmed',
  confirmation: 'notification delivery confirmed; ingress confirmation write failed'});
export interface CleanupNotificationFailureInfo {
  readonly stage: string; readonly source: unknown; readonly holdStatus: string;
  readonly holdError: unknown; readonly holdSaved: boolean;
}
const known = new WeakMap<object, Readonly<CleanupNotificationFailureInfo>>();
export class CleanupNotificationFailure extends Error {
  constructor(secret: symbol, info: CleanupNotificationFailureInfo) {
    if (secret !== token) throw new TypeError('Expected recorded notification boundary');
    super(`known mirror refusal saved; ${info.stage}: ${passiveErrorText(info.source, 'notification failed')}; hold persistence: ${info.holdStatus}`, {cause: info.source});
    this.name = 'CleanupNotificationFailure'; known.set(this, Object.freeze({...info})); Object.freeze(this);
  }
}
export function cleanupNotificationFailureInfo(value: unknown): Readonly<CleanupNotificationFailureInfo> | null {
  return value !== null && (typeof value === 'object' || typeof value === 'function') ? known.get(value) ?? null : null;
}
/** PRECONDITION: caller already persisted a validated known cleanup refusal.
 * This is an error boundary, not a capability proving refusal or permission.
 * The original error survives secondary clock/hold failure. */
export async function recordCleanupNotificationFailure(database: string, ingressId: string,
  kind: 'delivery' | 'confirmation', source: unknown, now: () => number = systemNow): Promise<CleanupNotificationFailure> {
  requireDiscordText(database); requireDiscordText(ingressId);
  if (kind !== 'delivery' && kind !== 'confirmation') throw new TypeError('Expected notification boundary');
  if (typeof now !== 'function' || types.isProxy(now) || types.isAsyncFunction(now) || types.isGeneratorFunction(now)) throw new TypeError('Expected synchronous notification clock');
  const stage = stages[kind]; let holdStatus = 'saved', holdError: unknown, holdSaved = true;
  try {await hold(database, ingressId, stage, false, readCustodyTimestamp(now));}
  catch (error) {holdError = error; holdSaved = false; holdStatus = passiveErrorText(error, 'hold persistence failed');}
  return new CleanupNotificationFailure(token, {stage, source, holdStatus, holdError, holdSaved});
}
