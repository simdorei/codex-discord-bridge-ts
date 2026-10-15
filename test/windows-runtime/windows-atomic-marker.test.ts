import assert from 'node:assert/strict';
import {renameSync} from 'node:fs';
import {mkdtemp, readFile, readdir, rename, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import type {TestContext} from 'node:test';
import {Worker} from 'node:worker_threads';
import {
  acquireWindowsAtomicMarkerProfile, createWindowsAtomicMarkerHarnessForTest,
  publishWindowsAtomicMarker, shutdownWindowsAtomicMarkerProfile, windowsAtomicMarkerStatus,
  WindowsAtomicMarkerError,
} from '../../src/runtime/windows/windows-atomic-marker.ts';
import type {
  WindowsAtomicMarkerHarness, WindowsAtomicMarkerPhase, WindowsAtomicMarkerProfile,
} from '../../src/runtime/windows/windows-atomic-marker.ts';
import {WindowsSingletonOwnerError, releaseWindowsSingletonOwner} from '../../src/runtime/windows/windows-singleton-owner.ts';

const ROOT = 'C:\\CloudFixture';
const IDENTITY = '.codex_discord_rust.drain.identity';
const ACK = '.codex_discord_rust.drain.ack';
// Independent frozen text vectors; no wider marker encoder/store is imported.
const IDENTITY_TEXT = 'version=1\nruntime_id=runtime-a\npid=123\nstate=open\n';
const ACK_TEXT = 'version=1\nruntime_id=runtime-a\nprocess_identity=123|456\nnonce=nonce-a\nstate=sealed\n';
type FilePhase = Exclude<WindowsAtomicMarkerPhase, 'binding' | 'native'>;
type Event = Readonly<{phase: FilePhase; path: string; offset: number}>;
type Callback = (error: unknown, value: unknown) => void;
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return {promise, resolve};
}
interface FixtureOptions {
  root?: string;
  platform?: string;
  arch?: string;
  mainThread?: boolean;
  before?: (event: Event) => void | Promise<void>;
  writeChunkBytes?: number;
  zeroWriteAt?: number;
}
async function fixture(t: TestContext, options: FixtureOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'windows-atomic-927-'));
  t.after(async () => { await rm(directory, {recursive: true, force: true}); });
  const root = options.root ?? ROOT;
  const events: string[] = [];
  const fileEvents: Event[] = [];
  const moves: {source: string; destination: string; flags: unknown; callback: Callback}[] = [];
  const arrivals = new Map<number, ReturnType<typeof deferred<void>>>();
  const state = {
    loads: 0, creates: 0, closes: 0, captures: 0, lastError: 0 as unknown,
    captureThrows: false, closeValue: 1 as unknown, closeThrows: false,
    onLoad: null as (() => void) | null,
    onClose: null as (() => void) | null,
    launch: null as ((callback: Callback, index: number) => void) | null,
  };
  function local(path: string): string {
    const prefix = `${root}${root.endsWith('\\') || root.endsWith('/') ? '' : '\\'}`;
    assert.ok(path.startsWith(prefix));
    const leaf = path.slice(prefix.length);
    assert.ok(leaf === IDENTITY || leaf === ACK || /^\.codex_discord_rust\.marker\.[0-9a-f-]{36}\.tmp$/.test(leaf));
    return join(directory, leaf);
  }
  const move = Object.assign(() => { assert.fail('No synchronous native move'); }, {
    async(source: string, destination: string, flags: unknown, callback: Callback) {
      events.push('native:move');
      const index = moves.length;
      moves.push({source, destination, flags, callback});
      arrivals.get(index)?.resolve();
      state.launch?.(callback, index);
    },
  });
  const module = {version: '3.3.3', load(name: string) {
    assert.equal(name, 'kernel32.dll');
    return {func(declaration: string): unknown {
      switch (declaration) {
        case 'void * __stdcall CreateMutexW(void *attributes, int32_t initialOwner, str16 name)':
          return () => { events.push('native:create'); state.creates++; return 0xfedc_ba98_7654_3210n; };
        case 'uint32_t __stdcall GetLastError(void)':
          return () => { events.push('native:capture'); state.captures++; if (state.captureThrows) throw new Error('PRIVATE capture'); return state.lastError; };
        case 'int32_t __stdcall CloseHandle(void *handle)':
          return (handle: unknown) => {
            assert.equal(handle, 0xfedc_ba98_7654_3210n);
            events.push('native:close'); state.closes++; state.onClose?.();
            if (state.closeThrows) throw new Error('PRIVATE close');
            return state.closeValue;
          };
        case 'int32_t __stdcall MoveFileExW(str16 source, str16 destination, uint32_t flags)': return move;
        default: assert.fail('Unexpected native declaration');
      }
    }};
  }};
  const harness = createWindowsAtomicMarkerHarnessForTest({
    platform: options.platform ?? 'win32', arch: options.arch ?? 'x64', mainThread: options.mainThread ?? true,
    loadKoffi: () => { state.loads++; events.push('native:load'); state.onLoad?.(); return module; },
    mapping: {windowsRoot: root, fixtureRoot: directory},
    beforePhase: async event => { fileEvents.push(event); events.push(`fs:${event.phase}`); await options.before?.(event); },
    ...(options.writeChunkBytes === undefined ? {} : {writeChunkBytes: options.writeChunkBytes}),
    ...(options.zeroWriteAt === undefined ? {} : {zeroWriteAt: options.zeroWriteAt}),
  });
  function waitMove(index = 0): Promise<void> {
    if (moves[index] !== undefined) return Promise.resolve();
    let arrival = arrivals.get(index);
    if (arrival === undefined) { arrival = deferred(); arrivals.set(index, arrival); }
    return arrival.promise;
  }
  function deliver(index: number, value: unknown, lastError: unknown = 0, error: unknown = null, captureThrows = false): void {
    const submission = moves[index]; assert.ok(submission);
    state.lastError = lastError; state.captureThrows = captureThrows;
    submission.callback(error, value);
    state.lastError = 0xeeee; state.captureThrows = false;
    events.push('native:callback-return');
  }
  async function complete(options: {index?: number; value?: unknown; lastError?: unknown; error?: unknown; physical?: boolean; captureThrows?: boolean} = {}): Promise<void> {
    const index = options.index ?? 0;
    await waitMove(index);
    const submission = moves[index]!;
    // The only asynchronous rename in this suite is the raw native mock adapter.
    if (options.physical ?? true) await rename(local(submission.source), local(submission.destination));
    deliver(index, options.value ?? 1, options.lastError ?? 0, options.error ?? null, options.captureThrows ?? false);
  }
  return {directory, root, events, fileEvents, moves, state, harness, waitMove, deliver, complete, local};
}
function refusal(reason: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof WindowsAtomicMarkerError);
    assert.equal(error.reason, reason); assert.equal(Object.isFrozen(error), true);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    assert.doesNotMatch(`${error.stack} ${JSON.stringify(error)}`, /PRIVATE|CloudFixture/);
    return true;
  };
}
async function pending(promise: Promise<unknown>): Promise<void> {
  let settled = false; void promise.then(() => { settled = true; }, () => { settled = true; });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(settled, false);
}
async function failed(promise: Promise<unknown>, phase: WindowsAtomicMarkerPhase): Promise<WindowsAtomicMarkerError> {
  let result: unknown;
  await assert.rejects(promise, error => { result = error; return refusal(error instanceof WindowsAtomicMarkerError ? error.reason : 'io')(error); });
  assert.ok(result instanceof WindowsAtomicMarkerError); assert.equal(result.phase, phase);
  return result;
}

