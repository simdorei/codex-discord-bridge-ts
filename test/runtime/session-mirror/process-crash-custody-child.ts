import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {open, rename, realpath, stat} from 'node:fs/promises';
import {dirname, isAbsolute, join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {serializeSerdeValue} from '../../../src/core/serde-json.ts';
import {DeliveryFailure} from '../../../src/discord/delivery.ts';
import {readBoundMirrorCursor} from '../../../src/store/mirror-cursor-journal.ts';
import {OwnedWorkerSlot, ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
import {CompletionDeliveryError, type DiscordReceiptTransport} from '../../../src/runtime/completion/receipt-sender.ts';
import {mixedMirrorPacketSendPlan, type MixedMirrorPacket} from '../../../src/runtime/session-mirror/all-delivered-packet.ts';
import {pollBoundMirrorTarget} from '../../../src/runtime/session-mirror/bound-poll.ts';
import {activeMirrorFileReads} from '../../../src/runtime/session-mirror/file-window.ts';
import {MirrorBatchExecutionError} from '../../../src/runtime/session-mirror/observed-batch-executor.ts';
import {NativeMirrorReceiptStore} from '../../../src/runtime/session-mirror/receipt-store.ts';
import {discoverMirrorStore} from '../../../src/runtime/session-mirror/store-discovery.ts';

// Frozen before execution. A failure does not permit changing these limits,
// workload, cut placement, expected results, or any production implementation.
export const cuts = ['intent-before-send', 'external-accept-before-confirm', 'confirm-before-cursor'] as const;
export type Cut = typeof cuts[number];
export const limits = Object.freeze({nativeMs: 5_000, bootstrapMs: 10_000,
  childMs: 15_000, terminationMs: 5_000, matrixMs: 180_000, fileBytes: 65_536, maxRequests: 4});
export const options = Object.freeze({
  read: Object.freeze({maxWindowBytes: 4_096, maxRecordBytes: 512, maxRecords: 4, decodeTimeoutMs: limits.nativeMs}),
  ownership: Object.freeze({maxJobs: 32n, maxValueBytes: 1_048_576n, timeoutMs: limits.nativeMs}),
});
export const discoveryLimits = Object.freeze({...options.ownership, maxTargets: 32n, maxOutputBytes: 1_048_576});
export const noHoldings = Object.freeze({Background: 0, Control: 0, Observation: 0, Discovery: 0, Maintenance: 0});
export const FINAL_TURN = 'history-final-turn';
export const firstId = 9_007_199_254_740_993n;
export const messageId = (cut: Cut, seed: boolean) => firstId + BigInt(cuts.indexOf(cut) * 2 + (seed ? 0 : 1));
export function assertJoined(): void {
  assert.deepEqual(ownedWorkerUsage(), noHoldings); assert.equal(activeMirrorFileReads(), 0);
}

/** Fixed-path, bounded, atomic file handshake. Acceptance additionally fsyncs
 * both the complete file and containing directory before returning to transport. */
export async function writeJSON(path: string, value: unknown, durable = false): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(value) + '\n');
  assert.ok(bytes.length <= limits.fileBytes);
  const handle = await open(path + '.tmp', 'wx', 0o600);
  try {await handle.writeFile(bytes); if (durable) await handle.sync();}
  finally {await handle.close();}
  await rename(path + '.tmp', path);
  if (durable) {const directory = await open(dirname(path), 'r'); try {await directory.sync();} finally {await directory.close();}}
}
export async function readJSON(path: string): Promise<unknown | undefined> {
  let handle;
  try {handle = await open(path, 'r');}
  catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error;}
  try {
    const info = await handle.stat(); assert.equal(info.isFile(), true); assert.ok(info.size <= limits.fileBytes);
    const bytes = await handle.readFile(); assert.ok(bytes.length <= limits.fileBytes);
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } finally {await handle.close();}
}
export function readState(path: string) {
  const db = new DatabaseSync(path, {readOnly: true});
  try {
    const cursor = readBoundMirrorCursor(db, 'thread'); assert.ok(cursor);
    return {cursor,
      bound: db.prepare('SELECT * FROM cdr_ts_mirror_cursor_anchors_v1 ORDER BY thread_id').all(),
      legacy: db.prepare('SELECT * FROM codex_session_mirror_offsets ORDER BY codex_thread_id').all(),
      receipts: db.prepare('SELECT * FROM codex_delivery_receipts ORDER BY receipt_key').all(),
      mapping: db.prepare('SELECT * FROM mirror_threads ORDER BY codex_thread_id').all(),
      intents: db.prepare('SELECT * FROM cdr_ts_mirror_startup_intents_v1 ORDER BY thread_id').all(),
    };
  } finally {db.close();}
}
export type State = ReturnType<typeof readState>;
export async function fileIdentity(path: string) {
  const s = await stat(path, {bigint: true});
  assert.equal(s.isFile(), true);
  return {dev: s.dev, ino: s.ino, birthtimeNs: s.birthtimeNs, mtimeNs: s.mtimeNs, ctimeNs: s.ctimeNs, size: s.size};
}
export function assertProgress(before: State, after: State): void {
  assert.deepEqual(after.receipts, before.receipts); assert.deepEqual(after.mapping, before.mapping);
  assert.deepEqual(after.intents, []); assert.equal(after.bound.length, 1); assert.equal(after.legacy.length, 1);
  const old = before.cursor, now = after.cursor;
  assert.equal(old.revision, 2n); assert.equal(old.anchor.offset, 4_352n);
  assert.equal(now.revision, 3n); assert.equal(now.anchor.offset, 4_608n); assert.equal(now.anchor.stamp.size, 4_608n);
  assert.equal(now.turn, FINAL_TURN); assert.equal(now.anchor.path, old.anchor.path);
  for (const key of ['dev', 'ino', 'birthtimeNs'] as const) assert.equal(now.anchor.stamp[key], old.anchor.stamp[key]);
  assert.notEqual(now.operationId, old.operationId);
  // The caller checks the exact target proof separately; readBoundMirrorCursor
  // above also enforces complete bound/legacy consistency, including timestamp.
}
export function receiptProof(row: Record<string, unknown>): string {
  assert.equal(typeof row.receipt_key, 'string'); assert.equal(typeof row.content_hash, 'string');
  return createHash('sha256').update(serializeSerdeValue([[row.receipt_key, row.content_hash]])).digest('hex');
}

