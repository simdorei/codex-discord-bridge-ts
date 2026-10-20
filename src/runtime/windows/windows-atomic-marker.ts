import {randomUUID} from 'node:crypto';
import {mkdir, open, unlink} from 'node:fs/promises';
import type {FileHandle} from 'node:fs/promises';
import {isAbsolute, join, win32} from 'node:path';
import {
  createWindowsNativeBinding, createWindowsNativeBindingForTest, WindowsNativeBindingError,
} from './windows-native.ts';
import type {WindowsMoveSubmission, WindowsNativeBinding} from './windows-native.ts';
import {
  acquireWindowsSingletonOwner, assertWindowsSingletonOwnerHeld, releaseWindowsSingletonOwner,
  createWindowsSingletonOwnerHarnessForTest,
} from './windows-singleton-owner.ts';
import type {WindowsSingletonOwner, WindowsSingletonCloseObservation} from './windows-singleton-owner.ts';

/** Serialized write-through publication under the original native singleton. */
declare const profileBrand: unique symbol;
export interface WindowsAtomicMarkerProfile { readonly [profileBrand]: true; }
export type WindowsAtomicMarker = 'identity' | 'ack' | 'lock' | 'heartbeat';
export type WindowsAtomicMarkerPhase = 'binding' | 'mkdir' | 'open' | 'write' | 'sync' | 'close' | 'native' | 'cleanup';
type Outcome = 'not-published' | 'unconfirmed' | 'published';
type Reason = 'identity' | 'root' | 'selector' | 'text' | 'busy' | 'sealed' | 'quarantined' | 'binding' | 'io' | 'zero-progress' | 'native';
type Debt = Readonly<{handle: boolean; temporary: boolean}>;

export class WindowsAtomicMarkerError extends Error {
  readonly code = 'WINDOWS_ATOMIC_MARKER_ERROR';
  constructor(
    readonly reason: Reason,
    readonly phase: WindowsAtomicMarkerPhase | null = null,
    readonly outcome: Outcome = 'not-published',
    readonly debt: Debt = Object.freeze({handle: false, temporary: false}),
    readonly diagnostic: WindowsNativeBindingError | null = null,
    readonly lastError: number | null = null,
    readonly launchDiagnostic: WindowsNativeBindingError | null = null,
  ) {
    super(`Windows atomic marker failure (${reason}/${phase ?? 'admission'})`);
    this.name = 'WindowsAtomicMarkerError';
    this.stack = `${this.name}: ${this.message}`;
    Object.freeze(this);
  }
}

export interface WindowsAtomicMarkerPublication {
  readonly outcome: 'published';
  readonly lastError: number;
  readonly launchDiagnostic: WindowsNativeBindingError | null;
}
export interface WindowsAtomicMarkerStatus {
  readonly sealed: boolean;
  readonly quarantined: boolean;
  readonly phase: WindowsAtomicMarkerPhase | null;
  readonly debt: Debt;
  readonly launchDiagnostic: WindowsNativeBindingError | null;
}
export interface WindowsAtomicMarkerShutdown {
  readonly closure: 'closed' | 'unresolved';
  readonly debt: Debt;
  /** Null means file debt prevented any singleton release attempt. */
  readonly ownerRelease: WindowsSingletonCloseObservation | null;
}

const LEAVES = Object.freeze({identity: '.codex_discord_rust.drain.identity', ack: '.codex_discord_rust.drain.ack',
  lock: '.codex_discord_rust.runtime.lock', heartbeat: '.codex_discord_rust.heartbeat'});