test('01 import-safe real host and worker gates, and mock host gates, precede filesystem access', async t => {
  assert.notEqual(process.platform, 'win32', 'Cloud mock evidence only');
  assert.throws(() => acquireWindowsAtomicMarkerProfile(ROOT), WindowsSingletonOwnerError);
  const worker = new Worker(`const {parentPort}=require('node:worker_threads'); import(${JSON.stringify(new URL('../../src/runtime/windows/windows-atomic-marker.js', import.meta.url).href)}).then(m=>{try{m.acquireWindowsAtomicMarkerProfile('C:\\\\worker');}catch(e){parentPort.postMessage(e.reason);}});`, {eval: true, execArgv: ['--no-strip-types']});
  assert.equal(await new Promise(resolve => { worker.once('message', resolve); worker.once('error', error => { throw error; }); }), 'thread');
  await worker.terminate();
  for (const options of [{platform: 'linux'}, {arch: 'ia32'}, {mainThread: false}]) {
    const f = await fixture(t, options);
    assert.throws(() => f.harness.acquire(ROOT), WindowsSingletonOwnerError);
    assert.equal(f.state.loads, 0); assert.deepEqual(f.fileEvents, []);
  }
  const arm = await fixture(t, {arch: 'arm64'}); const owner = arm.harness.acquire(ROOT);
  assert.equal((await arm.harness.shutdown(owner)).closure, 'closed');
});

