import test from 'node:test';
import assert from 'node:assert/strict';
import fs, {appendFile, open, rename, truncate, writeFile, type FileHandle} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {dirname, join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {OwnedWorkerSlot, ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
import {MirrorTargetBootstrapCoordinator} from '../../../src/runtime/session-mirror/bootstrap-coordinator.ts';
import {MirrorPollRecordHeldError, pollBoundMirrorTarget} from '../../../src/runtime/session-mirror/bound-poll.ts';
import {NativeMirrorCursorStore} from '../../../src/runtime/session-mirror/cursor-store.ts';
import {activeMirrorFileReads, MirrorFileChangedError} from '../../../src/runtime/session-mirror/file-window.ts';
import {MirrorBatchExecutionError} from '../../../src/runtime/session-mirror/observed-batch-executor.ts';
import {NativeMirrorStartupIntentStore} from '../../../src/runtime/session-mirror/startup-intent-store.ts';
import {discoverMirrorStore} from '../../../src/runtime/session-mirror/store-discovery.ts';
import type {DiscordReceiptTransport} from '../../../src/runtime/completion/receipt-sender.ts';

// Frozen before execution. A mismatch is a failed experiment, never permission
// to change workload, limits, expectations, or the production implementation.
const HISTORY_RECORDS = 16, RECORD_BYTES = 256, HISTORY_BYTES = 4_096, BASE = 4_352;
const FINAL_TURN = 'history-final-turn', FIRST_MESSAGE_ID = 9_007_199_254_740_993n;
const context = Object.freeze({maxBytes: HISTORY_BYTES, maxRecords: HISTORY_RECORDS,
  maxRecordBytes: 512, maxWindowBytes: 4_096, maxTurnBytes: 16_384, timeoutMs: 5_000});
const options = Object.freeze({
  read: Object.freeze({maxWindowBytes: 4_096, maxRecordBytes: 512, maxRecords: 4, decodeTimeoutMs: 5_000}),
  ownership: Object.freeze({maxJobs: 32n, maxValueBytes: 1_048_576n, timeoutMs: 5_000}),
});
const noHoldings = Object.freeze({Background: 0, Control: 0, Observation: 0, Discovery: 0, Maintenance: 0});
const cases = ['split-utf8', 'invalid-json', 'invalid-utf8', 'oversized-record',
  'same-path-replacement', 'truncation', 'prefix-changed-growth', 'accepted-send-append'] as const;
type Case = typeof cases[number];
type Stop = 'WindowEnd' | 'IncompleteRecord' | 'InvalidJson' | 'InvalidUtf8' | 'OversizedRecord';
type Failure = 'MirrorPollRecordHeldError' | 'MirrorFileChangedError' | 'MirrorBatchExecutionError';
type Expected = Readonly<{
  phase: string; dataBytes: number; returnedBytes: number; records: number | null; stop: Stop | null;
  nextOffset: number; revision: number; receipts: number; attempts: number; adapterCalls: number;
  boundary?: number; shortTail?: true; error?: Failure;
}>;
const seed: Expected = Object.freeze({phase: 'seed', dataBytes: 256, returnedBytes: 1280, records: 1,
  stop: 'WindowEnd', nextOffset: BASE, revision: 2, receipts: 1, attempts: 1, adapterCalls: 8, boundary: BASE});
const freezeSteps = (steps: Expected[]): readonly Expected[] => Object.freeze(steps.map(step => Object.freeze(step)));
const frozenPlan: Readonly<Record<Case, readonly Expected[]>> = Object.freeze({
  'split-utf8': freezeSteps([
    {phase: 'prefix-and-split', dataBytes: 328, returnedBytes: 1352, records: 1, stop: 'IncompleteRecord', nextOffset: BASE + 256, revision: 3, receipts: 2, attempts: 1, adapterCalls: 8, boundary: BASE + 256},
    {phase: 'unchanged-split', dataBytes: 72, returnedBytes: 584, records: 0, stop: 'IncompleteRecord', nextOffset: BASE + 256, revision: 3, receipts: 2, attempts: 0, adapterCalls: 2},
    {phase: 'completed-split', dataBytes: 256, returnedBytes: 1280, records: 1, stop: 'WindowEnd', nextOffset: BASE + 512, revision: 4, receipts: 3, attempts: 1, adapterCalls: 8, boundary: BASE + 512},
    {phase: 'final-eof', dataBytes: 0, returnedBytes: 512, records: 0, stop: 'WindowEnd', nextOffset: BASE + 512, revision: 4, receipts: 3, attempts: 0, adapterCalls: 2},
  ]),
  'invalid-json': freezeSteps([
    {phase: 'valid-prefix', dataBytes: 768, returnedBytes: 1792, records: 1, stop: 'InvalidJson', nextOffset: BASE + 256, revision: 3, receipts: 2, attempts: 1, adapterCalls: 8, boundary: BASE + 256},
    {phase: 'held-1', dataBytes: 512, returnedBytes: 1024, records: 0, stop: 'InvalidJson', nextOffset: BASE + 256, revision: 3, receipts: 2, attempts: 0, adapterCalls: 2, error: 'MirrorPollRecordHeldError'},
    {phase: 'held-2', dataBytes: 512, returnedBytes: 1024, records: 0, stop: 'InvalidJson', nextOffset: BASE + 256, revision: 3, receipts: 2, attempts: 0, adapterCalls: 2, error: 'MirrorPollRecordHeldError'},
  ]),
  'invalid-utf8': freezeSteps([
    {phase: 'valid-prefix', dataBytes: 768, returnedBytes: 1792, records: 1, stop: 'InvalidUtf8', nextOffset: BASE + 256, revision: 3, receipts: 2, attempts: 1, adapterCalls: 8, boundary: BASE + 256},
    {phase: 'held-1', dataBytes: 512, returnedBytes: 1024, records: 0, stop: 'InvalidUtf8', nextOffset: BASE + 256, revision: 3, receipts: 2, attempts: 0, adapterCalls: 2, error: 'MirrorPollRecordHeldError'},
    {phase: 'held-2', dataBytes: 512, returnedBytes: 1024, records: 0, stop: 'InvalidUtf8', nextOffset: BASE + 256, revision: 3, receipts: 2, attempts: 0, adapterCalls: 2, error: 'MirrorPollRecordHeldError'},
  ]),
  'oversized-record': freezeSteps([
    {phase: 'valid-prefix', dataBytes: 1025, returnedBytes: 2049, records: 1, stop: 'OversizedRecord', nextOffset: BASE + 256, revision: 3, receipts: 2, attempts: 1, adapterCalls: 8, boundary: BASE + 256},
    {phase: 'held-1', dataBytes: 769, returnedBytes: 1281, records: 0, stop: 'OversizedRecord', nextOffset: BASE + 256, revision: 3, receipts: 2, attempts: 0, adapterCalls: 2, error: 'MirrorPollRecordHeldError'},
    {phase: 'held-2', dataBytes: 769, returnedBytes: 1281, records: 0, stop: 'OversizedRecord', nextOffset: BASE + 256, revision: 3, receipts: 2, attempts: 0, adapterCalls: 2, error: 'MirrorPollRecordHeldError'},
  ]),
  'same-path-replacement': freezeSteps([
    {phase: 'rejected-1', dataBytes: 0, returnedBytes: 512, records: null, stop: null, nextOffset: BASE, revision: 2, receipts: 1, attempts: 0, adapterCalls: 1, error: 'MirrorFileChangedError'},
    {phase: 'rejected-2', dataBytes: 0, returnedBytes: 512, records: null, stop: null, nextOffset: BASE, revision: 2, receipts: 1, attempts: 0, adapterCalls: 1, error: 'MirrorFileChangedError'},
  ]),
  'truncation': freezeSteps([
    {phase: 'rejected-1', dataBytes: 0, returnedBytes: 128, records: null, stop: null, nextOffset: BASE, revision: 2, receipts: 1, attempts: 0, adapterCalls: 1, shortTail: true, error: 'MirrorFileChangedError'},
    {phase: 'rejected-2', dataBytes: 0, returnedBytes: 128, records: null, stop: null, nextOffset: BASE, revision: 2, receipts: 1, attempts: 0, adapterCalls: 1, shortTail: true, error: 'MirrorFileChangedError'},
  ]),
  'prefix-changed-growth': freezeSteps([
    {phase: 'rejected-1', dataBytes: 0, returnedBytes: 512, records: null, stop: null, nextOffset: BASE, revision: 2, receipts: 1, attempts: 0, adapterCalls: 1, error: 'MirrorFileChangedError'},
    {phase: 'rejected-2', dataBytes: 0, returnedBytes: 512, records: null, stop: null, nextOffset: BASE, revision: 2, receipts: 1, attempts: 0, adapterCalls: 1, error: 'MirrorFileChangedError'},
  ]),
  'accepted-send-append': freezeSteps([
    {phase: 'accepted-send-held-cursor', dataBytes: 256, returnedBytes: 1280, records: 1, stop: 'WindowEnd', nextOffset: BASE, revision: 2, receipts: 2, attempts: 1, adapterCalls: 7, boundary: BASE + 256, error: 'MirrorBatchExecutionError'},
    {phase: 'confirmed-receipt-reuse', dataBytes: 512, returnedBytes: 1536, records: 2, stop: 'WindowEnd', nextOffset: BASE + 512, revision: 3, receipts: 3, attempts: 1, adapterCalls: 8, boundary: BASE + 512},
    {phase: 'final-eof', dataBytes: 0, returnedBytes: 512, records: 0, stop: 'WindowEnd', nextOffset: BASE + 512, revision: 3, receipts: 3, attempts: 0, adapterCalls: 2},
  ]),
});

type ActualRead = {position: unknown; requested: unknown; returned: number};
type Interval = {readsEntered: number; reads: ActualRead[]; calls: Record<string, number>; decoderResponses: unknown[]};
type ReadRange = {kind: 'anchor' | 'data'; position: number; requestedBytes: number; returnedBytes: number; readCalls: number};
type PollRow = {
  poll: number; case: Case; phase: string; startOffset: number; nextOffset: number; revision: number;
  dataBytes: number; anchorBytes: number; returnedBytes: number; readCalls: number; readRanges: ReadRange[];
  decoderSubmissions: number; scannedRecords: number | null; events: number | null; decodedNextOffset: number | null; stop: Stop | null;
  outcome: 'Completed' | Failure; cause: 'MirrorFileChangedError' | null; heldStop: Stop | null; packetRetained: boolean;
  targets: number | null; satisfiedDeliveries: number | null; adapterCalls: number; adapterCallKinds: Record<string, number>;
  transportAttempts: number; confirmedReceipts: number; unknownReceipts: number; cursorAdvanced: boolean;
  nativeHoldingsAfterPoll: ReturnType<typeof ownedWorkerUsage>; activeFileReadsAfterPoll: number;
};

function record(value: unknown, bytes = RECORD_BYTES): Buffer {
  const json = JSON.stringify(value), size = Buffer.byteLength(json);
  assert.ok(size < bytes);
  const line = Buffer.from(json + ' '.repeat(bytes - size - 1) + '\n');
  assert.equal(line.length, bytes);
  return line;
}
const event = (message: string, bytes = RECORD_BYTES) => record({type: 'event_msg', payload: {type: 'agent_message', message}}, bytes);

/** Only exact rollout opens are wrapped. Original receivers, arguments, results,
 * and failures pass through. No payload copy, parse, substitute, or extra read.
 * Main-isolate byte counts deliberately exclude cold/native-isolate file IO. */
function observeWork(rollout: string) {
  let active: Interval | null = null;
  const originalOpen = fs.open, originalRun = OwnedWorkerSlot.prototype.run;
  fs.open = async function (this: unknown, ...args: Parameters<typeof originalOpen>) {
    const handle = await Reflect.apply(originalOpen, this, args) as FileHandle;
    if (args[0] === rollout) {
      const originalRead = handle.read;
      handle.read = async function (this: FileHandle, ...readArgs: unknown[]) {
        const interval = active;
        if (interval !== null) interval.readsEntered++;
        const result = await Reflect.apply(originalRead, this, readArgs) as {bytesRead: number; buffer: NodeJS.ArrayBufferView};
        if (interval !== null) interval.reads.push({position: readArgs[3], requested: readArgs[2], returned: result.bytesRead});
        return result;
      } as FileHandle['read'];
    }
    return handle;
  };
  syncBuiltinESMExports();
  const modules = new Map([
    [new URL('../../../src/runtime/session-mirror/cursor-store-worker.ts', import.meta.url).href, 'cursor-store-worker'],
    [new URL('../../../src/runtime/session-mirror/decode-worker.ts', import.meta.url).href, 'decode-worker'],
    [new URL('../../../src/runtime/session-mirror/ownership-worker.ts', import.meta.url).href, 'ownership-worker'],
    [new URL('../../../src/runtime/session-mirror/receipt-plan-worker.ts', import.meta.url).href, 'receipt-plan-worker'],
    [new URL('../../../src/runtime/session-mirror/receipt-store-worker.ts', import.meta.url).href, 'receipt-store-worker'],
  ]);
  OwnedWorkerSlot.prototype.run = function (this: OwnedWorkerSlot, url, data, timeout, signal) {
    const interval = active;
    const module = modules.get(url.href) ?? 'UnexpectedWorker';
    const kind = data !== null && typeof data === 'object' ? Object.getOwnPropertyDescriptor(data, 'kind')?.value : undefined;
    const key = module + (typeof kind === 'string' ? ':' + kind : '');
    if (interval !== null) interval.calls[key] = (interval.calls[key] ?? 0) + 1;
    return originalRun.call(this, url, data, timeout, signal).then(result => {
      if (interval !== null && module === 'decode-worker') interval.decoderResponses.push(result);
      return result;
    });
  };
  return {
    start(): Interval {assert.equal(active, null); active = {readsEntered: 0, reads: [], calls: {}, decoderResponses: []}; return active;},
    stop(): void {active = null;},
    restore(): void {active = null; OwnedWorkerSlot.prototype.run = originalRun; fs.open = originalOpen; syncBuiltinESMExports();},
  };
}

/** Reconcile all returned bytes, including read-ahead and both anchor pairs.
 * A real short read may split a range; syscall count is not a fixed threshold. */
function readAccounting(interval: Interval, start: number, expected: Expected) {
  const ranges = [{position: start - 256, length: expected.shortTail ? 128 : 256, data: false}];
  if (!expected.shortTail) ranges.push({position: 0, length: 256, data: false});
  if (expected.dataBytes > 0) ranges.push({position: start, length: expected.dataBytes, data: true});
  if (expected.boundary !== undefined) ranges.push({position: expected.boundary - 256, length: 256, data: false}, {position: 0, length: 256, data: false});
  let index = 0, data = 0, anchors = 0;
  const readRanges: ReadRange[] = [];
  for (const range of ranges) {
    let used = 0;
    const beforeReads = index;
    while (used < range.length) {
      const read = interval.reads[index++];
      assert.ok(read, 'missing actual rollout read');
      assert.equal(read.position, BigInt(range.position + used));
      assert.equal(read.requested, range.length - used);
      assert.ok(Number.isSafeInteger(read.returned) && read.returned > 0 && read.returned <= range.length - used);
      used += read.returned;
      if (range.data) data += read.returned; else anchors += read.returned;
    }
    readRanges.push({kind: range.data ? 'data' : 'anchor', position: range.position, requestedBytes: range.length, returnedBytes: used, readCalls: index - beforeReads});
  }
  assert.equal(index, interval.reads.length, 'unaccounted rollout read');
  assert.equal(interval.readsEntered, interval.reads.length, 'unexpected rejected native file read');
  return {dataBytes: data, anchorBytes: anchors, returnedBytes: data + anchors, readCalls: interval.readsEntered, readRanges};
}
function expectedCalls(expected: Expected): Record<string, number> {
  const executed = expected.records !== null && expected.records > 0;
  return {
    'cursor-store-worker:Read': 1,
    ...(expected.records === null ? {} : {'decode-worker': 1}),
    ...(executed ? {
      'ownership-worker': expected.attempts + 1, 'receipt-plan-worker': 1,
      'receipt-store-worker:Begin': expected.attempts, 'receipt-store-worker:Confirm': expected.attempts,
      ...(expected.error === 'MirrorBatchExecutionError' ? {} : {'cursor-store-worker:MixedAdvance': 1}),
    } : {}),
  };
}
function receiptRows(path: string) {
  const db = new DatabaseSync(path, {readOnly: true});
  try {return db.prepare('SELECT * FROM codex_delivery_receipts ORDER BY message_id').all();}
  finally {db.close();}
}
function assertJoined(): void {assert.deepEqual(ownedWorkerUsage(), noHoldings); assert.equal(activeMirrorFileReads(), 0);}

// The entire 30-poll matrix has a 60-second safety guard, not latency acceptance.
test('frozen mirror file-fault matrix measures real bounded work and durable holds', {timeout: 60_000}, async t => {
  const rows: PollRow[] = [], totals: Record<string, number> = {}, sentBodies = new Set<string>();
  let attempts = 0, finalReceipts = 0, advances = 0;
  let report: Record<string, unknown> | null = null, unfinishedPoll: Record<string, string | number> | null = null;
  let stage = 'setup', failureStage: string | null = null, outcome: 'passed' | 'failed' = 'failed';
  try {
    assert.equal(process.version, 'v24.21.0', 'measurement requires pinned Node');
    // Check synthetic construction before any measured operation.
    const split = event('utf8-😀');
    assert.equal(split.indexOf(Buffer.from('😀')), 70);
    assert.equal(split.subarray(0, 72).length, 72);
    assert.deepEqual(split.subarray(70, 72), Buffer.from([0xf0, 0x9f]));
    assert.equal(split.subarray(72).length, 184);
    for (const scenario of cases) {
      stage = 'setup';
      await storeFixture(async databasePath => {
        const rollout = join(dirname(databasePath), 'rollout.jsonl');
        const history = Buffer.concat([
          record({type: 'turn_context', payload: {turn_id: 'history-opening-turn'}}),
          ...Array.from({length: 14}, (_, index) => event(`historical-${index}`)),
          record({type: 'turn_context', payload: {turn_id: FINAL_TURN}}),
        ]);
        assert.equal(history.length, HISTORY_BYTES);
        assert.equal(history[254], 32);
        await writeFile(rollout, history);
        const db = await openInitialized(databasePath);
        try {db.prepare('INSERT INTO mirror_threads VALUES(?,?,?,?,?,?)').run('thread', 'project', 'title', 1n, 42n, 1);}
        finally {db.close();}
        const cursor = new NativeMirrorCursorStore(databasePath, 5_000);
        const intents = new NativeMirrorStartupIntentStore(databasePath, 5_000);
        const bootstrap = new MirrorTargetBootstrapCoordinator({databasePath, thread: 'thread', rolloutPath: rollout,
          channel: 42n, operationId: 'file-fault-work-bootstrap', createdAt: 1.25, context, totalTimeoutMs: 10_000});
        const work = observeWork(rollout), caseFirstAttempt = attempts;
        const seedMessage = `seed-${scenario}`, prefixMessage = `prefix-${scenario}`, suffixMessage = `suffix-${scenario}`;
        const expectedMessages = [seedMessage,
          ...(['same-path-replacement', 'truncation', 'prefix-changed-growth'].includes(scenario) ? [] : [prefixMessage]),
          ...(scenario === 'split-utf8' ? ['utf8-😀'] : scenario === 'accepted-send-append' ? [suffixMessage] : []),
        ];
        let appendedDuringSend = false;
        const transport: DiscordReceiptTransport = {
          async sendValidated(request) {
            const attempt = attempts++; // Entered before validation, including failures.
            assert.equal(request.method, 'POST');
            assert.equal(request.path, 'channels/42/messages');
            assert.equal(sentBodies.has(request.body), false, 'duplicate synthetic transport attempt');
            const body = JSON.parse(request.body) as {content: string; enforce_nonce: boolean; allowed_mentions: unknown};
            assert.equal(body.content, `In progress\n\n${expectedMessages[attempt - caseFirstAttempt]}`);
            assert.equal(body.enforce_nonce, true);
            assert.deepEqual(body.allowed_mentions, {parse: []});
            sentBodies.add(request.body);
            if (scenario === 'accepted-send-append' && attempt - caseFirstAttempt === 1) {
              assert.equal(appendedDuringSend, false);
              await appendFile(rollout, event(suffixMessage));
              appendedDuringSend = true;
            }
            return FIRST_MESSAGE_ID + BigInt(attempt);
          },
        };
        try {
          await cursor.initializeSchema();
          await intents.initializeSchema();
          stage = 'bootstrap';
          const initialized = await bootstrap.run(t.signal);
          assert.equal(initialized.kind, 'Initialized');
          assert.equal(initialized.reconciled, false);
          assert.equal(initialized.cursor.anchor.offset, BigInt(HISTORY_BYTES));
          assert.equal(initialized.cursor.revision, 1n);
          assert.equal(initialized.cursor.turn, FINAL_TURN);
          assert.equal(attempts, caseFirstAttempt);
          assert.equal(await intents.read('thread'), null);
          assert.deepEqual(receiptRows(databasePath), []);
          stage = 'discovery';
          const jobs = (await discoverMirrorStore(databasePath, {...options.ownership, maxTargets: 32n, maxOutputBytes: 1_048_576}, t.signal)).jobs;
          assert.equal(jobs.length, 0);
          assertJoined();
          let previous = initialized.cursor, previousReceipts = receiptRows(databasePath);

          async function poll(expected: Expected): Promise<void> {
            const start = Number(previous.anchor.offset), beforeAttempts = attempts, interval = work.start();
            stage = 'measured-poll';
            let counts: Awaited<ReturnType<typeof pollBoundMirrorTarget>> | null = null, failure: unknown;
            let failed = false;
            try {counts = await pollBoundMirrorTarget(databasePath, {id: 'thread', rolloutPath: rollout}, 42n, jobs, options, transport, t.signal);}
            catch (error) {failed = true; failure = error;}
            finally {
              work.stop();
              unfinishedPoll = {poll: rows.length + 1, case: scenario, phase: expected.phase, startOffset: start,
                returnedBytesObserved: interval.reads.reduce((sum, read) => sum + read.returned, 0),
                readCallsEntered: interval.readsEntered, readCallsReturned: interval.reads.length,
                adapterCallsObserved: Object.values(interval.calls).reduce((sum, count) => sum + count, 0),
                decoderResponsesObserved: interval.decoderResponses.length, transportAttemptsObserved: attempts - beforeAttempts};
            }
            // Check every lane before any outside-interval verification work.
            assertJoined();
            stage = 'poll-verification';
            let cause: PollRow['cause'] = null, heldStop: Stop | null = null, packetRetained = false;
            if (expected.error === undefined) {
              if (failed) throw failure;
              assert.deepEqual(counts, {targets: expected.records === 0 ? 0n : 1n,
                events: BigInt(expected.records!), sent: BigInt(expected.records!)});
            } else {
              assert.equal(failed, true, 'expected exact file-fault rejection');
              assert.equal(counts, null);
              if (expected.error === 'MirrorPollRecordHeldError') {
                assert.ok(failure instanceof MirrorPollRecordHeldError);
                assert.equal(failure.stop, expected.stop);
                assert.equal(failure.cause, undefined);
                heldStop = expected.stop;
              } else if (expected.error === 'MirrorFileChangedError') {
                assert.ok(failure instanceof MirrorFileChangedError);
                assert.equal(failure.cause, undefined);
              } else {
                assert.ok(failure instanceof MirrorBatchExecutionError);
                assert.ok(failure.cause instanceof MirrorFileChangedError);
                assert.equal(failure.cause.cause, undefined);
                assert.notEqual(failure.packet, null);
                cause = 'MirrorFileChangedError'; packetRetained = true;
              }
            }
            assert.deepEqual(interval.calls, expectedCalls(expected));
            const adapterCalls = Object.values(interval.calls).reduce((sum, value) => sum + value, 0);
            assert.equal(adapterCalls, expected.adapterCalls);
            assert.equal(interval.decoderResponses.length, expected.records === null ? 0 : 1);
            let decodedNextOffset: number | null = null, scannedRecords: number | null = null, events: number | null = null, stop: Stop | null = null;
            if (expected.records !== null) {
              const response = interval.decoderResponses[0] as {ok: boolean; value: {scannedRecords: number; eventCount: number; nextOffset: bigint; stop: string}};
              assert.equal(response.ok, true);
              assert.equal(response.value.scannedRecords, expected.records);
              assert.equal(response.value.eventCount, expected.records);
              assert.equal(response.value.nextOffset, BigInt(start + expected.records * RECORD_BYTES));
              assert.equal(response.value.stop, expected.stop);
              decodedNextOffset = Number(response.value.nextOffset);
              scannedRecords = response.value.scannedRecords; events = response.value.eventCount; stop = response.value.stop as Stop;
            }
            const bytes = readAccounting(interval, start, expected);
            assert.equal(bytes.dataBytes, expected.dataBytes);
            assert.equal(bytes.returnedBytes, expected.returnedBytes);
            assert.equal(attempts - beforeAttempts, expected.attempts);
            const saved = await cursor.read('thread', t.signal);
            assert.ok(saved);
            const receipts = receiptRows(databasePath);
            assert.equal(receipts.length, expected.receipts);
            assert.equal(receipts.length, attempts - caseFirstAttempt);
            assert.deepEqual(receipts.map(row => row.message_id), Array.from({length: receipts.length}, (_, index) => (FIRST_MESSAGE_ID + BigInt(caseFirstAttempt + index)).toString()));
            for (const row of receipts) {assert.equal(row.retryable, 0); assert.equal(row.blocked_reason, null);}
            // Every pre-existing complete receipt row remains byte-for-byte data-equal.
            assert.deepEqual(receipts.slice(0, previousReceipts.length), previousReceipts);
            const advanced = expected.nextOffset !== start;
            if (!advanced) assert.deepEqual(saved, previous, 'held/idle poll changed full cursor snapshot');
            else {
              advances++;
              assert.equal(saved.revision, previous.revision + 1n);
              assert.equal(saved.anchor.path, previous.anchor.path);
              for (const key of ['dev', 'ino', 'birthtimeNs'] as const) assert.equal(saved.anchor.stamp[key], previous.anchor.stamp[key]);
            }
            if (expected.attempts === 0) assert.deepEqual(receipts, previousReceipts, 'held/idle poll changed full receipt rows');
            assert.equal(saved.revision, BigInt(expected.revision));
            assert.equal(saved.anchor.offset, BigInt(expected.nextOffset));
            assert.equal(saved.turn, FINAL_TURN);
            assertJoined();
            for (const [key, count] of Object.entries(interval.calls)) totals[key] = (totals[key] ?? 0) + count;
            rows.push({poll: rows.length + 1, case: scenario, phase: expected.phase, startOffset: start,
              nextOffset: Number(saved.anchor.offset), revision: Number(saved.revision), ...bytes,
              decoderSubmissions: interval.calls['decode-worker'] ?? 0, scannedRecords,
              events, decodedNextOffset, stop, outcome: expected.error ?? 'Completed',
              cause, heldStop, packetRetained, targets: counts === null ? null : Number(counts.targets),
              satisfiedDeliveries: counts === null ? null : Number(counts.sent), adapterCalls, adapterCallKinds: {...interval.calls},
              transportAttempts: attempts - beforeAttempts, confirmedReceipts: receipts.length, unknownReceipts: 0,
              cursorAdvanced: advanced, nativeHoldingsAfterPoll: {...ownedWorkerUsage()}, activeFileReadsAfterPoll: activeMirrorFileReads()});
            previous = saved; previousReceipts = receipts; unfinishedPoll = null;
          }

          stage = 'fixture-mutation';
          const seedBytes = event(seedMessage);
          await appendFile(rollout, seedBytes);
          await poll(seed);
          stage = 'fixture-mutation';
          if (scenario === 'split-utf8') await appendFile(rollout, Buffer.concat([event(prefixMessage), split.subarray(0, 72)]));
          else if (scenario === 'invalid-json' || scenario === 'invalid-utf8' || scenario === 'oversized-record') {
            const bad = scenario === 'oversized-record' ? event(`oversized-${scenario}`, 513)
              : Buffer.concat([Buffer.from([scenario === 'invalid-json' ? 33 : 255]), Buffer.alloc(254, 32), Buffer.from('\n')]);
            assert.equal(bad.length, scenario === 'oversized-record' ? 513 : 256);
            await appendFile(rollout, Buffer.concat([event(prefixMessage), bad, event(`sentinel-${scenario}`)]));
          } else if (scenario === 'same-path-replacement') {
            await rename(rollout, rollout + '.old'); // Keep old inode alive to prevent inode-reuse ambiguity.
            await writeFile(rollout, Buffer.concat([history, seedBytes]));
          } else if (scenario === 'truncation') await truncate(rollout, BASE - 128);
          else if (scenario === 'prefix-changed-growth') {
            const handle = await open(rollout, 'r+');
            try {const result = await handle.write(Buffer.from([9]), 0, 1, 254); assert.equal(result.bytesWritten, 1);}
            finally {await handle.close();}
            await appendFile(rollout, event(`sentinel-${scenario}`));
          } else await appendFile(rollout, event(prefixMessage));
          for (const expected of frozenPlan[scenario]) {
            if (scenario === 'split-utf8' && expected.phase === 'completed-split') {
              stage = 'fixture-mutation'; await appendFile(rollout, split.subarray(72));
            }
            await poll(expected);
          }
          assert.equal(attempts - caseFirstAttempt, expectedMessages.length);
          assert.equal(appendedDuringSend, scenario === 'accepted-send-append');
          assert.equal(await intents.read('thread'), null);
          finalReceipts += previousReceipts.length;
          assertJoined();
        } catch (error) {failureStage = stage; throw error;}
        finally {
          stage = 'cleanup'; work.restore();
          const closed = await Promise.allSettled([bootstrap.close(), intents.close(), cursor.close()]);
          assertJoined();
          const rejected = closed.find(result => result.status === 'rejected');
          if (rejected?.status === 'rejected') throw rejected.reason;
        }
      });
      assertJoined();
    }
    stage = 'aggregate-verification';
    const sum = (key: 'dataBytes' | 'anchorBytes' | 'returnedBytes' | 'adapterCalls' | 'transportAttempts') => rows.reduce((total, row) => total + row[key], 0);
    const decodedRecords = rows.reduce((total, row) => total + (row.scannedRecords ?? 0), 0);
    assert.equal(rows.length, 30);
    assert.equal(sum('dataBytes'), 9_619); assert.equal(sum('anchorBytes'), 22_272);
    assert.equal(sum('returnedBytes'), 31_891); assert.equal(sum('adapterCalls'), 143);
    assert.equal(sum('transportAttempts'), 15); assert.equal(attempts, 15); assert.equal(sentBodies.size, 15);
    assert.equal(finalReceipts, 15); assert.equal(decodedRecords, 16); assert.equal(advances, 14);
    assert.deepEqual(totals, {'cursor-store-worker:Read': 30, 'decode-worker': 24, 'ownership-worker': 30,
      'receipt-plan-worker': 15, 'receipt-store-worker:Begin': 15, 'receipt-store-worker:Confirm': 15,
      'cursor-store-worker:MixedAdvance': 14});
    assertJoined();
    report = {schemaVersion: 1, checkpoint: 923, qualification: 'partial synthetic G1 integrated mirror file-fault read-work only', node: process.version,
      bootstrap: {cases: 8, recordsPerCase: HISTORY_RECORDS, bytesPerCase: HISTORY_BYTES, historicalTransportAttempts: 0, revision: 1, finalTurnRetained: true, readWorkMeasured: false},
      limits: {maxWindowBytes: 4096, maxRecordBytes: 512, maxRecords: 4, nativeTimeoutMs: 5000, ownershipMaxJobs: 32, ownershipMaxValueBytes: 1048576, testSafetyTimeoutMs: 60000},
      totals: {cases: 8, polls: rows.length, dataBytes: sum('dataBytes'), anchorBytes: sum('anchorBytes'), returnedBytes: sum('returnedBytes'),
        adapterCalls: sum('adapterCalls'), decodedRecords, transportAttempts: attempts, confirmedReceipts: finalReceipts, unknownReceipts: 0, cursorAdvances: advances},
      adapterCalls: totals, polls: rows};
    outcome = 'passed';
  } catch (error) {failureStage ??= stage; throw error;}
  finally {
    // Bounded diagnostics are emitted after all observers/owners/fixtures settle.
    // Failure preserves completed rows and unfinished counters; raw failures stay
    // in private TAP only. Nothing here claims an unfinished poll committed.
    t.diagnostic('mirror-file-fault-work-summary ' + JSON.stringify({
      ...(report ?? {schemaVersion: 1, checkpoint: 923,
        qualification: 'partial synthetic G1 integrated mirror file-fault read-work only', polls: rows}),
      outcome, failureStage, unfinishedPoll,
      cleanup: {nativeHoldings: ownedWorkerUsage(), activeFileReads: activeMirrorFileReads()},
    }));
  }
});
