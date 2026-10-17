import test, {after, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {join, dirname} from 'node:path';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {remoteRuntimeInput, remoteInput, deferred, change, command} from '../../helpers/remote-runtime-fixture.ts';
import {RuntimeMeasurementRecorder, monotonicNs, type DriverInput, type DriverOutput, type MeasurementEvent} from '../../helpers/runtime-measurement.ts';
import {createSyntheticRuntimeRemoteProfile} from '../../../src/runtime/discord-runtime/remote-start.ts';
import {runLocalRuntimeApplication, LocalRuntimeOwnershipRetainedError} from '../../../src/runtime/discord-runtime/local-application.ts';
import {loadRuntimeConfig} from '../../../src/config/runtime.ts';
import {PosixRuntimeInstance} from '../../../src/runtime/runtime-instance.ts';
import {RuntimeStopSignal} from '../../../src/runtime/discord-runtime/stop-signal.ts';
import {RuntimeWorkerExitChannel} from '../../../src/runtime/discord-runtime/monitored-worker.ts';
import {RecommendedGateway} from '../../../src/discord/gateway/recommended.ts';
import {DRAIN_MARKER_NAMES} from '../../../src/runtime/restart-readiness/drain-marker.ts';
import {ownedWorkerUsage, ownedWorkerModuleUrl} from '../../../src/runtime/owned-worker-slot.ts';

const reports: unknown[] = [];
const sourceLimits = {connectionActive: 4, connectionTotal: 16, connectionWireBytes: 4194304};
const safetyGuardMs = 15000; // Test termination guard, never an acceptance threshold.
const failureChain = (error: unknown, depth = 0): readonly string[] => error instanceof Error && depth < 5 ? [error.name, ...failureChain(error.cause, depth + 1)] : [];
const failureName = (error: unknown): string => error instanceof Error ? error.name : 'NonErrorFailure';
async function boundedWait(check: () => boolean, name: string): Promise<void> {
  const deadline = performance.now() + safetyGuardMs;
  while (!check()) {assert.ok(performance.now() < deadline, `Safety guard: ${name}`); await delay(2);}
}
async function driver(recorder: RuntimeMeasurementRecorder) {
  const ready = deferred<Extract<DriverOutput, {kind: 'ready'}>>(), closed = deferred();
  const worker = new Worker(ownedWorkerModuleUrl(new URL('../../helpers/runtime-measurement-driver.ts', import.meta.url), import.meta.url));
  let announcedClosed = false;
  const exited = new Promise<number>(resolve => worker.once('exit', code => {
    if (!announcedClosed) {const error = new Error('Independent driver exited before close acknowledgement'); ready.reject(error); closed.reject(error);}
    resolve(code);
  }));
  // Keep setup/close failures observed even before the owner reaches that await.
  void ready.promise.catch(() => {}); void closed.promise.catch(() => {});
  const send = (value: DriverInput) => worker.postMessage(value);
  worker.on('error', error => {recorder.record({kind: 'driver-failure', atNs: monotonicNs(), outcome: failureName(error)}); ready.reject(error); closed.reject(error);});
  worker.on('message', (message: DriverOutput) => {
    if (message.kind === 'ready') {ready.resolve(message); return;}
    if (message.kind === 'closed') {announcedClosed = true; closed.resolve(); return;}
    if (message.kind === 'event') {try {recorder.record(message.event);} catch {recorder.record({kind: 'driver-failure', atNs: monotonicNs(), outcome: 'InvalidDriverEvent'});} return;}
    const atNs = monotonicNs();
    recorder.record({kind: 'probe-observed', atNs, plannedNs: message.plannedNs, probeId: message.probeId});
    recorder.record({kind: 'native-lane-sample', atNs, lanes: ownedWorkerUsage()});
    send({kind: 'probe-ack', probeId: message.probeId, observedNs: atNs});
  });
  return {...await ready.promise, send, close: async () => {send({kind: 'close'}); try {await closed.promise;} finally {const code = await exited; if (code !== 0) throw new Error('Independent driver failed to exit cleanly');}}};
}

// This complete workload, including every original ID and wire deadline, is
// declared before starting the root. No request is replayed or refreshed.
const threads = ['synthetic-expiry-project-0', 'synthetic-expiry-project-1', 'synthetic-expiry-project-2', 'synthetic-expiry-project-3'];
const validDeadline = '1970-01-01T00:03:20Z';
const initialClock = Object.freeze({seconds: 100n, nanosecond: 0n});
const identity = (role: string) => `synthetic-919-${role}-9007199254740993-é🧪`;
const operation = (role: string, thread: string, deadline: string, type: 'project_session' | 'write_file' = 'write_file') => {
  const id = identity(role);
  return Object.freeze({id, role, deadline, wire: command(type, {request_id: id, thread_id: thread, deadline_at: deadline,
    ...(type === 'project_session' ? {} : {content: 'synthetic-expiry-é🧪'})})});
};
const sessions = threads.map((thread, index) => operation(`session-${index}`, thread, validDeadline, 'project_session'));
const equality = operation('deadline-equality', threads[0]!, '1970-01-01T00:01:40Z');
const future = operation('deadline-plus-one-nanosecond', threads[0]!, '1970-01-01T00:01:40.000000001Z');
const waves = [110, 120, 130].map((seconds, index) => {
  const wave = index + 1;
  // Explicit UTC strings avoid deriving any deadline from real elapsed time.
  const queuedDeadline = ['1970-01-01T00:01:50Z', '1970-01-01T00:02:00Z', '1970-01-01T00:02:10Z'][index]!;
  return Object.freeze({wave, deadlineSeconds: seconds, queuedDeadline,
    held: threads.map((thread, i) => operation(`wave-${wave}-held-${i}`, thread, validDeadline)),
    queued: Array.from({length: 12}, (_, i) => operation(`wave-${wave}-queued-${i}`, threads[i % 4]!, queuedDeadline)),
    overflow: operation(`wave-${wave}-overflow`, threads[0]!, validDeadline),
    probe: operation(`wave-${wave}-fresh-probe`, threads[wave % 4]!, validDeadline)});
});
const operations = [...sessions, equality, future, ...waves.flatMap(wave => [...wave.held, ...wave.queued, wave.overflow, wave.probe])];
const contract = Object.freeze({roots: 1, projects: 4, waves: 3, activePerWave: 4, queuedPerWave: 12, overflowPerWave: 1,
  initialDispatcherClock: {seconds: '100', nanosecond: '0'}, queuedDeadlineSeconds: ['110', '120', '130'],
  advancedClockNanosecond: '1', validDeadlineSeconds: '200', bindingExpirySeconds: '300',
  expected: {declared: 60, injected: 60, wireResults: 60, projectSessionResults: 4, writeFileResults: 16,
    requestExpired: 37, bridgeBusy: 3, startedLeaves: 16, settledLeaves: 16, cancelledLeaves: 0, missingWireResults: 0},
  equalityBoundary: 'deadline == injected UTC expires; deadline == injected UTC + 1ns succeeds',
  timingVerdict: 'DETERMINISTIC_CLOCK_STRUCTURE_ONLY_NO_REAL_TIME_TIMEOUT_OR_PERFORMANCE_CLAIM'});

test('expiry measurement predeclares exact counts, unique Unicode IDs and fixed deadlines', () => {
  assert.equal(operations.length, contract.expected.declared);
  assert.equal(new Set(operations.map(item => item.id)).size, operations.length);
  for (const item of operations) {
    const wire = JSON.parse(item.wire) as {request_id: string; deadline_at: string};
    assert.equal(wire.request_id, item.id); assert.equal(wire.deadline_at, item.deadline);
    assert.ok(item.id.includes('9007199254740993-é🧪'));
    assert.ok(Buffer.byteLength(item.wire) > item.wire.length);
  }
  assert.equal(equality.deadline, '1970-01-01T00:01:40Z');
  assert.equal(future.deadline, '1970-01-01T00:01:40.000000001Z');
  for (const wave of waves) {
    assert.equal(wave.held.length, 4); assert.equal(wave.queued.length, 12);
    assert.ok([...wave.held, ...wave.queued, wave.overflow].reduce((bytes, item) => bytes + Buffer.byteLength(item.wire), 0) < sourceLimits.connectionWireBytes);
  }
});

test('bounded synthetic-root measurement: three expired-queue recovery waves', {timeout: 60000}, async t => {
  const recorder = new RuntimeMeasurementRecorder(), rootPath = mkdtempSync(join(tmpdir(), 'cdr-expiry-measurement-919-'));
  const input = remoteRuntimeInput(join(rootPath, 'mirror.sqlite')), stop = new AbortController();
  const held = new Map<string, ReturnType<typeof deferred<void>>>();
  const waveReceipts: unknown[] = [], clockTransitions: unknown[] = [], boundaryReceipts: unknown[] = [];
  let clock: Readonly<{seconds: bigint; nanosecond: bigint}> = initialClock;
  let ready = false, releases = 0, disposed = 0, runtimeJoined = false, retained = false;
  let runtimeError: unknown, scenarioError: unknown;
  let run: Promise<void> | undefined, socket: Awaited<ReturnType<typeof driver>> | undefined;
  const mono = () => clock.seconds * 1000000000n + clock.nanosecond;
  const event = (kind: string, extra: Omit<MeasurementEvent, 'kind' | 'atNs'> = {}) => recorder.record({kind, atNs: monotonicNs(), ...extra});
  const observed = (kind: string, id?: string) => recorder.events.some(e => e.kind === kind && (id === undefined || e.requestId === id));
  const count = (kind: string) => recorder.events.filter(e => e.kind === kind).length;
  const observedFailure = () => recorder.events.find(e => ['driver-failure', 'gateway-failure', 'send-failure'].includes(e.kind)
    || e.kind === 'remote-disconnected' && !stop.signal.aborted);
  const until = async (check: () => boolean, name: string) => {
    await boundedWait(() => check() || runtimeError !== undefined || observedFailure() !== undefined, name);
    if (runtimeError !== undefined) throw runtimeError;
    assert.equal(observedFailure(), undefined, `Observed failure while waiting for ${name}`);
  };
  const send = (items: readonly typeof operations[number][]) => socket!.send({kind: 'batch', wires: items.map(item => item.wire), spacingMs: 5});
  const result = (item: typeof operations[number], resultType: string, errorCode: string | null = null) => {
    const value = recorder.report().operations.find(candidate => candidate.requestId === item.id)!;
    assert.equal(value.resultType, resultType, item.role); assert.equal(value.errorCode, errorCode, item.role);
    assert.equal(value.sendFailure, null, item.role); assert.notEqual(value.sendCompletedNs, null, item.role);
    return value;
  };
  for (const item of operations) recorder.declare(item.id, item.role, item.wire);
  event('scenario-start');
  try {
    socket = await driver(recorder);
    const ports = remoteInput(socket.remoteUrl);
    change(ports.input.dispatcher, 'nowUtc', () => clock);
    change(ports.input.dispatcher, 'nowMonotonic', mono);
    change(ports.input, 'disconnected', async outcome => {event('remote-disconnected', {generation: outcome.generation.toString(),
      outcome: outcome.ok ? 'connection-ended' : 'connection-error', ...(outcome.ok ? {} : {errorChain: failureChain(outcome.error)})});});
    change(ports.input.handoff, 'restore', async () => Object.freeze(threads.map(threadId => Object.freeze({threadId,
      root: '/synthetic/project', expiresAt: Object.freeze({seconds: 300n, nanosecond: 0n})}))));
    change(ports.backend, 'writeFile', async (request, context) => {
      event('leaf-started', {requestId: request.request_id});
      const cancelled = () => event('leaf-cancelled', {requestId: request.request_id});
      context.signal.addEventListener('abort', cancelled, {once: true});
      if (context.signal.aborted) cancelled();
      try {
        // Both held-entry and actual-return budgets use the same injected clock.
        // An expired queued request must never reach either check or this leaf.
        assert.ok(context.budget.remaining(null, mono()) > 0n);
        await held.get(request.request_id)?.promise;
        assert.ok(context.budget.remaining(null, mono()) > 0n);
        event('leaf-settled', {requestId: request.request_id, outcome: context.signal.aborted ? 'returned-after-cancellation' : 'returned-success'});
        return Object.freeze({path: request.path, sha256: 'a'.repeat(64), bytes_written: BigInt(Buffer.byteLength(request.content)), created: true});
      } finally {context.signal.removeEventListener('abort', cancelled);}
    });
    change(ports.backend, 'close', async () => {event('project-closed');});
    const instance = {release: async () => {releases++; event('singleton-released');}} as unknown as PosixRuntimeInstance;
    t.mock.method(PosixRuntimeInstance, 'acquire', async (root: string) => {assert.equal(root, rootPath); event('synthetic-singleton-acquired'); return instance;});
    t.mock.method(RuntimeStopSignal, 'install', () => ({signal: stop.signal, dispose: () => {disposed++; event('stop-signal-disposed');}} as unknown as RuntimeStopSignal));
    const close = RuntimeWorkerExitChannel.prototype.close;
    t.mock.method(RuntimeWorkerExitChannel.prototype, 'close', function(this: RuntimeWorkerExitChannel) {ready = true; event('runtime-workers-started'); return close.call(this);});
    t.mock.method(RecommendedGateway, 'startPaused', async () => RecommendedGateway.startPausedForTest({httpOrigin: socket!.httpOrigin, gatewayUrl: socket!.gatewayUrl,
      messageContent: false, jitter: () => 0n, reportReceiveErrorDrop: () => event('gateway-failure', {outcome: 'receive-error'}),
      reportTriggerFailure: () => event('gateway-failure', {outcome: 'trigger-failure'}), reportHttpError: () => event('gateway-failure', {outcome: 'http-error'})}));
    const config = {...loadRuntimeConfig(new Map([['DISCORD_BOT_TOKEN', 'synthetic-root-bot'], ['DISCORD_ALLOW_ALL_CHANNELS', '1']])), sessionMirror: false};
    const env = {HOME: rootPath, CODEX_HOME: rootPath, CODEX_STATE_DB: input.paths.stateDb, CODEX_EXE: input.executor.pro.executable, CODEX_DISCORD_MIRROR_DB: input.paths.mirrorDb};
    event('runtime-start-requested');
    run = runLocalRuntimeApplication(config, env, rootPath, 'synthetic-expiry-measurement-919', undefined, undefined, createSyntheticRuntimeRemoteProfile(ports.input))
      .then(() => {runtimeJoined = true; event('runtime-joined', {outcome: 'success'});}, error => {runtimeError = error; retained = error instanceof LocalRuntimeOwnershipRetainedError;
        runtimeJoined = !retained; event('runtime-failed', {outcome: failureName(error), retained});});
    await until(() => ready && observed('remote-hello'), 'root startup');
    for (const item of sessions) {send([item]); await until(() => observed('result', item.id), 'session result'); result(item, 'project_session_result');}
    send([equality]); await until(() => observed('result', equality.id), 'equality expiry result');
    boundaryReceipts.push(result(equality, 'operation_error', 'request_expired'));
    assert.equal(observed('leaf-started', equality.id), false);
    send([future]); await until(() => observed('result', future.id), 'one-nanosecond future result');
    boundaryReceipts.push(result(future, 'write_file_result'));
    for (const wave of waves) {
      const waveStartNs = monotonicNs(), startedBefore = count('leaf-started'), settledBefore = count('leaf-settled');
      event(`wave-${wave.wave}-start`); if (wave.wave === 1) event('load-start');
      const release = deferred();
      for (const item of wave.held) held.set(item.id, release);
      send(wave.held);
      await until(() => wave.held.every(item => observed('leaf-started', item.id)), 'four held leaves');
      const heldSinceNs = monotonicNs();
      send([...wave.queued, wave.overflow]);
      await until(() => observed('result', wave.overflow.id), 'exact-ID overflow refusal');
      const refused = result(wave.overflow, 'operation_error', 'bridge_busy');
      assert.equal(count('leaf-started') - startedBefore, 4);
      assert.equal(count('leaf-settled') - settledBefore, 0);
      assert.equal(wave.queued.some(item => observed('leaf-started', item.id) || observed('result', item.id)), false);
      assert.equal(observed('leaf-started', wave.overflow.id), false);
      for (const item of [...wave.held, ...wave.queued]) {
        const observation = recorder.report().operations.find(candidate => candidate.requestId === item.id)!;
        assert.notEqual(observation.injectedNs, null); assert.notEqual(observation.sendCompletedNs, null);
        assert.ok(BigInt(observation.injectedNs!) < BigInt(refused.resultNs!));
        assert.ok(BigInt(observation.sendCompletedNs!) < BigInt(refused.resultNs!));
      }
      const progress = () => recorder.events.filter(e => BigInt(e.atNs) >= BigInt(heldSinceNs));
      await until(() => progress().some(e => e.kind === 'gateway-heartbeat') && progress().some(e => e.kind === 'probe-observed'), 'independent held-window heartbeat and probe');
      assert.equal(count('remote-disconnected'), 0);
      for (const item of wave.held) {
        assert.equal(observed('leaf-settled', item.id), false); assert.equal(observed('leaf-cancelled', item.id), false);
      }
      assert.equal(wave.queued.some(item => observed('result', item.id) || observed('leaf-started', item.id)), false);
      const clockBefore = {seconds: clock.seconds.toString(), nanosecond: clock.nanosecond.toString()};
      assert.ok(clock.seconds < BigInt(wave.deadlineSeconds));
      const advancedNs = monotonicNs();
      clock = Object.freeze({seconds: BigInt(wave.deadlineSeconds), nanosecond: 1n});
      assert.ok(clock.seconds < 200n && clock.seconds < 300n);
      assert.ok(BigInt(refused.resultNs!) < BigInt(advancedNs));
      clockTransitions.push({wave: wave.wave, atNs: advancedNs, before: clockBefore,
        after: {seconds: clock.seconds.toString(), nanosecond: clock.nanosecond.toString()}, observedOverflowId: wave.overflow.id,
        observedOverflowResultNs: refused.resultNs, heldCount: 4, queuedDeadlinesCrossed: 12, validHeldDeadlineSeconds: '200'});
      event(`wave-${wave.wave}-clock-advanced`);
      const heldReleaseNs = monotonicNs();
      event(`wave-${wave.wave}-held-release`); if (wave.wave === 1) event('held-release');
      release.resolve();
      await until(() => [...wave.held, ...wave.queued].every(item => observed('result', item.id)), 'held success and queued expiry results');
      for (const item of wave.held) result(item, 'write_file_result');
      for (const item of wave.queued) {
        const expired = result(item, 'operation_error', 'request_expired');
        assert.equal(observed('leaf-started', item.id), false);
        assert.ok(BigInt(expired.resultNs!) > BigInt(advancedNs));
        assert.ok(BigInt(expired.resultNs!) > BigInt(heldReleaseNs));
      }
      assert.equal(count('leaf-started') - startedBefore, 4);
      assert.equal(count('leaf-settled') - settledBefore, 4);
      assert.equal(count('leaf-cancelled'), 0); assert.equal(count('remote-disconnected'), 0);
      send([wave.probe]); await until(() => observed('result', wave.probe.id), 'fresh recovery probe result');
      result(wave.probe, 'write_file_result');
      const window = recorder.events.filter(e => BigInt(e.atNs) >= BigInt(heldSinceNs) && BigInt(e.atNs) <= BigInt(heldReleaseNs));
      waveReceipts.push({wave: wave.wave, structuralOutcome: 'completed', waveStartNs, heldSinceNs, heldReleaseNs, recoveredNs: monotonicNs(),
        heldIds: wave.held.map(item => item.id), queuedIds: wave.queued.map(item => item.id), overflowId: wave.overflow.id, freshProbeId: wave.probe.id,
        heldSuccessfulResults: 4, queuedExpiredResults: 12, explicitRefusals: 1, expiredBackendStarts: 0, freshSuccessfulProbes: 1,
        heldWindow: {gatewayHeartbeatNs: window.filter(e => e.kind === 'gateway-heartbeat').map(e => e.atNs),
          observedProbeIds: window.filter(e => e.kind === 'probe-observed').map(e => e.probeId!)}});
    }
    const report = recorder.report(), counts = report.externalCounts;
    assert.deepEqual(report.issues, []);
    for (const field of ['declared', 'injected', 'wireResults', 'startedLeaves', 'settledLeaves', 'missingWireResults'] as const) assert.equal(counts[field], contract.expected[field]);
    assert.equal(counts.wireErrors, 37); assert.equal(counts.explicitRefusals, 3); assert.equal(counts.cancellationObservedLeaves, 0);
    assert.equal(counts.stillActiveLeaves, 0); assert.equal(counts.peakActiveLeaves, 4); assert.equal(counts.finalInjectedBytesWithoutWireResult, 0);
    assert.equal(report.operations.filter(item => item.resultType === 'project_session_result').length, 4);
    assert.equal(report.operations.filter(item => item.resultType === 'write_file_result').length, 16);
    assert.equal(report.operations.filter(item => item.errorCode === 'request_expired').length, 37);
    assert.equal(report.diagnosticsNs.injectToWireResultIncludingErrors.samples, 60);
    assert.equal(count('remote-hello'), 1); assert.equal(count('remote-disconnected'), 0);
    event('shutdown-requested'); stop.abort(); await run;
    if (runtimeError !== undefined) throw runtimeError;
    assert.equal(runtimeJoined, true); assert.equal(releases, 1); assert.equal(disposed, 1);
    assert.equal(count('remote-hello'), 1); assert.equal(count('remote-disconnected'), 0);
    assert.equal(existsSync(join(rootPath, DRAIN_MARKER_NAMES.identity)), false);
    assert.deepEqual(ownedWorkerUsage(), {Background: 0, Control: 0, Observation: 0, Discovery: 0, Maintenance: 0});
    assert.equal(recorder.events.some(e => ['driver-failure', 'gateway-failure', 'send-failure'].includes(e.kind)
      || e.kind === 'remote-disconnected' && e.outcome === 'connection-error'), false);
  } catch (error) {scenarioError = error; event('scenario-failed', {outcome: failureName(error)});}
  finally {
    if (!stop.signal.aborted) event('shutdown-requested');
    for (const release of held.values()) release.resolve();
    stop.abort(); if (run !== undefined) await run;
    t.mock.restoreAll();
    if (socket !== undefined) try {await socket.close();} catch (error) {scenarioError ??= error; event('driver-cleanup-failed', {outcome: failureName(error)});}
    if (scenarioError === undefined && recorder.report().issues.length > 0) {scenarioError = new Error('Measurement accounting failed'); event('scenario-failed', {outcome: 'AccountingFailure'});}
    if (scenarioError === undefined) event('scenario-completed', {outcome: 'structural-assertions-completed-no-timing-verdict'});
    reports.push({scenario: 'three-expired-queue-recovery-waves', sourceLimits, safetyGuardMs,
      structuralOutcome: scenarioError === undefined ? 'completed' : 'failed', runtimeJoined, retained, singletonReleases: releases,
      stopSignalDisposals: disposed, markerRemains: existsSync(join(rootPath, DRAIN_MARKER_NAMES.identity)), finalNativeHeld: ownedWorkerUsage(),
      clockTransitions, boundaryReceipts, waves: waveReceipts, ...recorder.report()});
    if (!retained) rmSync(rootPath, {recursive: true});
  }
  if (scenarioError !== undefined) throw scenarioError;
});
after(() => {
  const destination = process.env.RUNTIME_EXPIRY_MEASUREMENT_OUTPUT;
  if (destination === undefined) return;
  const profile = JSON.parse(readFileSync(new URL('../../../measurement-profile.json', import.meta.url), 'utf8')) as unknown;
  mkdirSync(dirname(destination), {recursive: true});
  writeFileSync(destination, JSON.stringify({schemaVersion: 1, checkpoint: 919, classification: 'partial-synthetic-expired-queue-recovery-evidence',
    timingVerdict: 'UNQUALIFIED_DETERMINISTIC_CLOCK_NO_REAL_TIMEOUT_OR_MATCHED_RUST_RUN',
    units: {timestamps: 'process.hrtime nanoseconds as decimal strings; shared monotonic clock across worker threads', bytes: 'UTF-8 wire bytes',
      dispatcherClock: 'injected UTC seconds/nanosecond; injected budget monotonic nanoseconds advances in lockstep, not real elapsed time'},
    contract, profile, runtime: {node: process.version, sqlite: process.versions.sqlite, platform: process.platform, arch: process.arch},
    boundary: 'Actual prepared root with temporary SQLite, mock resident process, independent loopback driver, emitted native codecs and synthetic singleton seam',
    exclusions: ['real-time repeated timeouts', 'native singleton exclusion', 'native remote backends', 'protected durable handoff', 'all-lane saturation',
      'G4 closure', 'G7 comparison', 'operational qualification', '893 activation', '913 qualification'],
    expectedScenarioCount: 1, recordedScenarioCount: reports.length, scenarios: reports}, null, 2) + '\n');
});