test('02 exact opaque profile authentication; no owner token or structural port escapes', async t => {
  const f = await fixture(t), other = await fixture(t);
  const profile = f.harness.acquire(ROOT), foreign = other.harness.acquire(ROOT);
  assert.equal(Object.isFrozen(profile), true); assert.equal(Object.getPrototypeOf(profile), null);
  assert.deepEqual(Reflect.ownKeys(profile), []);
  const revoked = Proxy.revocable(profile, {}); revoked.revoke();
  for (const fake of [undefined, null, {}, {...profile}, Object.create(profile), new Proxy(profile, {}), revoked.proxy, foreign, {owner: profile, binding: {}}]) {
    assert.throws(() => f.harness.publish(fake, 'identity', 'x'), refusal('identity'));
    assert.throws(() => f.harness.status(fake), refusal('identity'));
    assert.throws(() => f.harness.shutdown(fake), refusal('identity'));
  }
  for (const call of [() => publishWindowsAtomicMarker(profile, 'identity', 'x'), () => shutdownWindowsAtomicMarkerProfile(profile), () => windowsAtomicMarkerStatus(profile)])
    assert.throws(call, refusal('identity'));
  assert.throws(() => releaseWindowsSingletonOwner(profile), WindowsSingletonOwnerError);
  assert.equal((await f.harness.shutdown(profile)).closure, 'closed');
  await other.harness.shutdown(foreign);
});

test('03 fixed identity/ack paths preserve exact root spelling and frozen independent payloads', async t => {
  const root = 'c:/Spelled\\.\\Root/';
  const f = await fixture(t, {root}), p = f.harness.acquire(root);
  assert.throws(() => f.harness.acquire(root.toUpperCase()), refusal('root'));
  for (const [index, marker, leaf, text] of [[0, 'identity', IDENTITY, IDENTITY_TEXT], [1, 'ack', ACK, ACK_TEXT]] as const) {
    const write = f.harness.publish(p, marker, text); await f.waitMove(index);
    const move = f.moves[index]!;
    assert.equal(move.destination, root + leaf); assert.ok(move.source.startsWith(root + '.codex_discord_rust.marker.'));
    assert.equal(move.source.slice(0, root.length), root); assert.equal(move.flags, 9);
    await f.complete({index}); assert.equal((await write).outcome, 'published');
    assert.equal(await readFile(join(f.directory, leaf), 'utf8'), text);
  }
  for (const marker of ['../escape', 'other', '', new String('identity'), null])
    assert.throws(() => f.harness.publish(p, marker as 'identity', 'x'), refusal('selector'));
  await f.harness.shutdown(p);
});

