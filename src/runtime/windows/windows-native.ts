import {createRequire} from 'node:module';

/** Uninstalled, unqualified Win32 binding contract. No runtime integration. */
export type WindowsHandle = bigint | null;
type Operation = 'factory' | 'create-mutex' | 'close-handle' | 'move-file';
type Phase = 'platform' | 'architecture' | 'dependency' | 'version' | 'surface' |
  'bind' | 'input' | 'busy' | 'invoke' | 'callback' | 'last-error' | 'result' | 'unknown-handle';

export class WindowsNativeBindingError extends Error {
  readonly code = 'WINDOWS_NATIVE_BINDING_ERROR';
  constructor(readonly operation: Operation, readonly phase: Phase) {
    super(`Windows native binding failure (${operation}/${phase})`);
    this.name = 'WindowsNativeBindingError';
    // Native exceptions can contain paths or arguments. Never retain their cause,
    // message, custom properties, or stack, including through a wrapper error.
    this.stack = `${this.name}: ${this.message}`;
    Object.freeze(this);
  }
}

type BindingFailure = Readonly<{kind: 'binding-error'; error: WindowsNativeBindingError}>;
export type WindowsObservation<T> = Readonly<{kind: 'win32'; value: T; lastError: number}>;
export type WindowsCloseResult = (WindowsObservation<number> | BindingFailure) &
  Readonly<{closure: 'closed' | 'unresolved'}>;
export interface WindowsMutexQuarantine {
  readonly kind: 'known-handle' | 'unknown-result';
  readonly state: 'retained' | 'closed' | 'unresolved';
  /** One shot, cached even when CloseHandle throws. No implicit retry. */
  close(): WindowsCloseResult;
}
export type WindowsMutexResult =
  | (WindowsObservation<WindowsHandle> & Readonly<{ownership: 'none' | 'returned'; quarantine: null}>)
  | (BindingFailure & Readonly<{
      ownership: 'none' | 'quarantined' | 'unknown'; quarantine: WindowsMutexQuarantine | null;
    }>);
export type WindowsMoveCompletion = WindowsObservation<number> | BindingFailure;
export interface WindowsMoveSubmission {
  readonly state: 'pending' | 'callback-complete';
  readonly launchError: WindowsNativeBindingError | null;
  /** Settles only on the actual native callback, never on a launch exception. */
  readonly completion: Promise<WindowsMoveCompletion>;
}
export interface WindowsNativeBinding {
  readonly dependencyVersion: '3.3.3';
  readonly pendingMoveCount: number;
  readonly quarantinedMutexCount: number;
  createMutex(name: string): WindowsMutexResult;
  closeHandle(handle: bigint): WindowsCloseResult;
  moveReplaceWriteThrough(source: string, destination: string): WindowsMoveSubmission;
  moveReplaceWriteThroughSync(source: string, destination: string): WindowsMoveCompletion;
}

type NativeFunction = (...args: unknown[]) => unknown;
type NativeCallback = (error: unknown, value: unknown) => void;
type RawCapture =
  | {kind: 'captured'; value: unknown; lastError: unknown}
  | {kind: 'failed'; phase: 'invoke' | 'last-error'; returned: boolean; value: unknown};

const MAX_POINTER = 0xffff_ffff_ffff_ffffn;
const CREATE_MUTEX = 'void * __stdcall CreateMutexW(void *attributes, int32_t initialOwner, str16 name)';
const GET_LAST_ERROR = 'uint32_t __stdcall GetLastError(void)';
const CLOSE_HANDLE = 'int32_t __stdcall CloseHandle(void *handle)';
const MOVE_FILE = 'int32_t __stdcall MoveFileExW(str16 source, str16 destination, uint32_t flags)';

// Intentionally process-lifetime rooted. There is no unload/reset API. This also
// keeps ambiguous submissions and quarantined ownership from disappearing on GC.
const retainedNativeLifetimes: unknown[] = [];

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
function functionValue(value: unknown): value is NativeFunction { return typeof value === 'function'; }
function uint32(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;
}
function int32(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= -0x8000_0000 && value <= 0x7fff_ffff;
}
function handle(value: unknown): value is bigint {
  return typeof value === 'bigint' && value > 0n && value <= MAX_POINTER;
}
function failure(operation: Operation, phase: Phase): BindingFailure {
  return Object.freeze({kind: 'binding-error', error: new WindowsNativeBindingError(operation, phase)});
}
function input(text: string, operation: Operation): string {
  if (typeof text !== 'string' || text.includes('\0')) throw new WindowsNativeBindingError(operation, 'input');
  return text;
}