type Counters = {native: Record<string, number>; transportEntries: number; beginResults: string[]; confirmEntries: number; confirmTrue: number};
const counters = (): Counters => ({native: {}, transportEntries: 0, beginResults: [], confirmEntries: 0, confirmTrue: 0});
export const calls = (kind: 'unconfirmed' | 'confirmed' | 'eof', confirm = false): Record<string, number> => ({
  'cursor:Read': 1, decode: 1,
  ...(kind === 'eof' ? {} : {ownership: kind === 'confirmed' ? 1 : 2, plan: 1,
    ...(kind === 'unconfirmed' ? {'receipt:Begin': 1} : {'cursor:MixedAdvance': 1}),
    ...(confirm ? {'receipt:Confirm': 1} : {}),
  }),
});
export type ChildPoll = {poll: number; outcome: 'UnknownHeld' | 'ReusedConfirmed' | 'EOF'; error: string | null;
  cause: string | null; innerCause: string | null; deliveryFailure: {part: number; totalParts: number; attempts: number; sourceMatchesCause: boolean} | null;
  authenticNewPacket: boolean; satisfied: number; offset: number; revision: number;
  receiptsUnchanged: boolean; fullStateUnchanged: boolean; counts: Counters;
  nativeHoldings: ReturnType<typeof ownedWorkerUsage>; activeFileReads: number};
export type ChildReport = {outcome: 'parked' | 'passed' | 'failed'; cut: Cut; mode: string; stage: string;
  counts: Counters; polls: ChildPoll[]; nativeHoldings: ReturnType<typeof ownedWorkerUsage>; activeFileReads: number};