test('04 generated short-path maximum 259 units inclusive and all excluded roots fail before load', async t => {
  // Temp leaf is 27 prefix + 36 UUID + 4 suffix = 67; root 191 + separator 1.
  const boundary = 'C:\\' + 'a'.repeat(188);
  assert.equal(boundary.length, 191);
  const f = await fixture(t, {root: boundary}), p = f.harness.acquire(boundary);
  const write = f.harness.publish(p, 'ack', 'x'); await f.waitMove();
  assert.equal(f.moves[0]!.source.length, 259); await f.complete(); await write; await f.harness.shutdown(p);
  let loads = 0;
  for (const root of [boundary + 'a', '', 'relative', 'C:relative', '\\root', '\\\\host\\share', '\\\\?\\C:\\a', '/root', 'C:\\한글', 'C:\\a\0', 'C:\\a\n', 'C:\\a\x7f', 'C:\\a\ud800', new String(ROOT), {toString() { assert.fail('No coercion'); }}]) {
    assert.throws(() => createWindowsAtomicMarkerHarnessForTest({platform: 'win32', arch: 'x64', mainThread: true,
      loadKoffi() { loads++; return {}; }, mapping: {windowsRoot: root as string, fixtureRoot: f.directory}}), refusal('root'));
  }
  assert.equal(loads, 0);
});

test('05 exact UTF8 including non-BMP/NUL, 4096 bytes inclusive, and malformed/oversize primitive refusal', async t => {
  const f = await fixture(t), p = f.harness.acquire(ROOT);
  for (const [index, text] of ['한글-e\u0301-😀\0\n', 'a'.repeat(4096), '😀'.repeat(1024), ''].entries()) {
    const write = f.harness.publish(p, 'identity', text); await f.complete({index}); await write;
    assert.deepEqual(await readFile(join(f.directory, IDENTITY)), Buffer.from(text));
  }
  const before = f.fileEvents.length;
  for (const text of ['a'.repeat(4097), '😀'.repeat(1024) + 'a', 'é'.repeat(2049), '\ud800', '\udfff', 'a\ud800b', new String('x'), null, {toString() { assert.fail('No coercion'); }}])
    assert.throws(() => f.harness.publish(p, 'ack', text as string), refusal('text'));
  assert.equal(f.fileEvents.length, before); await f.harness.shutdown(p);
});

test('06 exclusive same-directory wx collision neither overwrites nor cleans foreign temp', async t => {
  let foreign = '';
  const f = await fixture(t, {before: async event => {
    if (event.phase === 'open') { foreign = event.path; await writeFile(foreign, 'foreign', {flag: 'wx'}); }
  }}), p = f.harness.acquire(ROOT);
  await writeFile(join(f.directory, IDENTITY), 'old');
  const error = await failed(f.harness.publish(p, 'identity', 'new'), 'open');
  assert.deepEqual(error.debt, {handle: false, temporary: false});
  assert.equal(await readFile(foreign, 'utf8'), 'foreign');
  assert.equal(await readFile(join(f.directory, IDENTITY), 'utf8'), 'old');
  assert.equal(f.moves.length, 0); assert.equal(f.fileEvents.some(e => e.phase === 'cleanup'), false);
  assert.equal((await f.harness.shutdown(p)).closure, 'closed');
});

test('07 partial writes fully advance byte offsets; zero progress fails and cleans owned temp', async t => {
  const f = await fixture(t, {writeChunkBytes: 3}), p = f.harness.acquire(ROOT);
  const text = 'a😀한글z'; const write = f.harness.publish(p, 'ack', text);
  await f.waitMove();
  assert.deepEqual(f.fileEvents.filter(e => e.phase === 'write').map(e => e.offset), [0, 3, 6, 9]);
  await f.complete(); await write; assert.equal(await readFile(join(f.directory, ACK), 'utf8'), text);
  await f.harness.shutdown(p);
  const z = await fixture(t, {zeroWriteAt: 0}), zp = z.harness.acquire(ROOT);
  const error = await failed(z.harness.publish(zp, 'ack', 'new'), 'write'); assert.equal(error.reason, 'zero-progress');
  assert.deepEqual(await readdir(z.directory), []); assert.equal(z.moves.length, 0);
  await z.harness.shutdown(zp);
});

