import {it, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createCipheriv, createDecipheriv, randomBytes} from 'node:crypto';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {inspect} from 'node:util';
import {
 writePosixRestartHandoff, claimPosixRestartHandoff, RestartHandoffPersistenceError,
 type RestartHandoffProtector,
} from '../../src/remote-agent/restart-handoff-persistence.ts';
import {
 RestartHandoffCodecError, MAX_RESTART_HANDOFF_BYTES, encodeRestartHandoffPayload,
 encodeRestartHandoffEnvelope, decodeRestartHandoffEnvelope, type RestartHandoffProject,
} from '../../src/remote-agent/restart-handoff-codec.ts';
import {parseRemoteUtcDateTime} from '../../src/remote-agent/datetime.ts';

const now = Object.freeze(parseRemoteUtcDateTime('2026-10-15T12:00:00Z', 100));
const future = Object.freeze(parseRemoteUtcDateTime('2026-10-15T12:10:00Z', 100));
const binding = Object.freeze({bridgeUrl: 'wss://synthetic.invalid/bridge', deviceId: 'synthetic-device-920'});
const project = (root: string, threadId = 'synthetic-thread-920'): RestartHandoffProject => ({root, threadId, expiresAt: future});
function code(expected: string): (error: unknown) => boolean {
 return error => (error instanceof RestartHandoffCodecError || error instanceof RestartHandoffPersistenceError) &&
  error.code === expected && error.cause === undefined;
}
function deferred<T>() {
 let resolve!: (value: T) => void;
 const promise = new Promise<T>(accept => { resolve = accept; });
 return {promise, resolve};
}
/** Ephemeral authenticated test-only protector. No key is persisted or loaded. */
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
async function fixture(t: TestContext) {
 const dir = await fs.mkdtemp(join(tmpdir(), 'synthetic-handoff-920-'));
 t.after(() => fs.rm(dir, {recursive: true, force: true}));
 const root = join(dir, 'project'); await fs.mkdir(root);
 const path = join(dir, 'handoff.json'), protector = authenticated();
 return {dir, root, path, protector,
  write: (projects = [project(root)]) => writePosixRestartHandoff(path, projects, binding, now, protector),
  claim: () => claimPosixRestartHandoff(true, path, binding, now, protector),
 };
}
async function entries(dir: string) { return (await fs.readdir(dir)).sort(); }
async function claimed(dir: string): Promise<string> {
 const names = (await fs.readdir(dir)).filter(name => name.includes('.claimed.'));
 assert.equal(names.length, 1); return join(dir, names[0]!);
}
function replaceFs(t: TestContext, name: keyof typeof fs, replacement: (...args: any[]) => any) {
 const descriptor = Object.getOwnPropertyDescriptor(fs, name)!;
 Object.defineProperty(fs, name, {...descriptor, value: replacement}); syncBuiltinESMExports();
 t.after(() => { Object.defineProperty(fs, name, descriptor); syncBuiltinESMExports(); });
}
async function rawPayload(f: Awaited<ReturnType<typeof fixture>>, bytes: Uint8Array) {
 const cipher = await f.protector.protect(bytes);
 await fs.writeFile(f.path, encodeRestartHandoffEnvelope(Buffer.from(cipher).toString('base64')));
}
it('empty writer and disabled claim have no effects or context/protector/path access', async t => {
 const f = await fixture(t); await f.write(); const original = await fs.readFile(f.path);
 let hooks = 0; const fail = () => { hooks++; throw Error('not called'); };
 const hostile = new Proxy({}, {get: fail, ownKeys: fail, getPrototypeOf: fail, getOwnPropertyDescriptor: fail}) as any;
 assert.equal(await writePosixRestartHandoff(hostile, [], hostile, hostile, hostile), false);
 assert.deepEqual(await claimPosixRestartHandoff(false, hostile, hostile, hostile, hostile), []);
 assert.deepEqual(await fs.readFile(f.path), original); assert.equal(hooks, 0);
 assert.deepEqual(await entries(f.dir), ['handoff.json', 'project']);
});
it('writes only authenticated ciphertext with mode 0600, exact deadline and complete publication', async t => {
 const f = await fixture(t); assert.equal(await f.write(), true);
 const stored = await fs.readFile(f.path, 'utf8');
 for (const secret of [f.root, 'synthetic-thread-920', binding.deviceId, binding.bridgeUrl]) assert.equal(stored.includes(secret), false);
 assert.equal((await fs.stat(f.path)).mode & 0o777, 0o600);
 const envelope = decodeRestartHandoffEnvelope(stored);
 const plain = JSON.parse(Buffer.from(await f.protector.unprotect(Buffer.from(envelope.ciphertext, 'base64'))).toString('utf8'));
 assert.equal(plain.resume_until, '2026-10-15T12:02:00Z'); assert.equal(plain.created_at, '2026-10-15T12:00:00Z');
 assert.deepEqual(await entries(f.dir), ['handoff.json', 'project']);
});
it('protection completes before parent creation; success waits for actual atomic rename', async t => {
 const f = await fixture(t), parent = join(f.dir, 'new-parent'), path = join(parent, 'handoff');
 const protectGate = deferred<void>(), enteredRename = deferred<void>(), renameGate = deferred<void>();
 const originalRename = fs.rename;
 replaceFs(t, 'rename', async (...args: Parameters<typeof fs.rename>) => {
  if (args[1] === path) { enteredRename.resolve(); await renameGate.promise; }
  return originalRename(...args);
 });
 const protector = {...f.protector, protect: async (bytes: Uint8Array) => { await protectGate.promise; return f.protector.protect(bytes); }};
 let settled = false; const pending = writePosixRestartHandoff(path, [project(f.root)], binding, now, protector).then(result => { settled = true; return result; });
 await assert.rejects(fs.stat(parent), {code: 'ENOENT'}); assert.equal(settled, false);
 protectGate.resolve(); await enteredRename.promise;
 await assert.rejects(fs.stat(path), {code: 'ENOENT'}); assert.equal(settled, false);
 renameGate.resolve(); assert.equal(await pending, true); assert.ok((await fs.stat(path)).isFile());
});
it('protection rejection is redacted and causes no mkdir or write', async t => {
 const f = await fixture(t), parent = join(f.dir, 'never-created'), path = join(parent, 'handoff');
 const marker = 'private-protector-error-920'; let traps = 0;
 const hostile = new Proxy({}, {get() { traps++; throw Error(marker); }, getPrototypeOf() { traps++; throw Error(marker); }});
 const protector = {...f.protector, protect: () => { throw hostile; }};
 await assert.rejects(writePosixRestartHandoff(path, [project(f.root)], binding, now, protector), error => {
  assert.equal(inspect(error).includes(marker), false); return code('ProtectionFailed')(error);
 });
 assert.equal(traps, 0); await assert.rejects(fs.stat(parent), {code: 'ENOENT'});
});
it('128 projects persist, while 129 fail before protection', async t => {
 const f = await fixture(t); let calls = 0;
 const protector = {...f.protector, protect: (bytes: Uint8Array) => { calls++; return f.protector.protect(bytes); }};
 const projects = Array.from({length: 128}, (_, i) => project(f.root, String(i)));
 assert.equal(await writePosixRestartHandoff(f.path, projects, binding, now, protector), true);
 assert.equal((await f.claim()).length, 128);
 await assert.rejects(writePosixRestartHandoff(f.path, [...projects, project(f.root)], binding, now, protector), code('TooLarge'));
 assert.equal(calls, 1); await assert.rejects(fs.stat(f.path), {code: 'ENOENT'});
});
it('serialized base64 envelope overhead is bounded before mkdir', async t => {
 const f = await fixture(t), parent = join(f.dir, 'oversize'), path = join(parent, 'handoff');
 const protector = {...f.protector, protect: () => Buffer.alloc(MAX_RESTART_HANDOFF_BYTES)};
 await assert.rejects(writePosixRestartHandoff(path, [project(f.root)], binding, now, protector), code('TooLarge'));
 await assert.rejects(fs.stat(parent), {code: 'ENOENT'});
});
it('writer captures data/callbacks and copies synchronous output before caller mutation', async t => {
 const f = await fixture(t), b: {bridgeUrl: string; deviceId: string} = {...binding}, n = {...now}, p = [{...project(f.root)}];
 let encrypted: Buffer | undefined;
 const protector = {...f.protector, protect(bytes: Uint8Array) { encrypted = Buffer.from(f.protector.protect(bytes) as Uint8Array); return encrypted; }};
 const pending = writePosixRestartHandoff(f.path, p, b, n, protector);
 p[0]!.root = '/changed'; b.deviceId = 'changed'; n.seconds += 10_000n;
 protector.protect = () => { throw Error('must not call'); }; encrypted!.fill(0);
 assert.equal(await pending, true); assert.deepEqual(await f.claim(), [project(f.root)]);
});
it('protector callbacks are detached and missing/accessor/proxy protectors fail without fallback', async t => {
 const f = await fixture(t); let hooks = 0;
 const protector = {
  protect(this: unknown, bytes: Uint8Array) { assert.equal(this, undefined); return f.protector.protect(bytes); },
  unprotect(this: unknown, bytes: Uint8Array) { assert.equal(this, undefined); return f.protector.unprotect(bytes); },
 };
 await writePosixRestartHandoff(f.path, [project(f.root)], binding, now, protector);
 assert.equal((await claimPosixRestartHandoff(true, f.path, binding, now, protector)).length, 1);
 const getter = {get protect() { hooks++; throw Error('not called'); }, unprotect: f.protector.unprotect};
 const proxy = new Proxy(protector, {get() { hooks++; throw Error('not called'); }, ownKeys() { hooks++; throw Error('not called'); }});
 for (const invalid of [undefined, {}, getter, proxy, {...protector, extra: true}, {...protector, protect: new Proxy(protector.protect, {})}]) {
  await assert.rejects(writePosixRestartHandoff(f.path, [project(f.root)], binding, now, invalid as any), code('Malformed'));
 }
 assert.equal(hooks, 0); await assert.rejects(fs.stat(f.path), {code: 'ENOENT'});
});
it('byte results reject thenables, proxies and shared memory without reading accessors', async t => {
 const f = await fixture(t); let hooks = 0;
 const thenable = {get then() { hooks++; throw Error('not called'); }};
 const proxy = new Proxy(new Uint8Array(1), {get() { hooks++; throw Error('not called'); }});
 for (const result of ['plaintext', thenable, proxy, new Uint8Array(new SharedArrayBuffer(1)), null]) {
  await assert.rejects(writePosixRestartHandoff(f.path, [project(f.root)], binding, now,
   {...f.protector, protect: () => result as any}), code('Malformed'));
 }
 assert.equal(hooks, 0); await assert.rejects(fs.stat(f.path), {code: 'ENOENT'});
});
it('intrinsic byte capture ignores caller getters and copies byte subranges exactly', async t => {
 const f = await fixture(t); let hooks = 0;
 const protector = {...f.protector, protect(bytes: Uint8Array) {
  const encrypted = f.protector.protect(bytes) as Uint8Array;
  const surrounding = Buffer.concat([Buffer.alloc(3), encrypted, Buffer.alloc(4)]);
  const view = new Uint8Array(surrounding.buffer, surrounding.byteOffset + 3, encrypted.byteLength);
  for (const name of ['buffer', 'byteLength', 'byteOffset', 'length', 'then']) Object.defineProperty(view, name, {get() { hooks++; throw Error('not called'); }});
  return view;
 }};
 await writePosixRestartHandoff(f.path, [project(f.root)], binding, now, protector);
 assert.equal((await f.claim()).length, 1); assert.equal(hooks, 0);
});
it('claim captures binding/time and unprotect callback before first await', async t => {
 const f = await fixture(t); await f.write(); const b: {bridgeUrl: string; deviceId: string} = {...binding}, n = {...now};
 const protector = {...f.protector};
 const pending = claimPosixRestartHandoff(true, f.path, b, n, protector);
 b.deviceId = 'changed'; n.seconds += 10_000n; protector.unprotect = () => { throw Error('not called'); };
 assert.deepEqual(await pending, [project(f.root)]);
});
it('claim missing file returns empty; directory is malformed without consumption', async t => {
 const f = await fixture(t); assert.deepEqual(await f.claim(), []);
 await fs.mkdir(f.path); await assert.rejects(f.claim(), code('Malformed'));
 assert.ok((await fs.stat(f.path)).isDirectory()); assert.deepEqual(await entries(f.dir), ['handoff.json', 'project']);
});
it('canonicalizes all directories while retaining vector order, duplicates and frozen values', async t => {
 const f = await fixture(t), other = join(f.dir, 'other'), alias = join(f.dir, 'alias');
 await fs.mkdir(other); await fs.symlink(f.root, alias);
 await f.write([project(alias, 'duplicate'), project(other, 'middle'), project(f.root, 'duplicate')]);
 const result = await f.claim();
 assert.deepEqual(result, [project(f.root, 'duplicate'), project(other, 'middle'), project(f.root, 'duplicate')]);
 assert.ok(Object.isFrozen(result) && result.every(p => Object.isFrozen(p) && Object.isFrozen(p.expiresAt)));
 await assert.rejects(fs.stat(f.path), {code: 'ENOENT'}); assert.equal((await entries(f.dir)).some(n => n.includes('.claimed.')), false);
});
it('two concurrent claims consume at most one published entry', async t => {
 const f = await fixture(t); await f.write();
 const results = await Promise.all([f.claim(), f.claim()]);
 assert.deepEqual(results.map(v => v.length).sort(), [0, 1]); assert.deepEqual(await entries(f.dir), ['project']);
});
it('older claim cleanup cannot remove a newly published handoff', async t => {
 const f = await fixture(t); await f.write([project(f.root, 'old')]);
 const entered = deferred<void>(), release = deferred<void>();
 const protector = {...f.protector, unprotect: async (bytes: Uint8Array) => { entered.resolve(); await release.promise; return f.protector.unprotect(bytes); }};
 const pending = claimPosixRestartHandoff(true, f.path, binding, now, protector);
 await entered.promise; await f.write([project(f.root, 'new')]); const published = await fs.readFile(f.path);
 release.resolve(); assert.equal((await pending)[0]!.threadId, 'old');
 assert.deepEqual(await fs.readFile(f.path), published); assert.equal((await f.claim())[0]!.threadId, 'new');
 assert.deepEqual(await entries(f.dir), ['project']);
});
it('authentication failure consumes the claim and exposes no protector error data', async t => {
 const f = await fixture(t); await f.write();
 const envelope = decodeRestartHandoffEnvelope(await fs.readFile(f.path, 'utf8'));
 const cipher = Buffer.from(envelope.ciphertext, 'base64'); cipher[cipher.length - 1]! ^= 1;
 await fs.writeFile(f.path, encodeRestartHandoffEnvelope(cipher.toString('base64')));
 await assert.rejects(f.claim(), code('UnprotectionFailed')); assert.deepEqual(await entries(f.dir), ['project']);
});
it('primary unprotection failure wins failed claimed-file cleanup', async t => {
 const f = await fixture(t); await f.write();
 const protector = {...f.protector, unprotect: async () => {
  const path = await claimed(f.dir); await fs.unlink(path); await fs.mkdir(path); throw Error('private-primary');
 }};
 await assert.rejects(claimPosixRestartHandoff(true, f.path, binding, now, protector), code('UnprotectionFailed'));
 assert.ok((await fs.stat(await claimed(f.dir))).isDirectory());
});
it('primary codec validation failure wins failed cleanup', async t => {
 const f = await fixture(t); await f.write();
 const protector = {...f.protector, unprotect: async (bytes: Uint8Array) => {
  const path = await claimed(f.dir); await fs.unlink(path); await fs.mkdir(path);
  const payload = JSON.parse(Buffer.from(await f.protector.unprotect(bytes)).toString('utf8'));
  payload.resume_until = '2026-10-15T12:00:00Z'; return Buffer.from(JSON.stringify(payload));
 }};
 await assert.rejects(claimPosixRestartHandoff(true, f.path, binding, now, protector), code('Expired'));
});
it('valid projects are withheld if claimed-file removal fails', async t => {
 const f = await fixture(t); await f.write();
 const protector = {...f.protector, unprotect: async (bytes: Uint8Array) => {
  const path = await claimed(f.dir); await fs.unlink(path); await fs.mkdir(path); return f.protector.unprotect(bytes);
 }};
 await assert.rejects(claimPosixRestartHandoff(true, f.path, binding, now, protector), code('CleanupFailed'));
});
it('claim does not settle successfully until actual removal completes', async t => {
 const f = await fixture(t); await f.write(); const originalUnlink = fs.unlink;
 const entered = deferred<void>(), release = deferred<void>();
 replaceFs(t, 'unlink', async (path: Parameters<typeof fs.unlink>[0]) => {
  if (String(path).includes('.claimed.')) { entered.resolve(); await release.promise; }
  return originalUnlink(path);
 });
 let settled = false; const pending = f.claim().then(result => { settled = true; return result; });
 await entered.promise; assert.equal(settled, false); assert.ok((await fs.stat(await claimed(f.dir))).isFile());
 release.resolve(); assert.equal((await pending).length, 1); assert.deepEqual(await entries(f.dir), ['project']);
});
for (const [label, bytes] of [
 ['invalid UTF-8', Buffer.from([0x7b, 0xc3, 0x28, 0x7d])],
 ['UTF-8 BOM', Buffer.from('\ufeff{"format_version":1,"ciphertext":""}')],
 ['noncanonical base64', Buffer.from('{"format_version":1,"ciphertext":"AB=="}')],
 ['unsupported envelope version', Buffer.from('{"format_version":2,"ciphertext":""}')],
] as const) it('rejects and removes outer ' + label + ' before unprotect', async t => {
 const f = await fixture(t); await fs.writeFile(f.path, bytes); let calls = 0;
 const protector = {...f.protector, unprotect() { calls++; throw Error('must not call'); }};
 await assert.rejects(claimPosixRestartHandoff(true, f.path, binding, now, protector), code(label === 'unsupported envelope version' ? 'UnsupportedFormat' : 'Malformed'));
 assert.equal(calls, 0); assert.deepEqual(await entries(f.dir), ['project']);
});
for (const [label, bytes] of [
 ['invalid UTF-8', Buffer.from([0xc3, 0x28])], ['UTF-8 BOM', Buffer.from('\ufeff{}')],
] as const) it('rejects and removes plaintext ' + label, async t => {
 const f = await fixture(t); await rawPayload(f, bytes);
 await assert.rejects(f.claim(), code('Malformed')); assert.deepEqual(await entries(f.dir), ['project']);
});
it('exact 1 MiB envelope is readable, max+1 is rejected before unprotect', async t => {
 const f = await fixture(t); await f.write(); const envelope = await fs.readFile(f.path);
 await fs.writeFile(f.path, Buffer.concat([envelope, Buffer.alloc(MAX_RESTART_HANDOFF_BYTES - envelope.length, 0x20)]));
 assert.equal((await f.claim()).length, 1);
 await fs.writeFile(f.path, Buffer.alloc(MAX_RESTART_HANDOFF_BYTES + 1, 0x20));
 let calls = 0; const protector = {...f.protector, unprotect() { calls++; throw Error('not called'); }};
 await assert.rejects(claimPosixRestartHandoff(true, f.path, binding, now, protector), code('TooLarge'));
 assert.equal(calls, 0); assert.deepEqual(await entries(f.dir), ['project']);
});
it('growing file after fstat is read at most max+1 bytes and rejected', async t => {
 const f = await fixture(t); await f.write(); const originalOpen = fs.open;
 let requested = 0, read = 0;
 replaceFs(t, 'open', async (...args: Parameters<typeof fs.open>) => {
  const handle = await originalOpen(...args);
  if (!String(args[0]).includes('.claimed.')) return handle;
  return {
   async stat() { const result = await handle.stat(); await fs.appendFile(String(args[0]), Buffer.alloc(MAX_RESTART_HANDOFF_BYTES, 0x20)); return result; },
   async read(...values: [Buffer, number, number, null]) { requested += values[2]; const result = await handle.read(...values); read += result.bytesRead; return result; },
   close: () => handle.close(),
  };
 });
 await assert.rejects(f.claim(), code('TooLarge')); assert.equal(requested, MAX_RESTART_HANDOFF_BYTES + 1);
 assert.equal(read, MAX_RESTART_HANDOFF_BYTES + 1); assert.deepEqual(await entries(f.dir), ['project']);
});
it('bounded read retries short reads and still reads no more than max+1 bytes', async t => {
 const f = await fixture(t); await f.write(); const originalOpen = fs.open; let total = 0, calls = 0;
 replaceFs(t, 'open', async (...args: Parameters<typeof fs.open>) => {
  const handle = await originalOpen(...args); if (!String(args[0]).includes('.claimed.')) return handle;
  return {stat: () => handle.stat(), close: () => handle.close(), async read(buffer: Buffer, offset: number, length: number, position: null) {
   calls++; const result = await handle.read(buffer, offset, Math.min(length, 31), position); total += result.bytesRead; return result;
  }};
 });
 assert.equal((await f.claim()).length, 1); assert.ok(calls > 2); assert.ok(total <= MAX_RESTART_HANDOFF_BYTES);
});
for (const failure of ['Expired', 'ProjectExpired', 'GatewayMismatch', 'ProtocolMismatch'] as const) {
 it(failure + ' is validated before any project root lookup', async t => {
  const f = await fixture(t); const payload = JSON.parse(encodeRestartHandoffPayload([project(f.root), project('/unavailable')], binding, now)!);
  if (failure === 'Expired') payload.resume_until = '2026-10-15T12:00:00Z';
  if (failure === 'ProjectExpired') payload.projects[1].expires_at = '2026-10-15T12:00:00Z';
  if (failure === 'GatewayMismatch') payload.gateway_fingerprint = 'wrong';
  if (failure === 'ProtocolMismatch') payload.protocol_version = 11;
  await rawPayload(f, Buffer.from(JSON.stringify(payload))); let calls = 0;
  replaceFs(t, 'realpath', async () => { calls++; throw Error('not called'); });
  await assert.rejects(f.claim(), code(failure)); assert.equal(calls, 0); assert.deepEqual(await entries(f.dir), ['project']);
 });
}
for (const rootType of ['missing', 'file'] as const) it('all-or-error roots reject a later ' + rootType + ' and consume claim', async t => {
 const f = await fixture(t), root = join(f.dir, 'bad-root'); if (rootType === 'file') await fs.writeFile(root, 'synthetic');
 await f.write([project(f.root, 'valid-first'), project(root, 'invalid-second')]);
 await assert.rejects(f.claim(), code('ProjectRootUnavailable'));
 assert.equal((await entries(f.dir)).some(name => name === 'handoff.json' || name.includes('.claimed.')), false);
});
it('read error remains primary when close and unlink also fail', async t => {
 const f = await fixture(t); await f.write(); const originalOpen = fs.open; let closed = 0, removed = 0;
 replaceFs(t, 'open', async (...args: Parameters<typeof fs.open>) => {
  const handle = await originalOpen(...args); if (!String(args[0]).includes('.claimed.')) return handle;
  return {stat: () => handle.stat(), read: async () => { throw Error('private-read-path'); }, close: async () => { closed++; await handle.close(); throw Error('private-close-path'); }};
 });
 replaceFs(t, 'unlink', async () => { removed++; throw Error('private-unlink-path'); });
 await assert.rejects(f.claim(), error => { assert.equal(inspect(error).includes('private-'), false); return code('ReadFailed')(error); });
 assert.equal(closed, 1); assert.equal(removed, 1);
});
it('read close failure rejects before unprotect but still removes claim', async t => {
 const f = await fixture(t); await f.write(); const originalOpen = fs.open; let calls = 0;
 replaceFs(t, 'open', async (...args: Parameters<typeof fs.open>) => {
  const handle = await originalOpen(...args); if (!String(args[0]).includes('.claimed.')) return handle;
  return {stat: () => handle.stat(), read: (...values: [Buffer, number, number, null]) => handle.read(...values), close: async () => { await handle.close(); throw Error('private-close'); }};
 });
 const protector = {...f.protector, unprotect() { calls++; throw Error('not called'); }};
 await assert.rejects(claimPosixRestartHandoff(true, f.path, binding, now, protector), code('ReadFailed'));
 assert.equal(calls, 0); assert.deepEqual(await entries(f.dir), ['project']);
});
it('native atomic writer uses wx0600, write, fsync, close, then rename', async t => {
 const f = await fixture(t), originalOpen = fs.open, originalRename = fs.rename; const order: string[] = [];
 replaceFs(t, 'open', async (...args: Parameters<typeof fs.open>) => {
  assert.equal(args[1], 'wx'); assert.equal(args[2], 0o600); order.push('open'); const handle = await originalOpen(...args);
  return {writeFile: async (...a: Parameters<typeof handle.writeFile>) => { order.push('write'); return handle.writeFile(...a); },
   sync: async () => { order.push('sync'); return handle.sync(); }, close: async () => { order.push('close'); return handle.close(); }};
 });
 replaceFs(t, 'rename', async (...args: Parameters<typeof fs.rename>) => { order.push('rename'); return originalRename(...args); });
 assert.equal(await f.write(), true); assert.deepEqual(order, ['open', 'write', 'sync', 'close', 'rename']);
});
it('atomic rename failure preserves previous envelope and removes only its owned temp', async t => {
 const f = await fixture(t); await f.write(); const original = await fs.readFile(f.path);
 replaceFs(t, 'rename', async () => { throw Error('private-publication-path'); });
 await assert.rejects(f.write([project(f.root, 'replacement')]), code('PublicationFailed'));
 assert.deepEqual(await fs.readFile(f.path), original); assert.deepEqual(await entries(f.dir), ['handoff.json', 'project']);
});
for (const step of ['write', 'sync', 'close'] as const) it('atomic ' + step + ' failure attempts close and removes the owned temp', async t => {
 const f = await fixture(t), originalOpen = fs.open; let closed = 0, renamed = 0;
 replaceFs(t, 'open', async (...args: Parameters<typeof fs.open>) => {
  const handle = await originalOpen(...args);
  return {writeFile: async (...a: Parameters<typeof handle.writeFile>) => { if (step === 'write') throw Error('private-write'); return handle.writeFile(...a); },
   sync: async () => { if (step === 'sync') throw Error('private-sync'); return handle.sync(); },
   close: async () => { closed++; await handle.close(); if (step === 'close') throw Error('private-close'); }};
 });
 replaceFs(t, 'rename', async () => { renamed++; throw Error('must not call'); });
 await assert.rejects(f.write(), code('PublicationFailed')); assert.equal(closed, 1); assert.equal(renamed, 0);
 assert.deepEqual(await entries(f.dir), ['project']);
});
it('rename ENOENT race returns empty without unprotect or cleanup', async t => {
 const f = await fixture(t); await f.write(); const originalRename = fs.rename; let calls = 0;
 replaceFs(t, 'rename', async (...args: Parameters<typeof fs.rename>) => { await fs.unlink(args[0]); return originalRename(...args); });
 const protector = {...f.protector, unprotect() { calls++; throw Error('not called'); }};
 assert.deepEqual(await claimPosixRestartHandoff(true, f.path, binding, now, protector), []);
 assert.equal(calls, 0); assert.deepEqual(await entries(f.dir), ['project']);
});
it('source metadata follows symlinks as Rust does; consuming a link is not global replay protection', async t => {
 const f = await fixture(t); await f.write(); const retained = join(f.dir, 'retained-envelope');
 await fs.rename(f.path, retained); await fs.symlink(retained, f.path);
 assert.equal((await f.claim()).length, 1); assert.ok((await fs.stat(retained)).isFile());
 await assert.rejects(fs.lstat(f.path), {code: 'ENOENT'});
});
it('relative, malformed and executable paths/context fail before filesystem activity', async t => {
 const f = await fixture(t); let hooks = 0;
 const hostile = new Proxy({}, {get() { hooks++; throw Error('not called'); }, getPrototypeOf() { hooks++; throw Error('not called'); }});
 for (const path of ['relative/handoff', '', '/bad\0path', '/bad\ud800', hostile]) {
  await assert.rejects(writePosixRestartHandoff(path as string, [project(f.root)], binding, now, f.protector), code('Malformed'));
 }
 for (const b of [hostile, {...binding, extra: 1}, {get bridgeUrl() { hooks++; throw Error('not called'); }, deviceId: ''}]) {
  await assert.rejects(claimPosixRestartHandoff(true, f.path, b as any, now, f.protector), code('Malformed'));
 }
 assert.equal(hooks, 0); assert.deepEqual(await entries(f.dir), ['project']);
});
it('oversized unprotected bytes retain the 915 independent plaintext bound', async t => {
 const f = await fixture(t); await f.write();
 const protector = {...f.protector, unprotect: () => Buffer.alloc(MAX_RESTART_HANDOFF_BYTES + 1)};
 await assert.rejects(claimPosixRestartHandoff(true, f.path, binding, now, protector), code('TooLarge'));
 assert.deepEqual(await entries(f.dir), ['project']);
});
it('ordinary native promises allow passive decoration and ignore own then accessors', async t => {
 const f = await fixture(t); let hooks = 0;
 const decorate = (bytes: Uint8Array) => {
  const promise = Promise.resolve(bytes);
  Object.defineProperty(promise, 'constructor', {value: Promise});
  Object.defineProperty(promise, 'then', {get() { hooks++; throw Error('not called'); }});
  Object.defineProperty(promise, Symbol('async-context-like'), {value: 'synthetic'});
  return promise;
 };
 const protector = {protect: (bytes: Uint8Array) => decorate(f.protector.protect(bytes) as Uint8Array),
  unprotect: (bytes: Uint8Array) => decorate(f.protector.unprotect(bytes) as Uint8Array)};
 await writePosixRestartHandoff(f.path, [project(f.root)], binding, now, protector);
 assert.equal((await claimPosixRestartHandoff(true, f.path, binding, now, protector)).length, 1); assert.equal(hooks, 0);
});
it('async native rejection is redacted and the claimed file is consumed', async t => {
 const f = await fixture(t); await f.write();
 const marker = 'synthetic-private-async-rejection';
 const protector = {...f.protector, unprotect: async () => { throw Error(marker); }};
 await assert.rejects(claimPosixRestartHandoff(true, f.path, binding, now, protector), error => {
  assert.equal(inspect(error).includes(marker), false); return code('UnprotectionFailed')(error);
 });
 assert.deepEqual(await entries(f.dir), ['project']);
});
it('already missing claimed entry after validation is a cleanup failure, not success', async t => {
 const f = await fixture(t); await f.write();
 const protector = {...f.protector, unprotect: async (bytes: Uint8Array) => {
  await fs.unlink(await claimed(f.dir)); return f.protector.unprotect(bytes);
 }};
 await assert.rejects(claimPosixRestartHandoff(true, f.path, binding, now, protector), code('CleanupFailed'));
 assert.deepEqual(await entries(f.dir), ['project']);
});
it('writer leaves project expiry checking to the reader', async t => {
 const f = await fixture(t); assert.equal(await f.write([{...project(f.root), expiresAt: now}]), true);
 await assert.rejects(f.claim(), code('ProjectExpired')); assert.deepEqual(await entries(f.dir), ['project']);
});
for (const step of ['stat', 'rename'] as const) it('native ' + step + ' claim failure is redacted and leaves source unconsumed', async t => {
 const f = await fixture(t); await f.write(); const original = await fs.readFile(f.path);
 replaceFs(t, step, async () => { throw Error('private-filesystem-path'); });
 await assert.rejects(f.claim(), error => { assert.equal(inspect(error).includes('private-filesystem-path'), false); return code('ClaimFailed')(error); });
 assert.deepEqual(await fs.readFile(f.path), original); assert.deepEqual(await entries(f.dir), ['handoff.json', 'project']);
});
it('relative roots pin initial cwd without normalizing symlink/parent traversal', async t => {
 const f = await fixture(t), originalCwd = process.cwd(), other = join(f.dir, 'other-cwd');
 const targetParent = join(f.dir, 'actual-parent'), nested = join(targetParent, 'nested');
 await fs.mkdir(nested, {recursive: true}); await fs.mkdir(other);
 await fs.symlink(nested, join(f.dir, 'alias'));
 await f.write([project('project', 'initial-cwd'), project('alias/..', 'symlink-parent')]);
 let pending: Promise<readonly RestartHandoffProject[]>;
 try { process.chdir(f.dir); pending = f.claim(); process.chdir(other); }
 finally { process.chdir(originalCwd); }
 const result = await pending;
 assert.deepEqual(result, [project(f.root, 'initial-cwd'), project(targetParent, 'symlink-parent')]);
});
it('empty root is unavailable rather than silently becoming cwd', async t => {
 const f = await fixture(t); await f.write([project('')]);
 await assert.rejects(f.claim(), code('ProjectRootUnavailable')); assert.deepEqual(await entries(f.dir), ['project']);
});
