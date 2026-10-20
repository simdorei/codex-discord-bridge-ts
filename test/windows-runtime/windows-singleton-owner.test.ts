import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {
  acquireWindowsSingletonOwner, assertWindowsSingletonOwnerHeld, releaseWindowsSingletonOwner,
  createWindowsSingletonOwnerHarnessForTest, windowsSingletonName, WindowsSingletonOwnerError,
} from '../../src/runtime/windows/windows-singleton-owner.ts';
import type {WindowsSingletonCloseObservation} from '../../src/runtime/windows/windows-singleton-owner.ts';

// Frozen independently using Python hashlib over ASCII-lowercased UTF-8, before
// candidate compilation/execution. Expected names never use the implementation.
const NAME_VECTORS = Object.freeze([
  ['C:\\', 'Local\\CodexDiscordBot_3dc8472eaebe1a9d'],
  ['C:\\Repo', 'Local\\CodexDiscordBot_c4866a467d261ea3'],
  ['c:\\rEPO', 'Local\\CodexDiscordBot_c4866a467d261ea3'],
  ['C:/Repo', 'Local\\CodexDiscordBot_619c46f38f5cfecb'],
  ['C:\\Repo\\', 'Local\\CodexDiscordBot_3bc36924e70cba40'],
  ['C:\\Repo\\.\\Child', 'Local\\CodexDiscordBot_9d935467d50b0aa8'],
  ['C:\\Repo\\..\\Other', 'Local\\CodexDiscordBot_c78d6818d9c3ef9e'],
  ['D:\\PROJECT WITH SPACES', 'Local\\CodexDiscordBot_30ccd501119c6037'],
  ['C:\\한글', 'Local\\CodexDiscordBot_7a67b1fc290d6606'],
  ['C:\\İ', 'Local\\CodexDiscordBot_556e08beba62e375'],
  ['C:\\😀', 'Local\\CodexDiscordBot_6bb6e336602c9448'],
  ['C:\\ΟΣ', 'Local\\CodexDiscordBot_fea1077fb9dc59f7'],
] as const);

function fixture(host: {platform?: string; arch?: string; mainThread?: boolean} = {}) {
  const calls: {name: string; args: unknown[]}[] = [];
  const declarations: string[] = [];
  const state = {
    mutex: 0xffff_ffff_ffff_ffffn as unknown, close: 1 as unknown,
    createError: 0 as unknown, closeError: 0 as unknown,
    mutexThrows: false, closeThrows: false, createCaptureThrows: false, closeCaptureThrows: false,
    onLoad: null as (() => void) | null,
    onCreate: null as (() => void) | null,
    onClose: null as (() => void) | null,
  };
  let loads = 0;
  let lastOperation: 'create' | 'close' = 'create';
  const move = Object.assign(() => { throw new Error('Move must not run'); }, {
    async() { throw new Error('Async move must not run'); },
  });
  const module = {version: '3.3.3', load(path: string) {
    assert.equal(path, 'kernel32.dll');
    return {func(declaration: string): unknown {
      declarations.push(declaration);
      switch (declaration) {
        case 'void * __stdcall CreateMutexW(void *attributes, int32_t initialOwner, str16 name)':
          return (...args: unknown[]) => {
            calls.push({name: 'create', args}); lastOperation = 'create'; state.onCreate?.();
            if (state.mutexThrows) throw new Error('PRIVATE native create path');
            return state.mutex;
          };
        case 'uint32_t __stdcall GetLastError(void)':
          return (...args: unknown[]) => {
            calls.push({name: 'last-error', args});
            if (lastOperation === 'create' ? state.createCaptureThrows : state.closeCaptureThrows)
              throw new Error('PRIVATE native DWORD path');
            return lastOperation === 'create' ? state.createError : state.closeError;
          };
        case 'int32_t __stdcall CloseHandle(void *handle)':
          return (...args: unknown[]) => {
            calls.push({name: 'close', args}); lastOperation = 'close'; state.onClose?.();
            if (state.closeThrows) throw new Error('PRIVATE native close path');
            return state.close;
          };
        case 'int32_t __stdcall MoveFileExW(str16 source, str16 destination, uint32_t flags)': return move;
        default: throw new Error('Unexpected native declaration');
      }
    }};
  }};
  const harness = createWindowsSingletonOwnerHarnessForTest({
    platform: host.platform ?? 'win32', arch: host.arch ?? 'x64', mainThread: host.mainThread ?? true,
    loadKoffi() { loads++; state.onLoad?.(); return module; },
  });
  return {harness, state, calls, declarations, module, get loads() { return loads; },
    closeCalls: () => calls.filter(call => call.name === 'close'),
  };
}

