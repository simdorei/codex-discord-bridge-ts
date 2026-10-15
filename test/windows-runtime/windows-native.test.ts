import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  createWindowsNativeBinding, createWindowsNativeBindingForTest, WindowsNativeBindingError,
} from '../../src/runtime/windows/windows-native.ts';

type Callback = (error: unknown, value: unknown) => void;
function fixture() {
  const calls: {name: string; args: unknown[]}[] = [];
  const events: string[] = [];
  const callbacks: Callback[] = [];
  const state = {
    mutex: 0x1234n as unknown, close: 1 as unknown, lastError: 0 as unknown,
    mutexThrows: false, closeThrows: false, lastErrorThrows: false,
    launch: null as null | ((callback: Callback) => void),
  };
  const move = Object.assign(() => { throw new Error('Synchronous move must never execute'); }, {
    async(...args: unknown[]): void {
      calls.push({name: 'MoveFileExW.async', args}); events.push('move');
      const callback = args[3]; assert.equal(typeof callback, 'function');
      callbacks.push(callback as Callback);
      state.launch?.(callback as Callback);
    },
  });
  const declarations: string[] = [];
  const library = {
    func(declaration: string): unknown {
      declarations.push(declaration);
      switch (declaration) {
        case 'void * __stdcall CreateMutexW(void *attributes, int32_t initialOwner, str16 name)':
          return (...args: unknown[]): unknown => {
            calls.push({name: 'CreateMutexW', args}); events.push('create');
            if (state.mutexThrows) throw new Error('PRIVATE mutex argument path');
            return state.mutex;
          };
        case 'uint32_t __stdcall GetLastError(void)':
          return (...args: unknown[]): unknown => {
            calls.push({name: 'GetLastError', args}); events.push('last-error');
            if (state.lastErrorThrows) throw new Error('PRIVATE last-error path');
            return state.lastError;
          };
        case 'int32_t __stdcall CloseHandle(void *handle)':
          return (...args: unknown[]): unknown => {
            calls.push({name: 'CloseHandle', args}); events.push('close');
            if (state.closeThrows) throw new Error('PRIVATE close handle path');
            return state.close;
          };
        case 'int32_t __stdcall MoveFileExW(str16 source, str16 destination, uint32_t flags)': return move;
        default: throw new Error('Unexpected declaration');
      }
    },
  };
  const loaded: unknown[] = [];
  const module = {version: '3.3.3', load(path: unknown): unknown { loaded.push(path); return library; }};
  const binding = createWindowsNativeBindingForTest({platform: 'win32', arch: 'x64', loadKoffi: () => module});
  function deliver(value: unknown, lastError: unknown, error: unknown = null, index = callbacks.length - 1): void {
    state.lastError = lastError;
    const callback = callbacks[index]; assert.ok(callback);
    callback(error, value);
    // Model Koffi restoring the previous main-thread context on callback return.
    state.lastError = 0xeeee;
    events.push('callback-return');
  }
  return {binding, state, calls, events, loaded, declarations, callbacks, module, library, move, deliver};
}
function assertRedacted(error: unknown, phase?: string): void {
  assert.ok(error instanceof WindowsNativeBindingError);
  if (phase !== undefined) assert.equal(error.phase, phase);
  assert.equal(error.code, 'WINDOWS_NATIVE_BINDING_ERROR');
  assert.equal(Object.hasOwn(error, 'cause'), false);
  assert.doesNotMatch(`${String(error)} ${error.stack} ${JSON.stringify(error)}`, /PRIVATE/);
}

test('real factory is import-safe and refuses this non-Windows host before loading', () => {
  assert.notEqual(process.platform, 'win32', 'This selected suite is cloud mock evidence only');
  assert.throws(createWindowsNativeBinding, error => { assertRedacted(error, 'platform'); return true; });
});

test('host gates run before injected loader, including unsupported Windows ia32', () => {
  for (const [platform, arch, phase] of [['linux', 'x64', 'platform'], ['darwin', 'arm64', 'platform'], ['win32', 'ia32', 'architecture'], ['win32', 'mips', 'architecture']]) {
    let loads = 0;
    assert.throws(() => createWindowsNativeBindingForTest({platform: platform!, arch: arch!, loadKoffi() { loads++; throw new Error('PRIVATE'); }}),
      error => { assertRedacted(error, phase); return true; });
    assert.equal(loads, 0);
  }
});