const TEMP_PREFIX = '.codex_discord_rust.marker.';
const TEMP_SUFFIX = '.tmp';
// Reserve four units for the extended prefix and one for the terminating NUL.
const MAX_PATH_UNITS = 32762;
const MAX_TEXT_BYTES = 4096;
type FilePhase = Exclude<WindowsAtomicMarkerPhase, 'binding' | 'native'>;
type TestEvent = Readonly<{phase: FilePhase; path: string; offset: number}>;
interface FileAccess {
  path(root: string, leaf: string | null): string;
  before(phase: FilePhase, path: string, offset: number): Promise<void>;
  readonly writeChunkBytes: number;
  readonly zeroWriteAt: number | null;
}
interface Context {
  readonly identities: WeakMap<object, Entry>;
  readonly retained: Set<Entry>;
  readonly acquireOwner: (root: string) => WindowsSingletonOwner;
  readonly assertOwner: (owner: unknown, root: string) => void;
  readonly releaseOwner: (owner: unknown) => Promise<WindowsSingletonCloseObservation>;
  readonly makeBinding: () => WindowsNativeBinding;
  readonly files: FileAccess;
}
interface Operation {
  phase: WindowsAtomicMarkerPhase;
  readonly completion: Promise<WindowsAtomicMarkerPublication>;
  handle: FileHandle | null;
  temporary: string | null;
  owned: boolean;
  submission: WindowsMoveSubmission | null;
}
interface Entry {
  readonly root: string;
  readonly owner: WindowsSingletonOwner;
  readonly profile: WindowsAtomicMarkerProfile;
  binding: WindowsNativeBinding | null;
  active: Operation | null;
  sealed: boolean;
  quarantined: boolean;
  debt: Debt;
  /** Retain unresolved file handles/pathnames even after a failed operation settles. */
  retainedOperation: Operation | null;
  shutdown: Promise<WindowsAtomicMarkerShutdown> | null;
}

function nativePath(root: string, leaf: string): string {
  return `${root}${root.endsWith('\\') || root.endsWith('/') ? '' : '\\'}${leaf}`;
}
function movePath(root: string, leaf: string): string {
  const path = nativePath(root, leaf);
  return path.length > 259 ? win32.toNamespacedPath(path) : path;
}
function captureRoot(root: string): string {
  if (typeof root !== 'string' || root.length > MAX_PATH_UNITS ||
      !/^[A-Za-z]:[\\/]/.test(root) || /[\x00-\x1f\x7f]/.test(root) || /[\uD800-\uDFFF]/u.test(root) ||
      nativePath(root, `${TEMP_PREFIX}${'0'.repeat(36)}${TEMP_SUFFIX}`).length > MAX_PATH_UNITS ||
      nativePath(root, LEAVES.identity).length > MAX_PATH_UNITS ||
      nativePath(root, LEAVES.ack).length > MAX_PATH_UNITS) {
    throw new WindowsAtomicMarkerError('root');
  }
  return root;
}
function captureText(text: string): Buffer {
  // UTF-16 length is bounded before scanning/encoding. No object coercion.
  if (typeof text !== 'string' || text.length > MAX_TEXT_BYTES) throw new WindowsAtomicMarkerError('text');
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new WindowsAtomicMarkerError('text');
    } else if (unit >= 0xdc00 && unit <= 0xdfff) throw new WindowsAtomicMarkerError('text');
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) throw new WindowsAtomicMarkerError('text');
  return Buffer.from(text, 'utf8');
}
function context(
  acquireOwner: Context['acquireOwner'], assertOwner: Context['assertOwner'], releaseOwner: Context['releaseOwner'],
  makeBinding: Context['makeBinding'], files: FileAccess,
): Context {
  return {identities: new WeakMap(), retained: new Set(), acquireOwner, assertOwner, releaseOwner, makeBinding, files};
}
const production = context(acquireWindowsSingletonOwner, assertWindowsSingletonOwnerHeld, releaseWindowsSingletonOwner,
  createWindowsNativeBinding, {
    path: (root, leaf) => leaf === null ? root : nativePath(root, leaf),
    before: async () => {}, writeChunkBytes: MAX_TEXT_BYTES, zeroWriteAt: null,
  });
const retainedTestContexts: Context[] = [];