function refused(action: () => unknown, reason: WindowsSingletonOwnerError['reason']): WindowsSingletonOwnerError {
  let captured: unknown;
  try { action(); } catch (error) { captured = error; }
  assert.ok(captured instanceof WindowsSingletonOwnerError);
  assert.equal(captured.reason, reason);
  assert.equal(captured.code, 'WINDOWS_SINGLETON_OWNER_ERROR');
  assert.equal(Object.isFrozen(captured), true);
  assert.equal(Object.hasOwn(captured, 'cause'), false);
  assert.doesNotMatch(`${String(captured)} ${captured.stack} ${JSON.stringify(captured)}`, /PRIVATE/);
  return captured;
}

test('independent literal names match frozen Rust ASCII lowercase SHA-256 first16hex', () => {
  for (const [root, name] of NAME_VECTORS) {
    assert.equal(windowsSingletonName(root), name);
    assert.match(name, /^Local\\CodexDiscordBot_[0-9a-f]{16}$/);
    assert.equal(name.length, 38);
  }
});

test('only ASCII case folds; slashes, dot segments, trailing slash and spaces stay distinct', () => {
  assert.equal(windowsSingletonName('C:\\Repo'), windowsSingletonName('c:\\rEPO'));
  for (const alias of ['C:/Repo', 'C:\\Repo\\', 'C:\\Repo\\.', 'C:\\Repo ', 'C:\\other\\..\\Repo'])
    assert.notEqual(windowsSingletonName('C:\\Repo'), windowsSingletonName(alias));
  assert.notEqual(windowsSingletonName('C:\\Repo\\Child'), windowsSingletonName('C:\\Repo\\.\\Child'));
});

test('excluded root classes and nonprimitive inputs fail before loader or coercion', () => {
  const f = fixture(); let coercions = 0;
  const object = {get toString() { coercions++; throw new Error('PRIVATE coercion'); },
    get [Symbol.toPrimitive]() { coercions++; throw new Error('PRIVATE coercion'); }};
  const invalid: unknown[] = [undefined, null, true, 1, 1n, Symbol('root'), new String('C:\\Repo'), object,
    '', 'Repo', 'C:', 'C:Repo', '\\Repo', '/Repo', '\\\\server\\share', '\\\\?\\C:\\Repo', '\\\\.\\C:\\Repo',
    'C:\\a\0b', 'C:\\Repo\n', 'C:\\Repo\r', 'C:\\Repo\t', 'C:\\Repo\x1f', 'C:\\Repo\x7f',
    'C:\\\ud800', 'C:\\\udfff'];
  for (const root of invalid) {
    refused(() => windowsSingletonName(root as string), 'input');
    refused(() => f.harness.acquire(root as string), 'input');
    refused(() => acquireWindowsSingletonOwner(root as string), 'input');
  }
  assert.equal(coercions, 0); assert.equal(f.loads, 0); assert.deepEqual(f.calls, []);
});

