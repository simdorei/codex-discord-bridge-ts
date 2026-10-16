import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {getEnvironmentData, setEnvironmentData, isMainThread, parentPort, threadId, workerData} from 'node:worker_threads';
import {OwnedWorkerSlot} from '../../../src/runtime/owned-worker-slot.ts';
import {readBoundMirrorCursorInTransaction} from '../../../src/store/mirror-cursor-journal.ts';
import {createHash} from 'node:crypto';
import {serializeSerdeValue} from '../../../src/core/serde-json.ts';
const receiptProof = (r: Record<string, unknown>) => createHash('sha256').update(serializeSerdeValue([[r.receipt_key, r.content_hash]])).digest('hex');

const KEY = 'checkpoint936-cursor-handoff';
type Cut = 'before-commit' | 'before-ack';
type Configuration = {database: string; cut: Cut; operationId: string; cells: SharedArrayBuffer};
export type HandoffSnapshot = {stage: 'unsubmitted' | 'submitted' | 'held'; ready: number; threadId: number;
  begins: number; commitsEntered: number; commitsForwarded: number; closes: number; ackEntries: number;
  held: number; operationId: string | null; receiptSetHash: string | null; responseReceived: boolean};

// The genuine process-start --import is inherited by the ORIGINAL native worker.
// No custom Worker, replacement entry module, workerData or ACK is introduced.
if (!isMainThread) {
  const config = getEnvironmentData(KEY) as Configuration | undefined;
  if (config !== undefined) {
    const expectedEntry = fileURLToPath(new URL('../../../src/runtime/session-mirror/cursor-store-worker.js', import.meta.url));
    assert.equal(process.argv[1], expectedEntry); assert.equal(workerData.kind, 'MixedAdvance');
    assert.equal(workerData.path, config.database); assert.equal(workerData.operationId, config.operationId);
    assert.equal(workerData.expected.anchor.offset, 4352n); assert.equal(workerData.expected.revision, 2n);
    assert.equal(workerData.anchor.offset, 4608n); assert.equal(workerData.channel, 42n);
    assert.equal(workerData.skipped.length, 0); assert.equal(workerData.receipts.length, 1);
    assert.ok(parentPort);
    const cells = new Int32Array(config.cells), originalExec = DatabaseSync.prototype.exec,
      originalClose = DatabaseSync.prototype.close, originalPost = parentPort.postMessage;
    let connection: DatabaseSync | undefined, committedValue: ReturnType<typeof readBoundMirrorCursorInTransaction>;
    function hold(): void {
      Atomics.store(cells, 7, 1);
      // Never released by the owner: this process is killed at the exact call.
      // The original native 5s timeout and parent 15s safety guard remain active.
      while (true) Atomics.wait(cells, 8, 0);
    }
    DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string): void {
      if (sql === 'BEGIN IMMEDIATE') {
        assert.equal(Atomics.add(cells, 2, 1), 0); assert.equal(connection, undefined); connection = this;
      }
      if (sql === 'COMMIT') {
        assert.equal(this, connection); assert.equal(Atomics.add(cells, 3, 1), 0); assert.equal(this.isTransaction, true);
        committedValue = readBoundMirrorCursorInTransaction(this, 'thread'); assert.ok(committedValue);
        assert.equal(committedValue.operationId, config!.operationId);
        assert.equal(committedValue.revision, 3n); assert.deepEqual(committedValue.anchor, workerData.anchor);
        assert.equal(committedValue.turn, workerData.turn); assert.equal(committedValue.updatedAt, workerData.updatedAt);
        const receipt = this.prepare('SELECT * FROM codex_delivery_receipts WHERE receipt_key=?').get(workerData.receipts[0].key);
        assert.ok(receipt); assert.equal(receipt.content_hash, workerData.receipts[0].contentHash);
        assert.equal(typeof receipt.message_id, 'string'); assert.ok(BigInt(receipt.message_id as string) > 9007199254740992n);
        assert.equal(committedValue.receiptSetHash, receiptProof(receipt));
        if (config!.cut === 'before-commit') hold();
        Reflect.apply(originalExec, this, [sql]); Atomics.add(cells, 4, 1); assert.equal(this.isTransaction, false); return;
      }
      return Reflect.apply(originalExec, this, [sql]);
    };
    DatabaseSync.prototype.close = function (this: DatabaseSync): void {
      const value = Reflect.apply(originalClose, this, []);
      if (this === connection) {assert.equal(this.isOpen, false); Atomics.add(cells, 5, 1);}
      return value;
    };
    parentPort.postMessage = function (...args: Parameters<typeof originalPost>): void {
      assert.equal(Atomics.add(cells, 6, 1), 0);
      assert.equal(config!.cut, 'before-ack'); assert.equal(Atomics.load(cells, 4), 1); assert.equal(Atomics.load(cells, 5), 1);
      assert.deepEqual(args[0], {ok: true, value: committedValue});
      hold();
      return Reflect.apply(originalPost, parentPort, args);
    };
    Atomics.store(cells, 0, 1); Atomics.store(cells, 1, threadId);
  }
}

export function observeCursorHandoff(database: string, cut: Cut) {
  assert.equal(isMainThread, true);
  const originalRun = OwnedWorkerSlot.prototype.run, originalEnvironment = getEnvironmentData(KEY);
  const cells = new Int32Array(new SharedArrayBuffer(9 * 4));
  let operationId: string | null = null, receiptSetHash: string | null = null, responseReceived = false;
  const module = new URL('../../../src/runtime/session-mirror/cursor-store-worker.ts', import.meta.url).href;
  OwnedWorkerSlot.prototype.run = function (this: OwnedWorkerSlot, url, data, timeout, signal) {
    const q = data as {kind?: string; path?: string; operationId?: string; receipts?: {key: string; contentHash: string}[]};
    if (url.href !== module || q.kind !== 'MixedAdvance') return originalRun.call(this, url, data, timeout, signal);
    assert.equal(q.path, database); assert.equal(timeout, 5000); assert.equal(operationId, null);
    assert.equal(typeof q.operationId, 'string'); operationId = q.operationId!;
    assert.equal(q.receipts?.length, 1); receiptSetHash = receiptProof({receipt_key: q.receipts![0]!.key, content_hash: q.receipts![0]!.contentHash});
    setEnvironmentData(KEY, {database, cut, operationId, cells: cells.buffer} satisfies Configuration);
    let pending: Promise<unknown>;
    try {pending = originalRun.call(this, url, data, timeout, signal);}
    finally {setEnvironmentData(KEY, originalEnvironment);}
    return pending.then(value => {responseReceived = true; return value;});
  };
  return {
    snapshot(): HandoffSnapshot {
      const n = (i: number) => Atomics.load(cells, i);
      return {stage: n(7) ? 'held' : operationId === null ? 'unsubmitted' : 'submitted', ready: n(0), threadId: n(1),
        begins: n(2), commitsEntered: n(3), commitsForwarded: n(4), closes: n(5), ackEntries: n(6), held: n(7),
        operationId, receiptSetHash, responseReceived};
    },
    restore(): void {OwnedWorkerSlot.prototype.run = originalRun; setEnvironmentData(KEY, originalEnvironment);},
  };
}
