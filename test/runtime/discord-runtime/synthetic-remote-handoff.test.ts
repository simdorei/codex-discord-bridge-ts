import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createCipheriv, createDecipheriv, randomBytes} from 'node:crypto';
import fs from 'node:fs/promises';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {remoteRuntimeInput, remoteInput, remoteSocket, gatewaySocket, deferred, until, change, command} from '../../helpers/remote-runtime-fixture.ts';
import {createSyntheticRuntimeRemoteProfile, syntheticRuntimeRemoteSnapshot} from '../../../src/runtime/discord-runtime/remote-start.ts';
import {runLocalRuntimeApplication, LocalRuntimeOwnershipRetainedError} from '../../../src/runtime/discord-runtime/local-application.ts';
import {loadRuntimeConfig} from '../../../src/config/runtime.ts';
import {PosixRuntimeInstance} from '../../../src/runtime/runtime-instance.ts';
import {RuntimeStopSignal} from '../../../src/runtime/discord-runtime/stop-signal.ts';
import {RuntimeWorkerExitChannel} from '../../../src/runtime/discord-runtime/monitored-worker.ts';
import {RecommendedGateway} from '../../../src/discord/gateway/recommended.ts';
import {DRAIN_MARKER_NAMES} from '../../../src/runtime/restart-readiness/drain-marker.ts';
import {writePosixRestartHandoff, RestartHandoffPersistenceError, type RestartHandoffProtector} from '../../../src/remote-agent/restart-handoff-persistence.ts';
import {decodeRestartHandoffEnvelope, decodeRestartHandoffPayload, encodeRestartHandoffEnvelope} from '../../../src/remote-agent/restart-handoff-codec.ts';
import type {PosixRuntimeRestartHandoff} from '../../../src/remote-agent/restart-handoff-lifecycle.ts';
import type {RemoteOperationContext, RemoteProjectBinding} from '../../../src/remote-agent/dispatcher-ports.ts';
import type {PreparedRuntimeWorkerOwner} from '../../../src/runtime/discord-runtime/prepared-workers.ts';

const now = Object.freeze({seconds: 100n, nanosecond: 0n});
const expiresAt = Object.freeze({seconds: 300n, nanosecond: 0n});
/** Authenticated ephemeral test-only protection. The key is never persisted. */
function authenticated(): RestartHandoffProtector {
 const key = randomBytes(32);
 return {
  protect(bytes) {
   const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
   const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
   return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  },
  unprotect(bytes) {
   const input = Buffer.from(bytes), decipher = createDecipheriv('aes-256-gcm', key, input.subarray(0, 12));
   decipher.setAuthTag(input.subarray(12, 28));
   return Buffer.concat([decipher.update(input.subarray(28)), decipher.final()]);
  },
 };
}
function handoff(path: string, protector: RestartHandoffProtector, resumeRequested = true): PosixRuntimeRestartHandoff {
 return {kind: 'PosixCiphertextRestartHandoff', path, protector, resumeRequested};
}
function binding(ports: ReturnType<typeof remoteInput>) {
 return {bridgeUrl: ports.input.socket.bridgeUrl, deviceId: ports.input.socket.deviceId};
}
function replaceFs<K extends keyof typeof fs>(t: TestContext, name: K, replacement: typeof fs[K]) {
 const descriptor = Object.getOwnPropertyDescriptor(fs, name)!;
 Object.defineProperty(fs, name, {...descriptor, value: replacement}); syncBuiltinESMExports();
 let restored = false;
 const restore = () => { if (!restored) { restored = true; Object.defineProperty(fs, name, descriptor); syncBuiltinESMExports(); } };
 t.after(restore); return restore;
}
/** Explicit fake singleton, as in synthetic-remote-application.test.ts. The known
 * UNIX bind restriction is not retried; this proves custody, not lock exclusion. */
