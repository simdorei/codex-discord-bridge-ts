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

type Scenario = 'held-versus-unrelated' | 'count-saturation' | 'byte-saturation-cancel-drain';
async function measure(t: TestContext, scenario: Scenario): Promise<void> {
  const recorder = new RuntimeMeasurementRecorder(), rootPath = mkdtempSync(join(tmpdir(), 'cdr-measurement-917-'));
  const input = remoteRuntimeInput(join(rootPath, 'mirror.sqlite')), stop = new AbortController(), release = deferred();
  const held = new Set<string>();
  let ready = false, releases = 0, disposed = 0, runtimeJoined = false, retained = false;
  let runtimeError: unknown, scenarioError: unknown;
  let run: Promise<void> | undefined, socket: Awaited<ReturnType<typeof driver>> | undefined;
  const observedFailure = () => recorder.events.find(e => ['driver-failure', 'gateway-failure', 'send-failure'].includes(e.kind) || e.kind === 'remote-disconnected' && e.outcome === 'connection-error');
  const until = async (check: () => boolean, name: string) => {
    await boundedWait(() => check() || observedFailure() !== undefined, name);
    assert.equal(observedFailure(), undefined, `Observed failure while waiting for ${name}`);
  };
  const event = (kind: string, extra: Omit<MeasurementEvent, 'kind' | 'atNs'> = {}) => recorder.record({kind, atNs: monotonicNs(), ...extra});
  const observed = (kind: string, id?: string) => recorder.events.some(e => e.kind === kind && (id === undefined || e.requestId === id));
  const count = (kind: string) => recorder.events.filter(e => e.kind === kind).length;
  const send = (id: string, role: string, threadId: string, content = 'synthetic', type: 'project_session' | 'write_file' = 'write_file') => {
    const wire = command(type, {request_id: id, thread_id: threadId, content, ...(type === 'project_session' ? {content: undefined} : {})});
    recorder.declare(id, role, wire); socket!.send({kind: 'batch', wires: [wire], spacingMs: 0}); return id;
  };
  const batch = (items: {id: string; thread: string; content: string; role: string}[]) => {
    const wires = items.map(item => {const wire = command('write_file', {request_id: item.id, thread_id: item.thread, content: item.content}); recorder.declare(item.id, item.role, wire); return wire;});
    socket!.send({kind: 'batch', wires, spacingMs: 5});
  };
  event('scenario-start');
  try {
    socket = await driver(recorder);
    const ports = remoteInput(socket.remoteUrl);
    change(ports.input, 'disconnected', async outcome => {event('remote-disconnected', {generation: outcome.generation.toString(), outcome: outcome.ok ? 'connection-ended' : 'connection-error', ...(outcome.ok ? {} : {errorChain: failureChain(outcome.error)})});});
    const threads = ['synthetic-project-0', 'synthetic-project-1', 'synthetic-project-2', 'synthetic-project-3'];
    change(ports.input.handoff, 'restore', async () => Object.freeze(threads.map(threadId => Object.freeze({threadId, root: '/synthetic/project', expiresAt: Object.freeze({seconds: 300n, nanosecond: 0n})}))));
    change(ports.backend, 'writeFile', async (request, context) => {
      event('leaf-started', {requestId: request.request_id});
      const cancelled = () => event('leaf-cancelled', {requestId: request.request_id});
      context.signal.addEventListener('abort', cancelled, {once: true});
      if (context.signal.aborted) cancelled();
      try {
        if (held.has(request.request_id)) await release.promise;
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
    run = runLocalRuntimeApplication(config, env, rootPath, 'synthetic-measurement-917', undefined, undefined, createSyntheticRuntimeRemoteProfile(ports.input))
      .then(() => {runtimeJoined = true; event('runtime-joined', {outcome: 'success'});}, error => {runtimeError = error; retained = error instanceof LocalRuntimeOwnershipRetainedError; runtimeJoined = !retained; event('runtime-failed', {outcome: failureName(error), retained});});
    await until(() => ready && observed('remote-hello') || runtimeError !== undefined, 'root startup');
    if (runtimeError !== undefined) throw runtimeError;
    for (const [index, thread] of threads.entries()) {
      const id = send(`synthetic-${scenario}-session-${index}`, 'session-setup', thread, '', 'project_session');
      await until(() => observed('result', id) || runtimeError !== undefined, 'session result');
      if (runtimeError !== undefined) throw runtimeError;
      assert.equal(recorder.report().operations.find(o => o.requestId === id)!.resultType, 'project_session_result');
    }
    event('load-start');
    if (scenario === 'held-versus-unrelated') {
      const heldId = 'synthetic-held-9007199254740993-é'; held.add(heldId); send(heldId, 'held-leaf', threads[0]!);
      await until(() => observed('leaf-started', heldId), 'held leaf start');
      const otherId = send('synthetic-unrelated-9007199254740995', 'unrelated-leaf', threads[1]!);
      await until(() => observed('result', otherId) || runtimeError !== undefined, 'unrelated result');
      assert.equal(observed('leaf-settled', heldId), false);
      assert.equal(recorder.report().operations.find(o => o.requestId === otherId)!.resultType, 'write_file_result');
      event('held-release'); release.resolve();
      await until(() => observed('result', heldId), 'held result');
      const heldOutcome = recorder.report().operations.find(o => o.requestId === heldId)!;
      assert.equal(heldOutcome.resultType, 'write_file_result'); assert.equal(heldOutcome.errorCode, null);
    } else {
      const holdIds = threads.map((thread, index) => {const id = `synthetic-${scenario}-held-${index}`; held.add(id); return {id, thread, content: 'held', role: 'held-leaf'};});
      batch(holdIds);
      await until(() => holdIds.every(item => observed('leaf-started', item.id)) || runtimeError !== undefined, 'four accepted held leaves');
      if (runtimeError !== undefined) throw runtimeError;
      const queuedCount = scenario === 'count-saturation' ? 12 : 5;
      const content = scenario === 'count-saturation' ? 'queued' : 'é'.repeat(400000);
      const queued = Array.from({length: queuedCount}, (_, index) => ({id: `synthetic-${scenario}-queued-${index}`, thread: threads[index % 4]!, content, role: 'queued-candidate'}));
      const refusedId = `synthetic-${scenario}-refused-9007199254740997-é`;
      batch([...queued, {id: refusedId, thread: threads[0]!, content, role: 'expected-explicit-refusal'}]);
      await until(() => observed('result', refusedId) || runtimeError !== undefined, 'saturation refusal');
      if (runtimeError !== undefined) throw runtimeError;
      assert.equal(recorder.report().operations.find(o => o.requestId === refusedId)!.errorCode, 'bridge_busy');
      assert.equal(recorder.report().operations.find(o => o.requestId === refusedId)!.resultType, 'operation_error');
      assert.equal(recorder.report().externalCounts.explicitRefusals, 1);
      assert.equal(count('leaf-started'), 4);
      assert.equal(queued.some(item => observed('leaf-started', item.id)), false);
      if (scenario === 'count-saturation') {
        event('held-release'); release.resolve();
        await until(() => [...holdIds, ...queued].every(item => observed('result', item.id)) || runtimeError !== undefined, 'released count workload results');
        if (runtimeError !== undefined) throw runtimeError;
        const outcomes = recorder.report();
        for (const item of [...holdIds, ...queued]) {
          const operation = outcomes.operations.find(o => o.requestId === item.id)!;
          assert.equal(operation.resultType, 'write_file_result'); assert.equal(operation.errorCode, null);
        }
        assert.equal(outcomes.externalCounts.startedLeaves, 16); assert.equal(outcomes.externalCounts.settledLeaves, 16);
        assert.equal(outcomes.externalCounts.explicitRefusals, 1); assert.equal(outcomes.externalCounts.missingWireResults, 0);
      } else {
        event('shutdown-requested'); stop.abort();
        await until(() => holdIds.every(item => observed('leaf-cancelled', item.id)), 'held leaf cancellation');
        event('held-cancellation-check', {retained: releases === 0 && !runtimeJoined && existsSync(join(rootPath, DRAIN_MARKER_NAMES.identity))});
        assert.equal(releases, 0); assert.equal(runtimeJoined, false); assert.equal(count('leaf-settled'), 0);
        assert.equal(existsSync(join(rootPath, DRAIN_MARKER_NAMES.identity)), true);
        event('held-release'); release.resolve();
        await run;
        assert.equal(queued.some(item => observed('leaf-started', item.id)), false);
        assert.equal(count('leaf-settled'), 4);
        const outcomes = recorder.report();
        assert.equal(outcomes.externalCounts.startedLeaves, 4); assert.equal(outcomes.externalCounts.cancellationObservedLeaves, 4);
        assert.equal(outcomes.externalCounts.missingWireResults, 9); assert.equal(outcomes.externalCounts.explicitRefusals, 1);
        assert.equal(outcomes.operations.filter(o => o.role === 'queued-candidate' && o.startedNs === null && o.resultNs === null).length, 5);
      }
    }
    if (!stop.signal.aborted) {event('shutdown-requested'); stop.abort();}
    await run;
    if (runtimeError !== undefined) throw runtimeError;
    assert.equal(runtimeJoined, true); assert.equal(releases, 1); assert.equal(disposed, 1);
    assert.equal(existsSync(join(rootPath, DRAIN_MARKER_NAMES.identity)), false);
    assert.deepEqual(ownedWorkerUsage(), {Background: 0, Control: 0, Observation: 0, Discovery: 0, Maintenance: 0});
    assert.ok(recorder.report().phaseObservations.loadUntilHeldRelease.gatewayHeartbeatNs.length > 0, 'Actual mock-gateway heartbeat must be observed while load is held');
    assert.equal(recorder.events.some(e => ['driver-failure', 'gateway-failure', 'send-failure'].includes(e.kind) || e.kind === 'remote-disconnected' && e.outcome === 'connection-error'), false, 'Observed failure remains part of this scenario');
  } catch (error) {scenarioError = error; event('scenario-failed', {outcome: failureName(error)});}
  finally {
    if (!stop.signal.aborted) event('shutdown-requested');
    release.resolve(); stop.abort();
    if (run !== undefined) await run;
    t.mock.restoreAll();
    if (socket !== undefined) try {await socket.close();} catch (error) {scenarioError ??= error; event('driver-cleanup-failed', {outcome: failureName(error)});}
    const report = recorder.report();
    if (scenarioError === undefined && report.issues.length > 0) {scenarioError = new Error('Measurement accounting failed'); event('scenario-failed', {outcome: 'AccountingFailure'});}
    if (scenarioError === undefined) event('scenario-completed', {outcome: 'structural-assertions-completed-no-timing-verdict'});
    reports.push({scenario, sourceLimits, safetyGuardMs, structuralOutcome: scenarioError === undefined ? 'completed' : 'failed', runtimeJoined, retained,
      ...recorder.report()});
    if (!retained) rmSync(rootPath, {recursive: true});

  }
  if (scenarioError !== undefined) throw scenarioError;
}
for (const scenario of ['held-versus-unrelated', 'count-saturation', 'byte-saturation-cancel-drain'] as const) {
  test(`bounded synthetic-root measurement: ${scenario}`, {timeout: 60000}, t => measure(t, scenario));
}
after(() => {
  const destination = process.env.RUNTIME_MEASUREMENT_OUTPUT;
  if (destination === undefined) return;
  const profileFile = new URL('../../../measurement-profile.json', import.meta.url);
  const profile = JSON.parse(readFileSync(profileFile, 'utf8')) as unknown;
  mkdirSync(dirname(destination), {recursive: true});
  writeFileSync(destination, JSON.stringify({schemaVersion: 1, checkpoint: 917, classification: 'partial-synthetic-G2-G4-evidence',
    timingVerdict: 'UNQUALIFIED_NO_PREDECLARED_THRESHOLDS_OR_MATCHED_RUST_RUN', units: {timestamps: 'process.hrtime nanoseconds as decimal strings; shared monotonic clock across worker threads', bytes: 'UTF-8 wire bytes'},
    profile, runtime: {node: process.version, sqlite: process.versions.sqlite, platform: process.platform, arch: process.arch},
    boundary: 'Actual prepared root with temporary SQLite, mock resident process, independent loopback driver, emitted native codecs and synthetic singleton seam',
    exclusions: ['native singleton exclusion', 'native remote backends', 'protected durable handoff', 'all-lane saturation', 'repeated timeouts', 'expired queued work', 'G7 comparison', 'operational qualification', '893 activation', '913 qualification'],
    expectedScenarioCount: 3, recordedScenarioCount: reports.length, scenarios: reports}, null, 2) + '\n');
});
