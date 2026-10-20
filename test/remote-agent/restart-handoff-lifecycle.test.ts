import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createCipheriv, createDecipheriv, randomBytes} from 'node:crypto';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WebSocketServer, type WebSocket} from 'ws';
import {SecretToken} from '../../src/config/remote.ts';
import {RemoteAgentControl, RemoteAgentStatus} from '../../src/remote-agent/agent-state.ts';
import type {RemoteUtcDateTime} from '../../src/remote-agent/datetime.ts';
import {formatRemoteUtcDateTime} from '../../src/remote-agent/datetime-format.ts';
import type {RemoteProjectBackend, RemoteProjectBinding, RemoteSessionBackend} from '../../src/remote-agent/dispatcher-ports.ts';
import {
 closePreparedManagedRemoteAgent, managedRemoteSnapshot, prepareManagedRemoteAgent,
 requestManagedRemoteStop, runManagedRemoteAgent, type SyntheticManagedRemoteConfiguration,
 type SyntheticRemoteHandoffPorts,
} from '../../src/remote-agent/managed-agent.ts';
import {
 decodeRestartHandoffEnvelope, decodeRestartHandoffPayload, RestartHandoffCodecError,
 type RestartHandoffBinding, type RestartHandoffProject,
} from '../../src/remote-agent/restart-handoff-codec.ts';
import {
 capturePosixRuntimeRestartHandoff, type PosixRuntimeRestartHandoff,
} from '../../src/remote-agent/restart-handoff-lifecycle.ts';
import {
 RestartHandoffPersistenceError, writePosixRestartHandoff, type RestartHandoffProtector,
} from '../../src/remote-agent/restart-handoff-persistence.ts';

const date = (seconds: bigint, nanosecond = 0n): RemoteUtcDateTime => Object.freeze({seconds, nanosecond});
const project = (root: string, threadId = 'lifecycle-project', expiresAt = date(500n)): RestartHandoffProject =>
 Object.freeze({threadId, root, expiresAt});
const socketBinding = (bridgeUrl = 'ws://127.0.0.1:1234/'): RestartHandoffBinding =>
 ({bridgeUrl, deviceId: 'synthetic-lifecycle-device'});