function rootSeam(t: TestContext, input: ReturnType<typeof remoteRuntimeInput>) {
 const stop = new AbortController(); let acquires = 0, releases = 0, disposed = 0, ready = false;
 const instance = {release: async () => { releases++; }} as unknown as PosixRuntimeInstance;
 t.mock.method(PosixRuntimeInstance, 'acquire', async (root: string) => { assert.equal(root, input.paths.root); acquires++; return instance; });
 t.mock.method(RuntimeStopSignal, 'install', () => ({signal: stop.signal, dispose: () => { disposed++; }} as unknown as RuntimeStopSignal));
 const close = RuntimeWorkerExitChannel.prototype.close;
 t.mock.method(RuntimeWorkerExitChannel.prototype, 'close', function(this: RuntimeWorkerExitChannel) { ready = true; return close.call(this); });
 const config = {...loadRuntimeConfig(new Map([['DISCORD_BOT_TOKEN', 'synthetic-root-handoff'], ['DISCORD_ALLOW_ALL_CHANNELS', '1']])), sessionMirror: false};
 const env = {HOME: input.paths.root, CODEX_HOME: input.paths.root, CODEX_STATE_DB: input.paths.stateDb, CODEX_EXE: input.executor.pro.executable, CODEX_DISCORD_MIRROR_DB: input.paths.mirrorDb};
 return {stop, config, env, counts: () => ({acquires, releases, disposed, ready})};
}
function retained(root: ReturnType<typeof rootSeam>, input: ReturnType<typeof remoteRuntimeInput>, settled: boolean) {
 assert.equal(settled, false);
 assert.equal(root.counts().acquires, 1);
 assert.equal(root.counts().releases, 0);
 assert.equal(root.counts().disposed, 0);
 assert.equal(existsSync(join(input.paths.root, DRAIN_MARKER_NAMES.identity)), true);
 process.kill(Number(readFileSync(join(input.paths.root, 'pid'), 'utf8')), 0);
}
function released(root: ReturnType<typeof rootSeam>, input: ReturnType<typeof remoteRuntimeInput>) {
 assert.equal(root.counts().releases, 1);
 assert.equal(root.counts().disposed, 1);
 assert.equal(existsSync(join(input.paths.root, DRAIN_MARKER_NAMES.identity)), false);
}
async function claimedFiles(root: string) { return (await fs.readdir(root)).filter(name => name.includes('.claimed.')); }
async function plaintext(path: string, protector: RestartHandoffProtector) {
 const envelope = decodeRestartHandoffEnvelope(await fs.readFile(path, 'utf8'));
 return Buffer.from(await protector.unprotect(Buffer.from(envelope.ciphertext, 'base64'))).toString('utf8');
}

// All IO hooks are restored before the next test. Tests in this file are serial.
test('POSIX runtime profile capture is passive and requires exact canonical loopback spelling', async t => storeFixture(async path => {
 const ports = remoteInput('ws://127.0.0.1:1234/'), destination = join(path, 'uncreated', 'handoff.json');
 let clock = 0, protect = 0, unprotect = 0, io = 0;
 change(ports.input.dispatcher, 'nowUtc', () => { clock++; return now; });
 const protector: RestartHandoffProtector = {protect: bytes => { protect++; return bytes; }, unprotect: bytes => { unprotect++; return bytes; }};
 const original = {stat: fs.stat, open: fs.open, rename: fs.rename, unlink: fs.unlink, mkdir: fs.mkdir, realpath: fs.realpath};
 const restorers = (Object.keys(original) as (keyof typeof original)[]).map(name => replaceFs(t, name, ((...args: unknown[]) => { io++; return Reflect.apply(original[name], fs, args); }) as typeof fs[typeof name]));
 try {
  const profile = createSyntheticRuntimeRemoteProfile({...ports.input, handoff: handoff(destination, protector)});
  assert.equal(syntheticRuntimeRemoteSnapshot(profile).phase, 'new');
  for (const url of ['ws://127.0.0.1:1234', 'ws://127.1:1234/', 'ws://127.0.0.1:1234/a/../', 'ws://localhost:1234/', 'ws://127.0.0.1:1234/#fragment', 'ws://user@127.0.0.1:1234/', 'wss://127.0.0.1:1234/']) {
   assert.throws(() => createSyntheticRuntimeRemoteProfile({...ports.input, socket: {...ports.input.socket, bridgeUrl: url}, handoff: handoff(destination, protector)}));
  }
  // The old explicit fixture branch keeps its established URL contract.
  assert.equal(syntheticRuntimeRemoteSnapshot(createSyntheticRuntimeRemoteProfile(remoteInput().input)).phase, 'new');
  assert.deepEqual({clock, protect, unprotect, io}, {clock: 0, protect: 0, unprotect: 0, io: 0});
  assert.equal(existsSync(destination), false);
 } finally { for (const restore of restorers.reverse()) restore(); }
}));

