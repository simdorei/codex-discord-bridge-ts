import test from 'node:test';
import assert from 'node:assert/strict';
import fs, {appendFile, writeFile, type FileHandle} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {dirname, join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {OwnedWorkerSlot, ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
import {MirrorTargetBootstrapCoordinator} from '../../../src/runtime/session-mirror/bootstrap-coordinator.ts';
import {pollBoundMirrorTarget} from '../../../src/runtime/session-mirror/bound-poll.ts';
import {NativeMirrorCursorStore} from '../../../src/runtime/session-mirror/cursor-store.ts';
import {activeMirrorFileReads} from '../../../src/runtime/session-mirror/file-window.ts';
import {NativeMirrorStartupIntentStore} from '../../../src/runtime/session-mirror/startup-intent-store.ts';
import {discoverMirrorStore} from '../../../src/runtime/session-mirror/store-discovery.ts';
import type {DiscordReceiptTransport} from '../../../src/runtime/completion/receipt-sender.ts';

// Frozen before the first measurement. Changing one of these expectations is a
// new experiment, not a way to turn an unexpected result into a passing run.
const HISTORY_RECORDS = 16_384;
const RECORD_BYTES = 256;
const HISTORY_BYTES = 4_194_304;
const FINAL_OFFSET = 4_203_008;
const FINAL_TURN = 'history-final-turn';
const FIRST_MESSAGE_ID = 9_007_199_254_740_993n;
const context = Object.freeze({maxBytes: HISTORY_BYTES, maxRecords: HISTORY_RECORDS,
  maxRecordBytes: 512, maxWindowBytes: 65_536, maxTurnBytes: 16_384, timeoutMs: 5_000});
const options = Object.freeze({
  read: Object.freeze({maxWindowBytes: 4_096, maxRecordBytes: 512, maxRecords: 4, decodeTimeoutMs: 5_000}),
  ownership: Object.freeze({maxJobs: 32n, maxValueBytes: 1_048_576n, timeoutMs: 5_000}),
});
const backlogBytes = Object.freeze([5_120, 5_120, 5_120, 5_120, 5_120, 4_352, 3_328, 2_304, 1_280]);
const noHoldings = Object.freeze({Background: 0, Control: 0, Observation: 0, Discovery: 0, Maintenance: 0});

type Phase = 'initial-eof' | 'single-append' | 'backlog' | 'final-eof';
type ActualRead = {position: unknown; requested: unknown; returned: number};
type Interval = {reads: ActualRead[]; calls: Record<string, number>; decoderResponses: unknown[]};
type PollRow = {
  poll: number; phase: Phase; phasePoll: number; startOffset: number; nextOffset: number;
  dataBytes: number; anchorBytes: number; returnedBytes: number; readCalls: number;
  scannedRecords: number; events: number; stop: string; adapterCalls: number;
  transportAttempts: number; confirmedReceipts: number; revision: number;
  nativeHoldingsAfterPoll: number; activeFileReadsAfterPoll: number;
};

function record(value: unknown): string {
  const json = JSON.stringify(value), size = Buffer.byteLength(json);
  assert.ok(size < RECORD_BYTES);
  const line = json + ' '.repeat(RECORD_BYTES - size - 1) + '\n';
  assert.equal(Buffer.byteLength(line), RECORD_BYTES);
  return line;
}
const event = (message: string) => record({type: 'event_msg', payload: {type: 'agent_message', message}});
const warmMessage = (index: number) => `warm-${String(index).padStart(3, '0')}`;

/** Exact rollout opens only; forward the same receiver/arguments/result/errors.
 * No source bytes are copied or parsed by the observer. Metadata-only opens do
 * not contribute bytes. Each returned count comes from the real FileHandle.read.
 * Main-isolate interception deliberately makes no cold/native-isolate IO claim. */
function observeWork(rollout: string) {
  let active: Interval | null = null;
  const originalOpen = fs.open, originalRun = OwnedWorkerSlot.prototype.run;
  fs.open = async (...args: Parameters<typeof originalOpen>) => {
    const handle = await originalOpen(...args);
    if (args[0] === rollout) {
      const originalRead = handle.read;
      handle.read = async function (this: FileHandle, ...readArgs: unknown[]) {
        const interval = active;
        const result = await Reflect.apply(originalRead, this, readArgs) as {bytesRead: number; buffer: NodeJS.ArrayBufferView};
        if (interval !== null) interval.reads.push({position: readArgs[3], requested: readArgs[2], returned: result.bytesRead});
        return result;
      } as FileHandle['read'];
    }
    return handle;
  };
  syncBuiltinESMExports();
  OwnedWorkerSlot.prototype.run = function (this: OwnedWorkerSlot, url, data, timeout, signal) {
    const interval = active;
    const module = url.pathname.split('/').at(-1)!.replace(/\.(?:ts|js)$/, '');
    const kind = data !== null && typeof data === 'object' ? Object.getOwnPropertyDescriptor(data, 'kind')?.value : undefined;
    const key = module + (typeof kind === 'string' ? ':' + kind : '');
    if (interval !== null) interval.calls[key] = (interval.calls[key] ?? 0) + 1;
    const pending = originalRun.call(this, url, data, timeout, signal);
    return pending.then(result => {
      if (interval !== null && module === 'decode-worker') interval.decoderResponses.push(result);
      return result;
    });
  };
  return {
    start(): Interval {
      assert.equal(active, null);
      active = {reads: [], calls: {}, decoderResponses: []};
      return active;
    },
    stop(): void {active = null;},
    restore(): void {
      active = null;
      OwnedWorkerSlot.prototype.run = originalRun;
      fs.open = originalOpen;
      syncBuiltinESMExports();
    },
  };
}

/** Reconcile actual reads against the frozen logical ranges. A real short read
 * may split a range, so FileHandle call count is recorded, not an acceptance
 * constant. Every byte, including read-ahead and both anchor pairs, is included. */
function readAccounting(reads: readonly ActualRead[], start: number, next: number, dataBytes: number) {
  const ranges = [{position: start - 256, length: 256, data: false}, {position: 0, length: 256, data: false}];
  if (dataBytes > 0) ranges.push({position: start, length: dataBytes, data: true});
  if (next > start) ranges.push({position: next - 256, length: 256, data: false}, {position: 0, length: 256, data: false});
  let index = 0, data = 0, anchors = 0;
  for (const range of ranges) {
    let used = 0;
    while (used < range.length) {
      const read = reads[index++];
      assert.ok(read, 'missing actual rollout read');
      assert.equal(read.position, BigInt(range.position + used));
      assert.equal(read.requested, range.length - used);
      assert.ok(Number.isSafeInteger(read.returned) && read.returned > 0 && read.returned <= range.length - used);
      used += read.returned;
      if (range.data) data += read.returned; else anchors += read.returned;
    }
  }
  assert.equal(index, reads.length, 'unaccounted rollout read');
  return {dataBytes: data, anchorBytes: anchors, returnedBytes: data + anchors, readCalls: reads.length};
}

function expectedCalls(records: number): Record<string, number> {
  return {
    'cursor-store-worker:Read': 1,
    'decode-worker': 1,
    ...(records === 0 ? {} : {
      'ownership-worker': records + 1,
      'receipt-plan-worker': 1,
      'receipt-store-worker:Begin': records,
      'receipt-store-worker:Confirm': records,
      'cursor-store-worker:MixedAdvance': 1,
    }),
  };
}
function receiptRows(path: string) {
  const db = new DatabaseSync(path, {readOnly: true});
  try {
    return db.prepare('SELECT message_id,retryable,blocked_reason FROM codex_delivery_receipts ORDER BY message_id').all();
  } finally {db.close();}
}
function assertJoined(): void {
  assert.deepEqual(ownedWorkerUsage(), noHoldings);
  assert.equal(activeMirrorFileReads(), 0);
}

test('frozen warm mirror workload measures actual incremental read work and durable progress', {timeout: 60_000}, async t => {
  const rows: PollRow[] = [];
  let report: Record<string, unknown> | null = null;
  let stage = 'setup', failureStage: string | null = null;
  let unfinishedPoll: Record<string, string | number> | null = null;
  let outcome: 'passed' | 'failed' = 'failed';
  try {
    assert.equal(process.version, 'v24.21.0', 'measurement requires pinned Node');
    await storeFixture(async databasePath => {
    const rollout = join(dirname(databasePath), 'rollout.jsonl');
    const lines = [record({type: 'turn_context', payload: {turn_id: 'history-opening-turn'}})];
    for (let index = 1; index < HISTORY_RECORDS - 1; index++) lines.push(event(`historical-${index}`));
    lines.push(record({type: 'turn_context', payload: {turn_id: FINAL_TURN}}));
    const history = lines.join('');
    assert.equal(lines.length, HISTORY_RECORDS);
    assert.equal(Buffer.byteLength(history), HISTORY_BYTES);
    await writeFile(rollout, history);
    const db = await openInitialized(databasePath);
    try {db.prepare('INSERT INTO mirror_threads VALUES(?,?,?,?,?,?)').run('thread', 'project', 'title', 1n, 42n, 1);}
    finally {db.close();}

    const cursor = new NativeMirrorCursorStore(databasePath, 5_000);
    const intents = new NativeMirrorStartupIntentStore(databasePath, 5_000);
    const bootstrap = new MirrorTargetBootstrapCoordinator({databasePath, thread: 'thread', rolloutPath: rollout,
      channel: 42n, operationId: 'incremental-work-bootstrap', createdAt: 1.25, context, totalTimeoutMs: 10_000});
    const work = observeWork(rollout), totals: Record<string, number> = {};
    const sentBodies = new Set<string>();
    let attempts = 0;
    const transport: DiscordReceiptTransport = {
      async sendValidated(request) {
        const attempt = attempts++; // Count every invocation, including rejected validation.
        assert.equal(request.method, 'POST');
        assert.equal(request.path, 'channels/42/messages');
        assert.equal(sentBodies.has(request.body), false, 'duplicate synthetic transport attempt');
        const body = JSON.parse(request.body) as {content: string; enforce_nonce: boolean; allowed_mentions: unknown};
        assert.equal(body.content, `In progress\n\n${warmMessage(attempt)}`);
        assert.equal(body.enforce_nonce, true);
        assert.deepEqual(body.allowed_mentions, {parse: []});
        sentBodies.add(request.body);
        return FIRST_MESSAGE_ID + BigInt(attempt);
      },
    };
    try {
      // Schema preparation, bootstrap, discovery, and verification are unmeasured.
      await cursor.initializeSchema();
      await intents.initializeSchema();
      stage = 'bootstrap';
      const initialized = await bootstrap.run(t.signal);
      assert.equal(initialized.kind, 'Initialized');
      assert.equal(initialized.reconciled, false);
      assert.equal(initialized.cursor.anchor.offset, BigInt(HISTORY_BYTES));
      assert.equal(initialized.cursor.revision, 1n);
      assert.equal(initialized.cursor.turn, FINAL_TURN);
      assert.equal(attempts, 0);
      assert.equal(await intents.read('thread'), null);
      assert.deepEqual(receiptRows(databasePath), []);
      stage = 'discovery';
      const jobs = (await discoverMirrorStore(databasePath, {...options.ownership, maxTargets: 32n, maxOutputBytes: 1_048_576}, t.signal)).jobs;
      assert.equal(jobs.length, 0);
      assertJoined();
      let previous = initialized.cursor, previousReceipts = receiptRows(databasePath), advances = 0;
      let availableOffset = HISTORY_BYTES;

      async function poll(phase: Phase, phasePoll: number, records: number, returnedBytes: number): Promise<void> {
        const start = Number(previous.anchor.offset), next = start + records * RECORD_BYTES;
        stage = 'warm-poll';
        const beforeAttempts = attempts, interval = work.start();
        let counts;
        try {counts = await pollBoundMirrorTarget(databasePath, {id: 'thread', rolloutPath: rollout}, 42n, jobs, options, transport, t.signal);}
        finally {
          work.stop();
          // This bounded observation is retained if the poll or any subsequent
          // assertion fails. It does not claim durable progress or successful
          // decoding. No raw response, request body, path, or error is exposed.
          unfinishedPoll = {poll: rows.length + 1, phase, phasePoll, startOffset: start,
            returnedBytesObserved: interval.reads.reduce((sum, read) => sum + read.returned, 0),
            readCallsObserved: interval.reads.length,
            adapterCallsObserved: Object.values(interval.calls).reduce((sum, count) => sum + count, 0),
            decoderResponsesObserved: interval.decoderResponses.length, transportAttemptsObserved: attempts - beforeAttempts};
        }
        // Check joined holdings before any outside-interval verification work.
        assertJoined();
        assert.deepEqual(counts, {targets: records === 0 ? 0n : 1n, events: BigInt(records), sent: BigInt(records)});
        assert.deepEqual(interval.calls, expectedCalls(records));
        assert.equal(interval.decoderResponses.length, 1);
        const response = interval.decoderResponses[0] as {ok: boolean; value: {scannedRecords: number; eventCount: number; nextOffset: bigint; stop: string}};
        assert.equal(response.ok, true);
        const decoded = response.value;
        assert.equal(decoded.scannedRecords, records);
        assert.equal(decoded.eventCount, records);
        assert.equal(decoded.nextOffset, BigInt(next));
        assert.equal(decoded.stop, records === 4 ? 'RecordLimit' : 'WindowEnd');
        const bytes = readAccounting(interval.reads, start, next, Math.min(options.read.maxWindowBytes, availableOffset - start));
        assert.equal(bytes.returnedBytes, returnedBytes);
        assert.equal(attempts - beforeAttempts, records);
        const saved = await cursor.read('thread', t.signal);
        assert.ok(saved);
        const receipts = receiptRows(databasePath);
        assert.equal(receipts.length, attempts);
        assert.deepEqual(receipts.map(row => row.message_id), Array.from({length: attempts}, (_, index) => (FIRST_MESSAGE_ID + BigInt(index)).toString()));
        for (const row of receipts) {assert.equal(row.retryable, 0); assert.equal(row.blocked_reason, null);}
        if (records === 0) {
          assert.deepEqual(saved, previous, 'EOF poll changed cursor');
          assert.deepEqual(receipts, previousReceipts, 'EOF poll changed receipts');
        } else {
          advances++;
          assert.equal(saved.revision, previous.revision + 1n);
          assert.equal(saved.anchor.offset, BigInt(next));
        }
        assert.equal(saved.turn, FINAL_TURN);
        assertJoined();
        for (const [key, count] of Object.entries(interval.calls)) totals[key] = (totals[key] ?? 0) + count;
        rows.push({poll: rows.length + 1, phase, phasePoll, startOffset: start, nextOffset: next, ...bytes,
          scannedRecords: decoded.scannedRecords, events: decoded.eventCount, stop: decoded.stop,
          adapterCalls: Object.values(interval.calls).reduce((sum, value) => sum + value, 0),
          transportAttempts: attempts - beforeAttempts, confirmedReceipts: receipts.length, revision: Number(saved.revision),
          nativeHoldingsAfterPoll: 0, activeFileReadsAfterPoll: 0});
        previous = saved;
        previousReceipts = receipts;
        unfinishedPoll = null;
      }

      for (let repeat = 1; repeat <= 8; repeat++) await poll('initial-eof', repeat, 0, 512);
      await appendFile(rollout, event(warmMessage(0)));
      availableOffset += RECORD_BYTES;
      await poll('single-append', 1, 1, 1_280);
      const backlog = Array.from({length: 33}, (_, index) => event(warmMessage(index + 1))).join('');
      assert.equal(Buffer.byteLength(backlog), 8_448);
      await appendFile(rollout, backlog);
      availableOffset += 8_448;
      for (let index = 0; index < backlogBytes.length; index++) await poll('backlog', index + 1, index === 8 ? 1 : 4, backlogBytes[index]!);
      for (let repeat = 1; repeat <= 8; repeat++) await poll('final-eof', repeat, 0, 512);

      const sum = (key: 'dataBytes' | 'anchorBytes' | 'returnedBytes' | 'scannedRecords' | 'transportAttempts' | 'adapterCalls') => rows.reduce((total, row) => total + row[key], 0);
      assert.equal(rows.length, 26);
      assert.equal(sum('dataBytes'), 27_904);
      assert.equal(sum('anchorBytes'), 18_432);
      assert.equal(sum('returnedBytes'), 46_336);
      assert.equal(sum('scannedRecords'), 34);
      assert.equal(sum('transportAttempts'), 34);
      assert.equal(sum('adapterCalls'), 184);
      assert.equal(Math.max(...rows.map(row => row.adapterCalls)), 17);
      assert.equal(attempts, 34);
      assert.equal(sentBodies.size, 34);
      assert.equal(advances, 10);
      assert.equal(previous.revision, 11n);
      assert.equal(previous.anchor.offset, BigInt(FINAL_OFFSET));
      assert.equal(availableOffset, FINAL_OFFSET);
      assert.deepEqual(totals, {'cursor-store-worker:Read': 26, 'decode-worker': 26, 'ownership-worker': 44,
        'receipt-plan-worker': 10, 'receipt-store-worker:Begin': 34, 'receipt-store-worker:Confirm': 34,
        'cursor-store-worker:MixedAdvance': 10});
      assert.equal(await intents.read('thread'), null);
      assertJoined();
      // Assemble bounded evidence here; emit only after all fixture cleanup.
      // No raw bodies, paths, SQLite files, worker payloads or error text.
      report = {schemaVersion: 1, checkpoint: 922,
        qualification: 'partial synthetic G1 warm incremental read-work only', node: process.version,
        bootstrap: {records: HISTORY_RECORDS, bytes: HISTORY_BYTES, historicalTransportAttempts: 0, revision: 1, finalTurnRetained: true, readWorkMeasured: false},
        limits: {maxWindowBytes: 4096, maxRecordBytes: 512, maxRecords: 4, nativeTimeoutMs: 5000, ownershipMaxJobs: 32, ownershipMaxValueBytes: 1048576, testSafetyTimeoutMs: 60000},
        totals: {polls: rows.length, dataBytes: sum('dataBytes'), anchorBytes: sum('anchorBytes'), returnedBytes: sum('returnedBytes'),
          decodedRecords: sum('scannedRecords'), transportAttempts: attempts, confirmedReceipts: previousReceipts.length, unknownReceipts: 0,
          cursorAdvances: advances, finalRevision: Number(previous.revision), finalOffset: Number(previous.anchor.offset), adapterCalls: sum('adapterCalls'), maxAdapterCallsPerPoll: 17},
        adapterCalls: totals, polls: rows};
    } catch (error) {
      failureStage = stage;
      throw error;
    } finally {
      stage = 'cleanup';
      work.restore();
      await bootstrap.close();
      await intents.close();
      await cursor.close();
      assertJoined();
    }
    });
    outcome = 'passed';
  } catch (error) {
    failureStage ??= stage;
    throw error;
  } finally {
    // Report only after instrumentation, native owners, and temporary fixture
    // cleanup have settled. The original exception still fails the test; only
    // fixed stage labels and bounded counters enter the reviewed diagnostic.
    t.diagnostic('mirror-incremental-work-summary ' + JSON.stringify({
      ...(report ?? {schemaVersion: 1, checkpoint: 922,
        qualification: 'partial synthetic G1 warm incremental read-work only', polls: rows}),
      outcome, failureStage, unfinishedPoll,
      cleanup: {nativeHoldings: ownedWorkerUsage(), activeFileReads: activeMirrorFileReads()},
    }));
  }
});
