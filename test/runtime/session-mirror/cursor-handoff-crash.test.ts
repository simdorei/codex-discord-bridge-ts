import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import {createHash} from 'node:crypto';
import type {Stats} from 'node:fs';
import {appendFile, lstat, mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
import {MirrorTargetBootstrapCoordinator} from '../../../src/runtime/session-mirror/bootstrap-coordinator.ts';
import {pollBoundMirrorTarget} from '../../../src/runtime/session-mirror/bound-poll.ts';
import {NativeMirrorCursorStore} from '../../../src/runtime/session-mirror/cursor-store.ts';
import {activeMirrorFileReads} from '../../../src/runtime/session-mirror/file-window.ts';
import {NativeMirrorStartupIntentStore} from '../../../src/runtime/session-mirror/startup-intent-store.ts';
import {discoverMirrorStore} from '../../../src/runtime/session-mirror/store-discovery.ts';
import type {IdempotentMessageRequest} from '../../../src/discord/idempotent-message.ts';
import {assertJoined, assertProgress, calls, cuts, discoveryLimits, fileIdentity, FINAL_TURN, limits,
  messageId, noHoldings, options, readJSON, readState, receiptProof, writeJSON,
  type ChildReport, type Cut, type State} from './cursor-handoff-crash-child.ts';

function record(value: unknown): Buffer {
  const json = JSON.stringify(value), size = Buffer.byteLength(json); assert.ok(size < 256);
  const bytes = Buffer.from(json + ' '.repeat(255 - size) + '\n'); assert.equal(bytes.length, 256); return bytes;
}
const event = (message: string) => record({type: 'event_msg', payload: {type: 'agent_message', message}});
function validateRequest(value: unknown, content: string): asserts value is IdempotentMessageRequest {
  assert.ok(value && typeof value === 'object'); const request = value as IdempotentMessageRequest;
  assert.deepEqual(Object.keys(request).sort(), ['body', 'method', 'path']);
  assert.equal(request.method, 'POST'); assert.equal(request.path, 'channels/42/messages');
  assert.equal(typeof request.body, 'string'); assert.ok(Buffer.byteLength(request.body) < 2_048);
  const parsed = JSON.parse(request.body) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed).sort(), ['allowed_mentions', 'content', 'enforce_nonce', 'nonce']);
  assert.equal(parsed.content, `In progress\n\n${content}`); assert.equal(parsed.enforce_nonce, true);
  assert.deepEqual(parsed.allowed_mentions, {parse: []});
  const nonce = /"nonce":([0-9]+),"enforce_nonce":true}/.exec(request.body)?.[1];
  assert.ok(nonce); assert.ok(BigInt(nonce) >= 0n && BigInt(nonce) < (1n << 64n));
}

/** Own exactly this direct spawn handle. A successful kill request is never
 * mistaken for actual death; exit and close must both be witnessed. No process
 * lookup, tree enumeration, group signal, shell, IPC channel, or detached child. */
class OwnedChild {
  readonly child: ChildProcess;
  spawned = false; spawnFailed = false; errorSeen = false;
  exitSeen = false; closeSeen = false; killAttempted = false; killAccepted: boolean | null = null;
  exitCode: number | null = null; exitSignal: NodeJS.Signals | null = null;
  closeCode: number | null = null; closeSignal: NodeJS.Signals | null = null;
  terminationDeadline: number | null = null;
  constructor(root: string, cut: Cut, mode: 'crash' | 'restart') {
    assert.ok(import.meta.url.endsWith('.js'), 'process experiment requires compiled JavaScript');
    this.child = spawn(process.execPath, ['--no-strip-types', '--import', fileURLToPath(new URL('./cursor-handoff-crash-observer.js', import.meta.url)), fileURLToPath(new URL('./cursor-handoff-crash-child.js', import.meta.url)), root, cut, mode],
      {cwd: root, shell: false, detached: false, stdio: 'ignore', env: {...process.env, NODE_OPTIONS: '--no-strip-types'}});
    this.child.once('spawn', () => {this.spawned = true;});
    this.child.on('error', () => {this.errorSeen = true; if (!this.spawned && this.child.pid === undefined) this.spawnFailed = true;});
    this.child.once('exit', (code, signal) => {this.exitSeen = true; this.exitCode = code; this.exitSignal = signal;});
    this.child.once('close', (code, signal) => {this.closeSeen = true; this.closeCode = code; this.closeSignal = signal;});
  }
  get settled(): boolean {return this.closeSeen && (this.exitSeen || (this.spawnFailed && this.child.pid === undefined));}
  evidence() {return {spawned: this.spawned, spawnFailed: this.spawnFailed, errorSeen: this.errorSeen,
    exitSeen: this.exitSeen, closeSeen: this.closeSeen, exitCode: this.exitCode, exitSignal: this.exitSignal,
    closeCode: this.closeCode, closeSignal: this.closeSignal, killAttempted: this.killAttempted, killAccepted: this.killAccepted};}
  async join(deadline: number): Promise<void> {
    while (!this.settled) {assert.ok(performance.now() < deadline, 'owned child actual exit/close deadline'); await delay(20);}
  }
  async killAndJoin(): Promise<void> {
    this.terminationDeadline ??= performance.now() + limits.terminationMs;
    if (!this.settled && !this.exitSeen && !this.killAttempted) {
      this.killAttempted = true; this.killAccepted = this.child.kill('SIGKILL');
    }
    await this.join(this.terminationDeadline);
  }
}