test('root custody spans actual unprotect and claim unlink before any project, gateway or dial', {timeout: 20000}, async t => storeFixture(async path => {
 const input = remoteRuntimeInput(path), root = rootSeam(t, input), destination = join(input.paths.root, 'handoff.json');
 const ws = await remoteSocket(() => { throw Error('unexpected remote dial'); });
 const ports = remoteInput(ws.url + '/'), crypto = authenticated(), link = join(input.paths.root, 'project-link');
 await fs.symlink(join(input.paths.root, 'project'), link);
 await writePosixRestartHandoff(destination, [{threadId: 'original', root: link, expiresAt}], binding(ports), now, crypto);
 const unprotectEntered = deferred(), unprotectRelease = deferred(), unlinkEntered = deferred(), unlinkRelease = deferred(), closeEntered = deferred(), closeRelease = deferred();
 const primary = Error('gateway construction failed after restore'); let settled = false, gatewayCalls = 0, unprotects = 0, clocks = 0;
 const events: string[] = [], restored: RemoteProjectBinding[] = [];
 change(ports.input.dispatcher, 'nowUtc', () => { clocks++; return now; });
 change(ports.input.dispatcher, 'openProject', async value => { events.push('open'); restored.push(value); return ports.backend; });
 change(ports.backend, 'close', async () => { events.push('project-close'); closeEntered.resolve(); await closeRelease.promise; });
 const protector: RestartHandoffProtector = {...crypto, unprotect: async bytes => { unprotects++; events.push('unprotect'); unprotectEntered.resolve(); await unprotectRelease.promise; return crypto.unprotect(bytes); }};
 const option = handoff(destination, protector), profile = createSyntheticRuntimeRemoteProfile({...ports.input, handoff: option});
 // Mutating every source after capture cannot redirect restoration or binding.
 change(option, 'path', join(input.paths.root, 'wrong.json'));
 change(option, 'resumeRequested', false);
 change(protector, 'unprotect', () => { throw Error('replacement protector must not run'); });
 change(ports.input.dispatcher, 'nowUtc', () => { throw Error('replacement clock must not run'); });
 change(ports.input.socket, 'deviceId', 'replacement-device');
 change(ports.input.socket, 'bridgeUrl', 'ws://127.0.0.1:1/');
 const originalUnlink = fs.unlink;
 const restoreFs = replaceFs(t, 'unlink', async target => {
  if (String(target).includes('.handoff.json.claimed.')) { events.push('unlink'); unlinkEntered.resolve(); await unlinkRelease.promise; }
  return originalUnlink(target);
 });
 t.mock.method(RecommendedGateway, 'startPaused', async () => { gatewayCalls++; assert.equal((await claimedFiles(input.paths.root)).length, 0); throw primary; });
 const pending = runLocalRuntimeApplication(root.config, root.env, input.paths.root, 'fixture', undefined, undefined, profile);
 const outcome = pending.then(() => { settled = true; return undefined; }, error => { settled = true; return error; });
 try {
  await unprotectEntered.promise;
  retained(root, input, settled); assert.equal(existsSync(destination), false); assert.equal((await claimedFiles(input.paths.root)).length, 1);
  assert.equal(restored.length, 0); assert.equal(gatewayCalls, 0); assert.equal(ws.count(), 0);
  unprotectRelease.resolve(); await unlinkEntered.promise; await delay(5);
  retained(root, input, settled); assert.equal(restored.length, 0); assert.equal(gatewayCalls, 0); assert.equal(ws.count(), 0);
  unlinkRelease.resolve(); await closeEntered.promise;
  retained(root, input, settled); assert.equal(gatewayCalls, 1); assert.equal(ws.count(), 0); assert.equal(unprotects, 1); assert.equal(clocks, 1);
  assert.deepEqual(restored, [{threadId: 'original', root: await fs.realpath(link), expiresAt}]);
  assert.deepEqual(events, ['unprotect', 'unlink', 'open', 'project-close']);
  closeRelease.resolve(); assert.equal(await outcome, primary); released(root, input);
  assert.equal((await claimedFiles(input.paths.root)).length, 0);
 } finally {
  unprotectRelease.resolve(); unlinkRelease.resolve(); closeRelease.resolve(); root.stop.abort(); await outcome;
  restoreFs(); t.mock.restoreAll(); await ws.close();
 }
}));

test('startup cancellation joins held decryption and unlink before releasing root without remote exposure', {timeout: 20000}, async t => storeFixture(async path => {
 const input = remoteRuntimeInput(path), root = rootSeam(t, input), destination = join(input.paths.root, 'handoff.json'), crypto = authenticated();
 const ws = await remoteSocket(() => { throw Error('unexpected remote dial'); }), ports = remoteInput(ws.url + '/');
 await writePosixRestartHandoff(destination, [{threadId: 'original', root: join(input.paths.root, 'project'), expiresAt}], binding(ports), now, crypto);
 const decryptEntered = deferred(), decryptRelease = deferred(), unlinkEntered = deferred(), unlinkRelease = deferred();
 const cancelled = Error('stop during actual ciphertext restore'); let settled = false, gatewayCalls = 0;
 const profile = createSyntheticRuntimeRemoteProfile({...ports.input, handoff: handoff(destination, {...crypto, unprotect: async bytes => { decryptEntered.resolve(); await decryptRelease.promise; return crypto.unprotect(bytes); }})});
 const originalUnlink = fs.unlink;
 const restoreFs = replaceFs(t, 'unlink', async target => {
  if (String(target).includes('.handoff.json.claimed.')) { unlinkEntered.resolve(); await unlinkRelease.promise; }
  return originalUnlink(target);
 });
 t.mock.method(RecommendedGateway, 'startPaused', async () => { gatewayCalls++; throw Error('unexpected gateway'); });
 const outcome = runLocalRuntimeApplication(root.config, root.env, input.paths.root, 'fixture', undefined, undefined, profile).then(() => { settled = true; return undefined; }, error => { settled = true; return error; });
 try {
  await decryptEntered.promise; root.stop.abort(cancelled); await delay(5);
  retained(root, input, settled); assert.equal(ports.counts().opens, 0); assert.equal(gatewayCalls, 0); assert.equal(ws.count(), 0);
  decryptRelease.resolve(); await unlinkEntered.promise; await delay(5);
  retained(root, input, settled); assert.equal(ports.counts().opens, 0); assert.equal(gatewayCalls, 0); assert.equal(ws.count(), 0);
  assert.equal((await claimedFiles(input.paths.root)).length, 1);
  unlinkRelease.resolve(); assert.equal(await outcome, cancelled); released(root, input);
  assert.equal(ports.counts().opens, 0); assert.equal(gatewayCalls, 0); assert.equal(ws.count(), 0); assert.equal(existsSync(destination), false); assert.equal((await claimedFiles(input.paths.root)).length, 0);
 } finally { decryptRelease.resolve(); unlinkRelease.resolve(); root.stop.abort(); await outcome; restoreFs(); t.mock.restoreAll(); await ws.close(); }
}));