function acquire(scope: Context, root: string): WindowsAtomicMarkerProfile {
  const captured = captureRoot(root);
  // 926 reserves the name before any loader/native reentry and owns all failed
  // acquisition debt. This profile never receives or exposes a raw HANDLE.
  const owner = scope.acquireOwner(captured);
  const profile = Object.freeze(Object.create(null)) as WindowsAtomicMarkerProfile;
  const entry: Entry = {root: captured, owner, profile, binding: null, active: null,
    sealed: false, quarantined: false, debt: Object.freeze({handle: false, temporary: false}),
    retainedOperation: null, shutdown: null};
  scope.identities.set(profile, entry);
  scope.retained.add(entry);
  return profile;
}
function authentic(scope: Context, profile: unknown): Entry {
  const entry = typeof profile === 'object' && profile !== null ? scope.identities.get(profile) : undefined;
  if (entry === undefined) throw new WindowsAtomicMarkerError('identity');
  return entry;
}
function diagnostic(error: unknown): WindowsNativeBindingError | null {
  return error instanceof WindowsNativeBindingError ? error : null;
}
function absent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function execute(scope: Context, entry: Entry, operation: Operation, marker: WindowsAtomicMarker, bytes: Buffer): Promise<WindowsAtomicMarkerPublication> {
  const files = scope.files;
  let primary: WindowsAtomicMarkerError | null = null;
  let closed = false;
  let outcome: Outcome = 'not-published';
  let lastError: number | null = null;
  let launchDiagnostic: WindowsNativeBindingError | null = null;
  let temporaryLeaf: string | null = null;
  const phase = async (value: FilePhase, path: string, offset = 0): Promise<void> => {
    operation.phase = value;
    await files.before(value, path, offset);
  };
  try {
    scope.assertOwner(entry.owner, entry.root);
    // Active custody is already installed before this possibly reentrant loader.
    if (entry.binding === null) entry.binding = scope.makeBinding();
    temporaryLeaf = `${TEMP_PREFIX}${randomUUID()}${TEMP_SUFFIX}`;
    const parent = files.path(entry.root, null);
    const temporary = files.path(entry.root, temporaryLeaf);
    operation.temporary = temporary;
    await phase('mkdir', parent);
    await mkdir(parent, {recursive: true});
    await phase('open', temporary);
    operation.handle = await open(temporary, 'wx', 0o600);
    operation.owned = true; // EEXIST or other open failure confers no ownership.
    let offset = 0;
    while (offset < bytes.length) {
      await phase('write', temporary, offset);
      const requested = Math.min(bytes.length - offset, files.writeChunkBytes);
      const written = files.zeroWriteAt === offset ? 0 :
        (await operation.handle.write(bytes, offset, requested, offset)).bytesWritten;
      if (!Number.isInteger(written) || written <= 0 || written > requested)
        throw new WindowsAtomicMarkerError('zero-progress', 'write');
      offset += written;
    }
    await phase('sync', temporary);
    await operation.handle.sync();
  } catch (error) {
    primary = error instanceof WindowsAtomicMarkerError ? error : new WindowsAtomicMarkerError(
      operation.phase === 'binding' ? 'binding' : 'io', operation.phase, 'not-published', undefined, diagnostic(error));
  }

  // Close even after write/sync failure, but never retry an unproved close.
  if (operation.handle !== null) {
    try {
      await phase('close', operation.temporary!);
      await operation.handle.close();
      closed = true;
    } catch {
      primary ??= new WindowsAtomicMarkerError('io', 'close');
    }
  }
  if (primary === null) {
    operation.phase = 'native';
    // Only the private real 925 binding is used; no JS rename fallback exists.
    // A launch throw is caught by 925 and DOES NOT settle its completion.
    try {
      operation.submission = entry.binding!.moveReplaceWriteThrough(movePath(entry.root, temporaryLeaf!), movePath(entry.root, LEAVES[marker]));
      launchDiagnostic = operation.submission.launchError;
      const completion = await operation.submission.completion;
      if (completion.kind === 'binding-error') {
        outcome = 'unconfirmed';
        primary = new WindowsAtomicMarkerError('native', 'native', outcome, undefined, completion.error);
      } else {
        lastError = completion.lastError;
        if (completion.value === 0) primary = new WindowsAtomicMarkerError('native', 'native', 'not-published', undefined, null, lastError);
        else outcome = 'published';
      }
    } catch (error) {
      // Real 925 only throws for validation/busy, before launch. Conservatively
      // retain custody if its contract is ever violated instead of guessing.
      entry.debt = Object.freeze({handle: false, temporary: true});
      entry.quarantined = true;
      entry.retainedOperation = operation;
      outcome = 'unconfirmed';
      primary = new WindowsAtomicMarkerError('native', 'native', outcome, entry.debt, diagnostic(error));
    }
  }

  let temporaryDebt = entry.debt.temporary;
  const handleDebt = operation.handle !== null && !closed;
  // Only the owned temp is eligible. Proved close and actual callback completion
  // precede cleanup. ENOENT can mean a move happened before a capture error.
  if (primary !== null && operation.owned && closed && !temporaryDebt) {
    try {
      await phase('cleanup', operation.temporary!);
      try { await unlink(operation.temporary!); } catch (error) { if (!absent(error)) throw error; }
    } catch { temporaryDebt = true; }
  }
  if (handleDebt) temporaryDebt = operation.owned;
  entry.debt = Object.freeze({handle: handleDebt, temporary: temporaryDebt});
  if (handleDebt || temporaryDebt) {
    entry.quarantined = true;
    entry.retainedOperation = operation;
  }
  if (primary !== null) throw new WindowsAtomicMarkerError(primary.reason, primary.phase, outcome,
    entry.debt, primary.diagnostic, primary.lastError, launchDiagnostic);
  return Object.freeze({outcome: 'published', lastError: lastError!, launchDiagnostic});
}