test('08 real IO sequence completes sync and close before native submit; previous target survives until move', async t => {
  const f = await fixture(t), p = f.harness.acquire(ROOT);
  await writeFile(join(f.directory, IDENTITY), 'old');
  const write = f.harness.publish(p, 'identity', 'new'); await f.waitMove();
  assert.deepEqual(f.events.slice(4), ['fs:mkdir', 'fs:open', 'fs:write', 'fs:sync', 'fs:close', 'native:move']);
  assert.equal(await readFile(join(f.directory, IDENTITY), 'utf8'), 'old');
  assert.equal(await readFile(f.local(f.moves[0]!.source), 'utf8'), 'new');
  await f.complete(); await write;
  assert.equal(await readFile(join(f.directory, IDENTITY), 'utf8'), 'new');
  assert.deepEqual(await readdir(f.directory), [IDENTITY]); await f.harness.shutdown(p);
});

for (const badPhase of ['mkdir', 'open', 'write', 'sync', 'close'] as const) {
  test(`09 ${badPhase} failure prevents native submission and preserves old destination`, async t => {
    const f = await fixture(t, {before(event) { if (event.phase === badPhase) throw new Error('PRIVATE IO path'); }}), p = f.harness.acquire(ROOT);
    await writeFile(join(f.directory, ACK), 'old');
    const error = await failed(f.harness.publish(p, 'ack', 'new'), badPhase);
    assert.equal(f.moves.length, 0); assert.equal(await readFile(join(f.directory, ACK), 'utf8'), 'old');
    const end = await f.harness.shutdown(p);
    if (badPhase === 'close') {
      assert.deepEqual(error.debt, {handle: true, temporary: true}); assert.equal(end.closure, 'unresolved');
      assert.equal(end.ownerRelease, null); assert.equal(f.state.closes, 0);
      assert.equal(f.fileEvents.some(e => e.phase === 'cleanup'), false);
    } else { assert.equal(end.closure, 'closed'); assert.deepEqual(await readdir(f.directory), [ACK]); }
  });
}

for (const primaryPhase of ['write', 'sync'] as const) {
  for (const secondaryPhase of ['close', 'cleanup'] as const) {
    test(`10 ${primaryPhase} primary survives ${secondaryPhase} failure and quarantines debt`, async t => {
      const f = await fixture(t, {before(event) { if (event.phase === primaryPhase || event.phase === secondaryPhase) throw new Error('PRIVATE failure'); }}), p = f.harness.acquire(ROOT);
      const error = await failed(f.harness.publish(p, 'identity', 'new'), primaryPhase);
      assert.equal(error.debt.temporary, true); assert.equal(error.debt.handle, secondaryPhase === 'close');
      assert.throws(() => f.harness.publish(p, 'ack', 'again'), refusal('quarantined'));
      const end = await f.harness.shutdown(p); assert.equal(end.closure, 'unresolved'); assert.equal(end.ownerRelease, null);
      assert.equal(f.state.closes, 0);
      assert.equal(f.fileEvents.filter(e => e.phase === secondaryPhase).length, 1);
    });
  }
}

test('11+12 completed move failure cleans only owned source and leaves destination intact', async t => {
  const f = await fixture(t), p = f.harness.acquire(ROOT);
  await writeFile(join(f.directory, IDENTITY), 'old');
  const write = f.harness.publish(p, 'identity', 'new'); const rejection = failed(write, 'native');
  await f.complete({value: 0, lastError: 32, physical: false});
  const error = await rejection; assert.equal(error.outcome, 'not-published'); assert.equal(error.lastError, 32);
  assert.equal(await readFile(join(f.directory, IDENTITY), 'utf8'), 'old');
  assert.deepEqual(f.fileEvents.filter(e => e.phase === 'cleanup').map(e => e.path), [f.local(f.moves[0]!.source)]);
  assert.deepEqual(await readdir(f.directory), [IDENTITY]); await f.harness.shutdown(p);
});

test('13 exact flags9, signed nonzero BOOL success, stale DWORD and callback-local error capture', async t => {
  const f = await fixture(t), p = f.harness.acquire(ROOT);
  const write = f.harness.publish(p, 'ack', 'new'); await f.waitMove(); const captures = f.state.captures;
  await f.complete({value: -1, lastError: 0xffff_ffff});
  const result = await write; assert.equal(result.lastError, 0xffff_ffff); assert.equal(result.outcome, 'published');
  assert.equal(f.moves[0]!.flags, 9); assert.equal(f.state.captures, captures + 1);
  assert.deepEqual(f.events.slice(-2), ['native:capture', 'native:callback-return']); await f.harness.shutdown(p);
});