test('unprotect error remains primary after actual claimed-file cleanup failure and exposes no remote authority', {timeout: 15000}, async t => storeFixture(async path => {
 const input = remoteRuntimeInput(path), root = rootSeam(t, input), destination = join(input.paths.root, 'handoff.json');
 const ports = remoteInput('ws://127.0.0.1:1234/'), crypto = authenticated();
 await writePosixRestartHandoff(destination, [{threadId: 'original', root: join(input.paths.root, 'project'), expiresAt}], binding(ports), now, crypto);
 let gatewayCalls = 0, unlinks = 0, settled = false;
 const cleanupEntered = deferred(), cleanupRelease = deferred(), originalUnlink = fs.unlink;
 const restoreFs = replaceFs(t, 'unlink', async target => {
  if (String(target).includes('.handoff.json.claimed.')) { unlinks++; cleanupEntered.resolve(); await cleanupRelease.promise; throw Error('private claim cleanup detail'); }
  return originalUnlink(target);
 });
 const profile = createSyntheticRuntimeRemoteProfile({...ports.input, handoff: handoff(destination, {...crypto, unprotect: () => { throw Error('private decryption detail'); }})});
 t.mock.method(RecommendedGateway, 'startPaused', async () => { gatewayCalls++; throw Error('unexpected gateway'); });
 const outcome = runLocalRuntimeApplication(root.config, root.env, input.paths.root, 'fixture', undefined, undefined, profile).then(() => { settled = true; return undefined; }, error => { settled = true; return error; });
 try {
  await cleanupEntered.promise; retained(root, input, settled); assert.equal(ports.counts().opens, 0); assert.equal(gatewayCalls, 0);
  cleanupRelease.resolve(); const error = await outcome;
  assert.ok(error instanceof RestartHandoffPersistenceError); assert.equal(error.code, 'UnprotectionFailed'); assert.equal(error.cause, undefined);
  assert.equal(unlinks, 1); assert.equal(ports.counts().opens, 0); assert.equal(gatewayCalls, 0); released(root, input);
  assert.equal(existsSync(destination), false); assert.equal((await claimedFiles(input.paths.root)).length, 1);
 } finally { cleanupRelease.resolve(); root.stop.abort(); await outcome; restoreFs(); t.mock.restoreAll(); }
}));