function publish(scope: Context, profile: unknown, marker: WindowsAtomicMarker, text: string): Promise<WindowsAtomicMarkerPublication> {
  const entry = authentic(scope, profile);
  if (entry.sealed) throw new WindowsAtomicMarkerError('sealed');
  if (entry.quarantined) throw new WindowsAtomicMarkerError('quarantined');
  if (entry.active !== null) throw new WindowsAtomicMarkerError('busy');
  if (marker !== 'identity' && marker !== 'ack' && marker !== 'lock' && marker !== 'heartbeat') throw new WindowsAtomicMarkerError('selector');
  const bytes = captureText(text);
  let resolve!: (value: WindowsAtomicMarkerPublication) => void;
  let reject!: (error: unknown) => void;
  const completion = new Promise<WindowsAtomicMarkerPublication>((yes, no) => { resolve = yes; reject = no; });
  const operation: Operation = {phase: 'binding', completion, handle: null, temporary: null, owned: false, submission: null};
  entry.active = operation; // Before loader, hook, filesystem operation, or await.
  void execute(scope, entry, operation, marker, bytes).then(
    result => { entry.active = null; resolve(result); },
    error => { entry.active = null; reject(error); },
  );
  return completion;
}
function status(scope: Context, profile: unknown): WindowsAtomicMarkerStatus {
  const entry = authentic(scope, profile);
  return Object.freeze({sealed: entry.sealed, quarantined: entry.quarantined, phase: entry.active?.phase ?? null,
    debt: entry.debt, launchDiagnostic: entry.active?.submission?.launchError ?? null});
}
function shutdown(scope: Context, profile: unknown): Promise<WindowsAtomicMarkerShutdown> {
  const entry = authentic(scope, profile);
  if (entry.shutdown !== null) return entry.shutdown;
  let settle!: (value: WindowsAtomicMarkerShutdown) => void;
  const completion = new Promise<WindowsAtomicMarkerShutdown>(resolve => { settle = resolve; });
  entry.shutdown = completion;
  entry.sealed = true; // No callback/await can admit another publication.
  const finish = async (): Promise<WindowsAtomicMarkerShutdown> => {
    if (entry.active !== null) {
      try { await entry.active.completion; } catch { /* Joined cleanup; primary belongs to publisher. */ }
    }
    if (entry.debt.handle || entry.debt.temporary)
      return Object.freeze({closure: 'unresolved', debt: entry.debt, ownerRelease: null});
    const ownerRelease = await scope.releaseOwner(entry.owner);
    if (ownerRelease.closure === 'closed') scope.retained.delete(entry);
    else entry.quarantined = true;
    return Object.freeze({closure: ownerRelease.closure, debt: entry.debt, ownerRelease});
  };
  void finish().then(settle, () => {
    entry.quarantined = true;
    settle(Object.freeze({closure: 'unresolved', debt: entry.debt, ownerRelease: null}));
  });
  return completion;
}

