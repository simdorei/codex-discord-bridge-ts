import {createHash} from 'node:crypto';
import {isMainThread} from 'node:worker_threads';
import {
  createWindowsNativeBinding, createWindowsNativeBindingForTest, WindowsNativeBindingError,
} from './windows-native.ts';
import type {WindowsCloseResult, WindowsMutexQuarantine, WindowsMutexResult, WindowsNativeBinding} from './windows-native.ts';

/** Native named-mutex ownership for a bounded local drive root. */
declare const ownerBrand: unique symbol;
export interface WindowsSingletonOwner { readonly [ownerBrand]: true; }
export interface WindowsSingletonCloseObservation {
  readonly closure: 'closed' | 'unresolved';
  readonly diagnostic: WindowsNativeBindingError | null;
  readonly value: number | null;
  readonly lastError: number | null;
}
type Operation = 'name' | 'acquire' | 'assert' | 'release';
type Reason = 'input' | 'thread' | 'unavailable' | 'binding' | 'create-failed' |
  'already-exists' | 'identity' | 'root' | 'not-held';
type Custody = 'none' | 'closed' | 'unresolved';

export class WindowsSingletonOwnerError extends Error {
  readonly code = 'WINDOWS_SINGLETON_OWNER_ERROR';
  constructor(
    readonly operation: Operation,
    readonly reason: Reason,
    readonly custody: Custody = 'none',
    readonly diagnostic: WindowsNativeBindingError | null = null,
    readonly lastError: number | null = null,
    readonly cleanup: WindowsSingletonCloseObservation | null = null,
  ) {
    super(`Windows singleton owner failure (${operation}/${reason})`);
    this.name = 'WindowsSingletonOwnerError';
    this.stack = `${this.name}: ${this.message}`;
    Object.freeze(this);
  }
}

type State = 'reserved' | 'held' | 'releasing' | 'closed' | 'unresolved';
interface Entry {
  readonly root: string;
  readonly name: string;
  state: State;
  binding: WindowsNativeBinding | null;
  handle: bigint | null;
  quarantine: WindowsMutexQuarantine | null;
  token: WindowsSingletonOwner | null;
  release: Promise<WindowsSingletonCloseObservation> | null;
  closeAttempted: boolean;
  cleanup: WindowsSingletonCloseObservation | null;
}
interface Context {
  readonly names: Map<string, Entry>;
  readonly identities: WeakMap<object, Entry>;
  readonly mainThread: () => boolean;
  readonly makeBinding: () => WindowsNativeBinding;
}

const MAX_ROOT_BYTES = 65_536;
const ERROR_ALREADY_EXISTS = 183;

function capturedRoot(root: string): string {
  // Check both UTF-16 and UTF-8 bounds before
  // hashing; never coerce, normalize, resolve, trim, or inspect a caller object.
  if (typeof root !== 'string' || root.length > MAX_ROOT_BYTES ||
      !/^[A-Za-z]:[\\/]/.test(root) || /[\x00-\x1f\x7f]/.test(root) ||
      /[\uD800-\uDFFF]/u.test(root) || Buffer.byteLength(root, 'utf8') > MAX_ROOT_BYTES) {
    throw new WindowsSingletonOwnerError('name', 'input');
  }
  return root;
}

/** Rust lexical Unicode lowercase / SHA-256 algorithm; no path normalization. */
export function windowsSingletonName(root: string): string {
  const captured = capturedRoot(root);
  if (process.versions.unicode !== '17.0') throw new WindowsSingletonOwnerError('name', 'input');
  return `Local\\CodexDiscordBot_${createHash('sha256').update(captured.toLowerCase(), 'utf8').digest('hex').slice(0, 16)}`;
}

function context(mainThread: () => boolean, makeBinding: () => WindowsNativeBinding): Context {
  return {names: new Map(), identities: new WeakMap(), mainThread, makeBinding};
}

// These private roots outlive caller references. Test custody is intentionally
// disjoint from production custody, including token authentication and debts.
const production = context(() => isMainThread, () => createWindowsNativeBinding());
const retainedTestContexts: Context[] = [];

function nativeDiagnostic(error: unknown): WindowsNativeBindingError | null {
  return error instanceof WindowsNativeBindingError ? error : null;
}

function observation(result: WindowsCloseResult): WindowsSingletonCloseObservation {
  return Object.freeze({closure: result.closure,
    diagnostic: result.kind === 'binding-error' ? result.error : null,
    value: result.kind === 'win32' ? result.value : null,
    lastError: result.kind === 'win32' ? result.lastError : null});
}

function closeOnce(scope: Context, entry: Entry, close: () => WindowsCloseResult): WindowsSingletonCloseObservation {
  if (entry.closeAttempted) return entry.cleanup!;
  entry.closeAttempted = true;
  entry.state = 'releasing';
  // Install fail-closed evidence before FFI. No callback/reentry can retry.
  entry.cleanup = Object.freeze({closure: 'unresolved',
    diagnostic: new WindowsNativeBindingError('close-handle', 'invoke'), value: null, lastError: null});
  try { entry.cleanup = observation(close()); } catch { /* Keep redacted unresolved evidence. */ }
  entry.state = entry.cleanup.closure;
  // A failed DWORD capture does not erase a proved nonzero CloseHandle result.
  if (entry.cleanup.closure === 'closed') scope.names.delete(entry.name);
  return entry.cleanup;
}