for (const failure of ['callback', 'result', 'capture'] as const) {
  test(`14 native ${failure} binding error yields unconfirmed and still joins cleanup`, async t => {
    const f = await fixture(t), p = f.harness.acquire(ROOT);
    await writeFile(join(f.directory, IDENTITY), 'old');
    const write = f.harness.publish(p, 'identity', 'new'); const rejection = failed(write, 'native');
    await f.complete({physical: false, value: failure === 'result' ? true : 1,
      error: failure === 'callback' ? new Error('PRIVATE callback') : null, captureThrows: failure === 'capture'});
    const error = await rejection; assert.equal(error.outcome, 'unconfirmed');
    assert.equal(error.diagnostic?.phase, failure === 'capture' ? 'last-error' : failure);
    assert.equal(await readFile(join(f.directory, IDENTITY), 'utf8'), 'old');
    assert.deepEqual(await readdir(f.directory), [IDENTITY]); await f.harness.shutdown(p);
  });
}

test('15 post-success capture failure never rolls destination back; missing source cleanup is discharged', async t => {
  const f = await fixture(t), p = f.harness.acquire(ROOT);
  await writeFile(join(f.directory, ACK), 'old');
  const write = f.harness.publish(p, 'ack', 'physically-new'); const rejection = failed(write, 'native');
  await f.complete({captureThrows: true}); const error = await rejection;
  assert.equal(error.outcome, 'unconfirmed'); assert.deepEqual(error.debt, {handle: false, temporary: false});
  assert.equal(await readFile(join(f.directory, ACK), 'utf8'), 'physically-new');
  assert.deepEqual(await readdir(f.directory), [ACK]); assert.equal((await f.harness.shutdown(p)).closure, 'closed');
});

for (const held of ['mkdir', 'open', 'write', 'sync', 'close', 'cleanup'] as const) {
  test(`16+17 held ${held}: synchronous busy refusal, immediate shutdown seal, join before release`, async t => {
    const entered = deferred(), release = deferred();
    let reentry: (() => void) | undefined;
    const f = await fixture(t, {before: async event => {
      if (held === 'cleanup' && event.phase === 'sync') throw new Error('PRIVATE primary');
      if (event.phase === held) { reentry?.(); entered.resolve(); await release.promise; }
    }}), p = f.harness.acquire(ROOT);
    reentry = () => { assert.throws(() => f.harness.publish(p, 'ack', 'reentry'), refusal('busy')); assert.equal(f.state.closes, 0); };
    const write = f.harness.publish(p, 'identity', 'new');
    const observed = write.then(value => value, error => error);
    await entered.promise; assert.equal(f.harness.status(p).phase, held);
    const events = f.events.length;
    assert.throws(() => f.harness.publish(p, 'ack', 'queued'), refusal('busy'));
    assert.equal(f.events.length, events);
    const closing = f.harness.shutdown(p); assert.equal(f.harness.shutdown(p), closing);
    assert.equal(f.harness.status(p).sealed, true); assert.throws(() => f.harness.publish(p, 'ack', 'late'), refusal('sealed'));
    await pending(closing); assert.equal(f.state.closes, 0);
    release.resolve();
    if (held !== 'cleanup') { await f.complete(); assert.equal((await observed).outcome, 'published'); }
    else assert.ok(await observed instanceof WindowsAtomicMarkerError);
    assert.equal((await closing).closure, 'closed'); assert.equal(f.state.closes, 1);
    assert.equal(f.events.at(-2), 'native:close');
  });
}