const deferred = <T = void>() => {
 let resolve!: (value: T) => void;
 const promise = new Promise<T>(accept => { resolve = accept; });
 return {promise, resolve};
};
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function change<T extends object, K extends keyof T>(target: T, key: K, value: T[K]): void {
 (target as {-readonly [P in keyof T]: T[P]})[key] = value;
}
function code(expected: string): (error: unknown) => boolean {
 return error => (error instanceof RestartHandoffCodecError || error instanceof RestartHandoffPersistenceError) && error.code === expected;
}
/** Real authenticated ciphertext with a fresh process-memory-only test key. */
function authenticated(): RestartHandoffProtector {
 const key = randomBytes(32);
 return {
  protect(bytes) {
   const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
   const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
   return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
  },
  unprotect(bytes) {
   const input = Buffer.from(bytes), cipher = createDecipheriv('aes-256-gcm', key, input.subarray(0, 12));
   cipher.setAuthTag(input.subarray(12, 28));
   return Buffer.concat([cipher.update(input.subarray(28)), cipher.final()]);
  },
 };
}
async function fixture(t: TestContext) {
 const dir = await fs.mkdtemp(join(tmpdir(), 'synthetic-handoff-lifecycle-'));
 t.after(() => fs.rm(dir, {recursive: true, force: true}));
 const root = join(dir, 'project'), store = join(dir, 'store');
 await fs.mkdir(root); await fs.mkdir(store);
 return {dir, root, store, path: join(store, 'handoff.json'), protector: authenticated()};
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function option(f: Fixture, resumeRequested = true): PosixRuntimeRestartHandoff {
 return {kind: 'PosixCiphertextRestartHandoff', path: f.path, resumeRequested, protector: f.protector};
}
function managed(
 f: Fixture, handoff: SyntheticRemoteHandoffPorts, nowUtc: () => RemoteUtcDateTime = () => date(100n),
 bridgeUrl = 'ws://127.0.0.1:1234/',
) {
 const opened: RemoteProjectBinding[] = [], events: string[] = [];
 const control = new RemoteAgentControl(), status = new RemoteAgentStatus();
 let closeProject = async () => { events.push('project'); };
 const session: RemoteSessionBackend = {
  stopComputer: async () => { events.push('computer'); },
  closeTerminalWindows: async () => { events.push('windows'); },
  closeTerminals: async () => { events.push('terminals'); },
  computer: null, terminal: null, terminalWindow: null,
 };
 const input: SyntheticManagedRemoteConfiguration = {
  kind: 'SyntheticManagedRemote',
  socket: {bridgeUrl, deviceId: socketBinding().deviceId, deviceToken: new SecretToken('synthetic-lifecycle-token')},
  reconnectDelaySeconds: 0n, status, control, handoff,
  dispatcher: {
   nowUtc, nowMonotonic: () => 0n,
   openProject: async value => {
    // Real claim removal is a prerequisite of every resource transfer.
    assert.deepEqual(await fs.readdir(f.store), []);
    opened.push(value); events.push('open');
    const backend: RemoteProjectBackend = {
     close: async () => closeProject(), createSession: async () => session,
     listFiles: null, readFile: null, writeFile: null, core: null,
    };
    return backend;
   },
  },
  disconnected: async () => {},
 };
 return {input, control, status, opened, events, session, onClose: (callback: () => Promise<void>) => { closeProject = callback; }};
}
async function stopped(input: SyntheticManagedRemoteConfiguration, restart: boolean) {
 const signal = new AbortController().signal, owner = await prepareManagedRemoteAgent(input, signal);
 if (restart) input.control.requestRestartHandoff();
 requestManagedRemoteStop(owner);
 await runManagedRemoteAgent(owner, signal);
 return owner;
}
async function server(t: TestContext, connected: (peer: WebSocket) => void) {
 const ws = new WebSocketServer({host: '127.0.0.1', port: 0, perMessageDeflate: false});
 ws.on('connection', (peer, request) => {
  assert.equal(request.headers.authorization, 'Bearer synthetic-lifecycle-token');
  connected(peer);
 });
 await once(ws, 'listening');
 t.after(async () => { for (const peer of ws.clients) peer.terminate(); await new Promise<void>(resolve => ws.close(() => resolve())); });
 return `ws://127.0.0.1:${(ws.address() as {port: number}).port}/`;
}

test('POSIX runtime option is mandatory, exact and passive, including protector and canonical socket spelling', async t => {
 const f = await fixture(t); let hooks = 0;
 const clock = () => { hooks++; return date(100n); };
 const active = () => { hooks++; throw Error('must remain passive'); };
 const valid = option(f);
 const bad: unknown[] = [
  undefined, null, {}, {...valid, kind: 'SyntheticProtectedBindingPorts'}, {...valid, path: 'relative'},
  {...valid, resumeRequested: undefined}, {...valid, binding: socketBinding()}, {...valid, clock},
  {...valid, nowUtc: clock}, {...valid, get path() { return active(); }},
  {...valid, protector: {...f.protector, extra: true}},
  {...valid, protector: new Proxy(f.protector, {get: active, getPrototypeOf: active, ownKeys: active})},
  {...valid, protector: {get protect() { return active(); }, unprotect: f.protector.unprotect}},
  {...valid, protector: {protect: new Proxy(f.protector.protect, {apply: active}), unprotect: f.protector.unprotect}},
  new Proxy(valid, {get: active, getPrototypeOf: active, ownKeys: active}),
 ];
 for (const value of bad) assert.throws(() => capturePosixRuntimeRestartHandoff(value as PosixRuntimeRestartHandoff, socketBinding(), clock), TypeError);
 for (const bridgeUrl of [
  'ws://127.0.0.1:1234', 'ws://localhost:1234/', 'wss://127.0.0.1:1234/',
  'ws://127.1:1234/', 'ws://127.0.0.1:0/', 'ws://127.0.0.1:01234/',
  'ws://user@127.0.0.1:1234/', 'ws://127.0.0.1:1234/#fragment',
 ]) assert.throws(() => capturePosixRuntimeRestartHandoff(valid, socketBinding(bridgeUrl), clock), TypeError);
 assert.throws(() => capturePosixRuntimeRestartHandoff(valid, socketBinding(), new Proxy(clock, {apply: active})), TypeError);
 const captured = capturePosixRuntimeRestartHandoff(valid, socketBinding(), clock);
 assert.equal(captured.kind, 'SyntheticProtectedBindingPorts'); assert.equal(Object.isFrozen(captured), true);
 assert.equal(hooks, 0); assert.deepEqual(await fs.readdir(f.store), []);
});

test('capture freezes path, socket binding, resume choice, protector functions and dispatcher clock before effects', async t => {
 const f = await fixture(t), binding = socketBinding(), raw = option(f), alternate = join(f.store, 'retargeted');
 const primitive = f.protector; let protects = 0, unprotects = 0, clocks = 0;
 const protector: RestartHandoffProtector = {
  protect: function(this: unknown, bytes) { assert.equal(this, undefined); protects++; return primitive.protect(bytes); },
  unprotect: function(this: unknown, bytes) { assert.equal(this, undefined); unprotects++; return primitive.unprotect(bytes); },
 };
 change(raw, 'protector', protector);
 const clockHost = {nowUtc: function(this: unknown) { assert.equal(this, undefined); clocks++; return date(100n); }};
 await writePosixRestartHandoff(f.path, [project(f.root)], binding, date(100n), primitive);
 const captured = capturePosixRuntimeRestartHandoff(raw, binding, clockHost.nowUtc);
 assert.equal(clocks + protects + unprotects, 0);
 change(raw, 'path', alternate); change(raw, 'resumeRequested', false);
 change(raw, 'protector', {protect: () => assert.fail('new protector'), unprotect: () => assert.fail('new unprotector')});
 change(protector, 'protect', () => assert.fail('retargeted protect'));
 change(protector, 'unprotect', () => assert.fail('retargeted unprotect'));
 change(binding, 'bridgeUrl', 'ws://127.0.0.1:4321/'); change(binding, 'deviceId', 'retargeted');
 clockHost.nowUtc = () => assert.fail('retargeted clock');
 assert.deepEqual(await captured.restore(new AbortController().signal), [project(await fs.realpath(f.root))]);
 assert.deepEqual(await fs.readdir(f.store), []); assert.equal(clocks, 1); assert.equal(unprotects, 1);
 assert.equal(await captured.protect([project(f.root)], date(101n)), true);
 const envelopeText = await fs.readFile(f.path, 'utf8');
 assert.equal(envelopeText.includes(f.root), false); assert.equal(envelopeText.includes('lifecycle-project'), false);
 const envelope = decodeRestartHandoffEnvelope(envelopeText);
 const plaintext = Buffer.from(await primitive.unprotect(Buffer.from(envelope.ciphertext, 'base64'))).toString('utf8');
 assert.equal(decodeRestartHandoffPayload(plaintext, socketBinding(), date(101n)).createdAt.seconds, 101n);
 assert.equal(protects, 1); assert.equal(clocks, 1); await assert.rejects(fs.stat(alternate), {code: 'ENOENT'});
});

test('normal start with resume false performs no handoff reads, unprotection or clock calls, and normal stop never publishes', async t => {
 const f = await fixture(t); let clocks = 0, unprotects = 0, protects = 0, reads = 0;
 await fs.writeFile(f.path, 'untouched invalid handoff');
 const raw = option(f, false);
 change(raw, 'protector', {
  protect: () => { protects++; return assert.fail('normal stop protection'); },
  unprotect: () => { unprotects++; return assert.fail('normal start unprotection'); },
 });
 const now = () => { clocks++; return date(100n); };
 const ports = capturePosixRuntimeRestartHandoff(raw, socketBinding(), now);
 const originalStat = fs.stat, originalOpen = fs.open;
 fs.stat = ((...args: Parameters<typeof fs.stat>) => { reads++; return originalStat(...args); }) as typeof fs.stat;
 fs.open = ((...args: Parameters<typeof fs.open>) => { reads++; return originalOpen(...args); }) as typeof fs.open;
 syncBuiltinESMExports();
 let owner;
 try { owner = await stopped(managed(f, ports, now).input, false); }
 finally { fs.stat = originalStat; fs.open = originalOpen; syncBuiltinESMExports(); }
 assert.equal(reads, 0); assert.equal(clocks, 0); assert.equal(unprotects, 0); assert.equal(protects, 0);
 assert.equal(managedRemoteSnapshot(owner).handoffPrepared, false);
 assert.equal(await fs.readFile(f.path, 'utf8'), 'untouched invalid handoff');
});

test('concrete restore canonicalizes directories and removes the claim before the first managed project opens', async t => {
 const f = await fixture(t), alias = join(f.dir, 'alias'); await fs.symlink(f.root, alias);
 await writePosixRestartHandoff(f.path, [project(alias)], socketBinding(), date(100n), f.protector);
 const ports = capturePosixRuntimeRestartHandoff(option(f), socketBinding(), () => date(100n));
 const m = managed(f, ports), owner = await prepareManagedRemoteAgent(m.input, new AbortController().signal);
 assert.deepEqual(m.opened, [project(await fs.realpath(f.root))]);
 assert.deepEqual(await fs.readdir(f.store), []); await closePreparedManagedRemoteAgent(owner);
 assert.deepEqual(m.events, ['open', 'project']);
});

test('fingerprint, device, resume expiry, project expiry and unavailable roots fail after consumption and before project opens', async t => {
 const f = await fixture(t), fileRoot = join(f.dir, 'regular-file'); await fs.writeFile(fileRoot, 'not a directory');
 const cases = [
  {binding: socketBinding('ws://127.0.0.1:4321/'), now: date(100n), root: f.root, expires: date(500n), error: 'GatewayMismatch'},
  {binding: {...socketBinding(), deviceId: 'different-device'}, now: date(100n), root: f.root, expires: date(500n), error: 'GatewayMismatch'},
  {binding: socketBinding(), now: date(220n), root: f.root, expires: date(500n), error: 'Expired'},
  {binding: socketBinding(), now: date(100n), root: f.root, expires: date(100n), error: 'ProjectExpired'},
  {binding: socketBinding(), now: date(100n), root: fileRoot, expires: date(500n), error: 'ProjectRootUnavailable'},
  {binding: socketBinding(), now: date(100n), root: join(f.dir, 'missing'), expires: date(500n), error: 'ProjectRootUnavailable'},
 ];
 for (const value of cases) {
  await writePosixRestartHandoff(f.path, [project(value.root, 't', value.expires)], socketBinding(), date(100n), f.protector);
  const ports = capturePosixRuntimeRestartHandoff(option(f), value.binding, () => value.now), m = managed(f, ports);
  await assert.rejects(prepareManagedRemoteAgent(m.input, new AbortController().signal), code(value.error));
  assert.equal(m.opened.length, 0); assert.deepEqual(await fs.readdir(f.store), []);
 }
});

test('consumed 17- and 128-project vectors, duplicate IDs and over-budget text cannot partially install a managed project', async t => {
 const f = await fixture(t);
 const cases: readonly (readonly RestartHandoffProject[])[] = [
  Array.from({length: 17}, (_, index) => project(f.root, String(index))),
  Array.from({length: 128}, (_, index) => project(f.root, String(index))),
  [project(f.root, 'duplicate'), project(f.root, 'duplicate')],
  [project(f.root, 'valid-first'), project(f.root, 'x'.repeat(4097))],
 ];
 for (const projects of cases) {
  assert.equal(await writePosixRestartHandoff(f.path, projects, socketBinding(), date(100n), f.protector), true);
  const ports = capturePosixRuntimeRestartHandoff(option(f), socketBinding(), () => date(100n)), m = managed(f, ports);
  await assert.rejects(prepareManagedRemoteAgent(m.input, new AbortController().signal), /project budget|Duplicate restored|text budget/);
  assert.equal(m.opened.length, 0); assert.deepEqual(await fs.readdir(f.store), []);
 }
});

test('the managed sixteen-project and 4096-character identity boundaries remain accepted after actual claim removal', async t => {
 const f = await fixture(t);
 const projects = Array.from({length: 16}, (_, index) => project(f.root, index === 0 ? 'x'.repeat(4096) : String(index)));
 await writePosixRestartHandoff(f.path, projects, socketBinding(), date(100n), f.protector);
 const ports = capturePosixRuntimeRestartHandoff(option(f), socketBinding(), () => date(100n)), m = managed(f, ports);
 const owner = await prepareManagedRemoteAgent(m.input, new AbortController().signal);
 assert.equal(m.opened.length, 16); assert.equal(m.opened[0]!.threadId.length, 4096);
 assert.equal(managedRemoteSnapshot(owner).dispatcher.projects, 16); assert.deepEqual(await fs.readdir(f.store), []);
 await closePreparedManagedRemoteAgent(owner); assert.equal(m.events.filter(value => value === 'project').length, 16);
});

test('empty writer returns actual false, and empty or expired managed restart skips protection and publication', async t => {
 const f = await fixture(t); let protects = 0, now = date(100n);
 const primitive = f.protector, raw = option(f, false);
 change(raw, 'protector', {...primitive, protect: bytes => { protects++; return primitive.protect(bytes); }});
 const ports = capturePosixRuntimeRestartHandoff(raw, socketBinding(), () => now);
 assert.equal(await ports.protect(Object.freeze([]), date(100n)), false);
 const empty = await stopped(managed(f, ports, () => now).input, true);
 assert.equal(managedRemoteSnapshot(empty).handoffRequested, true); assert.equal(managedRemoteSnapshot(empty).handoffPrepared, false);
 assert.equal(protects, 0); assert.deepEqual(await fs.readdir(f.store), []);
 await writePosixRestartHandoff(f.path, [project(f.root, 'expires', date(101n))], socketBinding(), date(100n), primitive);
 change(raw, 'resumeRequested', true);
 const expiringPorts = capturePosixRuntimeRestartHandoff(raw, socketBinding(), () => now);
 const m = managed(f, expiringPorts, () => now), signal = new AbortController().signal;
 const owner = await prepareManagedRemoteAgent(m.input, signal); now = date(101n);
 m.control.requestRestartHandoff(); requestManagedRemoteStop(owner); await runManagedRemoteAgent(owner, signal);
 assert.equal(protects, 0); assert.equal(managedRemoteSnapshot(owner).handoffPrepared, false); assert.deepEqual(await fs.readdir(f.store), []);
});

test('restart requested during actual session drain is sticky and publishes only after drain and project release', {timeout: 15000}, async t => {
 const f = await fixture(t), active = deferred(), draining = deferred(), release = deferred(), stop = new AbortController();
 const url = await server(t, peer => peer.on('message', raw => {
  const message = JSON.parse(raw.toString());
  if (message.type === 'hello') {
   assert.equal(message.device_id, socketBinding().deviceId);
   peer.send('{"type":"hello_ack"}');
   peer.send(JSON.stringify({type: 'project_session', request_id: 'session', thread_id: 'lifecycle-project', computer_session_id: 'abcdefghijklmnop', computer_session_generation: 1, deadline_at: '1970-01-01T00:03:20Z'}));
  } else if (message.type === 'project_session_result') active.resolve();
 }));
 await writePosixRestartHandoff(f.path, [project(f.root)], socketBinding(url), date(100n), f.protector);
 const raw = option(f), primitive = f.protector; let protects = 0;
 change(raw, 'protector', {...primitive, protect: bytes => { protects++; return primitive.protect(bytes); }});
 const ports = capturePosixRuntimeRestartHandoff(raw, socketBinding(url), () => date(100n)), m = managed(f, ports, () => date(100n), url);
 change(m.session, 'stopComputer', async () => { draining.resolve(); await release.promise; m.events.push('computer'); });
 const owner = await prepareManagedRemoteAgent(m.input, stop.signal); let settled = false;
 const running = runManagedRemoteAgent(owner, stop.signal).then(() => { settled = true; });
 await active.promise; stop.abort(); await draining.promise;
 m.control.requestRestartHandoff(); await tick();
 assert.equal(settled, false); assert.equal(protects, 0); assert.equal(m.events.includes('project'), false);
 release.resolve(); await running;
 assert.equal(managedRemoteSnapshot(owner).handoffPrepared, true); assert.equal(protects, 1);
 assert.deepEqual(m.events.slice(-4), ['computer', 'windows', 'terminals', 'project']);
 assert.ok((await fs.stat(f.path)).isFile());
});

test('restart request after the loop decision during project cleanup cannot create a late handoff', async t => {
 const f = await fixture(t), closing = deferred(), release = deferred();
 await writePosixRestartHandoff(f.path, [project(f.root)], socketBinding(), date(100n), f.protector);
 const ports = capturePosixRuntimeRestartHandoff(option(f), socketBinding(), () => date(100n)), m = managed(f, ports);
 m.onClose(async () => { closing.resolve(); await release.promise; });
 const signal = new AbortController().signal, owner = await prepareManagedRemoteAgent(m.input, signal);
 requestManagedRemoteStop(owner); const running = runManagedRemoteAgent(owner, signal);
 await closing.promise; assert.equal(managedRemoteSnapshot(owner).handoffRequested, false);
 m.control.requestRestartHandoff(); release.resolve(); await running;
 assert.equal(managedRemoteSnapshot(owner).handoffRequested, false); assert.equal(managedRemoteSnapshot(owner).handoffPrepared, false);
 assert.deepEqual(await fs.readdir(f.store), []);
});

test('the exact post-cleanup clock sample filters expiry and creates the persisted payload, without a second writer sample', async t => {
 const f = await fixture(t), finalNow = date(200n, 123456789n);
 await writePosixRestartHandoff(f.path, [project(f.root, 'expired-during-cleanup', date(150n)), project(f.root, 'survives', date(250n))], socketBinding(), date(100n), f.protector);
 let cleaned = false, finalSamples = 0;
 const clock = () => cleaned ? (++finalSamples === 1 ? finalNow : date(9999n)) : date(100n);
 const ports = capturePosixRuntimeRestartHandoff(option(f), socketBinding(), clock), m = managed(f, ports, clock);
 m.onClose(async () => { await tick(); cleaned = true; });
 const signal = new AbortController().signal, owner = await prepareManagedRemoteAgent(m.input, signal);
 change(m.input.dispatcher, 'nowUtc', () => assert.fail('retargeted dispatcher clock'));
 m.control.requestRestartHandoff(); requestManagedRemoteStop(owner); await runManagedRemoteAgent(owner, signal);
 assert.equal(finalSamples, 1); assert.equal(managedRemoteSnapshot(owner).handoffPrepared, true);
 const envelope = decodeRestartHandoffEnvelope(await fs.readFile(f.path, 'utf8'));
 const plaintext = Buffer.from(await f.protector.unprotect(Buffer.from(envelope.ciphertext, 'base64'))).toString('utf8');
 const payload = decodeRestartHandoffPayload(plaintext, socketBinding(), finalNow);
 assert.deepEqual(payload.createdAt, finalNow); assert.deepEqual(payload.resumeUntil, date(320n, 123456789n));
 assert.deepEqual(payload.projects.map(value => value.threadId), ['survives']);
 assert.equal(JSON.parse(plaintext).created_at, formatRemoteUtcDateTime(finalNow));
});

test('expiry reached during final project cleanup skips concrete protection entirely', async t => {
 const f = await fixture(t); let now = date(100n), protects = 0;
 await writePosixRestartHandoff(f.path, [project(f.root, 'expires-in-cleanup', date(200n))], socketBinding(), now, f.protector);
 const raw = option(f); change(raw, 'protector', {...f.protector, protect: () => { protects++; return assert.fail('expired protection'); }});
 const ports = capturePosixRuntimeRestartHandoff(raw, socketBinding(), () => now), m = managed(f, ports, () => now);
 m.onClose(async () => { now = date(200n); });
 const owner = await stopped(m.input, true);
 assert.equal(protects, 0); assert.equal(managedRemoteSnapshot(owner).handoffPrepared, false); assert.deepEqual(await fs.readdir(f.store), []);
});

test('managed publication completion honors false and legacy void, and rejects malformed completion values', async t => {
 const f = await fixture(t);
 for (const result of [false, true, undefined, 'published', 1, null, Object.freeze({written: true})]) {
  let calls = 0;
  const ports: SyntheticRemoteHandoffPorts = {
   kind: 'SyntheticProtectedBindingPorts', restore: async () => Object.freeze([project(f.root)]),
   protect: async (_bindings, now) => { calls++; assert.deepEqual(now, date(100n)); return result as boolean | undefined; },
  };
  const m = managed(f, ports), signal = new AbortController().signal;
  const owner = await prepareManagedRemoteAgent(m.input, signal); m.control.requestRestartHandoff(); requestManagedRemoteStop(owner);
  const running = runManagedRemoteAgent(owner, signal);
  if (typeof result === 'boolean' || result === undefined) {
   await running; assert.equal(managedRemoteSnapshot(owner).handoffPrepared, result !== false);
  } else {
   await assert.rejects(running, /Invalid managed handoff completion/); assert.equal(managedRemoteSnapshot(owner).handoffPrepared, false);
  }
  assert.equal(calls, 1); assert.equal(managedRemoteSnapshot(owner).phase, 'closed');
 }
});