test('65536 UTF-8-byte ASCII boundary is exact and oversize fails before loading', async () => {
  const f = fixture(); const limit = 'C:\\' + 'a'.repeat(65_533);
  assert.equal(Buffer.byteLength(limit, 'utf8'), 65_536);
  assert.equal(windowsSingletonName(limit).length, 38);
  refused(() => f.harness.acquire(limit + 'a'), 'input'); assert.equal(f.loads, 0);
  const owner = f.harness.acquire(limit); f.harness.assertHeld(owner, limit);
  assert.equal((f.calls[0]?.args[2] as string).length, 38);
  await f.harness.release(owner);
});

test('real factory remains import-safe and non-Windows refusal cannot use a caller port', {skip: process.platform === 'win32'}, () => {
  const fake = {createMutex() { assert.fail('Caller binding must not run'); }};
  const error = refused(() => Reflect.apply(acquireWindowsSingletonOwner, fake, ['C:\\PRIVATE', fake]), 'binding');
  assert.equal(error.diagnostic?.operation, 'factory'); assert.equal(error.diagnostic?.phase, 'platform');
  assert.equal(error.custody, 'none');
  refused(() => acquireWindowsSingletonOwner('C:\\PRIVATE'), 'binding');
});

test('production worker acquisition refuses before the non-Windows/native-loader gate', async () => {
  const source = new URL('../../src/runtime/windows/windows-singleton-owner.js', import.meta.url).href;
  const worker = new Worker(`
    const {parentPort} = require('node:worker_threads');
    import(${JSON.stringify(source)}).then(({acquireWindowsSingletonOwner}) => {
      try { acquireWindowsSingletonOwner('C:\\\\Repo'); parentPort.postMessage({unexpected: true}); }
      catch (error) { parentPort.postMessage({reason: error.reason, diagnostic: error.diagnostic}); }
    }).catch(() => { process.exitCode = 1; });
  `, {eval: true});
  const message = await new Promise<unknown>((resolve, reject) => {
    let received = false; let message: unknown;
    worker.once('message', value => { received = true; message = value; });
    worker.once('error', reject);
    worker.once('exit', code => {
      if (code !== 0 || !received) reject(new Error('Worker gate did not report and exit successfully'));
      else resolve(message);
    });
  });
  assert.deepEqual(message, {reason: 'thread', diagnostic: null});
});

test('trusted harness uses 925 platform and x64/ARM64 gates, plus main-thread refusal', async () => {
  for (const host of [{platform: 'linux'}, {arch: 'ia32'}, {arch: 'mips'}, {mainThread: false}]) {
    const f = fixture(host); const error = refused(() => f.harness.acquire('C:\\Repo'), host.mainThread === false ? 'thread' : 'binding');
    assert.equal(error.diagnostic?.phase ?? 'thread', host.mainThread === false ? 'thread' : host.platform ? 'platform' : 'architecture');
    assert.equal(f.loads, 0); assert.deepEqual(f.calls, []);
  }
  for (const arch of ['x64', 'arm64']) {
    const f = fixture({arch}); const owner = f.harness.acquire('C:\\Repo');
    assert.equal(f.loads, 1); await f.harness.release(owner);
  }
});

test('arbitrary structural bindings are not a test-harness injection surface', () => {
  let invokes = 0;
  const fake = {createMutex() { invokes++; return {value: 1n, lastError: 0}; }, closeHandle() { invokes++; }};
  const harness = createWindowsSingletonOwnerHarnessForTest({platform: 'win32', arch: 'x64', mainThread: true, loadKoffi: () => fake});
  const error = refused(() => harness.acquire('C:\\Repo'), 'binding');
  assert.equal(error.diagnostic?.phase, 'version'); assert.equal(invokes, 0);
});