test('exact dependency version and named CJS runtime surface fail closed', () => {
  for (const module of [undefined, null, {}, {version: '3.3.2'}, {version: '3.3.4'}, {version: 3.3}, {version: '3.3.3', load: 1}, {default: {version: '3.3.3', load() {}}}]) {
    assert.throws(() => createWindowsNativeBindingForTest({platform: 'win32', arch: 'arm64', loadKoffi: () => module}),
      error => { assertRedacted(error); return true; });
  }
  assert.throws(() => createWindowsNativeBindingForTest({platform: 'win32', arch: 'x64', loadKoffi() { throw new Error('PRIVATE module location'); }}),
    error => { assertRedacted(error, 'dependency'); return true; });
});

test('malformed library, function, async surface and throwing getters are redacted', () => {
  const modules: unknown[] = [
    {version: '3.3.3', load() { return null; }},
    {version: '3.3.3', load() { return {func: 0}; }},
    {version: '3.3.3', load() { return {func() { return 1; }}; }},
    {version: '3.3.3', load() { return {func() { return () => 0; }}; }},
    {get version() { throw new Error('PRIVATE getter'); }},
    {version: '3.3.3', load() { throw new Error('PRIVATE library path'); }},
    {version: '3.3.3', load() { return {func() { throw new Error('PRIVATE declaration'); }}; }},
  ];
  for (const module of modules) assert.throws(() => createWindowsNativeBindingForTest({platform: 'win32', arch: 'x64', loadKoffi: () => module}),
    error => { assertRedacted(error); return true; });
});

test('only four fixed declarations bind once from kernel32 and references stay captured', () => {
  const f = fixture();
  assert.deepEqual(f.loaded, ['kernel32.dll']);
  assert.deepEqual(f.declarations, [
    'void * __stdcall CreateMutexW(void *attributes, int32_t initialOwner, str16 name)',
    'uint32_t __stdcall GetLastError(void)',
    'int32_t __stdcall CloseHandle(void *handle)',
    'int32_t __stdcall MoveFileExW(str16 source, str16 destination, uint32_t flags)',
  ]);
  f.module.load = () => { throw new Error('mutated loader'); };
  f.library.func = () => { throw new Error('mutated binder'); };
  f.move.async = () => { throw new Error('mutated async member'); };
  assert.equal(f.binding.createMutex('fixed').kind, 'win32');
  const move = f.binding.moveReplaceWriteThrough('a', 'b');
  assert.equal(move.launchError, null);
  assert.equal(f.callbacks.length, 1);
  f.deliver(1, 0);
  assert.equal(Object.isFrozen(f.binding), true);
  assert.equal('unload' in f.binding, false);
  assert.equal('reset' in f.binding, false);
});

test('CreateMutexW uses null attributes, zero BOOL, exact Unicode, and immediate DWORD capture', () => {
  const f = fixture(); f.state.lastError = 183;
  const name = 'Local\\한글-e\u0301-😀';
  const result = f.binding.createMutex(name);
  assert.deepEqual(f.calls, [{name: 'CreateMutexW', args: [null, 0, name]}, {name: 'GetLastError', args: []}]);
  assert.deepEqual(result, {kind: 'win32', value: 0x1234n, lastError: 183, ownership: 'returned', quarantine: null});
  // A returned handle, including ERROR_ALREADY_EXISTS, is cleanup ownership;
  // bInitialOwner=0 confers no waiting/locking/ReleaseMutex authority.
  assert.equal(f.calls.some(call => call.name === 'CloseHandle'), false);
});

test('null native handle is a Win32 observation, not a binding exception', () => {
  const f = fixture(); f.state.mutex = null; f.state.lastError = 5;
  assert.deepEqual(f.binding.createMutex('denied'), {kind: 'win32', value: null, lastError: 5, ownership: 'none', quarantine: null});
  assert.equal(f.binding.quarantinedMutexCount, 0);
});

test('handles preserve pointer width with no number conversion', () => {
  const f = fixture(); f.state.mutex = 0xffff_ffff_ffff_ffffn;
  const result = f.binding.createMutex('wide'); assert.equal(result.kind, 'win32');
  if (result.kind === 'win32') assert.equal(result.value, 0xffff_ffff_ffff_ffffn);
  f.binding.closeHandle(0xffff_ffff_ffff_ffffn);
  assert.deepEqual(f.calls.at(-2)?.args, [0xffff_ffff_ffff_ffffn]);
});

