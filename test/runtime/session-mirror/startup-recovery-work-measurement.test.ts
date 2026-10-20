import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile, appendFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
import {MirrorTargetBootstrapCoordinator} from '../../../src/runtime/session-mirror/bootstrap-coordinator.ts';
import {NativeMirrorCursorStore} from '../../../src/runtime/session-mirror/cursor-store.ts';
import {NativeMirrorStartupIntentStore} from '../../../src/runtime/session-mirror/startup-intent-store.ts';
import {captureMirrorStartupCutoff} from '../../../src/runtime/session-mirror/startup-context-reader.ts';
import {activeMirrorFileReads} from '../../../src/runtime/session-mirror/file-window.ts';
import type {MirrorStartupRecoveryData} from '../../../src/runtime/session-mirror/startup-intent-recovery-data.ts';
import {observeStartupRecoveryWork, type ActualRead, type WorkerObservation} from './startup-recovery-work-observer.ts';

// Frozen from production source BEFORE execution. Never tune after a failure.
const N = 4_194_304, RECORDS = 16_384, RECORD_BYTES = 256, WINDOW = 65_536;
const FINAL_TURN = 'history-final-turn', OPERATION = 'retained-original-operation';
const context = Object.freeze({maxBytes: N, maxRecords: RECORDS, maxRecordBytes: 512,
  maxWindowBytes: WINDOW, maxTurnBytes: 16_384, timeoutMs: 5_000});
const noHoldings = Object.freeze({Background: 0, Control: 0, Observation: 0, Discovery: 0, Maintenance: 0});
const anchorRanges = Object.freeze([{position: N - 256, length: 256, payload: false}, {position: 0, length: 256, payload: false}]);
const scanRanges = Object.freeze(Array.from({length: 64}, (_, index) => ({position: index * WINDOW, length: WINDOW, payload: true})));
function record(value: unknown): string {
  const json = JSON.stringify(value), bytes = Buffer.byteLength(json);
  assert.ok(bytes < RECORD_BYTES);
  const line = json + ' '.repeat(RECORD_BYTES - bytes - 1) + '\n';
  assert.equal(Buffer.byteLength(line), RECORD_BYTES); return line;
}
function account(reads: readonly ActualRead[], ranges: readonly {position: number; length: number; payload: boolean}[]) {
  let index = 0, payloadBytes = 0, anchorBytes = 0;
  for (const range of ranges) {
    let used = 0;
    while (used < range.length) {
      const read = reads[index++]; assert.ok(read, 'missing actual native read');
      assert.equal(read.position, range.position + used); assert.equal(read.requested, range.length - used);
      assert.equal(read.failed, 0);
      assert.ok(read.returned > 0 && read.returned <= range.length - used);
      used += read.returned;
      if (range.payload) payloadBytes += read.returned; else anchorBytes += read.returned;
    }
  }
  assert.equal(index, reads.length, 'unaccounted actual native read');
  return {payloadBytes, anchorBytes, returnedBytes: payloadBytes + anchorBytes, readCalls: reads.length};
}
function joined() {assert.deepEqual(ownedWorkerUsage(), noHoldings); assert.equal(activeMirrorFileReads(), 0);}
function workerClosed(row: WorkerObservation, opens: number) {
  assert.equal(row.module, 'startup-intent-store-worker'); assert.equal(row.ready, 1);
  assert.ok(row.threadId > 0); assert.equal(row.exited, 1); assert.equal(row.responseReceived, true);
  assert.equal(row.opens, opens); assert.equal(row.closes, opens); assert.equal(row.handles, 0);
  assert.equal(row.activeFileReads, 0); assert.equal(row.overflow, 0); assert.equal(row.observerErrors, 0);
  assert.equal(row.readFailures, 0); assert.equal(row.closeFailures, 0);
}