test('production and mock registries reject forged, cloned, proxied, foreign and prototype tokens without getters', async () => {
  const f = fixture(), other = fixture();
  const owner = f.harness.acquire('C:\\Repo'), foreign = other.harness.acquire('C:\\Repo');
  assert.equal(Object.getPrototypeOf(owner), null); assert.equal(Object.isFrozen(owner), true);
  assert.deepEqual(Reflect.ownKeys(owner), []); assert.equal(Object.isFrozen(f.harness), true);
  let getters = 0;
  const forged = {get root() { getters++; throw new Error('PRIVATE root'); }, get handle() { getters++; throw new Error('PRIVATE handle'); }};
  const proxy = new Proxy(owner, {get() { getters++; throw new Error('PRIVATE proxy'); }});
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const invalid = [null, undefined, true, 1, 1n, 'owner', () => {}, {}, {...owner}, Object.create(owner), forged, proxy, revoked.proxy, foreign];
  for (const token of invalid) {
    refused(() => f.harness.assertHeld(token, 'C:\\Repo'), 'identity');
    refused(() => f.harness.release(token), 'identity');
    refused(() => assertWindowsSingletonOwnerHeld(token, 'C:\\Repo'), 'identity');
    refused(() => releaseWindowsSingletonOwner(token), 'identity');
  }
  refused(() => assertWindowsSingletonOwnerHeld(owner, 'C:\\Repo'), 'identity');
  refused(() => releaseWindowsSingletonOwner(owner), 'identity');
  assert.equal(getters, 0); assert.equal(f.closeCalls().length, 0);
  await f.harness.release(owner); await other.harness.release(foreign);
  refused(() => assertWindowsSingletonOwnerHeld(owner, 'C:\\Repo'), 'identity');
});

test('held assertion requires the exact captured root, not merely its equal truncated name', async () => {
  const f = fixture(); let root = 'C:\\Repo'; const owner = f.harness.acquire(root); root = 'c:\\repo';
  f.harness.assertHeld(owner, 'C:\\Repo');
  for (const alias of [root, 'C:/Repo', 'C:\\Repo\\', new String('C:\\Repo'), null])
    refused(() => f.harness.assertHeld(owner, alias as string), 'root');
  refused(() => f.harness.acquire(root), 'unavailable');
  assert.equal(f.loads, 1); await f.harness.release(owner);
});

test('provisional reservation blocks loader and CreateMutexW same-name reentry', async () => {
  const f = fixture(); let reentries = 0;
  const reenter = () => { refused(() => f.harness.acquire('c:\\rEPO'), 'unavailable'); reentries++; };
  f.state.onLoad = reenter; f.state.onCreate = reenter;
  const owner = f.harness.acquire('C:\\Repo'); assert.equal(reentries, 2); assert.equal(f.loads, 1);
  assert.deepEqual(f.calls, [{name: 'create', args: [null, 0, 'Local\\CodexDiscordBot_c4866a467d261ea3']}, {name: 'last-error', args: []}]);
  await f.harness.release(owner);
});

test('factory failure removes only provisional reservation without native creation', async () => {
  const f = fixture(); f.state.onLoad = () => { throw new Error('PRIVATE loader path'); };
  const error = refused(() => f.harness.acquire('C:\\PRIVATE'), 'binding');
  assert.equal(error.diagnostic?.phase, 'dependency'); assert.equal(error.custody, 'none'); assert.deepEqual(f.calls, []);
  f.state.onLoad = null; const owner = f.harness.acquire('C:\\PRIVATE'); await f.harness.release(owner);
});

test('wide returned handle stays private and non183 stale DWORD never negates successful creation', async () => {
  for (const stale of [0, 1, 5, 6, 0xffff_ffff]) {
    const f = fixture(); f.state.createError = stale;
    const owner = f.harness.acquire('C:\\Repo'); f.harness.assertHeld(owner, 'C:\\Repo');
    assert.equal(f.closeCalls().length, 0); assert.deepEqual(Reflect.ownKeys(owner), []);
    const result = await f.harness.release(owner);
    assert.equal(result.closure, 'closed'); assert.equal(Object.isFrozen(result), true);
    assert.deepEqual(f.closeCalls(), [{name: 'close', args: [0xffff_ffff_ffff_ffffn]}]);
    assert.doesNotMatch(JSON.stringify(result), /handle|Repo/);
  }
});