test('NUL and nonprimitive text are refused before any native calls', () => {
  const f = fixture();
  for (const invalid of ['before\0after', new String('boxed'), null, 1, {toString() { throw new Error('PRIVATE'); }}]) {
    assert.throws(() => f.binding.createMutex(invalid as string), error => { assertRedacted(error, 'input'); return true; });
    assert.throws(() => f.binding.moveReplaceWriteThrough(invalid as string, 'destination'), WindowsNativeBindingError);
    assert.throws(() => f.binding.moveReplaceWriteThrough('source', invalid as string), WindowsNativeBindingError);
  }
  assert.deepEqual(f.calls, []);
  assert.equal(f.binding.pendingMoveCount, 0);
});

test('DWORD capture failure after native mutex success creates exact one-shot cleanup custody', () => {
  const f = fixture(); f.state.lastErrorThrows = true;
  const result = f.binding.createMutex('PRIVATE-name');
  assert.equal(result.kind, 'binding-error'); assert.equal(result.ownership, 'quarantined');
  assert.ok(result.quarantine); assert.equal(result.quarantine.kind, 'known-handle');
  assert.equal(result.quarantine.state, 'retained'); assert.equal(f.binding.quarantinedMutexCount, 1);
  if (result.kind === 'binding-error') assertRedacted(result.error, 'last-error');
  assert.equal(f.calls.some(call => call.name === 'CloseHandle'), false);
  f.state.lastErrorThrows = false;
  const close = result.quarantine.close();
  assert.equal(close.closure, 'closed'); assert.equal(result.quarantine.close(), close);
  assert.equal(result.quarantine.state, 'closed'); assert.equal(f.binding.quarantinedMutexCount, 0);
  assert.deepEqual(f.calls.filter(call => call.name === 'CloseHandle'), [{name: 'CloseHandle', args: [0x1234n]}]);
});

test('invalid DWORD after valid handle also retains cleanup and never narrows DWORD', () => {
  for (const invalid of [-1, 0x1_0000_0000, 0.5, NaN, Infinity, '5', 5n]) {
    const f = fixture(); f.state.lastError = invalid;
    const result = f.binding.createMutex('capture');
    assert.equal(result.kind, 'binding-error'); assert.equal(result.ownership, 'quarantined');
    assert.ok(result.quarantine); assert.equal(f.binding.quarantinedMutexCount, 1);
  }
});

test('malformed mutex outputs remain quarantined without inventing pointer conversions', () => {
  for (const invalid of [0n, -1n, 0x1_0000_0000_0000_0000n, 1234, undefined, {}, 'PRIVATE handle']) {
    const f = fixture(); f.state.mutex = invalid;
    const result = f.binding.createMutex('capture');
    assert.equal(result.kind, 'binding-error'); assert.equal(result.ownership, 'unknown');
    assert.deepEqual(f.events, ['create', 'last-error']);
    assert.ok(result.quarantine); assert.equal(result.quarantine.kind, 'unknown-result');
    const close = result.quarantine.close(); assert.equal(close.closure, 'unresolved');
    assert.equal(result.quarantine.close(), close); assert.equal(f.binding.quarantinedMutexCount, 1);
    assert.equal(f.calls.some(call => call.name === 'CloseHandle'), false);
  }
});

test('CreateMutexW invocation exception reports unknown ownership, never proved nonowner', () => {
  const f = fixture(); f.state.mutexThrows = true;
  const result = f.binding.createMutex('PRIVATE-name');
  assert.equal(result.kind, 'binding-error'); assert.equal(result.ownership, 'unknown');
  if (result.kind === 'binding-error') assertRedacted(result.error, 'invoke');
  assert.ok(result.quarantine); assert.equal(result.quarantine.close().closure, 'unresolved');
  assert.deepEqual(f.events, ['create']); assert.equal(f.binding.quarantinedMutexCount, 1);
});

test('null handle with failed last-error capture proves no returned handle to close', () => {
  const f = fixture(); f.state.mutex = null; f.state.lastErrorThrows = true;
  const result = f.binding.createMutex('none');
  assert.equal(result.kind, 'binding-error'); assert.equal(result.ownership, 'none');
  assert.equal(result.quarantine, null); assert.equal(f.binding.quarantinedMutexCount, 0);
});