test('16+17 binding loader and native launch reentry see active custody; shutdown cannot close early', async t => {
  const f = await fixture(t), p = f.harness.acquire(ROOT);
  let closing: ReturnType<WindowsAtomicMarkerHarness['shutdown']> | undefined;
  f.state.onLoad = () => {
    assert.equal(f.harness.status(p).phase, 'binding');
    assert.throws(() => f.harness.publish(p, 'ack', 'reentry'), refusal('busy'));
    closing = f.harness.shutdown(p); assert.equal(f.harness.shutdown(p), closing); assert.equal(f.state.closes, 0);
  };
  f.state.launch = () => {
    assert.equal(f.harness.status(p).phase, 'native');
    assert.throws(() => f.harness.publish(p, 'ack', 'late'), refusal('sealed'));
    assert.equal(f.harness.shutdown(p), closing); assert.equal(f.state.closes, 0);
  };
  const write = f.harness.publish(p, 'identity', 'new'); await f.waitMove(); assert.ok(closing);
  await pending(closing); await f.complete(); await write;
  assert.equal((await closing).closure, 'closed'); assert.equal(f.state.closes, 1);
});

test('16+17 native held without shutdown refuses overlap; shutdown joins actual callback', async t => {
  const f = await fixture(t), p = f.harness.acquire(ROOT);
  const write = f.harness.publish(p, 'ack', 'new'); await f.waitMove();
  assert.throws(() => f.harness.publish(p, 'ack', 'queued'), refusal('busy'));
  const closing = f.harness.shutdown(p); await pending(write); await pending(closing);
  assert.equal(f.state.closes, 0); assert.equal(f.moves.length, 1);
  await f.complete(); await write; assert.equal((await closing).closure, 'closed');
});

test('18 ambiguous launch with no callback retains temp/owner/pending write and shutdown indefinitely', async t => {
  const f = await fixture(t), p = f.harness.acquire(ROOT);
  f.state.launch = () => { throw new Error('PRIVATE launch'); };
  const write = f.harness.publish(p, 'identity', 'new'); await f.waitMove();
  const closing = f.harness.shutdown(p);
  await pending(write); await pending(closing);
  assert.equal(f.harness.status(p).launchDiagnostic?.phase, 'invoke');
  assert.equal(f.harness.status(p).phase, 'native'); assert.equal(f.state.closes, 0);
  assert.equal(await readFile(f.local(f.moves[0]!.source), 'utf8'), 'new');
  assert.equal(f.fileEvents.some(e => e.phase === 'cleanup'), false);
  assert.throws(() => f.harness.acquire(ROOT), WindowsSingletonOwnerError);
  // Deliberately no callback. No timer, cancellation, retry, or forced settlement.
});

for (const success of [true, false]) {
  test(`19 late ${success ? 'success' : 'failure'} after launch throw is authoritative and releases only after callback`, async t => {
    const f = await fixture(t), p = f.harness.acquire(ROOT);
    f.state.launch = () => { throw new Error('PRIVATE launch'); };
    const write = f.harness.publish(p, 'ack', 'new'); const observed = write.then(value => value, error => error);
    await f.waitMove(); const closing = f.harness.shutdown(p); await pending(closing);
    await f.complete({value: success ? 1 : 0, physical: success, lastError: success ? 999 : 5});
    const result = await observed; assert.equal(result.outcome, success ? 'published' : 'not-published');
    assert.equal(result.launchDiagnostic?.phase, 'invoke'); assert.equal((await closing).closure, 'closed');
    assert.equal(f.state.closes, 1);
  });
}

test('19 callback-before-launch-throw and duplicate callbacks preserve first completed physical replacement', async t => {
  const f = await fixture(t), p = f.harness.acquire(ROOT);
  f.state.launch = (_callback, index) => {
    const move = f.moves[index]!;
    // Synchronous rename exists solely inside this raw mock-native launch.
    renameSync(f.local(move.source), f.local(move.destination));
    f.deliver(index, 1, 77); throw new Error('PRIVATE after callback');
  };
  const write = f.harness.publish(p, 'identity', 'new'); await f.waitMove();
  const result = await write; const captures = f.state.captures;
  f.deliver(0, 0, 5, new Error('PRIVATE duplicate'));
  assert.equal(result.outcome, 'published'); assert.equal(result.lastError, 77); assert.equal(result.launchDiagnostic?.phase, 'invoke');
  assert.equal(f.state.captures, captures); assert.equal(await readFile(join(f.directory, IDENTITY), 'utf8'), 'new');
  await f.harness.shutdown(p);
});

