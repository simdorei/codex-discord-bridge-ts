import {realpath} from 'node:fs/promises';
import {types} from 'node:util';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {StoreIntegrityError} from '../../store/schema-assembly.ts';
import {cleanupRefusalFromOutcome} from '../../store/async-resolution-cleanup-refusal.ts';
import {getOwn} from '../../store/async-resolution-json-helpers.ts';
import {serializeSerdeValue} from '../../core/serde-json.ts';
import {parseSerdeValue} from '../../core/serde-json-parse.ts';
import {serdeValueEqual} from '../../core/serde-value-equal.ts';
import {invokeSynchronousVoid} from '../../core/synchronous-void.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {isRoutedInteractionWork} from '../../discord/interaction-routing.ts';
import {gatewayOwnField} from '../../discord/gateway/values.ts';
import {now as systemNow} from '../../store/queue-attach-goal.ts';
import {readCustodyTimestamp} from '../discord-dispatch/staged-custody.ts';
import type {InboundInteractionWork} from '../discord-dispatch/interaction-work.ts';
const beginExecution = state.beginIngressExecution, beginConfirmation = state.beginIngressConfirmation;
const read = state.getIngress, record = state.recordIngressResult, confirm = state.confirmIngress, hold = state.holdIngress;
const token = Symbol('ExecutionCustody');
export interface ExecutionCustodyOptions {
  readonly now?: () => number;
  readonly report: (value: {readonly code: 'interaction_processing_cancel_hold_clock_failed' | 'interaction_processing_cancel_hold_failed'; readonly error: unknown}) => void;
}
/** Explicit async owner for source ExecutionCustody durable transitions. Caller
 * must await dispose on every path, and must retain its queue admission permit
 * until cleanup finishes. NotificationFailure conversion belongs to the future
 * worker notification adapter; finishSuccess here exposes the original error. */
export class ExecutionCustody {
  readonly #database: string; readonly #id: string;
  readonly #now: () => number; readonly #report: ExecutionCustodyOptions['report'];
  #recorded = false; #knownRefusal = false; #armed = true; #closing = false;
  #pending: Promise<unknown> | null = null; #dispose: Promise<void> | null = null;
  constructor(secret: symbol, database: string, id: string, now: () => number, report: ExecutionCustodyOptions['report']) {
    if (secret !== token) throw new TypeError('Expected begun execution custody');
    this.#database = database; this.#id = id; this.#now = now; this.#report = report; Object.freeze(this);
  }
  static async begin(workerDatabase: string, custodyDatabase: string, ingressId: string,
    mode: InboundInteractionWork['processingMode'], options: ExecutionCustodyOptions): Promise<ExecutionCustody> {
    for (const text of [workerDatabase, custodyDatabase, ingressId]) requireDiscordText(text);
    if (mode !== 'Execute' && mode !== 'ConfirmationOnly') throw new TypeError('Expected interaction processing mode');
    const now = options.now ?? systemNow, report = options.report;
    for (const fn of [now, report]) if (typeof fn !== 'function' || types.isProxy(fn) || types.isAsyncFunction(fn) || types.isGeneratorFunction(fn)) throw new TypeError('Expected synchronous custody callbacks');
    // Preserve two ordered canonicalizations; absent files never initialize here.
    const database = await realpath(workerDatabase), other = await realpath(custodyDatabase);
    if (database !== other) throw new StoreIntegrityError('interaction custody belongs to a different worker database');
    const timestamp = readCustodyTimestamp(now);
    const began = mode === 'Execute' ? await beginExecution(database, ingressId, 'processing', null, timestamp)
      : await beginConfirmation(database, ingressId, timestamp);
    if (!began) throw new StoreIntegrityError(`interaction custody cannot begin ${mode}: ${ingressId}`);
    return new ExecutionCustody(token, database, ingressId, now, report);
  }
  get knownCleanupRefusal(): boolean {return this.#knownRefusal;}
  #operation<T>(run: () => Promise<T>): Promise<T> {
    if (this.#closing || this.#pending !== null) throw new TypeError('Execution custody is closed or already borrowed');
    const pending = Promise.resolve().then(run).finally(() => {this.#pending = null;}); this.#pending = pending; return pending;
  }
  requestRejection(work: InboundInteractionWork): Promise<string | null> {
    const channel = gatewayOwnField(work, 'channelId'), user = gatewayOwnField(work, 'userId'), routed = gatewayOwnField(work, 'work');
    for (const id of [channel, user]) if (typeof id !== 'bigint' || id <= 0n || id >= 1n << 64n) throw new TypeError('Expected interaction identity');
    if (!isRoutedInteractionWork(routed)) throw new TypeError('Expected owned routed work');
    const expected = parseSerdeValue(serializeSerdeValue(routed));
    return this.#operation(async () => {
      const row = await read(this.#database, this.#id);
      if (row === null) throw new StoreIntegrityError('interaction admission record disappeared');
      const rejection = getOwn(row.payload, 'request_rejection');
      if (rejection === undefined || rejection === null) return null;
      if (row.channelId !== channel || row.ownerUserId !== user || !serdeValueEqual(getOwn(row.payload, 'work'), expected)) {
        throw new StoreIntegrityError('rejected interaction envelope identity changed');
      }
      if (typeof rejection !== 'string' || rejection.length === 0) throw new StoreIntegrityError('interaction rejection is malformed');
      return rejection;
    });
  }
  async #record(outcome: unknown): Promise<void> {
    await record(this.#database, this.#id, outcome, readCustodyTimestamp(this.#now));
    this.#recorded = true; this.#knownRefusal = cleanupRefusalFromOutcome(outcome) !== undefined;
  }
  recordResult(outcome: unknown): Promise<void> {
    const snapshot = parseSerdeValue(serializeSerdeValue(outcome));
    return this.#operation(() => this.#record(snapshot));
  }
  finishSuccess(outcome: unknown): Promise<void> {
    const snapshot = parseSerdeValue(serializeSerdeValue(outcome));
    return this.#operation(async () => {
      if (!this.#recorded) await this.#record(snapshot);
      await confirm(this.#database, this.#id, readCustodyTimestamp(this.#now)); this.#armed = false;
    });
  }
  holdFailed(): Promise<void> {
    return this.#operation(async () => {
      if (!this.#recorded) await hold(this.#database, this.#id, 'interaction_processing_failed', false, readCustodyTimestamp(this.#now));
      this.#armed = false;
    });
  }
  dispose(): Promise<void> {
    if (this.#dispose !== null) return this.#dispose;
    this.#closing = true; const pending = this.#pending;
    this.#dispose = (async () => {
      if (pending !== null) {try {await pending;} catch {/* Original caller owns its operation error. */}}
      if (!this.#armed || this.#recorded) return; this.#armed = false;
      let timestamp: number;
      try {timestamp = readCustodyTimestamp(this.#now);}
      catch (error) {invokeSynchronousVoid(this.#report, {}, [{code: 'interaction_processing_cancel_hold_clock_failed', error}]); return;}
      try {await hold(this.#database, this.#id, 'interaction_processing_cancelled', false, timestamp);}
      catch (error) {invokeSynchronousVoid(this.#report, {}, [{code: 'interaction_processing_cancel_hold_failed', error}]);}
    })(); return this.#dispose;
  }
}
Object.freeze(ExecutionCustody.prototype);