type CaseRow = {cut: Cut; crash: ChildReport; termination: ReturnType<OwnedChild['evidence']>;
  restart: ChildReport; restartExit: ReturnType<OwnedChild['evidence']>; targetTransportAttempts: number;
  externalAcceptances: number; exactLargeIdPreserved: boolean; baselineCursorsRetainedAfterCrash: boolean;
  seedPreserved: boolean; mappingPreserved: boolean; rolloutIdentityPreserved: boolean;
  targetReceiptState: 'Unknown' | 'Confirmed'; finalOffset: number; finalRevision: number; fixtureRemoved: boolean};

test('frozen cursor handoff crash preserves atomic cursor and confirmed receipt custody', {timeout: limits.matrixMs}, async t => {
  assert.equal(process.version, 'v24.21.0'); assert.equal(process.platform, 'linux');
  const rows: CaseRow[] = [];
  let outcome: 'passed' | 'failed' = 'failed', stage = 'setup', failureStage: string | null = null;
  let spawnedChildren = 0, settledChildren = 0, active: OwnedChild | null = null, maxLive = 0;
  const currentChild = (): OwnedChild | null => active;
  let seedAttempts = 0, targetAttempts = 0, acceptances = 0, fixtureCleanupDebt = 0;
  let unfinished: {cut: Cut; stage: string; targetTransportAttempts: number; externalAcceptances: number;
    crash: ChildReport | null; restart: ChildReport | null; process: ReturnType<OwnedChild['evidence']> | null} | null = null;
  try {
    for (const cut of cuts) {
      stage = 'fixture-setup'; const parent = await realpath(process.env.CDR936_FIXTURE_PARENT!), root = await mkdtemp(join(parent, 'cdr-process-custody-'));
      const database = join(root, 'store.sqlite'), rollout = join(root, 'rollout.jsonl');
      let original: Stats | null = null, canonical: string | null = null;
      let cursor: NativeMirrorCursorStore | null = null, intents: NativeMirrorStartupIntentStore | null = null;
      let bootstrap: MirrorTargetBootstrapCoordinator | null = null;
      let caseAttempts = 0, caseAcceptances = 0, removed = false, row: CaseRow | null = null;
      let crashReport: ChildReport | null = null, restartReport: ChildReport | null = null;
      unfinished = {cut, stage, targetTransportAttempts: 0, externalAcceptances: 0, crash: null, restart: null, process: null};
      async function accept(value: unknown, seed: boolean, sequence?: number, mode?: string): Promise<bigint> {
        // Every call is counted before validation. No nonce/body deduplication,
        // cache, or synthetic provider replay masks a second transport request.
        if (seed) seedAttempts++; else {targetAttempts++; caseAttempts++; unfinished!.targetTransportAttempts = caseAttempts;}
        let requestValue = value;
        if (!seed) {
          assert.ok(value && typeof value === 'object'); const envelope = value as {sequence: number; request: unknown};
          assert.equal(envelope.sequence, sequence); assert.equal(mode, 'crash', 'restart must not send'); requestValue = envelope.request;
        }
        validateRequest(requestValue, `${seed ? 'seed' : 'target'}-${cut}`);
        assert.ok(seed || caseAttempts === 1, 'unexpected additional external attempt');
        
        const id = messageId(cut, seed), request = requestValue;
        const witness = {kind: 'synthetic-external-acceptance', messageId: id.toString(),
          requestSha256: createHash('sha256').update(request.body).digest('hex')};
        const path = join(root, seed ? 'seed.acceptance.json' : `target.acceptance-${caseAttempts}.json`);
        await writeJSON(path, witness, true); assert.deepEqual(await readJSON(path), witness);
        if (!seed) {acceptances++; caseAcceptances++; unfinished!.externalAcceptances = caseAcceptances;}
        return id;
      }
      async function drive(mode: 'crash' | 'restart'): Promise<ChildReport> {
        assert.equal(active, null); t.signal.throwIfAborted();
        active = new OwnedChild(root, cut, mode); spawnedChildren++; maxLive = Math.max(maxLive, spawnedChildren - settledChildren);
        assert.equal(spawnedChildren - settledChildren, 1);
        const owner = active, deadline = performance.now() + limits.childMs;
        let nextRequest = 1;
        while (true) {
          t.signal.throwIfAborted(); assert.ok(performance.now() < deadline, 'child barrier/restart safety deadline');
          const request = await readJSON(join(root, `${mode}.request-${nextRequest}.json`));
          if (request !== undefined) {
            // This is a transport entry even if its envelope or body is invalid.
            const accepted = await accept(request, false, nextRequest, mode);
            await writeJSON(join(root, `${mode}.response-${nextRequest}.json`), {sequence: nextRequest, messageId: accepted.toString()});
            nextRequest++; assert.ok(nextRequest <= limits.maxRequests + 1);
          }
          const found = await readJSON(join(root, `${mode}.${mode === 'crash' ? 'barrier' : 'result'}.json`));
          if (found !== undefined) {
            const result = found as ChildReport;
            if (mode === 'crash') crashReport = result; else restartReport = result;
            unfinished!.crash = crashReport; unfinished!.restart = restartReport;
            assert.equal(result.cut, cut); assert.equal(result.mode, mode);
            assert.equal(result.outcome, mode === 'crash' ? 'parked' : 'passed');
            assert.deepEqual(result.nativeHoldings, mode === 'crash' ? {...noHoldings, Background: 1} : noHoldings); assert.equal(result.activeFileReads, 0);
            if (mode === 'crash') {
              assert.equal(owner.exitSeen, false); assert.equal(owner.closeSeen, false);
              assert.deepEqual(result.counts.native, calls('unconfirmed', true));
              assert.equal(result.counts.transportEntries, caseAttempts); assert.equal(caseAttempts, 1);
              assert.equal(caseAcceptances, caseAttempts);
              assert.deepEqual(result.counts.beginResults, ['New']); assert.equal(result.counts.confirmEntries, 1); assert.equal(result.counts.confirmTrue, 1);
              const h = result.handoff; assert.ok(h); assert.equal(h.stage, 'held'); assert.equal(h.ready, 1); assert.ok(h.threadId > 0);
              assert.equal(h.begins, 1); assert.equal(h.commitsEntered, 1); assert.equal(h.held, 1); assert.equal(h.responseReceived, false);
              assert.equal(h.commitsForwarded, cut === 'before-ack' ? 1 : 0); assert.equal(h.closes, cut === 'before-ack' ? 1 : 0);
              assert.equal(h.ackEntries, cut === 'before-ack' ? 1 : 0);
            } else {
              await owner.join(deadline);
              assert.equal(owner.exitCode, 0); assert.equal(owner.exitSignal, null); assert.equal(owner.closeCode, 0);
              assert.equal(owner.closeSignal, null); assert.equal(owner.errorSeen, false);
              assert.equal(result.polls.length, 2);
            }
            return result;
          }
          if (mode === 'crash') {
            const failed = await readJSON(join(root, 'crash.result.json'));
            if (failed !== undefined) {crashReport = failed as ChildReport; unfinished!.crash = crashReport; assert.fail('crash child ended before barrier');}
          }
          assert.equal(owner.errorSeen, false, 'owned child error'); assert.equal(owner.settled, false, 'child closed before required handshake');
          await delay(20, undefined, {signal: t.signal});
        }
      }
      function retire(): ReturnType<OwnedChild['evidence']> {
        assert.ok(active?.settled); const evidence = active.evidence(); settledChildren++; active = null; return evidence;
      }
      function assertCrashState(baseline: State, state: State): void {
        if (cut === 'before-commit') {
          assert.deepEqual(state.cursor, baseline.cursor); assert.deepEqual(state.bound, baseline.bound); assert.deepEqual(state.legacy, baseline.legacy);
        } else {
          assert.equal(state.cursor.anchor.offset, 4608n); assert.equal(state.cursor.revision, 3n);
          assert.equal(state.cursor.operationId, crashReport!.handoff!.operationId);
          assert.equal(state.cursor.receiptSetHash, crashReport!.handoff!.receiptSetHash);
          assert.equal(state.cursor.turn, FINAL_TURN);
        }
        assert.deepEqual(state.mapping, baseline.mapping); assert.deepEqual(state.intents, []); assert.equal(state.receipts.length, 2);
        const seed = baseline.receipts[0]!;
        assert.deepEqual(state.receipts.find(receipt => receipt.receipt_key === seed.receipt_key), seed);
        const target = state.receipts.find(receipt => receipt.receipt_key !== seed.receipt_key); assert.ok(target);
        assert.equal(typeof target.receipt_key, 'string'); assert.match(String(target.content_hash), /^[0-9a-f]{64}$/);
        assert.equal(receiptProof(target), crashReport!.handoff!.receiptSetHash);
        assert.equal(target.retryable, 0); assert.equal(target.blocked_reason, null);
        assert.equal(target.message_id, messageId(cut, false).toString());
      }
      try {
        original = await lstat(root); canonical = await realpath(root);
        assert.equal(canonical, root); assert.equal(dirname(canonical), parent); assert.equal(original.isSymbolicLink(), false);
        cursor = new NativeMirrorCursorStore(database, limits.nativeMs); intents = new NativeMirrorStartupIntentStore(database, limits.nativeMs);
        bootstrap = new MirrorTargetBootstrapCoordinator({databasePath: database, thread: 'thread', rolloutPath: rollout,
          channel: 42n, operationId: 'process-crash-bootstrap', createdAt: 1.25,
          context: {maxBytes: 4_096, maxRecords: 16, maxRecordBytes: 512, maxWindowBytes: 4_096, maxTurnBytes: 16_384, timeoutMs: limits.nativeMs},
          totalTimeoutMs: limits.bootstrapMs});
        const history = Buffer.concat([record({type: 'turn_context', payload: {turn_id: 'history-opening-turn'}}),
          ...Array.from({length: 14}, (_, i) => event(`history-${i}`)), record({type: 'turn_context', payload: {turn_id: FINAL_TURN}})]);
        assert.equal(history.length, 4_096); await writeFile(rollout, history);
        const db = await openInitialized(database);
        try {db.prepare('INSERT INTO mirror_threads VALUES(?,?,?,?,?,?)').run('thread', 'project', 'title', 1n, 42n, 1);}
        finally {db.close();}
        await cursor.initializeSchema(t.signal); await intents.initializeSchema(t.signal);
        stage = 'bootstrap'; const initialized = await bootstrap.run(t.signal);
        assert.equal(initialized.kind, 'Initialized'); assert.equal(initialized.reconciled, false);
        assert.equal(initialized.cursor.anchor.offset, 4_096n); assert.equal(initialized.cursor.revision, 1n);
        assert.equal(initialized.cursor.turn, FINAL_TURN); assert.equal(await intents.read('thread'), null);
        assert.deepEqual(readState(database).receipts, []); assertJoined();
        stage = 'seed'; await appendFile(rollout, event(`seed-${cut}`));
        const jobs = (await discoverMirrorStore(database, discoveryLimits, t.signal)).jobs;
        const seeded = await pollBoundMirrorTarget(database, {id: 'thread', rolloutPath: rollout}, 42n, jobs, options,
          {sendValidated: request => accept(request, true)}, t.signal);
        assert.deepEqual(seeded, {targets: 1n, events: 1n, sent: 1n}); assertJoined();
        const baseline = readState(database); assert.equal(baseline.cursor.revision, 2n); assert.equal(baseline.cursor.anchor.offset, 4_352n);
        assert.equal(baseline.receipts.length, 1); assert.equal(baseline.receipts[0]!.message_id, messageId(cut, true).toString());
        assert.equal(baseline.cursor.receiptSetHash, receiptProof(baseline.receipts[0]!));
        await appendFile(rollout, event(`target-${cut}`)); const identity = await fileIdentity(rollout); assert.equal(identity.size, 4_608n);
        stage = 'crash-barrier'; crashReport = await drive('crash');
        const parkedState = readState(database); assertCrashState(baseline, parkedState);
        assert.deepEqual(await fileIdentity(rollout), identity); assertJoined();
        stage = 'kill-and-actual-join'; const killed = currentChild(); assert.ok(killed); await killed.killAndJoin();
        assert.equal(killed.exitSeen, true); assert.equal(killed.closeSeen, true);
        assert.equal(killed.exitCode, null); assert.equal(killed.exitSignal, 'SIGKILL'); assert.equal(killed.closeSignal, 'SIGKILL');
        assert.equal(killed.errorSeen, false); assert.equal(killed.killAccepted, true);
        const termination = retire();
        stage = 'post-crash-inspection'; const crashed = readState(database);
        assert.deepEqual(crashed, parkedState); assertCrashState(baseline, crashed); assert.deepEqual(await fileIdentity(rollout), identity);
        {
          const witness = await readJSON(join(root, 'target.acceptance-1.json')) as {messageId: string};
          assert.equal(witness.messageId, messageId(cut, false).toString());
        }
        stage = 'restart'; restartReport = await drive('restart'); const restartExit = retire();
        const final = readState(database); assert.deepEqual(await fileIdentity(rollout), identity);
        if (cut === 'before-commit') {
          assertProgress(crashed, final);
          const target = final.receipts.find(r => r.message_id === messageId(cut, false).toString()); assert.ok(target);
          assert.equal(final.cursor.receiptSetHash, receiptProof(target));
        } else assert.deepEqual(final, crashed);
        assert.deepEqual(final.receipts, parkedState.receipts);
        if (cut === 'before-commit') assert.notEqual(final.cursor.operationId, crashReport.handoff!.operationId);
        assertJoined();
        row = {cut, crash: crashReport, termination, restart: restartReport, restartExit, targetTransportAttempts: caseAttempts,
          externalAcceptances: caseAcceptances, exactLargeIdPreserved: true, baselineCursorsRetainedAfterCrash: cut === 'before-commit',
          seedPreserved: true, mappingPreserved: true, rolloutIdentityPreserved: true,
          targetReceiptState: 'Confirmed',
          finalOffset: Number(final.cursor.anchor.offset), finalRevision: Number(final.cursor.revision), fixtureRemoved: false};
      } catch (error) {failureStage ??= stage; throw error;}
      finally {
        const cleanupErrors: unknown[] = []; stage = 'cleanup';
        const remaining = currentChild();
        if (remaining !== null) {
          try {await remaining.killAndJoin();} catch (error) {cleanupErrors.push(error);}
          unfinished!.process = remaining.evidence();
          if (remaining.settled) retire();
        }
        const closed = await Promise.allSettled([bootstrap?.close(), intents?.close(), cursor?.close()]);
        for (const result of closed) if (result.status === 'rejected') cleanupErrors.push(result.reason);
        try {assertJoined();} catch (error) {cleanupErrors.push(error);}
        if (active === null && cleanupErrors.length === 0 && row !== null) {
          try {
            assert.ok(original); assert.ok(canonical);
            const now = await lstat(root); assert.equal(await realpath(root), canonical); assert.equal(dirname(canonical), parent);
            assert.equal(now.isSymbolicLink(), false); assert.equal(now.dev, original.dev); assert.equal(now.ino, original.ino);
            await rm(root, {recursive: true}); removed = true;
          } catch (error) {cleanupErrors.push(error);}
        }
        if (!removed) fixtureCleanupDebt++;
        if (row !== null) {row.fixtureRemoved = removed; rows.push(row);}
        if (unfinished !== null) unfinished.stage = failureStage ?? stage;
        if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'owned fixture cleanup failed');
      }
      assert.equal(active, null); assert.equal(removed, true); unfinished = null;
    }
    stage = 'aggregate-verification'; assert.equal(rows.length, 2); assert.equal(spawnedChildren, 4); assert.equal(settledChildren, 4);
    assert.equal(maxLive, 1); assert.equal(seedAttempts, 2); assert.equal(targetAttempts, 2); assert.equal(acceptances, 2);
    assert.equal(fixtureCleanupDebt, 0); assertJoined(); outcome = 'passed';
  } catch (error) {failureStage ??= stage; throw error;}
  finally {
    t.diagnostic('cursor-handoff-crash-summary ' + JSON.stringify({schemaVersion: 1, checkpoint: 936,
      qualification: 'partial Linux synthetic G5 cursor handoff crash custody', node: process.version,
      outcome, failureStage, limits, bootstrap: {cases: 2, records: 16, bytes: 4096, historicalTransportAttempts: 0,
        seedOffset: 4352, seedRevision: 2, targetBytes: 256},
      totals: {cases: rows.length, spawnedChildren, settledChildren, maxLiveChildren: maxLive, seedTransportAttempts: seedAttempts,
        targetTransportAttempts: targetAttempts, externalTargetAcceptances: acceptances}, cases: rows, unfinished,
      cleanup: {parentNativeHoldings: ownedWorkerUsage(), parentActiveFileReads: activeMirrorFileReads(),
        unconfirmedOwnedChildProcesses: active === null ? 0 : 1, fixtureCleanupDebt,
        killedChildHoldingsAfterDeath: 'not observable; only pre-death active holdings and actual process exit/close are evidenced'},
    }));
  }
});