test('20 shutdown caches exact Promise before reentrant CloseHandle and closes only once', async t => {
  const f = await fixture(t), p = f.harness.acquire(ROOT);
  let reentrant: ReturnType<WindowsAtomicMarkerHarness['shutdown']> | undefined;
  f.state.onClose = () => { reentrant = f.harness.shutdown(p); assert.throws(() => f.harness.publish(p, 'ack', 'late'), refusal('sealed')); };
  const closing = f.harness.shutdown(p);
  assert.equal(reentrant, closing); assert.equal(f.harness.shutdown(p), closing);
  assert.equal((await closing).closure, 'closed'); assert.equal(f.state.closes, 1);
  const next = f.harness.acquire(ROOT); await f.harness.shutdown(next); assert.equal(f.state.closes, 2);
  assert.equal(f.harness.shutdown(p), closing); assert.equal(f.state.closes, 2);
});

test('21 native failure remains primary over cleanup debt, no cleanup retry or false clean release', async t => {
  const f = await fixture(t, {before(event) { if (event.phase === 'cleanup') throw new Error('PRIVATE cleanup'); }}), p = f.harness.acquire(ROOT);
  const write = f.harness.publish(p, 'ack', 'new'); const rejection = failed(write, 'native');
  await f.complete({value: 0, lastError: 32, physical: false}); const error = await rejection;
  assert.equal(error.lastError, 32); assert.deepEqual(error.debt, {handle: false, temporary: true});
  assert.throws(() => f.harness.publish(p, 'ack', 'again'), refusal('quarantined'));
  const closing = f.harness.shutdown(p); assert.equal((await closing).closure, 'unresolved');
  assert.equal(f.harness.shutdown(p), closing); assert.equal((await closing).ownerRelease, null);
  assert.equal(f.state.closes, 0); assert.equal(f.fileEvents.filter(e => e.phase === 'cleanup').length, 1);
  assert.throws(() => f.harness.acquire(ROOT), WindowsSingletonOwnerError);
});

test('22 dropping caller references does not trigger release, cleanup, or another owner', async t => {
  const f = await fixture(t);
  let profile: WindowsAtomicMarkerProfile | null = f.harness.acquire(ROOT);
  const write = f.harness.publish(profile, 'ack', 'new'); profile = null;
  await f.waitMove(); await pending(write); assert.equal(f.state.closes, 0);
  assert.throws(() => f.harness.acquire(ROOT), WindowsSingletonOwnerError);
  await f.complete(); await write;
  assert.equal(f.state.closes, 0); assert.equal(f.fileEvents.some(e => e.phase === 'cleanup'), false);
  assert.throws(() => f.harness.acquire(ROOT), WindowsSingletonOwnerError);
});

test('23 real 926 unresolved owner release blocks reacquisition; no second close', async t => {
  const f = await fixture(t), p = f.harness.acquire(ROOT); f.state.closeValue = 0;
  const closing = f.harness.shutdown(p), result = await closing;
  assert.equal(result.closure, 'unresolved'); assert.equal(result.ownerRelease?.closure, 'unresolved');
  assert.equal(f.harness.status(p).quarantined, true); assert.equal(f.state.closes, 1);
  assert.equal(f.harness.shutdown(p), closing); assert.throws(() => f.harness.acquire(ROOT), WindowsSingletonOwnerError);
  assert.equal(f.state.closes, 1);
});

test('23 proved owner close with capture failure reports closure and permits later explicit acquisition', async t => {
  const f = await fixture(t), p = f.harness.acquire(ROOT); f.state.captureThrows = true;
  const result = await f.harness.shutdown(p); assert.equal(result.closure, 'closed');
  assert.equal(result.ownerRelease?.diagnostic?.phase, 'last-error'); f.state.captureThrows = false;
  const next = f.harness.acquire(ROOT); await f.harness.shutdown(next);
});