function acquire(scope: Context, root: string): WindowsSingletonOwner {
  if (!scope.mainThread()) throw new WindowsSingletonOwnerError('acquire', 'thread');
  const captured = capturedRoot(root);
  const name = windowsSingletonName(captured);
  if (scope.names.has(name)) throw new WindowsSingletonOwnerError('acquire', 'unavailable');
  const entry: Entry = {root: captured, name, state: 'reserved', binding: null, handle: null,
    quarantine: null, token: null, release: null, closeAttempted: false, cleanup: null};
  // Reserve before the factory as well as CreateMutexW, including loader reentry.
  scope.names.set(name, entry);
  let binding: WindowsNativeBinding;
  try { binding = scope.makeBinding(); entry.binding = binding; }
  catch (error) {
    scope.names.delete(name); // This layer has not submitted CreateMutexW.
    throw new WindowsSingletonOwnerError('acquire', 'binding', 'none', nativeDiagnostic(error));
  }
  let result: WindowsMutexResult;
  try { result = binding.createMutex(name); }
  catch (error) {
    entry.state = 'unresolved'; // A throw is not proof of no native side effect.
    throw new WindowsSingletonOwnerError('acquire', 'binding', 'unresolved', nativeDiagnostic(error));
  }
  if (result.kind === 'binding-error') {
    entry.quarantine = result.quarantine;
    if (result.ownership === 'none') {
      scope.names.delete(name);
      throw new WindowsSingletonOwnerError('acquire', 'binding', 'none', result.error);
    }
    if (result.quarantine?.kind === 'known-handle') {
      // Reuse 925's exact-handle, one-shot custody. Never reconstruct its handle.
      const quarantine = result.quarantine;
      const cleanup = closeOnce(scope, entry, () => quarantine.close());
      throw new WindowsSingletonOwnerError('acquire', 'binding', cleanup.closure, result.error, null, cleanup);
    }
    entry.state = 'unresolved'; // Retain unknown debt; no invented pointer/close.
    throw new WindowsSingletonOwnerError('acquire', 'binding', 'unresolved', result.error);
  }
  if (result.value === null) {
    scope.names.delete(name);
    throw new WindowsSingletonOwnerError('acquire', 'create-failed', 'none', null, result.lastError);
  }
  entry.handle = result.value;
  if (result.lastError === ERROR_ALREADY_EXISTS) {
    const handle = result.value;
    const cleanup = closeOnce(scope, entry, () => binding.closeHandle(handle));
    // Even proved cleanup never turns ERROR_ALREADY_EXISTS into an owner.
    throw new WindowsSingletonOwnerError('acquire', 'already-exists', cleanup.closure, null, result.lastError, cleanup);
  }
  const token = Object.freeze(Object.create(null)) as WindowsSingletonOwner;
  entry.token = token;
  entry.state = 'held';
  scope.identities.set(token, entry);
  return token;
}

function authentic(scope: Context, token: unknown, operation: 'assert' | 'release'): Entry {
  // No properties are read: getters, prototypes, proxies, copies, and brands
  // cannot substitute for the exact object minted in this private context.
  const entry = typeof token === 'object' && token !== null ? scope.identities.get(token) : undefined;
  if (entry === undefined) throw new WindowsSingletonOwnerError(operation, 'identity');
  return entry;
}

function assertHeld(scope: Context, token: unknown, root: string): void {
  const entry = authentic(scope, token, 'assert');
  if (entry.state !== 'held') throw new WindowsSingletonOwnerError('assert', 'not-held');
  if (typeof root !== 'string' || root !== entry.root) throw new WindowsSingletonOwnerError('assert', 'root');
}

function release(scope: Context, token: unknown): Promise<WindowsSingletonCloseObservation> {
  const entry = authentic(scope, token, 'release');
  if (entry.release !== null) return entry.release;
  if (entry.state !== 'held') throw new WindowsSingletonOwnerError('release', 'not-held');
  let settle!: (result: WindowsSingletonCloseObservation) => void;
  const completion = new Promise<WindowsSingletonCloseObservation>(resolve => { settle = resolve; });
  entry.release = completion;
  entry.state = 'releasing'; // Invalidate authority before any native call.
  const binding = entry.binding!;
  const handle = entry.handle!;
  settle(closeOnce(scope, entry, () => binding.closeHandle(handle)));
  return completion;
}

export function acquireWindowsSingletonOwner(root: string): WindowsSingletonOwner {
  return acquire(production, root);
}
export function assertWindowsSingletonOwnerHeld(token: unknown, root: string): void {
  assertHeld(production, token, root);
}
export function releaseWindowsSingletonOwner(token: unknown): Promise<WindowsSingletonCloseObservation> {
  return release(production, token);
}

export interface WindowsSingletonOwnerHarness {
  acquire(root: string): WindowsSingletonOwner;
  assertHeld(token: unknown, root: string): void;
  release(token: unknown): Promise<WindowsSingletonCloseObservation>;
}

/** Trusted raw-Koffi mock seam only; never accepts a structural native binding. */
export function createWindowsSingletonOwnerHarnessForTest(options: Readonly<{
  platform: string; arch: string; mainThread: boolean; loadKoffi: () => unknown;
}>): WindowsSingletonOwnerHarness {
  const {platform, arch, mainThread, loadKoffi} = options;
  const scope = context(() => mainThread, () => createWindowsNativeBindingForTest({platform, arch, loadKoffi}));
  retainedTestContexts.push(scope);
  return Object.freeze({
    acquire: (root: string) => acquire(scope, root),
    assertHeld: (token: unknown, root: string) => assertHeld(scope, token, root),
    release: (token: unknown) => release(scope, token),
  });
}