/** The real factory: native module loading is impossible before both host gates. */
export function createWindowsNativeBinding(): WindowsNativeBinding {
  return construct(process.platform, process.arch, () => createRequire(import.meta.url)('koffi'));
}

/** Trusted contract-test seam only. It never substitutes for the real factory. */
export function createWindowsNativeBindingForTest(options: Readonly<{
  platform: string; arch: string; loadKoffi: () => unknown;
}>): WindowsNativeBinding {
  return construct(options.platform, options.arch, options.loadKoffi);
}

function construct(platform: string, arch: string, loadKoffi: () => unknown): WindowsNativeBinding {
  if (platform !== 'win32') throw new WindowsNativeBindingError('factory', 'platform');
  if (arch !== 'x64' && arch !== 'arm64') throw new WindowsNativeBindingError('factory', 'architecture');
  let module: unknown;
  try { module = loadKoffi(); } catch { throw new WindowsNativeBindingError('factory', 'dependency'); }
  if (!object(module)) throw new WindowsNativeBindingError('factory', 'surface');
  let version: unknown, load: unknown;
  try { version = module.version; load = module.load; }
  catch { throw new WindowsNativeBindingError('factory', 'surface'); }
  if (version !== '3.3.3') throw new WindowsNativeBindingError('factory', 'version');
  if (!functionValue(load)) throw new WindowsNativeBindingError('factory', 'surface');
  let library: unknown;
  try {
    library = Reflect.apply(load, module, ['kernel32.dll']);
    retainedNativeLifetimes.push({module, library});
  } catch { throw new WindowsNativeBindingError('factory', 'surface'); }
  let createMutex: NativeFunction, getLastError: NativeFunction, closeHandle: NativeFunction, moveAsync: NativeFunction;
  let moveFile: NativeFunction;
  try {
    if (!object(library)) throw new WindowsNativeBindingError('factory', 'surface');
    const func = library.func;
    if (!functionValue(func)) throw new WindowsNativeBindingError('factory', 'surface');
    const bind = (declaration: string): NativeFunction => {
      const result: unknown = Reflect.apply(func, library, [declaration]);
      if (!functionValue(result)) throw new WindowsNativeBindingError('factory', 'surface');
      return result;
    };
    createMutex = bind(CREATE_MUTEX);
    getLastError = bind(GET_LAST_ERROR);
    closeHandle = bind(CLOSE_HANDLE);
    moveFile = bind(MOVE_FILE);
    const async: unknown = Reflect.get(moveFile, 'async');
    if (!functionValue(async)) throw new WindowsNativeBindingError('factory', 'surface');
    moveAsync = async;
  } catch { throw new WindowsNativeBindingError('factory', 'bind'); }

  const quarantines = new Set<WindowsMutexQuarantine>();
  const pendingMoves = new Set<object>();
  const lifetime = {module, library, createMutex, getLastError, closeHandle, moveFile, moveAsync, quarantines, pendingMoves};
  retainedNativeLifetimes.push(lifetime);

  function captureSync(fn: NativeFunction, args: readonly unknown[]): RawCapture {
    let value: unknown;
    try { value = Reflect.apply(fn, undefined, args); }
    catch { return {kind: 'failed', phase: 'invoke', returned: false, value: undefined}; }
    // No validation, logging, await, or other FFI between native return and this.
    let lastError: unknown;
    try { lastError = getLastError(); }
    catch { return {kind: 'failed', phase: 'last-error', returned: true, value}; }
    return {kind: 'captured', value, lastError};
  }
  function closeKnown(known: bigint): WindowsCloseResult {
    const raw = captureSync(closeHandle, [known]);
    const closure = int32(raw.value) && raw.value !== 0 ? 'closed' : 'unresolved';
    if (raw.kind === 'failed') return Object.freeze({...failure('close-handle', raw.phase), closure});
    if (!int32(raw.value)) return Object.freeze({...failure('close-handle', 'result'), closure});
    if (!uint32(raw.lastError)) return Object.freeze({...failure('close-handle', 'last-error'), closure});
    return Object.freeze({kind: 'win32', value: raw.value, lastError: raw.lastError, closure});
  }
  function quarantine(candidate: unknown, returned: boolean): WindowsMutexQuarantine {
    const known = returned && handle(candidate);
    let state: WindowsMutexQuarantine['state'] = known ? 'retained' : 'unresolved';
    let result: WindowsCloseResult | undefined;
    const debt: WindowsMutexQuarantine = Object.freeze({
      kind: known ? 'known-handle' : 'unknown-result',
      get state() { return state; },
      close(): WindowsCloseResult {
        if (result !== undefined) return result;
        // Mark the attempt before FFI, so even synchronous reentry cannot retry.
        result = Object.freeze({...failure('close-handle', 'unknown-handle'), closure: 'unresolved'});
        state = 'unresolved';
        // Retain the exact candidate even when it is unsafe to pass back to FFI.
        result = known && handle(candidate) ? closeKnown(candidate) :
          Object.freeze({...failure('close-handle', 'unknown-handle'), closure: 'unresolved'});
        state = result.closure;
        if (state === 'closed') quarantines.delete(debt);
        return result;
      },
    });
    quarantines.add(debt);
    return debt;
  }

  return Object.freeze({
    dependencyVersion: '3.3.3',
    get pendingMoveCount() { return pendingMoves.size; },
    get quarantinedMutexCount() { return quarantines.size; },
    createMutex(name: string): WindowsMutexResult {
      const capturedName = input(name, 'create-mutex');
      const raw = captureSync(createMutex, [null, 0, capturedName]);
      const validHandle = raw.value === null || handle(raw.value);
      const phase = raw.kind === 'failed' ? raw.phase : !validHandle ? 'result' : !uint32(raw.lastError) ? 'last-error' : null;
      if (raw.kind === 'captured' && phase === null && validHandle && uint32(raw.lastError)) {
        return Object.freeze({kind: 'win32', value: raw.value as WindowsHandle, lastError: raw.lastError,
          ownership: raw.value === null ? 'none' : 'returned', quarantine: null});
      }
      const returned = raw.kind === 'captured' || raw.returned;
      const debt = returned && raw.value === null ? null : quarantine(raw.value, returned);
      return Object.freeze({...failure('create-mutex', phase ?? 'result'),
        ownership: debt === null ? 'none' : debt.kind === 'known-handle' ? 'quarantined' : 'unknown', quarantine: debt});
    },
    closeHandle(known: bigint): WindowsCloseResult {
      if (!handle(known)) throw new WindowsNativeBindingError('close-handle', 'input');
      return closeKnown(known);
    },
    moveReplaceWriteThroughSync(source: string, destination: string): WindowsMoveCompletion {
      const capturedSource = input(source, 'move-file'), capturedDestination = input(destination, 'move-file');
      if (pendingMoves.size !== 0) throw new WindowsNativeBindingError('move-file', 'busy');
      const raw = captureSync(moveFile, [capturedSource, capturedDestination, 0x9]);
      if (raw.kind === 'failed') return failure('move-file', raw.phase);
      if (!int32(raw.value)) return failure('move-file', 'result');
      if (!uint32(raw.lastError)) return failure('move-file', 'last-error');
      return Object.freeze({kind: 'win32', value: raw.value, lastError: raw.lastError});
    },
    moveReplaceWriteThrough(source: string, destination: string): WindowsMoveSubmission {
      // Primitive strings are captured before submission; Koffi owns its UTF-16
      // conversion storage through the callback. No caller object is retained.
      const capturedSource = input(source, 'move-file');
      const capturedDestination = input(destination, 'move-file');
      if (pendingMoves.size !== 0) throw new WindowsNativeBindingError('move-file', 'busy');
      let state: WindowsMoveSubmission['state'] = 'pending';
      let launchError: WindowsNativeBindingError | null = null;
      let resolveCompletion!: (result: WindowsMoveCompletion) => void;
      const completion = new Promise<WindowsMoveCompletion>(resolve => { resolveCompletion = resolve; });
      const retained = {lifetime, capturedSource, capturedDestination, completion};
      pendingMoves.add(retained);
      const callback: NativeCallback = (error, value) => {
        if (state === 'callback-complete') return;
        let result: WindowsMoveCompletion;
        if (error !== null && error !== undefined) {
          result = failure('move-file', 'callback');
        } else {
          // Koffi's saved worker error context is available only inside callback.
          let lastError: unknown;
          let captured = false;
          try { lastError = getLastError(); captured = true; } catch { /* redacted below */ }
          result = !captured || !uint32(lastError) ? failure('move-file', 'last-error') :
            !int32(value) ? failure('move-file', 'result') :
              Object.freeze({kind: 'win32', value, lastError});
        }
        state = 'callback-complete';
        pendingMoves.delete(retained);
        resolveCompletion(result);
      };
      const submission: WindowsMoveSubmission = Object.freeze({
        get state() { return state; }, get launchError() { return launchError; }, completion,
      });
      try { Reflect.apply(moveAsync, moveFile, [capturedSource, capturedDestination, 0x9, callback]); }
      catch { launchError = new WindowsNativeBindingError('move-file', 'invoke'); }
      return submission;
    },
  });
}