test('two root lifetimes join command, session, project, protection and actual rename before encrypted restart handoff', {timeout: 30000}, async t => storeFixture(async path => {
 const input = remoteRuntimeInput(path), destination = join(input.paths.root, 'handoff.json'), crypto = authenticated();
 const commandEntered = deferred(), commandRelease = deferred(), sessionEntered = deferred(), sessionRelease = deferred(), projectEntered = deferred(), projectRelease = deferred(), protectEntered = deferred(), protectRelease = deferred(), renameEntered = deferred(), renameRelease = deferred();
 const stages: string[] = []; let accepted: RemoteOperationContext | undefined, protections = 0, firstSettled = false, secondSettled = false;
 const ws = await remoteSocket((peer, index) => peer.once('message', () => {
  peer.send('{"type":"hello_ack"}');
  if (index === 1) { peer.send(command('project_session')); peer.once('message', () => peer.send(command('write_file', {request_id: 'held-write'}))); }
 }));
 const ports = remoteInput(ws.url + '/'), socket = await gatewaySocket();
 const capturedBinding = binding(ports), projectRoot = join(input.paths.root, 'project');
 await writePosixRestartHandoff(destination, [{threadId: 'original', root: projectRoot, expiresAt}], capturedBinding, now, crypto);
 change(ports.backend, 'writeFile', async (value, context) => { stages.push('command'); accepted = context; commandEntered.resolve(); await commandRelease.promise; return Object.freeze({path: value.path, sha256: 'a'.repeat(64), bytes_written: 1n, created: true}); });
 change(ports.session, 'stopComputer', async () => { stages.push('computer'); sessionEntered.resolve(); await sessionRelease.promise; });
 change(ports.session, 'closeTerminalWindows', async () => { stages.push('windows'); });
 change(ports.session, 'closeTerminals', async () => { stages.push('terminals'); });
 change(ports.backend, 'close', async () => { stages.push('project'); projectEntered.resolve(); await projectRelease.promise; });
 const protector: RestartHandoffProtector = {...crypto, protect: async bytes => { protections++; stages.push('protect'); protectEntered.resolve(); await protectRelease.promise; return crypto.protect(bytes); }};
 const profile = createSyntheticRuntimeRemoteProfile({...ports.input, handoff: handoff(destination, protector)});
 const originalRename = fs.rename;
 const restoreFs = replaceFs(t, 'rename', async (source, target) => {
  if (String(target) === destination) { stages.push('rename'); renameEntered.resolve(); await renameRelease.promise; }
  return originalRename(source, target);
 });
 let root = rootSeam(t, input);
 t.mock.method(RecommendedGateway, 'startPaused', async () => { assert.equal(ports.counts().opens, 1); assert.equal(existsSync(destination), false); assert.equal((await claimedFiles(input.paths.root)).length, 0); return RecommendedGateway.startPausedForTest(socket); });
 const firstOutcome = runLocalRuntimeApplication(root.config, root.env, input.paths.root, 'fixture', undefined, undefined, profile).then(() => { firstSettled = true; return undefined; }, error => { firstSettled = true; return error; });
 let secondOutcome: Promise<unknown> | undefined;
 try {
  await commandEntered.promise; await until(() => root.counts().ready);
  writeFileSync(join(input.paths.root, DRAIN_MARKER_NAMES.restart), 'restart'); root.stop.abort(); await until(() => accepted!.signal.aborted);
  retained(root, input, firstSettled); assert.equal(protections, 0); assert.equal(syntheticRuntimeRemoteSnapshot(profile).handoffRequested, true);
  commandRelease.resolve(); await sessionEntered.promise;
  retained(root, input, firstSettled); assert.deepEqual(stages, ['command', 'computer']); assert.equal(protections, 0);
  sessionRelease.resolve(); await projectEntered.promise;
  retained(root, input, firstSettled); assert.deepEqual(stages, ['command', 'computer', 'windows', 'terminals', 'project']); assert.equal(protections, 0);
  projectRelease.resolve(); await protectEntered.promise;
  retained(root, input, firstSettled); assert.equal(existsSync(destination), false); assert.equal(protections, 1);
  protectRelease.resolve(); await renameEntered.promise;
  retained(root, input, firstSettled); assert.equal(existsSync(destination), false);
  renameRelease.resolve(); assert.equal(await firstOutcome, undefined); released(root, input);
  assert.deepEqual(stages, ['command', 'computer', 'windows', 'terminals', 'project', 'protect', 'rename']);
  const stored = await fs.readFile(destination, 'utf8'); assert.equal((await fs.stat(destination)).mode & 0o777, 0o600);
  for (const secret of [projectRoot, 'original', 'held-write', 'abcdefghijklmnop', capturedBinding.deviceId, capturedBinding.bridgeUrl, 'synthetic-runtime-fixture']) assert.equal(stored.includes(secret), false);
  const plain = await plaintext(destination, crypto), payload = decodeRestartHandoffPayload(plain, capturedBinding, now), wire = JSON.parse(plain);
  assert.deepEqual(payload.projects, [{threadId: 'original', root: projectRoot, expiresAt}]);
  assert.deepEqual(Object.keys(wire), ['format_version', 'protocol_version', 'gateway_fingerprint', 'created_at', 'resume_until', 'projects']);
  assert.deepEqual(Object.keys(wire.projects[0]), ['thread_id', 'root', 'expires_at']);
  assert.equal(wire.created_at, '1970-01-01T00:01:40Z'); assert.equal(wire.resume_until, '1970-01-01T00:03:40Z');

  // The same encrypted file is consumed by a fresh runtime with fresh sessions.
  restoreFs(); t.mock.restoreAll(); await fs.unlink(join(input.paths.root, DRAIN_MARKER_NAMES.restart));
  const second = remoteInput(ws.url + '/'); let secondUnprotects = 0, sessionCreates = 0; const restored: RemoteProjectBinding[] = [];
  change(second.input.dispatcher, 'openProject', async value => { restored.push(value); return second.backend; });
  change(second.backend, 'createSession', async () => { sessionCreates++; return second.session; });
  const next = createSyntheticRuntimeRemoteProfile({...second.input, handoff: handoff(destination, {...crypto, unprotect: bytes => { secondUnprotects++; return crypto.unprotect(bytes); }})});
  root = rootSeam(t, input);
  t.mock.method(RecommendedGateway, 'startPaused', async () => { assert.equal(existsSync(destination), false); assert.equal((await claimedFiles(input.paths.root)).length, 0); assert.equal(restored.length, 1); return RecommendedGateway.startPausedForTest(socket); });
  secondOutcome = runLocalRuntimeApplication(root.config, root.env, input.paths.root, 'fixture', undefined, undefined, next).then(() => { secondSettled = true; return undefined; }, error => { secondSettled = true; return error; });
  await until(() => root.counts().ready && ws.count() === 2 && syntheticRuntimeRemoteSnapshot(next).status.connected);
  assert.deepEqual(restored, [{threadId: 'original', root: projectRoot, expiresAt}]); assert.equal(secondUnprotects, 1); assert.equal(sessionCreates, 0);
  root.stop.abort(); assert.equal(await secondOutcome, undefined); assert.equal(secondSettled, true); released(root, input);
  assert.equal(syntheticRuntimeRemoteSnapshot(next).handoffRequested, false); assert.equal(existsSync(destination), false); assert.equal((await claimedFiles(input.paths.root)).length, 0);
 } finally {
  for (const gate of [commandRelease, sessionRelease, projectRelease, protectRelease, renameRelease]) gate.resolve();
  root.stop.abort(); await firstOutcome; if (secondOutcome !== undefined) await secondOutcome;
  restoreFs(); t.mock.restoreAll(); await ws.close(); await socket.close();
 }
}));

