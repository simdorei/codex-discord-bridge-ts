import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile, appendFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {observeWork, readAccounting, expectedCalls} from '../../helpers/two-target-backlog-observer.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {TargetLocks} from '../../../src/core/keyed-locks.ts';
import {ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
import {MirrorTargetBootstrapCoordinator} from '../../../src/runtime/session-mirror/bootstrap-coordinator.ts';
import {NativeMirrorCursorStore} from '../../../src/runtime/session-mirror/cursor-store.ts';
import {NativeMirrorStartupIntentStore} from '../../../src/runtime/session-mirror/startup-intent-store.ts';
import {discoverMirrorStore} from '../../../src/runtime/session-mirror/store-discovery.ts';
import {MirrorDispatch} from '../../../src/runtime/session-mirror/dispatch.ts';
import {withMirrorMappingLocks} from '../../../src/runtime/session-mirror/mapping-owner.ts';
import {pollBoundMirrorTarget} from '../../../src/runtime/session-mirror/bound-poll.ts';
import {activeMirrorFileReads} from '../../../src/runtime/session-mirror/file-window.ts';
import type {DiscordReceiptTransport} from '../../../src/runtime/completion/receipt-sender.ts';

// Source-derived constants frozen before execution. Failures are evidence, never
// permission to enlarge guards or change outcomes to match a run.
const RECORD_BYTES = 256, BACKLOG_RECORDS = 16_384, BACKLOG_BYTES = 4_194_304;
const FIRST_ID = 9_007_199_254_740_993n;
const context = Object.freeze({maxBytes: 512, maxRecords: 2, maxRecordBytes: 512,
  maxWindowBytes: 4096, maxTurnBytes: 16384, timeoutMs: 5000});
const options = Object.freeze({read: Object.freeze({maxWindowBytes: 4096, maxRecordBytes: 512, maxRecords: 4, decodeTimeoutMs: 5000}),
  ownership: Object.freeze({maxJobs: 32n, maxValueBytes: 1048576n, timeoutMs: 5000})});
const emptyNative = {Background: 0, Control: 0, Observation: 0, Discovery: 0, Maintenance: 0};
const emptyLocks = {activeTargetCount: 0, queuedWaiterCount: 0, heldLeaseReferenceCount: 0};
const expectedTotals = {'cursor-store-worker:Read': 4, 'decode-worker': 4, 'ownership-worker': 14,
  'receipt-plan-worker': 4, 'receipt-store-worker:Begin': 10, 'receipt-store-worker:Confirm': 10, 'cursor-store-worker:MixedAdvance': 4};
function record(value: unknown) {
  const json = JSON.stringify(value), size = Buffer.byteLength(json); assert.ok(size < RECORD_BYTES);
  return json + ' '.repeat(RECORD_BYTES - size - 1) + '\n';
}
const message = (target: string, index: number) => `${target}-unique-${String(index).padStart(5, '0')}`;
const event = (target: string, index: number) => record({type: 'event_msg', payload: {type: 'agent_message', message: message(target, index)}});
function nativeJoined() {assert.deepEqual(ownedWorkerUsage(), emptyNative); assert.equal(activeMirrorFileReads(), 0);}
function receipts(path: string) {
  const db = new DatabaseSync(path, {readOnly: true});
  try {return db.prepare('SELECT message_id,retryable,blocked_reason FROM codex_delivery_receipts ORDER BY message_id').all();}
  finally {db.close();}
}

test('two admitted mapped targets make bounded progress with a large unread backlog under original global FIFO mapping serialization', {timeout: 60_000}, async t => {
  let stage = 'setup', failureStage: string | null = null, outcome = 'failed', fixtureDirectory: string | undefined;
  const rows: Record<string, unknown>[] = [], rounds: Record<string, unknown>[] = [], ordering: string[] = [];
  const observed: Record<string, unknown>[] = [], totals: Record<string, number> = {};
  let attempts = 0, round = 0, waiterObserved = false;
  const sent = {A: 0, B: 0}, seen = new Set<string>(), locks = new TargetLocks();
  let dispatch: MirrorDispatch | undefined;
  try {
    assert.equal(process.version, 'v24.21.0');
    await storeFixture(async databasePath => {
      fixtureDirectory = dirname(databasePath);
      const targets = [{thread: 'A', channel: 42n, rollout: join(fixtureDirectory, 'A.jsonl')},
        {thread: 'B', channel: 43n, rollout: join(fixtureDirectory, 'B.jsonl')}];
      for (const target of targets) await writeFile(target.rollout,
        record({type: 'turn_context', payload: {turn_id: `${target.thread}-opening`}}) +
        record({type: 'turn_context', payload: {turn_id: `${target.thread}-final`}}));
      const db = await openInitialized(databasePath);
      try {for (const target of targets) db.prepare('INSERT INTO mirror_threads VALUES(?,?,?,?,?,?)').run(target.thread, 'project', 'title', 1n, target.channel, 1);}
      finally {db.close();}
      const cursor = new NativeMirrorCursorStore(databasePath, 5000), intents = new NativeMirrorStartupIntentStore(databasePath, 5000);
      const work = observeWork(targets.map(target => target.rollout));
      const transport: DiscordReceiptTransport = {async sendValidated(request) {
        const attempt = attempts++;
        const target = request.path === 'channels/42/messages' ? 'A' : 'B';
        assert.equal(request.path, target === 'A' ? 'channels/42/messages' : 'channels/43/messages');
        assert.equal(request.method, 'POST'); assert.equal(seen.has(request.body), false);
        const body = JSON.parse(request.body) as {content: string; enforce_nonce: boolean; allowed_mentions: unknown};
        assert.equal(body.content, `In progress\n\n${message(target, sent[target])}`);
        assert.equal(body.enforce_nonce, true); assert.deepEqual(body.allowed_mentions, {parse: []});
        if (target === 'A' && sent.A === 0) {
          assert.deepEqual(locks.snapshotRetainedWork(), {activeTargetCount: 3, queuedWaiterCount: 1, heldLeaseReferenceCount: 3});
          assert.equal(sent.B, 0); assert.equal(work.readCalls(targets[1]!.rollout), 0); assert.deepEqual(ordering, ['1:A:enter']);
          waiterObserved = true;
        }
        seen.add(request.body); sent[target]++; return FIRST_ID + BigInt(attempt);
      }};
      try {
        await cursor.initializeSchema(); await intents.initializeSchema();
        stage = 'bootstrap';
        for (const target of targets) {
          const bootstrap = new MirrorTargetBootstrapCoordinator({databasePath, thread: target.thread, rolloutPath: target.rollout,
            channel: target.channel, operationId: `bootstrap-${target.thread}`, createdAt: 1.25, context, totalTimeoutMs: 10000});
          try {
            const result = await bootstrap.run(t.signal);
            assert.equal(result.kind, 'Initialized'); assert.equal(result.reconciled, false);
            assert.equal(result.cursor.anchor.offset, 512n); assert.equal(result.cursor.revision, 1n);
            assert.equal(result.cursor.turn, `${target.thread}-final`); assert.equal(await intents.read(target.thread), null);
          } finally {await bootstrap.close();}
        }
        assert.equal(attempts, 0); assert.deepEqual(receipts(databasePath), []);
        const snapshot = await discoverMirrorStore(databasePath, {...options.ownership, maxTargets: 2n, maxOutputBytes: 1048576}, t.signal);
        assert.equal(snapshot.jobs.length, 0);
        const backlog = Array.from({length: BACKLOG_RECORDS}, (_, index) => event('A', index)).join('');
        assert.equal(Buffer.byteLength(backlog), BACKLOG_BYTES);
        await appendFile(targets[0]!.rollout, backlog); await appendFile(targets[1]!.rollout, event('B', 0));
        nativeJoined();
        dispatch = new MirrorDispatch({maxTargets: 2, maxBytes: 18}, (hint, signal) => withMirrorMappingLocks(locks, hint.thread, signal, async () => {
          const target = targets.find(target => target.thread === hint.thread)!;
          const count = hint.thread === 'A' ? 4 : 1;
          const start = 512 + (round - 1) * count * RECORD_BYTES, next = start + count * RECORD_BYTES;
          ordering.push(`${round}:${hint.thread}:enter`);
          const interval = work.start(), before = attempts;
          let result;
          try {result = await pollBoundMirrorTarget(databasePath, {id: hint.thread, rolloutPath: target.rollout}, hint.channel, snapshot.jobs, options, transport, signal);}
          finally {
            work.stop(); ordering.push(`${round}:${hint.thread}:exit`);
            observed.push({round, target: hint.thread, returnedBytes: interval.reads.reduce((sum, read) => sum + read.returned, 0),
              readCalls: interval.reads.length, adapterCalls: Object.values(interval.calls).reduce((sum, n) => sum + n, 0), transportAttempts: attempts - before});
          }
          nativeJoined();
          assert.deepEqual(result, {targets: 1n, events: BigInt(count), sent: BigInt(count)});
          assert.deepEqual(interval.calls, expectedCalls(count)); assert.equal(interval.decoderResponses.length, 1);
          const response = interval.decoderResponses[0] as {ok: boolean; value: {scannedRecords: number; eventCount: number; nextOffset: bigint; stop: string}};
          assert.equal(response.ok, true); assert.equal(response.value.scannedRecords, count); assert.equal(response.value.eventCount, count);
          assert.equal(response.value.nextOffset, BigInt(next)); assert.equal(response.value.stop, count === 4 ? 'RecordLimit' : 'WindowEnd');
          for (const read of interval.reads) assert.equal(read.path, target.rollout);
          const bytes = readAccounting(interval.reads, start, next, count === 4 ? 4096 : 256);
          assert.equal(bytes.returnedBytes, count === 4 ? 5120 : 1280); assert.equal(attempts - before, count);
          for (const [key, n] of Object.entries(interval.calls)) totals[key] = (totals[key] ?? 0) + n;
          rows.push({round, target: hint.thread, startOffset: start, nextOffset: next, ...bytes,
            decodedRecords: count, stop: response.value.stop, adapterCalls: count === 4 ? 17 : 8, transportAttempts: attempts - before});
          return result;
        }), () => 'synthetic bounded measurement failure');
        for (round = 1; round <= 2; round++) {
          if (round === 2) await appendFile(targets[1]!.rollout, event('B', 1));
          stage = 'dispatch-round';
          dispatch.refresh(targets.map(({thread, channel}) => ({thread, channel})));
          assert.equal(dispatch.dispatch(), 2); assert.equal(dispatch.activeCount, 2); assert.equal(dispatch.readyCount, 0);
          const harvested = [];
          while (dispatch.activeCount > 0) {await dispatch.waitForSettlement(t.signal); harvested.push(...dispatch.harvest());}
          assert.equal(harvested.length, 2);
          assert.deepEqual(harvested.map(row => row.finished.target.thread), ['A', 'B']);
          for (const row of harvested) {
            const result = row.finished.outcome;
            if (result.kind === 'Failed' || result.kind === 'TimedOut') throw result.error;
            if (result.kind === 'Cancelled') throw result.reason;
            assert.equal(row.report, null); assert.equal(result.kind, 'Completed');
          }
          nativeJoined(); assert.deepEqual(locks.snapshotRetainedWork(), emptyLocks);
          assert.equal(dispatch.activeCount, 0); assert.equal(dispatch.readyCount, 0);
          stage = 'round-verification';
          for (const target of targets) {
            const saved = await cursor.read(target.thread, t.signal); assert.ok(saved);
            assert.equal(saved.anchor.offset, BigInt(512 + round * (target.thread === 'A' ? 1024 : 256)));
            assert.equal(saved.revision, BigInt(round + 1)); assert.equal(saved.turn, `${target.thread}-final`);
          }
          const savedReceipts = receipts(databasePath);
          assert.equal(savedReceipts.length, round * 5);
          assert.deepEqual(savedReceipts.map(row => row.message_id), Array.from({length: round * 5}, (_, index) => (FIRST_ID + BigInt(index)).toString()));
          for (const row of savedReceipts) {assert.equal(row.retryable, 0); assert.equal(row.blocked_reason, null);}
          nativeJoined(); rounds.push({round, admitted: 2, completed: 2, confirmedReceipts: savedReceipts.length, dispatchSlots: 0, nativeHoldings: 0, fileReads: 0, locks: 0, waiters: 0});
        }
        assert.deepEqual(ordering, ['1:A:enter', '1:A:exit', '1:B:enter', '1:B:exit', '2:A:enter', '2:A:exit', '2:B:enter', '2:B:exit']);
        assert.equal(waiterObserved, true); assert.deepEqual(sent, {A: 8, B: 2}); assert.equal(attempts, 10); assert.equal(seen.size, 10);
        assert.deepEqual(totals, expectedTotals); assert.equal(Object.values(totals).reduce((sum, n) => sum + n, 0), 50);
        assert.equal(BACKLOG_BYTES - sent.A * RECORD_BYTES, 4192256); assert.equal(BACKLOG_RECORDS - sent.A, 16376);
      } catch (error) {failureStage = stage; throw error;}
      finally {
        stage = 'cleanup'; await dispatch?.close(); work.restore(); await intents.close(); await cursor.close();
        nativeJoined(); assert.deepEqual(locks.snapshotRetainedWork(), emptyLocks);
      }
    });
    outcome = 'passed';
  } catch (error) {failureStage ??= stage; throw error;}
  finally {
    t.diagnostic('mirror-two-target-backlog-summary ' + JSON.stringify({schemaVersion: 1, checkpoint: 941,
      qualification: 'partial synthetic two-target bounded backlog component measurement; global FIFO serialization', node: process.version,
      outcome, failureStage, polls: rows, rounds, observations: observed, ordering, waiterObserved, adapterCalls: totals,
      totals: {transportAttempts: attempts, targetAAttempts: sent.A, targetBAttempts: sent.B},
      cleanup: {temporaryFixtureRemoved: fixtureDirectory !== undefined && !existsSync(fixtureDirectory), nativeHoldings: ownedWorkerUsage(),
        activeFileReads: activeMirrorFileReads(), locks: locks.snapshotRetainedWork(), dispatchSlots: dispatch?.activeCount ?? 0}}));
  }
});