test('CloseHandle uses exact int32 BOOL and immediate DWORD; stale error never overrides success', () => {
  for (const value of [1, -1, -0x8000_0000, 0x7fff_ffff]) {
    const f = fixture(); f.state.close = value; f.state.lastError = 183;
    assert.deepEqual(f.binding.closeHandle(77n), {kind: 'win32', value, lastError: 183, closure: 'closed'});
    assert.deepEqual(f.events, ['close', 'last-error']);
  }
  const f = fixture(); f.state.close = 0; f.state.lastError = 6;
  assert.deepEqual(f.binding.closeHandle(77n), {kind: 'win32', value: 0, lastError: 6, closure: 'unresolved'});
});

test('invalid CloseHandle input never reaches FFI', () => {
  const f = fixture();
  for (const invalid of [null, 0n, -1n, 0x1_0000_0000_0000_0000n, 1, '1'])
    assert.throws(() => f.binding.closeHandle(invalid as bigint), WindowsNativeBindingError);
  assert.deepEqual(f.calls, []);
});

test('close success with failed DWORD capture preserves closed evidence', () => {
  const f = fixture(); f.state.lastErrorThrows = true;
  const create = f.binding.createMutex('capture'); assert.ok(create.quarantine);
  const close = create.quarantine.close();
  assert.equal(close.kind, 'binding-error'); assert.equal(close.closure, 'closed');
  assert.equal(create.quarantine.state, 'closed'); assert.equal(f.binding.quarantinedMutexCount, 0);
  if (close.kind === 'binding-error') assertRedacted(close.error, 'last-error');
});

test('failed, malformed or throwing close is unresolved and quarantine never retries', () => {
  for (const value of [0, true, undefined, 0x8000_0000, -0x8000_0001, NaN, 0.5, 'PRIVATE']) {
    const f = fixture(); f.state.lastErrorThrows = true;
    const create = f.binding.createMutex('capture'); assert.ok(create.quarantine);
    f.state.lastErrorThrows = false; f.state.close = value;
    const close = create.quarantine.close(); assert.equal(close.closure, 'unresolved');
    assert.equal(create.quarantine.close(), close); assert.equal(f.binding.quarantinedMutexCount, 1);
    assert.equal(f.calls.filter(call => call.name === 'CloseHandle').length, 1);
  }
  const f = fixture(); f.state.lastErrorThrows = true;
  const create = f.binding.createMutex('capture'); assert.ok(create.quarantine);
  f.state.closeThrows = true;
  const close = create.quarantine.close(); assert.equal(close.kind, 'binding-error');
  assert.equal(close.closure, 'unresolved'); assert.equal(create.quarantine.close(), close);
  if (close.kind === 'binding-error') assertRedacted(close.error, 'invoke');
  assert.equal(f.calls.filter(call => call.name === 'CloseHandle').length, 1);
});

test('move submits only async with exact captured Unicode paths and flags 0x9', async () => {
  const f = fixture(); let source = 'C:\\한글\\e\u0301😀.tmp', destination = 'C:\\한글\\final';
  const submission = f.binding.moveReplaceWriteThrough(source, destination);
  const originalSource = source, originalDestination = destination;
  source = 'changed'; destination = 'changed';
  assert.equal(submission.state, 'pending'); assert.equal(f.binding.pendingMoveCount, 1);
  assert.equal(submission.launchError, null);
  assert.deepEqual(f.calls[0]?.args.slice(0, 3), [originalSource, originalDestination, 0x9]);
  assert.equal(f.calls[0]?.name, 'MoveFileExW.async');
  let settled = false; void submission.completion.then(() => { settled = true; });
  await Promise.resolve(); assert.equal(settled, false);
  f.deliver(1, 0xffff_ffff);
  assert.equal(submission.state, 'callback-complete'); assert.equal(f.binding.pendingMoveCount, 0);
  assert.deepEqual(await submission.completion, {kind: 'win32', value: 1, lastError: 0xffff_ffff});
  assert.deepEqual(f.events, ['move', 'last-error', 'callback-return']);
  assert.equal(Object.isFrozen(submission), true);
});

test('async Win32 zero and callback binding error are different outcomes', async () => {
  const f = fixture();
  const failed = f.binding.moveReplaceWriteThrough('source', 'target');
  f.deliver(0, 5);
  assert.deepEqual(await failed.completion, {kind: 'win32', value: 0, lastError: 5});
  const bindingFailed = f.binding.moveReplaceWriteThrough('source', 'target');
  f.events.length = 0;
  f.deliver(1, 123, new Error('PRIVATE callback source path'));
  const result = await bindingFailed.completion;
  assert.equal(result.kind, 'binding-error');
  if (result.kind === 'binding-error') assertRedacted(result.error, 'callback');
  assert.deepEqual(f.events, ['callback-return']);
});