// Releasing these fake outer fixtures after assertions is test teardown only,
// never evidence that a failed remote cleanup granted production release authority.
async function disposeRetainedFixture(error: LocalRuntimeOwnershipRetainedError) {
 const owners = error.owners as {
  workers?: PreparedRuntimeWorkerOwner;
  context?: {disposeBeforeWorkers: () => Promise<void>};
  gateway?: {close: () => Promise<void>}; attachment?: {close: () => Promise<void>};
  controller?: {dispose: () => Promise<void>}; instance?: {release: () => Promise<void>}; stop: {dispose: () => void};
 };
 if (owners.workers !== undefined) { await owners.workers.close(); owners.workers.heartbeat.requestStop(); await owners.workers.heartbeat.worker.join(); owners.workers.disposeMonitor(); }
 await owners.context?.disposeBeforeWorkers(); await owners.gateway?.close(); await owners.attachment?.close(); await owners.controller?.dispose(); await owners.instance?.release(); owners.stop.dispose();
}

test('failed project cleanup retains root and resident after restart request and never protects a handoff', {timeout: 20000}, async t => storeFixture(async path => {
 const input = remoteRuntimeInput(path), root = rootSeam(t, input), destination = join(input.paths.root, 'handoff.json'), crypto = authenticated();
 const ws = await remoteSocket(peer => peer.once('message', () => peer.send('{"type":"hello_ack"}'))), socket = await gatewaySocket(), ports = remoteInput(ws.url + '/');
 await writePosixRestartHandoff(destination, [{threadId: 'original', root: join(input.paths.root, 'project'), expiresAt}], binding(ports), now, crypto);
 let protections = 0, closes = 0; let retainedError: LocalRuntimeOwnershipRetainedError | undefined;
 change(ports.backend, 'close', async () => { closes++; throw Error('project cleanup did not join'); });
 const profile = createSyntheticRuntimeRemoteProfile({...ports.input, handoff: handoff(destination, {...crypto, protect: bytes => { protections++; return crypto.protect(bytes); }})});
 t.mock.method(RecommendedGateway, 'startPaused', async () => RecommendedGateway.startPausedForTest(socket));
 const outcome = runLocalRuntimeApplication(root.config, root.env, input.paths.root, 'fixture', undefined, undefined, profile).then(() => undefined, error => error);
 try {
  await until(() => root.counts().ready && syntheticRuntimeRemoteSnapshot(profile).status.connected);
  writeFileSync(join(input.paths.root, DRAIN_MARKER_NAMES.restart), 'restart'); root.stop.abort();
  const error = await outcome; assert.ok(error instanceof LocalRuntimeOwnershipRetainedError); retainedError = error;
  assert.equal(root.counts().releases, 0); assert.equal(root.counts().disposed, 0); assert.equal(existsSync(join(input.paths.root, DRAIN_MARKER_NAMES.identity)), true);
  process.kill(Number(readFileSync(join(input.paths.root, 'pid'), 'utf8')), 0);
  assert.equal(closes, 1); assert.equal(protections, 0); assert.equal(existsSync(destination), false);
 } finally { root.stop.abort(); await outcome; if (retainedError !== undefined) await disposeRetainedFixture(retainedError); t.mock.restoreAll(); await ws.close(); await socket.close(); }
}));

