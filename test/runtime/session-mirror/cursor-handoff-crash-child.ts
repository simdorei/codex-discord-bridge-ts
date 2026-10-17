import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {open, rename, realpath, stat} from 'node:fs/promises';
import {dirname, isAbsolute, join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {serializeSerdeValue} from '../../../src/core/serde-json.ts';
import {readBoundMirrorCursor} from '../../../src/store/mirror-cursor-journal.ts';
import {OwnedWorkerSlot, ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
import {type DiscordReceiptTransport} from '../../../src/runtime/completion/receipt-sender.ts';
import {pollBoundMirrorTarget} from '../../../src/runtime/session-mirror/bound-poll.ts';
import {activeMirrorFileReads} from '../../../src/runtime/session-mirror/file-window.ts';
import {NativeMirrorReceiptStore} from '../../../src/runtime/session-mirror/receipt-store.ts';
import {discoverMirrorStore} from '../../../src/runtime/session-mirror/store-discovery.ts';

// Frozen before execution. A failure does not permit changing these limits,
// workload, cut placement, expected results, or any production implementation.
export const cuts = ['before-commit', 'before-ack'] as const;
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

import {observeCursorHandoff, type HandoffSnapshot} from './cursor-handoff-crash-observer.ts';
type Counters = {native: Record<string, number>; transportEntries: number; beginResults: string[]; confirmEntries: number; confirmTrue: number};
const counters = (): Counters => ({native: {}, transportEntries: 0, beginResults: [], confirmEntries: 0, confirmTrue: 0});
export const calls = (kind: 'unconfirmed' | 'confirmed' | 'eof', confirm = false): Record<string, number> => ({
  'cursor:Read': 1, decode: 1,
  ...(kind === 'eof' ? {} : {ownership: kind === 'confirmed' ? 1 : 2, plan: 1,
    ...(kind === 'unconfirmed' ? {'receipt:Begin': 1} : {'cursor:MixedAdvance': 1}),
    ...(confirm ? {'receipt:Confirm': 1, 'cursor:MixedAdvance': 1} : {}),
  }),
});
export type ChildPoll = {poll: number; outcome: 'ReusedConfirmed' | 'EOF'; error: string | null;
  cause: string | null; innerCause: string | null; deliveryFailure: {part: number; totalParts: number; attempts: number; sourceMatchesCause: boolean} | null;
  satisfied: number; offset: number; revision: number;
  receiptsUnchanged: boolean; fullStateUnchanged: boolean; counts: Counters;
  nativeHoldings: ReturnType<typeof ownedWorkerUsage>; activeFileReads: number};
export type ChildReport = {outcome: 'parked' | 'passed' | 'failed'; cut: Cut; mode: string; stage: string;
  counts: Counters; polls: ChildPoll[]; nativeHoldings: ReturnType<typeof ownedWorkerUsage>; activeFileReads: number; handoff: HandoffSnapshot | null};

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
  const observer = mode === 'crash' ? observeCursorHandoff(database, cut) : null;
  const report = (): ChildReport => ({outcome, cut, mode, stage, counts: last, polls,
    nativeHoldings: {...ownedWorkerUsage()}, activeFileReads: activeMirrorFileReads(), handoff: observer?.snapshot() ?? null});
  let barrierPublished = false;
  const watcher = setInterval(() => {
    if (observer?.snapshot().stage === 'held' && !barrierPublished) {
      barrierPublished = true; stage = 'held-in-original-worker'; outcome = 'parked';
      void writeJSON(file('barrier'), report()).catch(() => {process.exitCode = 1;});
    }
  }, 5);
  NativeMirrorReceiptStore.prototype.begin = async function (this: NativeMirrorReceiptStore, ...args) {
    const result = await originalBegin.apply(this, args); active?.beginResults.push(result.kind); return result;
  };
  NativeMirrorReceiptStore.prototype.confirm = async function (this: NativeMirrorReceiptStore, ...args) {
    if (active !== null) active.confirmEntries++;
    assert.equal(args[2], messageId(cut, false).toString());
    const result = await originalConfirm.apply(this, args);
    if (active !== null && result) active.confirmTrue++;
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
    assert.equal(initial.cursor.anchor.offset, mode === 'restart' && cut === 'before-ack' ? 4_608n : 4_352n);
    let previous = initial;
    for (let poll = 1; poll <= (mode === 'crash' ? 1 : 2); poll++) {
      stage = 'discovery'; const snapshot = await discoverMirrorStore(database, discoveryLimits, signal);
      assert.equal(snapshot.jobs.length, 0); assert.equal(snapshot.targets.length, 1); assertJoined();
      active = counters(); last = active; stage = 'poll';
      const result = await pollBoundMirrorTarget(database, {id: 'thread', rolloutPath: rollout}, 42n, snapshot.jobs, options, transport, signal);
      active = null; assert.equal(mode, 'restart', 'crash poll must remain held'); assertJoined();
      const state = readState(database); assert.deepEqual(await fileIdentity(rollout), identity);
      assert.deepEqual(state.receipts, initial.receipts); assert.deepEqual(state.mapping, initial.mapping); assert.deepEqual(state.intents, []);
      const reuse = cut === 'before-commit' && poll === 1;
      assert.deepEqual(last.native, calls(reuse ? 'confirmed' : 'eof'));
      assert.deepEqual(last.beginResults, []); assert.equal(last.confirmEntries, 0); assert.equal(last.confirmTrue, 0); assert.equal(last.transportEntries, 0);
      if (cut === 'before-commit') {
        assertProgress(initial, state);
        const target = initial.receipts.find(row => row.message_id === messageId(cut, false).toString()); assert.ok(target);
        assert.equal(state.cursor.receiptSetHash, receiptProof(target));
      }
      if (!reuse) assert.deepEqual(state, previous);
      assert.deepEqual(result, reuse ? {targets: 1n, events: 1n, sent: 1n} : {targets: 0n, events: 0n, sent: 0n});
      polls.push({poll, outcome: reuse ? 'ReusedConfirmed' : 'EOF', error: null, cause: null, innerCause: null,
        deliveryFailure: null, satisfied: Number(result.sent), offset: Number(state.cursor.anchor.offset),
        revision: Number(state.cursor.revision), receiptsUnchanged: true, fullStateUnchanged: !reuse, counts: last,
        nativeHoldings: {...ownedWorkerUsage()}, activeFileReads: activeMirrorFileReads()});
      previous = state;
    }
    assert.equal(sequence, 0); outcome = 'passed'; stage = 'complete';
  } catch (error) {outcome = 'failed'; process.exitCode = 1; throw error;}
  finally {
    clearInterval(watcher); clearTimeout(timer); active = null; observer?.restore();
    OwnedWorkerSlot.prototype.run = originalRun; NativeMirrorReceiptStore.prototype.begin = originalBegin;
    NativeMirrorReceiptStore.prototype.confirm = originalConfirm;
    await writeJSON(file('result'), report());
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {await childMain();} catch {process.exitCode = 1;}
}