test('callback captures DWORD before result validation or Promise continuations', async () => {
  const f = fixture(); const submission = f.binding.moveReplaceWriteThrough('source', 'target');
  const continuation = submission.completion.then(result => { f.events.push('continuation'); return result; });
  f.deliver(true, 6);
  const result = await continuation; assert.equal(result.kind, 'binding-error');
  if (result.kind === 'binding-error') assertRedacted(result.error, 'result');
  assert.deepEqual(f.events, ['move', 'last-error', 'callback-return', 'continuation']);
});

test('callback DWORD throwing or out of range fails as binding capture, never Win32', async () => {
  for (const invalid of [-1, 0x1_0000_0000, 0.5, NaN, undefined]) {
    const f = fixture(); const submission = f.binding.moveReplaceWriteThrough('source', 'target');
    f.deliver(0, invalid); const result = await submission.completion;
    assert.equal(result.kind, 'binding-error');
    if (result.kind === 'binding-error') assertRedacted(result.error, 'last-error');
  }
  const f = fixture(); f.state.lastErrorThrows = true;
  const submission = f.binding.moveReplaceWriteThrough('source', 'target'); f.deliver(0, 5);
  const result = await submission.completion; assert.equal(result.kind, 'binding-error');
  if (result.kind === 'binding-error') assertRedacted(result.error, 'last-error');
});

test('one pending native move prevents overlap without starting a second operation', () => {
  const f = fixture(); const first = f.binding.moveReplaceWriteThrough('source', 'target');
  assert.throws(() => f.binding.moveReplaceWriteThrough('another', 'target'), error => { assertRedacted(error, 'busy'); return true; });
  assert.equal(first.state, 'pending'); assert.equal(f.callbacks.length, 1);
  assert.equal(f.binding.pendingMoveCount, 1);
});

test('launch exception is explicit retained debt and cannot settle callback-only completion', async () => {
  const f = fixture(); f.state.launch = () => { throw new Error('PRIVATE launch path'); };
  const submission = f.binding.moveReplaceWriteThrough('source', 'target');
  assertRedacted(submission.launchError, 'invoke'); assert.equal(submission.state, 'pending');
  let completed = false; void submission.completion.then(() => { completed = true; });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(completed, false); assert.equal(f.binding.pendingMoveCount, 1);
  assert.throws(() => f.binding.moveReplaceWriteThrough('retry', 'target'), WindowsNativeBindingError);
  f.deliver(0, 32);
  assert.deepEqual(await submission.completion, {kind: 'win32', value: 0, lastError: 32});
  assert.equal(f.binding.pendingMoveCount, 0); assert.equal(f.callbacks.length, 1);
});

test('callback-before-launch-throw remains authoritative completion evidence', async () => {
  const f = fixture(); f.state.lastError = 7;
  f.state.launch = callback => { callback(null, 0); throw new Error('PRIVATE after callback'); };
  const submission = f.binding.moveReplaceWriteThrough('source', 'target');
  assert.equal(submission.state, 'callback-complete'); assert.equal(f.binding.pendingMoveCount, 0);
  assertRedacted(submission.launchError, 'invoke');
  assert.deepEqual(await submission.completion, {kind: 'win32', value: 0, lastError: 7});
});

test('duplicate native callback neither recaptures error nor changes settled observation', async () => {
  const f = fixture(); const submission = f.binding.moveReplaceWriteThrough('source', 'target');
  f.deliver(1, 11); f.deliver(0, 99);
  assert.deepEqual(await submission.completion, {kind: 'win32', value: 1, lastError: 11});
  assert.equal(f.calls.filter(call => call.name === 'GetLastError').length, 1);
});

test('distinct callback DWORDs stay bound to their own sequential moves', async () => {
  const f = fixture();
  const first = f.binding.moveReplaceWriteThrough('one', 'target'); f.deliver(0, 5);
  const second = f.binding.moveReplaceWriteThrough('two', 'target'); f.deliver(0, 32);
  assert.deepEqual(await first.completion, {kind: 'win32', value: 0, lastError: 5});
  assert.deepEqual(await second.completion, {kind: 'win32', value: 0, lastError: 32});
});