test('183 closes the exact returned handle once and always refuses, then permits explicit fresh acquisition only after closed proof', async () => {
  const f = fixture(); f.state.createError = 183;
  const error = refused(() => f.harness.acquire('C:\\Repo'), 'already-exists');
  assert.equal(error.lastError, 183); assert.equal(error.custody, 'closed'); assert.equal(error.cleanup?.closure, 'closed');
  assert.deepEqual(f.closeCalls(), [{name: 'close', args: [0xffff_ffff_ffff_ffffn]}]);
  assert.deepEqual(f.calls.map(call => call.name), ['create', 'last-error', 'close', 'last-error']);
  f.state.createError = 0; const owner = f.harness.acquire('C:\\Repo'); await f.harness.release(owner);
});

test('183 cleanup with close success and DWORD capture failure still refuses and reports closed plus diagnostic', async () => {
  const f = fixture(); f.state.createError = 183; f.state.closeCaptureThrows = true;
  const error = refused(() => f.harness.acquire('C:\\Repo'), 'already-exists');
  assert.equal(error.custody, 'closed'); assert.equal(error.cleanup?.diagnostic?.phase, 'last-error');
  assert.equal(f.closeCalls().length, 1);
  f.state.createError = 0; f.state.closeCaptureThrows = false;
  const owner = f.harness.acquire('C:\\Repo'); await f.harness.release(owner);
});

test('183 failed, malformed or throwing cleanup retains name debt permanently without retry', () => {
  for (const mode of ['zero', 'malformed', 'throw']) {
    const f = fixture(); f.state.createError = 183; f.state.closeError = 6;
    f.state.close = mode === 'zero' ? 0 : mode === 'malformed' ? true : 1; f.state.closeThrows = mode === 'throw';
    const error = refused(() => f.harness.acquire('C:\\Repo'), 'already-exists');
    assert.equal(error.custody, 'unresolved'); assert.equal(error.cleanup?.closure, 'unresolved');
    f.state.close = 1; f.state.closeThrows = false; f.state.createError = 0;
    refused(() => f.harness.acquire('C:\\Repo'), 'unavailable');
    assert.equal(f.closeCalls().length, 1); assert.equal(f.loads, 1);
  }
});

test('null handle never closes, including 183 or failed DWORD capture, and releases provisional name', async () => {
  for (const mode of ['zero', '183', 'capture']) {
    const f = fixture(); f.state.mutex = null; f.state.createError = mode === '183' ? 183 : 0;
    f.state.createCaptureThrows = mode === 'capture';
    const error = refused(() => f.harness.acquire('C:\\Repo'), mode === 'capture' ? 'binding' : 'create-failed');
    assert.equal(error.custody, 'none'); assert.equal(error.cleanup, null); assert.equal(f.closeCalls().length, 0);
    f.state.mutex = 1n; f.state.createError = 0; f.state.createCaptureThrows = false;
    const owner = f.harness.acquire('C:\\Repo'); await f.harness.release(owner);
  }
});

test('known-handle quarantine reuses 925 one-shot cleanup for thrown and malformed DWORD capture', async () => {
  for (const errorValue of [-1, 0x1_0000_0000, 0.5, NaN, Infinity, '5', 5n, 'throw']) {
    const f = fixture(); f.state.createError = errorValue; f.state.createCaptureThrows = errorValue === 'throw';
    const error = refused(() => f.harness.acquire('C:\\Repo'), 'binding');
    assert.equal(error.diagnostic?.phase, 'last-error'); assert.equal(error.custody, 'closed');
    assert.deepEqual(f.closeCalls(), [{name: 'close', args: [0xffff_ffff_ffff_ffffn]}]);
    f.state.createError = 0; f.state.createCaptureThrows = false;
    const owner = f.harness.acquire('C:\\Repo'); await f.harness.release(owner);
  }
});