for (const failure of ['protect', 'rename'] as const) {
 test(`root joins confirmed cleanup after ${failure} failure without a published handoff`, {timeout: 20000}, async t => storeFixture(async path => {
  const input = remoteRuntimeInput(path), root = rootSeam(t, input), destination = join(input.paths.root, 'handoff.json'), crypto = authenticated();
  const ws = await remoteSocket(peer => peer.once('message', () => peer.send('{"type":"hello_ack"}'))), socket = await gatewaySocket(), ports = remoteInput(ws.url + '/');
  await writePosixRestartHandoff(destination, [{threadId: 'original', root: join(input.paths.root, 'project'), expiresAt}], binding(ports), now, crypto);
  let closes = 0, protections = 0, renames = 0;
  change(ports.backend, 'close', async () => { closes++; });
  const protector: RestartHandoffProtector = {...crypto, protect: bytes => { protections++; assert.equal(closes, 1); if (failure === 'protect') throw Error('private protection failure'); return crypto.protect(bytes); }};
  const originalRename = fs.rename;
  const restoreFs = replaceFs(t, 'rename', async (source, target) => { if (String(target) === destination) { renames++; throw Error('private publication failure'); } return originalRename(source, target); });
  const profile = createSyntheticRuntimeRemoteProfile({...ports.input, handoff: handoff(destination, protector)});
  t.mock.method(RecommendedGateway, 'startPaused', async () => RecommendedGateway.startPausedForTest(socket));
  const outcome = runLocalRuntimeApplication(root.config, root.env, input.paths.root, 'fixture', undefined, undefined, profile).then(() => undefined, error => error);
  try {
   await until(() => root.counts().ready && syntheticRuntimeRemoteSnapshot(profile).status.connected);
   writeFileSync(join(input.paths.root, DRAIN_MARKER_NAMES.restart), 'restart'); root.stop.abort();
   const error = await outcome; assert.ok(error instanceof RestartHandoffPersistenceError); assert.equal(error.code, failure === 'protect' ? 'ProtectionFailed' : 'PublicationFailed');
   released(root, input); assert.equal(closes, 1); assert.equal(protections, 1); assert.equal(renames, failure === 'protect' ? 0 : 1);
   assert.equal(existsSync(destination), false); assert.equal((await fs.readdir(input.paths.root)).some(name => name.startsWith('.cdr-runtime-') || name.includes('.claimed.')), false);
  } finally { root.stop.abort(); await outcome; restoreFs(); t.mock.restoreAll(); await ws.close(); await socket.close(); }
 }));
}

test('a newer ciphertext publication survives removal of an older claim held in runtime decryption', {timeout: 20000}, async t => storeFixture(async path => {
 const input = remoteRuntimeInput(path), root = rootSeam(t, input), destination = join(input.paths.root, 'handoff.json'), crypto = authenticated();
 const ws = await remoteSocket(() => { throw Error('unexpected remote dial'); }), ports = remoteInput(ws.url + '/');
 const projectRoot = join(input.paths.root, 'project'), capturedBinding = binding(ports);
 await writePosixRestartHandoff(destination, [{threadId: 'original', root: projectRoot, expiresAt}], capturedBinding, now, crypto);
 const decryptEntered = deferred(), decryptRelease = deferred(), primary = Error('gateway stopped after old claim restoration');
 let settled = false, gatewayCalls = 0; const restored: RemoteProjectBinding[] = [];
 change(ports.input.dispatcher, 'openProject', async value => { restored.push(value); return ports.backend; });
 const profile = createSyntheticRuntimeRemoteProfile({...ports.input, handoff: handoff(destination, {...crypto, unprotect: async bytes => { decryptEntered.resolve(); await decryptRelease.promise; return crypto.unprotect(bytes); }})});
 t.mock.method(RecommendedGateway, 'startPaused', async () => { gatewayCalls++; assert.equal((await claimedFiles(input.paths.root)).length, 0); throw primary; });
 const outcome = runLocalRuntimeApplication(root.config, root.env, input.paths.root, 'fixture', undefined, undefined, profile).then(() => { settled = true; return undefined; }, error => { settled = true; return error; });
 try {
  await decryptEntered.promise; retained(root, input, settled);
  assert.equal(existsSync(destination), false); assert.equal((await claimedFiles(input.paths.root)).length, 1);
  assert.equal(restored.length, 0); assert.equal(gatewayCalls, 0); assert.equal(ws.count(), 0);
  const newer = [{threadId: 'newer-publication', root: projectRoot, expiresAt}];
  assert.equal(await writePosixRestartHandoff(destination, newer, capturedBinding, now, crypto), true);
  const published = await fs.readFile(destination);
  decryptRelease.resolve(); assert.equal(await outcome, primary); released(root, input);
  assert.deepEqual(restored, [{threadId: 'original', root: projectRoot, expiresAt}]); assert.equal(gatewayCalls, 1); assert.equal(ws.count(), 0);
  assert.equal((await claimedFiles(input.paths.root)).length, 0); assert.deepEqual(await fs.readFile(destination), published);
  assert.deepEqual(decodeRestartHandoffPayload(await plaintext(destination, crypto), capturedBinding, now).projects, newer);
 } finally { decryptRelease.resolve(); root.stop.abort(); await outcome; t.mock.restoreAll(); await ws.close(); }
}));