async function childMain(): Promise<void> {
  const [root, cutText, mode] = process.argv.slice(2);
  assert.equal(process.version, 'v24.21.0'); assert.equal(process.platform, 'linux');
  assert.ok(root && isAbsolute(root)); assert.equal(await realpath(root), root);
  assert.ok(cuts.includes(cutText as Cut)); assert.ok(mode === 'crash' || mode === 'restart');
  const cut = cutText as Cut, database = join(root, 'store.sqlite'), rollout = join(root, 'rollout.jsonl');
  const file = (name: string) => join(root, `${mode}.${name}.json`);
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(new Error('child safety deadline')), limits.childMs);
  const signal = controller.signal;
  let active: Counters | null = null, last = counters(), stage = 'discovery', outcome: ChildReport['outcome'] = 'failed';
  const polls: ChildPoll[] = [];
  const originalRun = OwnedWorkerSlot.prototype.run, originalBegin = NativeMirrorReceiptStore.prototype.begin,
    originalConfirm = NativeMirrorReceiptStore.prototype.confirm;
  const modules = new Map([
    [new URL('../../../src/runtime/session-mirror/cursor-store-worker.ts', import.meta.url).href, 'cursor'],
    [new URL('../../../src/runtime/session-mirror/decode-worker.ts', import.meta.url).href, 'decode'],
    [new URL('../../../src/runtime/session-mirror/ownership-worker.ts', import.meta.url).href, 'ownership'],
    [new URL('../../../src/runtime/session-mirror/receipt-plan-worker.ts', import.meta.url).href, 'plan'],
    [new URL('../../../src/runtime/session-mirror/receipt-store-worker.ts', import.meta.url).href, 'receipt'],
  ]);
  OwnedWorkerSlot.prototype.run = function (this: OwnedWorkerSlot, url, data, timeout, abort) {
    if (active !== null) {
      const module = modules.get(url.href); assert.ok(module, 'unexpected native submission');
      const kind = data !== null && typeof data === 'object' ? Object.getOwnPropertyDescriptor(data, 'kind')?.value : undefined;
      const key = module + (typeof kind === 'string' ? ':' + kind : '');
      active.native[key] = (active.native[key] ?? 0) + 1;
    }
    return originalRun.call(this, url, data, timeout, abort);
  };
  const report = (): ChildReport => ({outcome, cut, mode, stage, counts: last, polls,
    nativeHoldings: {...ownedWorkerUsage()}, activeFileReads: activeMirrorFileReads()});
  async function park(): Promise<never> {
    stage = 'parked-between-operations'; assertJoined();
    assert.deepEqual(last.native, calls('unconfirmed', cut === 'confirm-before-cursor'));
    assert.deepEqual(last.beginResults, ['New']);
    assert.equal(last.transportEntries, cut === 'intent-before-send' ? 0 : 1);
    assert.equal(last.confirmEntries, cut === 'intent-before-send' ? 0 : 1);
    assert.equal(last.confirmTrue, cut === 'confirm-before-cursor' ? 1 : 0);
    outcome = 'parked'; await writeJSON(file('barrier'), report());
    // A referenced timer keeps this actual process alive. Only the parent owns
    // SIGKILL; there is no signal handler or orderly-shutdown approximation.
    while (true) await delay(20, undefined, {signal});
  }
  NativeMirrorReceiptStore.prototype.begin = async function (this: NativeMirrorReceiptStore, ...args) {
    const result = await originalBegin.apply(this, args);
    active?.beginResults.push(result.kind);
    if (mode === 'crash' && cut === 'intent-before-send') {assert.equal(result.kind, 'New'); await park();}
    return result;
  };
  NativeMirrorReceiptStore.prototype.confirm = async function (this: NativeMirrorReceiptStore, ...args) {
    if (active !== null) active.confirmEntries++;
    assert.equal(args[2], messageId(cut, false).toString());
    if (mode === 'crash' && cut === 'external-accept-before-confirm') await park();
    const result = await originalConfirm.apply(this, args);
    if (active !== null && result) active.confirmTrue++;
    if (mode === 'crash' && cut === 'confirm-before-cursor') {assert.equal(result, true); await park();}
    return result;
  };
  let sequence = 0;
  const transport: DiscordReceiptTransport = {async sendValidated(request) {
    // Count before serialization, file publication, or any request validation.
    assert.ok(active); active.transportEntries++; const entered = ++sequence;
    assert.ok(entered <= limits.maxRequests);
    await writeJSON(file(`request-${entered}`), {sequence: entered, request});
    let response: unknown;
    while ((response = await readJSON(file(`response-${entered}`))) === undefined) await delay(20, undefined, {signal});
    const value = response as {sequence: number; messageId: string};
    assert.equal(value.sequence, entered); assert.equal(value.messageId, messageId(cut, false).toString());
    return BigInt(value.messageId);
  }};
  try {
    const initial = readState(database), identity = await fileIdentity(rollout);
    const seed = initial.receipts.find(row => row.message_id === messageId(cut, true).toString()); assert.ok(seed);
    assert.equal(initial.cursor.anchor.offset, 4_352n); assert.equal(initial.cursor.revision, 2n);
    let previous = initial, previousPacket: MixedMirrorPacket | null = null;
    for (let poll = 1; poll <= (mode === 'crash' ? 1 : 2); poll++) {
      stage = 'discovery'; const snapshot = await discoverMirrorStore(database, discoveryLimits, signal);
      assert.equal(snapshot.jobs.length, 0); assert.equal(snapshot.targets.length, 1); assertJoined();
      active = counters(); last = active; stage = 'poll';
      let result: Awaited<ReturnType<typeof pollBoundMirrorTarget>> | undefined, failure: unknown;
      try {result = await pollBoundMirrorTarget(database, {id: 'thread', rolloutPath: rollout}, 42n, snapshot.jobs, options, transport, signal);}
      catch (error) {failure = error;}
      finally {active = null;}
      assert.equal(mode, 'restart', 'crash child must never finish its selected poll');
      signal.throwIfAborted(); assertJoined(); stage = 'state-verification';
      const state = readState(database); assert.deepEqual(await fileIdentity(rollout), identity);
      assert.deepEqual(state.receipts, initial.receipts); assert.deepEqual(state.mapping, initial.mapping); assert.deepEqual(state.intents, []);
      assert.deepEqual(state.receipts.find(row => row.receipt_key === seed.receipt_key), seed);
      let label: ChildPoll['outcome'], packet = false, error: string | null = null, cause: string | null = null, innerCause: string | null = null;
      let deliveryFailure: ChildPoll['deliveryFailure'] = null;
      if (cut !== 'confirm-before-cursor') {
        assert.equal(result, undefined); assert.ok(failure instanceof MirrorBatchExecutionError);
        assert.equal(failure.constructor, MirrorBatchExecutionError); assert.ok(failure.cause instanceof DeliveryFailure);
        assert.equal(failure.cause.constructor, DeliveryFailure); assert.equal(failure.cause.source, failure.cause.cause);
        deliveryFailure = {part: failure.cause.part, totalParts: failure.cause.totalParts, attempts: failure.cause.attempts, sourceMatchesCause: true};
        assert.deepEqual(deliveryFailure, {part: 1, totalParts: 1, attempts: 1, sourceMatchesCause: true});
        assert.ok(failure.cause.cause instanceof CompletionDeliveryError);
        assert.equal(failure.cause.cause.constructor, CompletionDeliveryError); assert.equal(failure.cause.cause.cause, undefined);
        assert.equal(failure.cause.cause.message, 'Discord final delivery failed: send outcome unknown; held without automatic resend. Inspect !runners and reconcile the Discord message receipt.');
        assert.ok(failure.packet); assert.notEqual(failure.packet, previousPacket);
        if (previousPacket !== null) assert.notEqual(failure.packet.operationId, previousPacket.operationId);
        mixedMirrorPacketSendPlan(failure.packet); // Assert current-process authentic brand, never reconstruct one.
        assert.equal(failure.packet.receipts.length, 1);
        const target: Record<string, unknown> | undefined = initial.receipts.find(row => row.receipt_key !== seed.receipt_key); assert.ok(target);
        assert.deepEqual(failure.packet.receipts, [{key: target.receipt_key, contentHash: target.content_hash}]);
        assert.equal(target.message_id, null); assert.equal(target.retryable, 0); assert.equal(target.blocked_reason, null);
        previousPacket = failure.packet; packet = true; error = 'MirrorBatchExecutionError'; cause = 'DeliveryFailure'; innerCause = 'CompletionDeliveryError';
        assert.deepEqual(state, initial); assert.deepEqual(last.native, calls('unconfirmed'));
        assert.deepEqual(last.beginResults, ['Unknown']); label = 'UnknownHeld';
      } else {
        assert.equal(failure, undefined); assert.ok(result);
        assert.deepEqual(last.native, calls(poll === 1 ? 'confirmed' : 'eof')); assert.deepEqual(last.beginResults, []);
        assertProgress(initial, state);
        const target: Record<string, unknown> | undefined = initial.receipts.find(row => row.receipt_key !== seed.receipt_key); assert.ok(target);
        assert.equal(target.message_id, messageId(cut, false).toString()); assert.equal(state.cursor.receiptSetHash, receiptProof(target));
        if (poll === 2) assert.deepEqual(state, previous);
        assert.deepEqual(result, poll === 1 ? {targets: 1n, events: 1n, sent: 1n} : {targets: 0n, events: 0n, sent: 0n});
        label = poll === 1 ? 'ReusedConfirmed' : 'EOF';
      }
      assert.equal(last.transportEntries, 0); assert.equal(last.confirmEntries, 0); assert.equal(last.confirmTrue, 0);
      polls.push({poll, outcome: label, error, cause, innerCause, deliveryFailure, authenticNewPacket: packet, satisfied: Number(result?.sent ?? 0n),
        offset: Number(state.cursor.anchor.offset), revision: Number(state.cursor.revision), receiptsUnchanged: true,
        fullStateUnchanged: cut !== 'confirm-before-cursor' || poll === 2, counts: last,
        nativeHoldings: {...ownedWorkerUsage()}, activeFileReads: activeMirrorFileReads()});
      previous = state;
    }
    assert.equal(sequence, 0); outcome = 'passed'; stage = 'complete';
  } catch (error) {outcome = 'failed'; process.exitCode = 1; throw error;}
  finally {
    clearTimeout(timer); active = null;
    OwnedWorkerSlot.prototype.run = originalRun; NativeMirrorReceiptStore.prototype.begin = originalBegin;
    NativeMirrorReceiptStore.prototype.confirm = originalConfirm;
    await writeJSON(file('result'), report());
  }
}

// Importing helpers in the parent never starts a child workflow.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {await childMain();} catch {process.exitCode = 1;}
}