test('known quarantine retains unresolved close debt and preserves proved close despite failed close capture', async () => {
  for (const closes of [false, true]) {
    const f = fixture(); f.state.createCaptureThrows = true; f.state.closeCaptureThrows = true; f.state.close = closes ? 1 : 0;
    const error = refused(() => f.harness.acquire('C:\\Repo'), 'binding');
    assert.equal(error.custody, closes ? 'closed' : 'unresolved'); assert.equal(error.cleanup?.diagnostic?.phase, 'last-error');
    assert.equal(f.closeCalls().length, 1);
    f.state.createCaptureThrows = false; f.state.closeCaptureThrows = false; f.state.close = 1;
    if (closes) { const owner = f.harness.acquire('C:\\Repo'); await f.harness.release(owner); }
    else { refused(() => f.harness.acquire('C:\\Repo'), 'unavailable'); assert.equal(f.closeCalls().length, 1); }
  }
});

test('known quarantine zero, malformed and throwing close keeps exact one-shot debt', () => {
  for (const mode of ['zero', 'malformed', 'throw']) {
    const f = fixture(); f.state.createCaptureThrows = true;
    f.state.close = mode === 'zero' ? 0 : mode === 'malformed' ? true : 1;
    f.state.closeThrows = mode === 'throw';
    const error = refused(() => f.harness.acquire('C:\\Repo'), 'binding');
    assert.equal(error.custody, 'unresolved'); assert.equal(error.cleanup?.closure, 'unresolved');
    assert.equal(error.cleanup?.diagnostic?.phase ?? 'win32', mode === 'zero' ? 'win32' : mode === 'throw' ? 'invoke' : 'result');
    f.state.createCaptureThrows = false; f.state.close = 1; f.state.closeThrows = false;
    refused(() => f.harness.acquire('C:\\Repo'), 'unavailable'); assert.equal(f.closeCalls().length, 1);
    assert.deepEqual(f.closeCalls()[0]?.args, [0xffff_ffff_ffff_ffffn]);
  }
});

test('malformed handle and CreateMutexW invocation uncertainty retain unknown debt without pointer invention or cleanup retry', () => {
  for (const value of [0n, -1n, 0x1_0000_0000_0000_0000n, 1234, undefined, {}, 'PRIVATE handle', 'throw']) {
    const f = fixture(); f.state.mutex = value; f.state.mutexThrows = value === 'throw';
    const error = refused(() => f.harness.acquire('C:\\PRIVATE'), 'binding');
    assert.equal(error.custody, 'unresolved'); assert.equal(error.cleanup, null); assert.equal(f.closeCalls().length, 0);
    f.state.mutex = 1n; f.state.mutexThrows = false;
    refused(() => f.harness.acquire('C:\\PRIVATE'), 'unavailable');
    assert.equal(f.loads, 1); assert.equal(f.closeCalls().length, 0);
  }
});

test('release invalidates before FFI, shares cached Promise during reentry, and never closes twice', async () => {
  const f = fixture(); const owner = f.harness.acquire('C:\\Repo');
  let nested: Promise<WindowsSingletonCloseObservation> | undefined;
  f.state.onClose = () => {
    refused(() => f.harness.assertHeld(owner, 'C:\\Repo'), 'not-held');
    refused(() => f.harness.acquire('C:\\Repo'), 'unavailable');
    nested = f.harness.release(owner);
  };
  const first = f.harness.release(owner); assert.equal(nested, first); assert.equal(f.harness.release(owner), first);
  const result = await first; assert.equal(result.closure, 'closed'); assert.equal(await f.harness.release(owner), result);
  assert.equal(f.closeCalls().length, 1); refused(() => f.harness.assertHeld(owner, 'C:\\Repo'), 'not-held');
  f.state.onClose = null; const fresh = f.harness.acquire('c:\\repo');
  assert.notEqual(fresh, owner); refused(() => f.harness.assertHeld(owner, 'C:\\Repo'), 'not-held');
  assert.equal(f.harness.release(owner), first); assert.equal(f.closeCalls().length, 1);
  await f.harness.release(fresh);
});