for (const failure of ['unlink', 'tamper'] as const) {
 test(`concrete runtime restore rejects ${failure === 'unlink' ? 'successful decryption with failed claim unlink' : 'authenticated ciphertext tampering'} before project, gateway or dial`, {timeout: 15000}, async t => storeFixture(async path => {
  const input = remoteRuntimeInput(path), root = rootSeam(t, input), destination = join(input.paths.root, 'handoff.json'), crypto = authenticated();
  const ws = await remoteSocket(() => { throw Error('unexpected remote dial'); }), ports = remoteInput(ws.url + '/');
  await writePosixRestartHandoff(destination, [{threadId: 'original', root: join(input.paths.root, 'project'), expiresAt}], binding(ports), now, crypto);
  if (failure === 'tamper') {
   const envelope = decodeRestartHandoffEnvelope(await fs.readFile(destination, 'utf8'));
   const bytes = Buffer.from(envelope.ciphertext, 'base64'); bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
   await fs.writeFile(destination, encodeRestartHandoffEnvelope(bytes.toString('base64')));
  }
  let unprotects = 0, unlinks = 0, gatewayCalls = 0;
  const originalUnlink = fs.unlink;
  const restoreFs = replaceFs(t, 'unlink', async target => {
   if (String(target).includes('.handoff.json.claimed.')) { unlinks++; if (failure === 'unlink') throw Error('private native unlink failure'); }
   return originalUnlink(target);
  });
  const profile = createSyntheticRuntimeRemoteProfile({...ports.input, handoff: handoff(destination, {...crypto, unprotect: bytes => { unprotects++; return crypto.unprotect(bytes); }})});
  t.mock.method(RecommendedGateway, 'startPaused', async () => { gatewayCalls++; throw Error('unexpected gateway'); });
  const outcome = runLocalRuntimeApplication(root.config, root.env, input.paths.root, 'fixture', undefined, undefined, profile).then(() => undefined, error => error);
  try {
   const error = await outcome; assert.ok(error instanceof RestartHandoffPersistenceError);
   assert.equal(error.code, failure === 'unlink' ? 'CleanupFailed' : 'UnprotectionFailed'); assert.equal(error.cause, undefined);
   assert.equal(error.message, failure === 'unlink' ? 'restart handoff claim cleanup failed' : 'restart handoff unprotection failed');
   assert.equal(unprotects, 1); assert.equal(unlinks, 1); assert.equal(ports.counts().opens, 0); assert.equal(gatewayCalls, 0); assert.equal(ws.count(), 0);
   assert.equal(existsSync(destination), false); assert.equal((await claimedFiles(input.paths.root)).length, failure === 'unlink' ? 1 : 0); released(root, input);
  } finally { root.stop.abort(); await outcome; restoreFs(); t.mock.restoreAll(); await ws.close(); }
 }));
}

test('explicit stop marker overrides restart marker and suppresses concrete ciphertext protection', {timeout: 20000}, async t => storeFixture(async path => {
 const input = remoteRuntimeInput(path), root = rootSeam(t, input), destination = join(input.paths.root, 'handoff.json'), crypto = authenticated();
 const ws = await remoteSocket(peer => peer.once('message', () => peer.send('{"type":"hello_ack"}'))), socket = await gatewaySocket(), ports = remoteInput(ws.url + '/');
 await writePosixRestartHandoff(destination, [{threadId: 'original', root: join(input.paths.root, 'project'), expiresAt}], binding(ports), now, crypto);
 let protections = 0, closes = 0;
 change(ports.backend, 'close', async () => { closes++; });
 const profile = createSyntheticRuntimeRemoteProfile({...ports.input, handoff: handoff(destination, {...crypto, protect: bytes => { protections++; return crypto.protect(bytes); }})});
 t.mock.method(RecommendedGateway, 'startPaused', async () => RecommendedGateway.startPausedForTest(socket));
 const outcome = runLocalRuntimeApplication(root.config, root.env, input.paths.root, 'fixture', undefined, undefined, profile).then(() => undefined, error => error);
 try {
  await until(() => root.counts().ready && syntheticRuntimeRemoteSnapshot(profile).status.connected);
  writeFileSync(join(input.paths.root, DRAIN_MARKER_NAMES.stop), 'stop');
  writeFileSync(join(input.paths.root, DRAIN_MARKER_NAMES.restart), 'restart'); root.stop.abort();
  assert.equal(await outcome, undefined); released(root, input);
  assert.equal(syntheticRuntimeRemoteSnapshot(profile).handoffRequested, false); assert.equal(closes, 1); assert.equal(protections, 0);
  assert.equal(existsSync(destination), false); assert.equal((await claimedFiles(input.paths.root)).length, 0);
 } finally { root.stop.abort(); await outcome; t.mock.restoreAll(); await ws.close(); await socket.close(); }
}));