test('retained cutoff bootstrap measures original native worker read work', {timeout: 60_000}, async t => {
  let stage = 'setup', failureStage: string | null = null, outcome = 'failed';
  let observer: ReturnType<typeof observeStartupRecoveryWork> | undefined;
  let report: Record<string, unknown> | null = null, fixtureDirectory: string | undefined;
  try {
    assert.equal(process.version, 'v24.21.0');
    await storeFixture(async databasePath => {
      fixtureDirectory = dirname(databasePath);
      const rollout = join(fixtureDirectory, 'rollout.jsonl');
      const lines = [record({type: 'turn_context', payload: {turn_id: 'history-opening-turn'}})];
      for (let index = 1; index < RECORDS - 1; index++) lines.push(record({type: 'event_msg', payload: {type: 'agent_message', message: `historical-${index}`}}));
      lines.push(record({type: 'turn_context', payload: {turn_id: FINAL_TURN}}));
      assert.equal(lines.length, RECORDS); assert.equal(Buffer.byteLength(lines.join('')), N);
      await writeFile(rollout, lines.join(''));
      const db = await openInitialized(databasePath);
      try {db.prepare('INSERT INTO mirror_threads VALUES(?,?,?,?,?,?)').run('thread', 'project', 'title', 1n, 42n, 1);}
      finally {db.close();}
      const cursor = new NativeMirrorCursorStore(databasePath, 5_000), intents = new NativeMirrorStartupIntentStore(databasePath, 5_000);
      const bootstrap = new MirrorTargetBootstrapCoordinator({databasePath, thread: 'thread', rolloutPath: rollout, channel: 42n,
        operationId: 'must-not-replace-retained-operation', createdAt: 99, context, totalTimeoutMs: 10_000});
      try {
        await cursor.initializeSchema(); await intents.initializeSchema();
        const cutoff = await captureMirrorStartupCutoff(rollout, 5_000, t.signal);
        const retained = await intents.retain('thread', cutoff, 1.25, OPERATION, t.signal);
        assert.equal(retained.cutoff.offset, BigInt(N));
        await appendFile(rollout, record({type: 'turn_context', payload: {turn_id: 'post-cutoff-must-not-scan'}}));
        joined();
        stage = 'measured-bootstrap'; observer = observeStartupRecoveryWork(rollout);
        const result = await bootstrap.run(t.signal);
        // Stop BEFORE any verification reads; workers have really exited here.
        observer.restore(); joined();
        stage = 'acceptance';
        const workers = observer.snapshot();
        assert.deepEqual(workers.map(row => row.kind), ['ReadTarget', 'RecoverContext', 'CompleteContext']);
        workerClosed(workers[0]!, 0); workerClosed(workers[1]!, 67); workerClosed(workers[2]!, 2);
        assert.equal(new Set(workers.map(row => row.threadId)).size, 3);
        const readTarget = account(workers[0]!.reads, []);
        const recovered = account(workers[1]!.reads, [...anchorRanges, ...scanRanges]);
        const completed = account(workers[2]!.reads, anchorRanges);
        assert.deepEqual([readTarget.returnedBytes, recovered.payloadBytes, recovered.anchorBytes, completed.anchorBytes], [0, N, 512, 512]);
        assert.equal(recovered.returnedBytes + completed.returnedBytes, 4_195_328);
        const responses = observer.responses() as {ok: boolean; value: unknown}[];
        for (const response of responses) assert.equal(response.ok, true);
        assert.deepEqual((responses[0]!.value as {pending: unknown}).pending, retained);
        const evidence = responses[1]!.value as MirrorStartupRecoveryData;
        assert.deepEqual(evidence.pending, retained);
        assert.equal(evidence.context.scannedBytes, BigInt(N)); assert.equal(evidence.context.scannedRecords, RECORDS);
        assert.equal(evidence.context.currentTurn, FINAL_TURN);
        assert.equal(evidence.context.continuity, 'SameIdentityGrowthAndAnchors');
        assert.equal(evidence.context.anchor.offset, BigInt(N)); assert.equal(evidence.context.anchor.stamp.size, BigInt(N + RECORD_BYTES));
        assert.equal(result.kind, 'Resumed'); assert.equal(result.reconciled, false);
        assert.equal(result.cursor.operationId, OPERATION); assert.equal(result.cursor.updatedAt, 1.25);
        assert.equal(result.cursor.anchor.offset, BigInt(N)); assert.equal(result.cursor.revision, 1n); assert.equal(result.cursor.turn, FINAL_TURN);
        assert.deepEqual(await cursor.read('thread', t.signal), result.cursor); assert.equal(await intents.read('thread', t.signal), null);
        const verification = new DatabaseSync(databasePath, {readOnly: true});
        try {assert.equal(verification.prepare('SELECT count(*) AS n FROM codex_delivery_receipts').get()!.n, 0);}
        finally {verification.close();}
        joined();
        report = {profile: {historyRecords: RECORDS, recordBytes: RECORD_BYTES, retainedOffset: N, appendedBytes: RECORD_BYTES,
          ...context, coordinatorTimeoutMs: 10_000, testSafetyTimeoutMs: 60_000},
          totals: {payloadBytes: N, anchorBytes: 1024, returnedBytes: 4_195_328, scannedRecords: RECORDS, scannedBytes: N,
            workerSubmissions: 3, rolloutOpens: 69, rolloutCloses: 69, finalOffset: N, finalRevision: 1, pendingRetired: true,
            originalOperationPreserved: true, historicalFinalTurnRetained: true, receiptRows: 0,
            transportApplicable: false},
          operations: workers.map((row, index) => ({kind: row.kind, ...[readTarget, recovered, completed][index],
            opens: row.opens, closes: row.closes, nativeWorkerExited: row.exited === 1, activeFileReads: row.activeFileReads, handles: row.handles}))};
      } catch (error) {failureStage = stage; throw error;}
      finally {
        stage = 'cleanup';
        // Close/join before restoring preload ownership after any failed run.
        await bootstrap.close(); await intents.close(); await cursor.close();
        observer?.restore(); joined();
      }
    });
    outcome = 'passed';
  } catch (error) {failureStage ??= stage; throw error;}
  finally {
    // Numeric observations survive incomplete/failed attempts; no raw paths,
    // bodies, database contents, worker packets or errors in public evidence.
    t.diagnostic('mirror-startup-recovery-work-summary ' + JSON.stringify({schemaVersion: 1, checkpoint: 935,
      qualification: 'partial synthetic retained-cutoff bootstrap read-work only', node: process.version,
      ...(report ?? {}), outcome, failureStage,
      observations: observer?.snapshot().map(({threadId: _id, ...row}) => row) ?? [],
      cleanup: {temporaryFixtureRemoved: fixtureDirectory !== undefined && !existsSync(fixtureDirectory), nativeHoldings: ownedWorkerUsage(), activeFileReads: activeMirrorFileReads()}}));
  }
});