export function acquireWindowsAtomicMarkerProfile(root: string): WindowsAtomicMarkerProfile { return acquire(production, root); }
export function assertWindowsAtomicMarkerHeld(profile: unknown, root: string): void {
  const entry = authentic(production, profile);
  if (entry.sealed) throw new WindowsAtomicMarkerError('sealed');
  if (entry.quarantined) throw new WindowsAtomicMarkerError('quarantined');
  if (entry.root !== root) throw new WindowsAtomicMarkerError('root');
  production.assertOwner(entry.owner, root);
}
export function publishWindowsAtomicMarker(profile: unknown, marker: WindowsAtomicMarker, text: string): Promise<WindowsAtomicMarkerPublication> {
  return publish(production, profile, marker, text);
}
export function windowsAtomicMarkerStatus(profile: unknown): WindowsAtomicMarkerStatus { return status(production, profile); }
export function shutdownWindowsAtomicMarkerProfile(profile: unknown): Promise<WindowsAtomicMarkerShutdown> { return shutdown(production, profile); }

export interface WindowsAtomicMarkerHarness {
  acquire(root: string): WindowsAtomicMarkerProfile;
  publish(profile: unknown, marker: WindowsAtomicMarker, text: string): Promise<WindowsAtomicMarkerPublication>;
  status(profile: unknown): WindowsAtomicMarkerStatus;
  shutdown(profile: unknown): Promise<WindowsAtomicMarkerShutdown>;
}

/** Trusted cloud-only test context. No structural binding, owner, or filesystem
 * port is accepted. All ordinary file operations are actual disposable files.
 * Phase controls can gate/fail file I/O but cannot fabricate native completion.
 */
export function createWindowsAtomicMarkerHarnessForTest(options: Readonly<{
  platform: string; arch: string; mainThread: boolean; loadKoffi: () => unknown;
  mapping: Readonly<{windowsRoot: string; fixtureRoot: string}>;
  beforePhase?: (event: TestEvent) => void | Promise<void>;
  writeChunkBytes?: number;
  zeroWriteAt?: number;
}>): WindowsAtomicMarkerHarness {
  const {platform, arch, mainThread, loadKoffi, beforePhase} = options;
  const {windowsRoot, fixtureRoot} = options.mapping;
  captureRoot(windowsRoot);
  if (typeof fixtureRoot !== 'string' || !isAbsolute(fixtureRoot) || fixtureRoot.includes('\0'))
    throw new WindowsAtomicMarkerError('root');
  const writeChunkBytes = options.writeChunkBytes ?? MAX_TEXT_BYTES;
  const zeroWriteAt = options.zeroWriteAt ?? null;
  if (!Number.isInteger(writeChunkBytes) || writeChunkBytes < 1 || writeChunkBytes > MAX_TEXT_BYTES ||
      (zeroWriteAt !== null && (!Number.isInteger(zeroWriteAt) || zeroWriteAt < 0 || zeroWriteAt > MAX_TEXT_BYTES)))
    throw new WindowsAtomicMarkerError('text');
  const owners = createWindowsSingletonOwnerHarnessForTest({platform, arch, mainThread, loadKoffi});
  const scope = context(owners.acquire, owners.assertHeld, owners.release,
    () => createWindowsNativeBindingForTest({platform, arch, loadKoffi}), {
      path: (_root, leaf) => leaf === null ? fixtureRoot : join(fixtureRoot, leaf),
      before: async (phase, path, offset) => { await beforePhase?.(Object.freeze({phase, path, offset})); },
      writeChunkBytes, zeroWriteAt,
    });
  retainedTestContexts.push(scope);
  return Object.freeze({
    acquire: (root: string) => {
      if (typeof root !== 'string' || root !== windowsRoot) throw new WindowsAtomicMarkerError('root');
      return acquire(scope, root);
    },
    publish: (profile: unknown, marker: WindowsAtomicMarker, text: string) => publish(scope, profile, marker, text),
    status: (profile: unknown) => status(scope, profile),
    shutdown: (profile: unknown) => shutdown(scope, profile),
  });
}