test('release uses full signed BOOL range and stale DWORD never invalidates closure', async () => {
  for (const value of [1, -1, -0x8000_0000, 0x7fff_ffff]) {
    const f = fixture(); f.state.close = value; f.state.closeError = 183;
    const owner = f.harness.acquire('C:\\Repo');
    assert.deepEqual(await f.harness.release(owner), {closure: 'closed', diagnostic: null, value, lastError: 183});
  }
});

test('successful release with thrown or malformed DWORD capture permits reacquisition while reporting diagnostic separately', async () => {
  for (const mode of ['throw', 'malformed']) {
    const f = fixture(); f.state.closeCaptureThrows = mode === 'throw'; f.state.closeError = mode === 'malformed' ? -1 : 0;
    const owner = f.harness.acquire('C:\\Repo'); const result = await f.harness.release(owner);
    assert.equal(result.closure, 'closed'); assert.equal(result.diagnostic?.phase, 'last-error');
    assert.equal(result.value, null); assert.equal(result.lastError, null);
    f.state.closeCaptureThrows = false; f.state.closeError = 0;
    const fresh = f.harness.acquire('C:\\Repo'); await f.harness.release(fresh);
  }
});

test('zero, malformed, throwing and failed-capture releases remain invalid and permanently unavailable with one attempt', async () => {
  for (const value of [0, true, undefined, 0x8000_0000, -0x8000_0001, NaN, 0.5, 'PRIVATE', 'throw', 'capture']) {
    const f = fixture(); const owner = f.harness.acquire('C:\\Repo'); f.state.closeError = 6;
    f.state.close = value === 'throw' ? 1 : value === 'capture' ? 0 : value;
    f.state.closeThrows = value === 'throw'; f.state.closeCaptureThrows = value === 'capture';
    const first = f.harness.release(owner); const result = await first;
    assert.equal(result.closure, 'unresolved'); assert.equal(Object.isFrozen(result), true);
    f.state.close = 1; f.state.closeThrows = false; f.state.closeCaptureThrows = false;
    assert.equal(f.harness.release(owner), first); assert.equal(await f.harness.release(owner), result);
    refused(() => f.harness.assertHeld(owner, 'C:\\Repo'), 'not-held');
    refused(() => f.harness.acquire('C:\\Repo'), 'unavailable');
    assert.equal(f.closeCalls().length, 1); assert.equal(f.loads, 1);
  }
});

test('discarding caller token does not close or erase strong per-name custody', () => {
  const f = fixture(); f.harness.acquire('C:\\Repo');
  assert.equal(f.closeCalls().length, 0); refused(() => f.harness.acquire('c:\\repo'), 'unavailable');
  assert.equal(f.loads, 1); assert.equal(f.closeCalls().length, 0);
});

test('distinct lexical names can be held while an unrelated name has unresolved debt', async () => {
  const f = fixture(); const first = f.harness.acquire('C:\\Repo');
  f.state.mutex = 2n; const other = f.harness.acquire('D:\\Other');
  f.state.close = 0; assert.equal((await f.harness.release(first)).closure, 'unresolved');
  f.harness.assertHeld(other, 'D:\\Other');
  f.state.close = 1; assert.equal((await f.harness.release(other)).closure, 'closed');
  refused(() => f.harness.acquire('C:\\Repo'), 'unavailable');
  const fresh = f.harness.acquire('D:\\Other'); await f.harness.release(fresh);
});

test('owner invokes only create/capture/close/capture and never move, wait or release-mutex', async () => {
  const f = fixture(); const owner = f.harness.acquire('C:\\Repo'); await f.harness.release(owner);
  assert.deepEqual(f.calls.map(call => call.name), ['create', 'last-error', 'close', 'last-error']);
  assert.equal(f.declarations.length, 4);
  assert.equal(f.declarations.some(declaration => /WaitFor|ReleaseMutex/.test(declaration)), false);
});
