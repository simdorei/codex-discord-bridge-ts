import {types} from 'node:util';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {StoreIntegrityError} from '../../store/schema-assembly.ts';
import {snapshotBusyChoice, busyChoiceDataField, type BusyChoice} from '../../store/busy-choice.ts';
import type {IngressAdmission} from '../../store/ingress-admission.ts';
import {now as systemNow} from '../../store/queue-attach-goal.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {invokeSynchronousVoid} from '../../core/synchronous-void.ts';

export interface InteractionCustodyReceipt {
  readonly database: string;
  readonly ingressId: string;
  readonly busyChoice: Readonly<BusyChoice> | null;
}
export interface CustodyCleanupReport {
  readonly code: 'interaction_custody_cancel_hold_clock_failed' | 'interaction_custody_cancel_hold_failed';
  readonly error: unknown;
}
export interface CustodyOptions {
  readonly now?: () => number;
  readonly report: (value: CustodyCleanupReport) => void;
}
export type InteractionCustodyStage =
  | {readonly kind: 'Created'; readonly custody: StagedInteractionCustody}
  | {readonly kind: 'Duplicate'}
  | {readonly kind: 'CanonicalRepeat'; readonly receipt: InteractionCustodyReceipt; readonly confirmationReady: boolean};

const token = Symbol('StagedInteractionCustody');
const acknowledge = state.acknowledgeIngress, hold = state.holdIngress;
export function readCustodyTimestamp(now: () => number): number {
  const value = now();
  if (types.isPromise(value)) void Promise.prototype.then.call(value, undefined, () => undefined);
  if (!Number.isFinite(value) || value < 0) throw new TypeError('Expected nonnegative finite custody timestamp');
  return value;
}

/** Ownership adapter over an ALREADY successful store admission. The caller
 * still owns exact admission/settings/actor checks. A receipt is not authority
 * to execute; this type deliberately carries no Discord token.
 * Explicit awaited dispose replaces Rust Drop; never abandon its promise. */
export class StagedInteractionCustody {
  readonly #receipt: InteractionCustodyReceipt;
  readonly #now: () => number;
  readonly #report: CustodyOptions['report'];
  #armed = true;
  #closing = false;
  #inFlight: Promise<void> | null = null;
  #dispose: Promise<void> | null = null;

  constructor(secret: symbol, receipt: InteractionCustodyReceipt, options: CustodyOptions) {
    if (secret !== token) throw new TypeError('Expected admitted interaction custody');
    this.#receipt = receipt;
    this.#now = options.now ?? systemNow;
    this.#report = options.report;
    if (typeof this.#now !== 'function' || typeof this.#report !== 'function') throw new TypeError('Expected custody callbacks');
    Object.freeze(this);
  }
  #operation(run: () => Promise<void>): Promise<void> {
    if (this.#closing || this.#inFlight !== null) throw new TypeError('Custody is closed or already borrowed');
    const pending = Promise.resolve().then(run).finally(() => {this.#inFlight = null;});
    this.#inFlight = pending;
    return pending;
  }
  acknowledge(): Promise<void> {
    return this.#operation(async () => {
      if (!await acknowledge(this.#receipt.database, this.#receipt.ingressId, readCustodyTimestamp(this.#now))) {
        throw new StoreIntegrityError('interaction custody acknowledgement is no longer current');
      }
    });
  }
  holdNotExecuted(reason: string): Promise<void> {
    requireDiscordText(reason);
    return this.#operation(async () => {
      await hold(this.#receipt.database, this.#receipt.ingressId, reason, true, readCustodyTimestamp(this.#now));
      this.#armed = false;
    });
  }
  intoReceipt(): InteractionCustodyReceipt {
    if (this.#closing || this.#inFlight !== null) throw new TypeError('Custody is closed or already borrowed');
    this.#closing = true;
    this.#armed = false;
    return this.#receipt;
  }
  dispose(): Promise<void> {
    if (this.#dispose !== null) return this.#dispose;
    if (this.#closing) return Promise.resolve();
    this.#closing = true;
    const pending = this.#inFlight;
    this.#dispose = (async () => {
      // Existing operation errors belong to that operation's caller; cleanup
      // must still attempt the cancellation hold after a failed write.
      if (pending !== null) {try {await pending;} catch {}}
      if (!this.#armed) return;
      this.#armed = false;
      let now: number;
      try {now = readCustodyTimestamp(this.#now);}
      catch (error) {
        invokeSynchronousVoid(this.#report, {}, [Object.freeze({code: 'interaction_custody_cancel_hold_clock_failed', error})]);
        return;
      }
      try {await hold(this.#receipt.database, this.#receipt.ingressId, 'interaction_dispatch_cancelled', true, now);}
      catch (error) {
        invokeSynchronousVoid(this.#report, {}, [Object.freeze({code: 'interaction_custody_cancel_hold_failed', error})]);
      }
    })();
    return this.#dispose;
  }
}
Object.freeze(StagedInteractionCustody.prototype);

/** Mirrors custody::from_admission. It does not run custody::stage or fabricate
 * canonical authorization: its input must be the original store result. */
export function interactionCustodyFromAdmission(
  database: string, admission: IngressAdmission, busy: boolean, options: CustodyOptions,
): InteractionCustodyStage {
  requireDiscordText(database);
  if (typeof busy !== 'boolean') throw new TypeError('Expected busy interaction flag');
  const read = (key: string) => busyChoiceDataField(admission, key);
  const created = read('created');
  if (typeof created !== 'boolean') throw new TypeError('Expected admission created flag');
  if (!created) {
    const repeated = read('canonicalRepeatCreated');
    if (typeof repeated !== 'boolean') throw new TypeError('Expected canonical repeat flag');
    if (!repeated) return Object.freeze({kind: 'Duplicate'});
    if (!busy) throw new StoreIntegrityError('non-busy interaction unexpectedly coalesced by canonical owner');
    const record = read('record');
    if (record === null) throw new StoreIntegrityError('canonical interaction repeat has no durable record');
    const owner = busyChoiceDataField(record, 'ownerKind');
    if (owner !== 'prompt' && owner !== 'ingress') throw new StoreIntegrityError('canonical interaction repeat has no durable owner');
    const choice = read('busyChoice');
    if (choice === null) throw new StoreIntegrityError('canonical interaction repeat has no frozen authorization snapshot');
    const ingressId = busyChoiceDataField(record, 'ingressId'); requireDiscordText(ingressId);
    return Object.freeze({kind: 'CanonicalRepeat', confirmationReady: owner === 'prompt',
      receipt: Object.freeze({database, ingressId, busyChoice: Object.freeze(snapshotBusyChoice(choice as BusyChoice))})});
  }
  const record = read('record');
  if (record === null) throw new StoreIntegrityError('new interaction custody has no durable record');
  const choice = read('busyChoice');
  if (busy !== (choice !== null)) throw new StoreIntegrityError('busy interaction custody has no frozen authorization snapshot');
  const ingressId = busyChoiceDataField(record, 'ingressId'); requireDiscordText(ingressId);
  const receipt = Object.freeze({database, ingressId, busyChoice: choice === null ? null : Object.freeze(snapshotBusyChoice(choice as BusyChoice))});
  return Object.freeze({kind: 'Created', custody: new StagedInteractionCustody(token, receipt, options)});
}
