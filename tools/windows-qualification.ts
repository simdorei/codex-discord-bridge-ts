import {createHash, randomBytes} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {lstat as rawLstat, mkdir as rawMkdir, open as rawOpen, readFile as rawReadFile, readdir as rawReaddir, realpath as rawRealpath, unlink as rawUnlink, rmdir as rawRmdir} from 'node:fs/promises';
import {dirname, join, resolve, win32} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {isMainThread} from 'node:worker_threads';
import {setTimeout as delay, setImmediate as immediate} from 'node:timers/promises';

/** Additive qualification tool. Import/default execution performs no native work. */
export const LIMITS = Object.freeze({children: 3, transitionMs: 5000, caseMs: 30000,
  runMs: 300000, exitMs: 5000, packetBytes: 4096, slots: 128, outputBytes: 65536,
  replacements: 32, reads: 16384, pollMs: 10, files: 1024});
export const CASES = ['load', 'owner', 'contention-a', 'contention-b', 'death', 'move',
  'profile', 'replace-identity', 'replace-ack', 'shutdown', 'native-phase', 'rust'] as const;
export type CaseId = typeof CASES[number];
export type Status = 'PASS' | 'FAIL' | 'NOT RUN' | 'INCONCLUSIVE';
type Role = 'a' | 'b' | 'c';
type Mode = 'load' | 'owner' | 'contender' | 'fresh' | 'move' | 'profile' | 'writer' | 'reader' | 'shutdown' | 'native-phase';
type Event = 'loaded' | 'held' | 'refused' | 'published' | 'old' | 'new' | 'done';
type Cleanup = 'closed' | 'none' | 'unresolved';
type Reason = 'host' | 'arguments' | 'artifacts' | 'fixture' | 'protocol' | 'budget' | 'timeout' |
  'early-exit' | 'exit' | 'output' | 'native' | 'cleanup' | 'unobserved' | 'absent';
const MODES: readonly string[] = ['load', 'owner', 'contender', 'fresh', 'move', 'profile', 'writer', 'reader', 'shutdown', 'native-phase'];
const EVENTS: readonly string[] = ['loaded', 'held', 'refused', 'published', 'old', 'new', 'done'];
const SOURCE_FILES = ['src/runtime/windows/windows-native.ts', 'src/runtime/windows/windows-singleton-owner.ts',
  'src/runtime/windows/windows-atomic-marker.ts', 'tools/windows-qualification.ts'] as const;
const EMITTED_FILES = SOURCE_FILES.map(file => file.replace(/\.ts$/, '.js'));
const LEAVES = Object.freeze({identity: '.codex_discord_rust.drain.identity', ack: '.codex_discord_rust.drain.ack'});
const BODY = ['old:한글\0😀', 'new:e\u0301\0🪟'] as const;
const HEX = /^[0-9a-f]{64}$/;
const NONCE = /^[0-9a-f]{24}$/;
const self = fileURLToPath(import.meta.url);
const outputRoot = dirname(dirname(self));

interface Uncertainty {native: boolean; file: boolean; process: boolean;}
export class QualificationFault extends Error {
  constructor(readonly reason: Reason, readonly uncertainty: Readonly<Uncertainty> | null = null) { super(`Qualification ${reason}`); this.stack = this.message; Object.freeze(this); }
}
/** A deadline is a stop/debt signal, never cancellation or completion evidence. */
export class QualificationBudget {
  readonly absoluteEnd: number;
  end: number;
  expired = false;
  pending = 0;
  uncertainIo = false;
  constructor(milliseconds: number) { this.absoluteEnd = performance.now() + milliseconds; this.end = this.absoluteEnd; }
  check(): void { if (this.expired || performance.now() >= this.end) { this.expired = true; throw new QualificationFault('timeout'); } }
  async step<T>(action: () => Promise<T>, deadline = this.end): Promise<T> {
    const effective = Math.min(this.end, deadline);
    const gate = () => { this.check(); if (performance.now() >= effective) { this.expired = true; throw new QualificationFault('timeout'); } };
    gate(); this.pending++; let finished = false; let timer: NodeJS.Timeout | undefined;
    const operation = Promise.resolve().then(() => { gate(); return action(); });
    const settle = operation.finally(() => { this.pending--; finished = true; });
    try {
      const value = await Promise.race([settle, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { this.expired = true; this.uncertainIo ||= !finished; reject(new QualificationFault('timeout')); }, Math.max(1, effective - performance.now()));
      })]);
      gate(); return value;
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }
}
let budget: QualificationBudget | null = null;
const ioDeadline = new AsyncLocalStorage<number>();
function io<T>(action: () => Promise<T>): Promise<T> {
  const active = budget ?? new QualificationBudget(LIMITS.transitionMs);
  return active.step(action, ioDeadline.getStore() ?? active.end);
}
const lstat = (path: string) => io(() => rawLstat(path));
const mkdir = (path: string) => io(() => rawMkdir(path));
const open = (path: string, flags: string, mode?: number) => io(() => rawOpen(path, flags, mode));
const readFile = (path: string) => io(() => rawReadFile(path));
const readdir = (path: string, _options: {withFileTypes: true}) => io(() => rawReaddir(path, {withFileTypes: true}));
const realpath = (path: string) => io(() => rawRealpath(path));
const unlink = (path: string) => io(() => rawUnlink(path));
const rmdir = (path: string) => io(() => rawRmdir(path));
function check(condition: unknown, reason: Reason): asserts condition { if (!condition) throw new QualificationFault(reason); }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join('|') === [...keys].sort().join('|');
}
function bounded(value: unknown, max = 65536): value is number { return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max; }
function admittedChild(mode: string, caseId: CaseId, role: string, selector: string, root: string, nonce: string): boolean {
  if (win32.basename(root) !== `c${CASES.indexOf(caseId)}` || win32.basename(win32.dirname(root)) !== `wq-${nonce}`) return false;
  if (caseId === 'replace-identity' || caseId === 'replace-ack')
    return selector === caseId.slice(8) && (mode === 'writer' && role === 'a' || mode === 'reader' && role === 'b');
  if (selector !== 'identity') return false;
  if (caseId === 'contention-a' || caseId === 'contention-b') {
    const holder = caseId === 'contention-a' ? 'a' : 'b', other = holder === 'a' ? 'b' : 'a';
    return mode === 'owner' && role === holder || mode === 'contender' && role === other || mode === 'fresh' && role === 'c';
  }
  if (caseId === 'death') return mode === 'owner' && role === 'a' || mode === 'fresh' && role === 'c';
  return role === 'a' && mode === caseId && ['load', 'owner', 'move', 'profile', 'shutdown', 'native-phase'].includes(caseId);
}
export function admitHost(host: Readonly<{mainThread: boolean; platform: string; arch: string; version: string}>, args: readonly string[]): 'instructions' | 'native' | 'child' {
  if (args.length === 0 || args.length === 1 && args[0] === '--help') return 'instructions';
  // These checks precede path/dependency reads, production imports, fixtures and children.
  check(host.mainThread && host.platform === 'win32' && (host.arch === 'x64' || host.arch === 'arm64') && host.version === '24.21.0', 'host');
  if (args.length === 5 && args[0] === '--native' && args[1] === '--source-root' && args[3] === '--fixture-base') {
    admittedRoot(args[2]!); admittedRoot(args[4]!);
    admittedRoot(win32.join(args[4]!, `wq-${'0'.repeat(24)}`, 'c11', 'data')); return 'native';
  }
  if (args.length === 9 && args[0] === '--child' && MODES.includes(args[1]!) && CASES.includes(args[4] as CaseId) &&
      ['a', 'b', 'c'].includes(args[5]!) && NONCE.test(args[6]!) && ['identity', 'ack'].includes(args[7]!) && args[8] === 'protocol-1' &&
      admittedChild(args[1]!, args[4] as CaseId, args[5]!, args[7]!, args[3]!, args[6]!)) {
    admittedRoot(args[2]!); admittedRoot(args[3]!); admittedRoot(win32.join(args[3]!, 'data')); return 'child';
  }
  throw new QualificationFault('arguments');
}
export function admittedRoot(path: string): string {
  check(typeof path === 'string' && path.length <= 140 && /^[A-Za-z]:\\/.test(path) && !/[^\x20-\x7e]/.test(path), 'fixture');
  check(path === win32.normalize(path) && !path.endsWith('\\') && !path.includes('/'), 'fixture');
  const parts = path.slice(3).split('\\');
  check(parts.length > 0 && parts.every(part => /^[A-Za-z0-9_-][A-Za-z0-9_. -]*$/.test(part) &&
    !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)), 'fixture');
  return path;
}
async function checkedDirectory(path: string): Promise<void> {
  admittedRoot(path);
  // Check each existing component, refusing symlinks/junctions and spelling changes.
  for (let current = path; current.length > 3; current = win32.dirname(current)) {
    const info = await lstat(current); check(info.isDirectory() && !info.isSymbolicLink(), 'fixture');
    check((await realpath(current)).toLowerCase() === current.toLowerCase(), 'fixture');
  }
}
async function bytes(path: string, maximum: number): Promise<Buffer> {
  const info = await lstat(path); check(info.isFile() && !info.isSymbolicLink() && info.size <= maximum, 'artifacts');
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(maximum + 1); const result = await io(() => handle.read(buffer, 0, buffer.length, 0));
    check(result.bytesRead <= maximum, 'artifacts'); return buffer.subarray(0, result.bytesRead);
  } finally { await io(() => handle.close()); }
}
async function sha256(path: string): Promise<string> {
  const info = await lstat(path); check(info.isFile() && !info.isSymbolicLink() && info.size <= 100 * 1024 * 1024, 'artifacts');
  return createHash('sha256').update(await readFile(path)).digest('hex');
}
type Hashes = Record<string, string>;
interface Target {
  nodeSha256: string; mainArchiveSha512: string; prebuildArchiveSha512: string;
  files: Hashes; entry: string; prebuildEntry: string; binary: string; prebuildName: string; forbidden: string[];
}
interface Manifest {
  schemaVersion: 1; artifactSetId: string; source: Hashes; emitted: Hashes;
  targets: Record<'win32-x64' | 'win32-arm64', Target | null>;
}
export function validateManifest(value: unknown, arch: string): Manifest {
  check(object(value) && value.schemaVersion === 1 && value.artifactSetId === 'checkpoint928' && object(value.source) && object(value.emitted) && object(value.targets), 'artifacts');
  for (const [hashes, paths] of [[value.source, SOURCE_FILES], [value.emitted, EMITTED_FILES]] as const) {
    check(exact(hashes, paths) && Object.values(hashes).every(hash => typeof hash === 'string' && HEX.test(hash)), 'artifacts');
  }
  const target = value.targets[`win32-${arch}`];
  check(object(target) && typeof target.nodeSha256 === 'string' && HEX.test(target.nodeSha256) &&
    typeof target.mainArchiveSha512 === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(target.mainArchiveSha512) &&
    typeof target.prebuildArchiveSha512 === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(target.prebuildArchiveSha512) && object(target.files) &&
    exact(target.files, ['node_modules/koffi/package.json', 'node_modules/koffi/index.cjs', 'node_modules/koffi/src/koffi/index.cjs',
      'node_modules/koffi/src/koffi/src/static.cjs', `node_modules/@koromix/koffi-win32-${arch}/package.json`,
      `node_modules/@koromix/koffi-win32-${arch}/index.js`, `node_modules/@koromix/koffi-win32-${arch}/win32_${arch}/koffi.node`]) &&
    Object.entries(target.files).every(([path, hash]) => /^node_modules\/(?:@koromix\/)?[A-Za-z0-9_./-]+$/.test(path) && !path.includes('..') && typeof hash === 'string' && HEX.test(hash)), 'artifacts');
  check(typeof target.entry === 'string' && target.entry === 'node_modules/koffi/index.cjs' && typeof target.binary === 'string' &&
    Object.hasOwn(target.files, target.entry) && Object.hasOwn(target.files, target.binary) &&
    typeof target.prebuildEntry === 'string' && target.prebuildEntry === `node_modules/@koromix/koffi-win32-${arch}/index.js` && Object.hasOwn(target.files, target.prebuildEntry) &&
    typeof target.prebuildName === 'string' && target.prebuildName === `@koromix/koffi-win32-${arch}` &&
    Array.isArray(target.forbidden) && target.forbidden.length === 1 && target.forbidden[0] === `node_modules/koffi/build/koffi/win32_${arch}/koffi.node` &&
    target.binary === `node_modules/@koromix/koffi-win32-${arch}/win32_${arch}/koffi.node`, 'artifacts');
  return value as unknown as Manifest;
}
interface Verified {manifest: Manifest; target: Target; hashes: Hashes; sourceRoot: string; binary: string;}
async function verifyArtifacts(sourceRoot: string): Promise<Verified> {
  admittedRoot(sourceRoot); await checkedDirectory(outputRoot);
  const manifest = validateManifest(JSON.parse((await bytes(join(sourceRoot, 'tools/windows-qualification-artifacts.json'), 65536)).toString('utf8')), process.arch);
  const target = manifest.targets[`win32-${process.arch as 'x64' | 'arm64'}`]!;
  check(Reflect.get(process, 'resourcesPath') == null, 'artifacts');
  check((await bytes(join(outputRoot, 'package.json'), 64)).toString('utf8') === '{"type":"module"}\n', 'artifacts');
  const hashes: Hashes = {};
  for (const [root, expected, prefix] of [[sourceRoot, manifest.source, 'source'], [outputRoot, manifest.emitted, 'emitted']] as const) {
    for (const [path, hash] of Object.entries(expected)) { check(await sha256(join(root, path)) === hash, 'artifacts'); hashes[`${prefix}:${path}`] = hash; }
  }
  check(await sha256(process.execPath) === target.nodeSha256, 'artifacts'); hashes.node = target.nodeSha256;
  for (const [leaf, digest] of [['koffi-3.3.3.tgz', target.mainArchiveSha512], [`koffi-win32-${process.arch}-3.3.3.tgz`, target.prebuildArchiveSha512]] as const) {
    const archive = await bytes(join(outputRoot, 'artifacts', leaf), 40 * 1024 * 1024);
    check(createHash('sha512').update(archive).digest('base64') === digest, 'artifacts');
  }
  Object.assign(hashes, await verifyDependencyClosure(outputRoot, target));
  return {manifest, target, hashes, sourceRoot, binary: join(outputRoot, target.binary)};
}
/** Read-only closure check shared with real disposable cloud staging tests. */
export async function verifyDependencyClosure(root: string, target: Pick<Target, 'files' | 'entry' | 'prebuildEntry' | 'binary' | 'prebuildName' | 'forbidden'>): Promise<Hashes> {
  const hashes: Hashes = {};
  for (const [path, hash] of Object.entries(target.files)) { check(await sha256(join(root, path)) === hash, 'artifacts'); hashes[path] = hash; }
  for (const path of target.forbidden) {
    try { await lstat(join(root, path)); throw new QualificationFault('artifacts'); }
    catch (error) { check(object(error) && error.code === 'ENOENT', 'artifacts'); }
  }
  const require925 = createRequire(pathToFileURL(join(root, EMITTED_FILES[0]!)));
  check(require925.resolve('koffi') === join(root, target.entry), 'artifacts');
  check(require925.resolve(target.prebuildName) === join(root, target.prebuildEntry), 'artifacts');
  const requireStatic = createRequire(pathToFileURL(join(root, 'node_modules/koffi/src/koffi/src/static.cjs')));
  check(requireStatic.resolve(target.prebuildName) === join(root, target.prebuildEntry), 'artifacts');
  check(requireStatic.resolve(join(root, 'node_modules', target.prebuildName)) === join(root, target.prebuildEntry), 'artifacts');
  check((await realpath(join(root, target.entry))) === join(root, target.entry) &&
    (await realpath(join(root, target.binary))) === join(root, target.binary) &&
    (await realpath(join(root, target.prebuildEntry))) === join(root, target.prebuildEntry), 'artifacts');
  return hashes;
}
function loadedBinary(verified: Verified): void {
  const require925 = createRequire(pathToFileURL(join(outputRoot, EMITTED_FILES[0]!)));
  const native = Object.keys(require925.cache).filter(path => path.endsWith('.node'));
  check(native.length === 1 && native[0] === verified.binary, 'artifacts');
}
export interface Packet {
  nonce: string; caseId: CaseId; role: Role; sequence: number; event: Event;
  status: Status; cleanup: Cleanup; callbacks: number; reads: number; replacements: number; nativePhase: boolean; dwords: readonly number[];
}
export function parsePacket(raw: string, expected: Pick<Packet, 'nonce' | 'caseId' | 'role' | 'sequence'>): Packet {
  check(Buffer.byteLength(raw, 'utf8') <= LIMITS.packetBytes, 'protocol');
  let value: unknown; try { value = JSON.parse(raw); } catch { throw new QualificationFault('protocol'); }
  check(object(value) && exact(value, ['nonce', 'caseId', 'role', 'sequence', 'event', 'status', 'cleanup', 'callbacks', 'reads', 'replacements', 'nativePhase', 'dwords']) &&
    value.nonce === expected.nonce && value.caseId === expected.caseId && value.role === expected.role && value.sequence === expected.sequence &&
    bounded(value.sequence, LIMITS.slots - 1) && EVENTS.includes(value.event as string) && ['PASS', 'FAIL', 'NOT RUN', 'INCONCLUSIVE'].includes(value.status as string) &&
    ['closed', 'none', 'unresolved'].includes(value.cleanup as string) && bounded(value.callbacks, 128) && bounded(value.reads, LIMITS.reads) &&
    bounded(value.replacements, LIMITS.replacements) && typeof value.nativePhase === 'boolean' && Array.isArray(value.dwords) &&
    value.dwords.length <= 8 && value.dwords.every(dword => bounded(dword, 0xffff_ffff)), 'protocol');
  return Object.freeze(value) as unknown as Packet;
}
export interface CaseResult {caseId: CaseId; status: Status; reason: Reason | null; children: number;
  exited: number; closed: number; retained: boolean; callbacks: number; reads: number; replacements: number; nativePhase: boolean; dwords: number[]; uncertainty: Uncertainty; pendingIo: boolean;}
export function safeResult(caseId: CaseId, status: Status, error: unknown = null): CaseResult {
  return {caseId, status, reason: error instanceof QualificationFault ? error.reason : error === null ? null : 'native',
    children: 0, exited: 0, closed: 0, retained: status === 'FAIL' || status === 'INCONCLUSIVE', callbacks: 0, reads: 0, replacements: 0, nativePhase: false, dwords: [], uncertainty: {native: status === 'FAIL' || status === 'INCONCLUSIVE', file: status === 'FAIL' || status === 'INCONCLUSIVE', process: status === 'FAIL' || status === 'INCONCLUSIVE'}, pendingIo: false};
}
interface ProcessPort {
  on(name: string, listener: (...args: any[]) => void): unknown;
  stdout?: {on(name: string, listener: (chunk: Buffer) => void): unknown} | null;
  stderr?: {on(name: string, listener: (chunk: Buffer) => void): unknown} | null;
  kill(): boolean;
}
/** Orchestration accounting only: no method here settles a native operation. */
export class OwnedChild {
  exited = false; closed = false; poisoned = false; terminated = false;
  private code: number | null = null;
  private signal: string | null = null;
  private output = [0, 0];
  constructor(private readonly process: ProcessPort) {
    process.on('error', () => { this.poisoned = true; });
    process.on('exit', (code: number | null, signal: string | null) => { if (this.exited) this.poisoned = true; this.exited = true; this.code = code; this.signal = signal; });
    process.on('close', (code: number | null, signal: string | null) => {
      if (this.closed) this.poisoned = true; this.closed = true; if (!this.exited || code !== this.code || signal !== this.signal) this.poisoned = true;
    });
    for (const [index, stream] of [process.stdout, process.stderr].entries()) stream?.on('data', chunk => {
      this.output[index] = this.output[index]! + chunk.length;
      if (this.output[index]! > LIMITS.outputBytes) this.poisoned = true;
    });
  }
  checkAlive(): void { check(!this.poisoned, 'output'); check(!this.exited && !this.closed, 'early-exit'); }
  async finish(expectedDeath = false, milliseconds: number = LIMITS.exitMs): Promise<void> {
    const end = performance.now() + milliseconds;
    while (!this.exited || !this.closed) { check(performance.now() < end, 'timeout'); await delay(1); }
    check(!this.poisoned, 'exit');
    check(expectedDeath ? this.terminated && (this.code !== 0 || this.signal !== null) : this.code === 0 && this.signal === null && !this.terminated, 'exit');
  }
  terminate(): void {
    if (this.exited || this.terminated) return;
    this.terminated = true;
    try { if (!this.process.kill()) this.poisoned = true; } catch { this.poisoned = true; }
  }
}
export async function verifyOwnedCompletion(child: OwnedChild, receipt: Packet, milliseconds: number = LIMITS.exitMs): Promise<void> {
  check(receipt.event === 'done' && receipt.status === 'PASS' && receipt.cleanup === 'closed', 'protocol');
  await child.finish(false, milliseconds);
}
async function closedWrite(path: string, text: string): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try { await io(() => handle.writeFile(text, 'utf8')); await io(() => handle.sync()); } finally { await io(() => handle.close()); }
}
function protocolLeaf(role: Role, sequence: number, command: boolean, ready: boolean): string {
  check(bounded(sequence, LIMITS.slots - 1), 'budget'); return `${role}.${command ? 'go' : 'out'}.${sequence}.${ready ? 'ready' : 'json'}`;
}
async function writePacket(root: string, packet: Packet): Promise<void> {
  return ioDeadline.run(performance.now() + LIMITS.transitionMs, async () => {
  const text = JSON.stringify(packet); parsePacket(text, packet);
  await closedWrite(join(root, protocolLeaf(packet.role, packet.sequence, false, false)), text);
  await closedWrite(join(root, protocolLeaf(packet.role, packet.sequence, false, true)), packet.nonce);
  });
}
async function command(root: string, packet: Pick<Packet, 'nonce' | 'caseId' | 'role' | 'sequence'>): Promise<void> {
  return ioDeadline.run(performance.now() + LIMITS.transitionMs, async () => {
  const text = JSON.stringify(packet); check(Buffer.byteLength(text) < LIMITS.packetBytes, 'protocol');
  await closedWrite(join(root, protocolLeaf(packet.role, packet.sequence, true, false)), text);
  await closedWrite(join(root, protocolLeaf(packet.role, packet.sequence, true, true)), packet.nonce);
  });
}
let childFailure: {root: string; nonce: string; caseId: CaseId; role: Role} | null = null;
async function writeChildFailure(error: unknown): Promise<void> {
  return ioDeadline.run(performance.now() + LIMITS.transitionMs, async () => {
  if (childFailure === null || budget?.expired) return;
  const {root, ...identity} = childFailure;
  const reason = error instanceof QualificationFault ? error.reason : 'native';
  const report = {...identity, reason, uncertainty: {native: true, file: true, process: true}};
  await closedWrite(join(root, `${identity.role}.failure.json`), JSON.stringify(report));
  await closedWrite(join(root, `${identity.role}.failure.ready`), identity.nonce);
  });
}
async function readChildFailure(root: string, expected: Pick<Packet, 'nonce' | 'caseId' | 'role'>): Promise<void> {
  try {
    const sentinel = await bytes(join(root, `${expected.role}.failure.ready`), 24);
    check(sentinel.toString('utf8') === expected.nonce, 'protocol');
    const value: unknown = JSON.parse((await bytes(join(root, `${expected.role}.failure.json`), LIMITS.packetBytes)).toString('utf8'));
    check(object(value) && exact(value, ['nonce', 'caseId', 'role', 'reason', 'uncertainty']) &&
      Object.entries(expected).filter(([key]) => key !== 'sequence').every(([key, val]) => value[key] === val) &&
      typeof value.reason === 'string' && ['host', 'arguments', 'artifacts', 'fixture', 'protocol', 'budget', 'timeout', 'early-exit', 'exit', 'output', 'native', 'cleanup', 'unobserved', 'absent'].includes(value.reason) &&
      object(value.uncertainty) && exact(value.uncertainty, ['native', 'file', 'process']) &&
      Object.values(value.uncertainty).every(flag => typeof flag === 'boolean'), 'protocol');
    throw new QualificationFault(value.reason as Reason, value.uncertainty as unknown as Uncertainty);
  } catch (error) { if (object(error) && error.code === 'ENOENT') return; throw error; }
}
async function readWhenReady(root: string, expected: Pick<Packet, 'nonce' | 'caseId' | 'role' | 'sequence'>, isCommand: boolean, until: number, child?: OwnedChild): Promise<string> {
  return ioDeadline.run(until, async () => {
  let polls = 0; let exitRecheck = false;
  while (true) {
    check(performance.now() < until, 'timeout'); check(++polls <= 1000, 'budget');
    if (!isCommand && child !== undefined) await readChildFailure(root, expected);
    try {
      const sentinel = await bytes(join(root, protocolLeaf(expected.role, expected.sequence, isCommand, true)), 24);
      check(sentinel.toString('utf8') === expected.nonce, 'protocol');
      const text = (await bytes(join(root, protocolLeaf(expected.role, expected.sequence, isCommand, false)), LIMITS.packetBytes)).toString('utf8');
      if (isCommand) {
        let value: unknown; try { value = JSON.parse(text); } catch { throw new QualificationFault('protocol'); }
        check(object(value) && exact(value, ['nonce', 'caseId', 'role', 'sequence']) && Object.entries(expected).every(([key, val]) => value[key] === val), 'protocol');
      }
      check(performance.now() < until, 'timeout');
      return text;
    } catch (error) { if (!(object(error) && error.code === 'ENOENT')) throw error; }
    if (child !== undefined && (child.exited || child.closed)) {
      check(!child.poisoned, 'exit'); check(!exitRecheck, 'early-exit');
      exitRecheck = true; continue; // One final bounded read for a receipt closed just before exit.
    }
    child?.checkAlive(); await delay(LIMITS.pollMs);
  }
  });
}
interface TreeOwnership {protocol: Set<string>; data: readonly string[];}
async function inspectOwnedTree(root: string, ownership: TreeOwnership): Promise<void> {
  const entries = await readdir(root, {withFileTypes: true}); check(entries.length <= LIMITS.files, 'cleanup');
  const expected = new Set([...ownership.protocol, 'data']);
  check(entries.length === expected.size, 'cleanup');
  for (const entry of entries) {
    check(expected.has(entry.name) && !entry.isSymbolicLink(), 'cleanup');
    if (entry.name === 'data') {
      check(entry.isDirectory(), 'cleanup');
      const leaves = await readdir(join(root, 'data'), {withFileTypes: true});
      check(leaves.length === ownership.data.length, 'cleanup');
      for (const leaf of leaves) check(ownership.data.includes(leaf.name) && leaf.isFile() && !leaf.isSymbolicLink(), 'cleanup');
    } else check(entry.isFile(), 'cleanup');
  }
}
async function removeOwnedTree(root: string, ownership: TreeOwnership): Promise<void> {
  // No recursive deletion: every removal corresponds to proved case ownership.
  for (const leaf of ownership.data) await unlink(join(root, 'data', leaf));
  await rmdir(join(root, 'data'));
  for (const leaf of ownership.protocol) await unlink(join(root, leaf));
  await rmdir(root);
}
function dataLeaves(caseId: CaseId): readonly string[] {
  switch (caseId) {
    case 'move': return ['target.txt'];
    case 'profile': return [LEAVES.identity, LEAVES.ack];
    case 'replace-identity': case 'shutdown': case 'native-phase': return [LEAVES.identity];
    case 'replace-ack': return [LEAVES.ack];
    default: return [];
  }
}
/** Cloud-only protocol test adapter; cannot load native code or mint native reports. */
export function protocolForTest(root: string) {
  check(process.platform !== 'win32', 'host'); const ownership: TreeOwnership = {protocol: new Set(), data: []};
  return Object.freeze({
    write: async (packet: Packet) => {
      await writePacket(root, packet);
      ownership.protocol.add(protocolLeaf(packet.role, packet.sequence, false, false));
      ownership.protocol.add(protocolLeaf(packet.role, packet.sequence, false, true));
    },
    read: async (expected: Pick<Packet, 'nonce' | 'caseId' | 'role' | 'sequence'>, milliseconds = 1000) =>
      parsePacket(await readWhenReady(root, expected, false, performance.now() + milliseconds), expected),
    inspect: () => inspectOwnedTree(root, ownership),
  });
}
interface CaseContext {
  root: string; data: string; nonce: string; caseId: CaseId; end: number; stopped: boolean; nativeFinished: boolean; ownership: TreeOwnership;
  children: {owned: OwnedChild; role: Role}[]; result: CaseResult;
  cloudTest?: boolean; launch?: (args: readonly string[], env: NodeJS.ProcessEnv) => ProcessPort;
}
function until(context: CaseContext): number { return Math.min(context.end, performance.now() + LIMITS.transitionMs); }
export function admitOwnedChild(state: Readonly<{stopped: boolean; end: number;
  children: readonly Readonly<{role: string; closed: boolean; poisoned: boolean}>[]}>, role: string): void {
  check(!state.stopped && performance.now() < state.end && state.children.filter(child => !child.closed).length < LIMITS.children &&
    !state.children.some(child => child.role === role || child.poisoned), 'budget');
}
function start(context: CaseContext, sourceRoot: string, mode: Mode, role: Role, selector: 'identity' | 'ack' = 'identity'): OwnedChild {
  admitOwnedChild({stopped: context.stopped, end: context.end, children: context.children.map(child => ({role: child.role, closed: child.owned.closed, poisoned: child.owned.poisoned}))}, role);
  const env: NodeJS.ProcessEnv = {SystemRoot: process.env.SystemRoot, TEMP: context.root, TMP: context.root};
  const args = ['--no-strip-types', self, '--child', mode, sourceRoot, context.root, context.caseId, role, context.nonce, selector, 'protocol-1'];
  const processChild: ProcessPort = context.launch === undefined ? spawn(process.execPath, args, {shell: false, windowsHide: true,
    cwd: outputRoot, env, stdio: ['ignore', 'pipe', 'pipe']}) : context.launch(args, env);
  const owned = new OwnedChild(processChild); context.children.push({owned, role}); context.result.children++; return owned;
}
async function receive(context: CaseContext, role: Role, sequence: number, event: Event): Promise<Packet> {
  check(!context.stopped && performance.now() < context.end, 'timeout');
  const child = context.children.find(candidate => candidate.role === role)!.owned;
  const expected = {nonce: context.nonce, caseId: context.caseId, role, sequence};
  const packet = parsePacket(await readWhenReady(context.root, expected, false, until(context), child), expected);
  check(!context.stopped && performance.now() < context.end, 'timeout');
  if (event !== 'done') child.checkAlive();
  check(packet.event === event && (packet.status === 'PASS' || context.caseId === 'native-phase' && packet.status === 'INCONCLUSIVE'), 'native');
  check(packet.cleanup !== 'unresolved', 'cleanup');
  context.ownership.protocol.add(protocolLeaf(role, sequence, false, false));
  context.ownership.protocol.add(protocolLeaf(role, sequence, false, true));
  context.result.callbacks += packet.callbacks; context.result.reads += packet.reads; context.result.replacements += packet.replacements;
  context.result.nativePhase ||= packet.nativePhase;
  check(context.result.dwords.length + packet.dwords.length <= 32, 'protocol'); context.result.dwords.push(...packet.dwords);
  return packet;
}
async function send(context: CaseContext, role: Role, sequence: number): Promise<void> {
  check(!context.stopped && performance.now() < context.end, 'timeout');
  await command(context.root, {nonce: context.nonce, caseId: context.caseId, role, sequence});
  context.ownership.protocol.add(protocolLeaf(role, sequence, true, false));
  context.ownership.protocol.add(protocolLeaf(role, sequence, true, true));
}
async function complete(context: CaseContext, role: Role, sequence: number): Promise<Packet> {
  const packet = await receive(context, role, sequence, 'done');
  const owned = context.children.find(child => child.role === role)!.owned;
  if (packet.status === 'INCONCLUSIVE') { check(packet.cleanup === 'closed', 'cleanup'); await owned.finish(); context.result.status = 'INCONCLUSIVE'; context.result.reason = 'unobserved'; context.result.retained = true; }
  else await verifyOwnedCompletion(owned, packet);
  return packet;
}
export interface CaseDriver {
  start(mode: Mode, role: Role, selector?: 'identity' | 'ack'): OwnedChild;
  receive(role: Role, sequence: number, event: Event): Promise<Packet>;
  send(role: Role, sequence: number): Promise<void>;
  complete(role: Role, sequence: number): Promise<Packet>;
}
/** Shared finite orchestration, also driven by cloud process/protocol mocks. */
export async function orchestrateCase(id: CaseId, driver: CaseDriver): Promise<void> {
  if (id === 'rust') return;
  if (id === 'contention-a' || id === 'contention-b' || id === 'death') {
    const holderRole = id === 'contention-b' ? 'b' : 'a';
    const otherRole = holderRole === 'a' ? 'b' : 'a';
    const holder = driver.start('owner', holderRole); await driver.receive(holderRole, 0, 'held');
    if (id === 'death') { holder.terminate(); await holder.finish(true); }
    else {
      driver.start('contender', otherRole); await driver.complete(otherRole, 0);
      await driver.send(holderRole, 0); await driver.complete(holderRole, 1);
    }
    driver.start('fresh', 'c'); await driver.complete('c', 0); return;
  }
  if (id === 'replace-identity' || id === 'replace-ack') {
    const selector = id === 'replace-identity' ? 'identity' : 'ack';
    driver.start('writer', 'a', selector); await driver.receive('a', 0, 'published');
    driver.start('reader', 'b', selector);
    for (let index = 0; index < LIMITS.replacements; index++) {
      await driver.receive('b', index * 2, 'old'); await driver.send('a', index);
      await driver.receive('b', index * 2 + 1, 'new'); await driver.receive('a', index + 1, 'published');
      await driver.send('b', index);
    }
    await driver.send('a', LIMITS.replacements); await driver.complete('a', LIMITS.replacements + 1);
    await driver.complete('b', LIMITS.replacements * 2); return;
  }
  driver.start(id as Mode, 'a');
  if (id === 'owner') { await driver.receive('a', 0, 'held'); await driver.send('a', 0); await driver.complete('a', 1); }
  else await driver.complete('a', 0);
}
async function runCase(context: CaseContext, sourceRoot: string): Promise<void> {
  if (context.caseId === 'rust') { context.result.status = 'NOT RUN'; context.result.reason = 'absent'; return; }
  await orchestrateCase(context.caseId, {
    start: (mode, role, selector) => start(context, sourceRoot, mode, role, selector),
    receive: (role, sequence, event) => receive(context, role, sequence, event),
    send: (role, sequence) => send(context, role, sequence),
    complete: (role, sequence) => complete(context, role, sequence),
  });
}
async function boundedCase(context: CaseContext, sourceRoot: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  // Deadline stops orchestration, never pretends that a native callback occurred.
  const work = runCase(context, sourceRoot);
  try { await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new QualificationFault('timeout')), Math.max(1, context.end - performance.now())); })]); }
  catch (error) { context.stopped = true; if (error instanceof QualificationFault && error.reason === 'timeout') { budget!.expired = true; budget!.uncertainIo ||= budget!.pending > 0; } throw error; }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
async function manageCase(context: CaseContext, sourceRoot: string, end: number): Promise<boolean> {
  const result = context.result; let blocked = false;
    try {
      budget!.end = context.end; budget!.check(); if (!context.cloudTest) admittedRoot(context.data); await mkdir(context.root); await mkdir(context.data);
      await closedWrite(join(context.root, 'owner.json'), JSON.stringify({nonce: context.nonce, caseId: context.caseId}));
      await boundedCase(context, sourceRoot);
      context.nativeFinished = true; result.uncertainty = {native: false, file: false, process: false};
      if (result.status === 'PASS' || context.caseId === 'rust') {
        check(context.children.every(child => child.owned.exited && child.owned.closed && !child.owned.poisoned), 'cleanup');
        await inspectOwnedTree(context.root, context.ownership); await removeOwnedTree(context.root, context.ownership); result.retained = false; }
    } catch (error) {
      result.status = error instanceof QualificationFault && (error.reason === 'timeout' || error.reason === 'unobserved') ? 'INCONCLUSIVE' : 'FAIL';
      result.reason = error instanceof QualificationFault ? error.reason : 'native'; result.retained = true;
      result.uncertainty = error instanceof QualificationFault && error.uncertainty !== null ? {...error.uncertainty} :
        {native: context.children.length > 0 && !context.nativeFinished, file: true, process: context.children.some(child => !child.owned.closed || !child.owned.exited)};
      result.pendingIo = budget!.uncertainIo || budget!.pending > 0;
      if (budget!.expired || budget!.uncertainIo) blocked = true;
      for (const child of context.children) child.owned.terminate();
      context.stopped = true;
      await Promise.all(context.children.map(async child => { try { await child.owned.finish(child.owned.terminated, Math.max(1, Math.min(LIMITS.exitMs, end - performance.now()))); } catch { blocked = true; } }));
      // The root remains even after killed processes exit: no callback/cleanup proof.
    }
    result.exited = context.children.filter(child => child.owned.exited).length;
    result.closed = context.children.filter(child => child.owned.closed).length;
    result.uncertainty.process = result.exited !== result.children || result.closed !== result.children;
    if (context.children.some(child => !child.owned.exited || !child.owned.closed || child.owned.poisoned)) blocked = true;
    if (performance.now() >= end - (context.cloudTest ? 100 : LIMITS.exitMs)) blocked = true;
  return blocked;
}
/** Actual supervisor lifecycle with process ports, cloud-only and never native evidence. */
export async function supervisorCaseForTest(options: Readonly<{root: string; caseId?: CaseId; milliseconds?: number;
  launch: (args: readonly string[], env: NodeJS.ProcessEnv) => ProcessPort}>): Promise<{evidence: 'cloud-orchestration'; result: CaseResult; blocked: boolean}> {
  check(process.platform !== 'win32' && budget === null, 'host');
  const milliseconds = options.milliseconds ?? 1000; check(bounded(milliseconds, 5000) && milliseconds > 0, 'budget');
  budget = new QualificationBudget(milliseconds + 100);
  const caseId = options.caseId ?? 'load'; const result = safeResult(caseId, 'PASS');
  const context: CaseContext = {root: options.root, data: join(options.root, 'data'), nonce: 'a'.repeat(24), caseId,
    end: performance.now() + milliseconds, stopped: false, nativeFinished: false,
    ownership: {protocol: new Set(['owner.json']), data: dataLeaves(caseId)}, children: [], result, cloudTest: true, launch: options.launch};
  try { return {evidence: 'cloud-orchestration', result, blocked: await manageCase(context, 'cloud-test-source', budget.absoluteEnd)}; }
  finally { budget = null; }
}
async function supervisor(sourceRoot: string, base: string): Promise<void> {
  const end = budget!.absoluteEnd; budget!.end = end - LIMITS.exitMs;
  const verified = await verifyArtifacts(sourceRoot); await checkedDirectory(base);
  const nonce = randomBytes(12).toString('hex'); const runRoot = join(base, `wq-${nonce}`); admittedRoot(runRoot);
  await mkdir(runRoot); const results: CaseResult[] = []; let blocked = false;
  for (const [index, caseId] of CASES.entries()) {
    const result = safeResult(caseId, blocked ? 'NOT RUN' : 'PASS'); results.push(result);
    if (blocked) { result.reason = 'cleanup'; continue; }
    const root = join(runRoot, `c${index}`); const context: CaseContext = {root, data: join(root, 'data'), nonce, caseId,
      end: Math.min(end - LIMITS.exitMs, performance.now() + LIMITS.caseMs), stopped: false, nativeFinished: false, ownership: {protocol: new Set(['owner.json']), data: dataLeaves(caseId)}, children: [], result};
    blocked = await manageCase(context, verified.sourceRoot, end);
  }
  let retained = results.some(result => result.retained); let finalCleanupFailed = false;
  if (!retained) { try { budget!.end = end; await rmdir(runRoot); } catch { retained = true; finalCleanupFailed = true; } }
  process.stdout.write(JSON.stringify({schemaVersion: 1, evidence: 'native', platform: 'win32', architecture: process.arch,
    machineArchitecture: 'NOT VERIFIED; process architecture only', node: process.versions.node, artifacts: verified.hashes, cases: results,
    qualification: 'LIMITED CASE EVIDENCE ONLY', retained, cleanup: {status: finalCleanupFailed ? 'FAIL' : retained ? 'RETAINED' : 'CLOSED', reason: finalCleanupFailed ? 'cleanup' : null}, pendingIo: budget!.pending, uncertainIo: budget!.uncertainIo, exclusions: ['power-loss', 'physical-alias', 'ACL', 'AV', 'cross-session', 'native-leak', 'Rust', 'full-runtime']}) + '\n');
  process.exitCode = finalCleanupFailed || results.some(result => result.status === 'FAIL' || result.status === 'INCONCLUSIVE') ? 1 : 0;
}

async function child(args: readonly string[]): Promise<void> {
  const [_, mode, sourceRoot, root, caseValue, roleValue, nonce, selectorValue] = args;
  const verified = await verifyArtifacts(sourceRoot!); await checkedDirectory(root!);
  const caseId = caseValue as CaseId, role = roleValue as Role, selector = selectorValue as 'identity' | 'ack';
  const owner: unknown = JSON.parse((await bytes(join(root!, 'owner.json'), 128)).toString('utf8'));
  check(object(owner) && exact(owner, ['nonce', 'caseId']) && owner.nonce === nonce && owner.caseId === caseId, 'protocol');
  const data = join(root!, 'data'); await checkedDirectory(data);
  childFailure = {root: root!, nonce: nonce!, caseId, role};
  const base = {nonce: nonce!, caseId, role};
  const receipt = async (sequence: number, event: Event, extra: Partial<Pick<Packet, 'status' | 'cleanup' | 'callbacks' | 'reads' | 'replacements' | 'nativePhase' | 'dwords'>> = {}) => {
    await writePacket(root!, {...base, sequence, event, status: 'PASS', cleanup: 'none', callbacks: 0, reads: 0, replacements: 0, nativePhase: false, dwords: [], ...extra});
  };
  const go = async (sequence: number) => { await readWhenReady(root!, {...base, sequence}, true, performance.now() + LIMITS.transitionMs); };
  // Reader is a genuine filesystem-only direct child, never a native substitute.
  if (mode === 'reader') {
    let reads = 0;
    for (let index = 0; index < LIMITS.replacements; index++) {
      const old = BODY[index % 2]!, next = BODY[(index + 1) % 2]!;
      check((await bytes(join(data, LEAVES[selector]), 4096)).toString('utf8') === old, 'native'); reads++;
      await receipt(index * 2, 'old'); let observed = false; const end = performance.now() + LIMITS.transitionMs;
      while (!observed) {
        check(++reads <= LIMITS.reads, 'unobserved'); check(performance.now() < end, 'timeout');
        const text = (await bytes(join(data, LEAVES[selector]), 4096)).toString('utf8'); check(text === old || text === next, 'native');
        observed = text === next; if (!observed) await immediate();
      }
      await receipt(index * 2 + 1, 'new'); await go(index);
    }
    await receipt(LIMITS.replacements * 2, 'done', {cleanup: 'closed', reads}); return;
  }
  // Only these fixed, reviewed production modules can enter the native children.
  const native = await import('../src/runtime/windows/windows-native.ts');
  const singleton = await import('../src/runtime/windows/windows-singleton-owner.ts');
  const marker = await import('../src/runtime/windows/windows-atomic-marker.ts');
  const make = () => { const binding = native.createWindowsNativeBinding(); loadedBinary(verified); return binding; };
  const acquire = () => { const token = singleton.acquireWindowsSingletonOwner(data); loadedBinary(verified); return token; };
  const profile = () => { const token = marker.acquireWindowsAtomicMarkerProfile(data); loadedBinary(verified); return token; };
  const clean = async (token: unknown) => {
    const first = marker.shutdownWindowsAtomicMarkerProfile(token); check(first === marker.shutdownWindowsAtomicMarkerProfile(token), 'native');
    const result = await first; check(result.closure === 'closed' && result.ownerRelease?.closure === 'closed' && !result.debt.handle && !result.debt.temporary, 'cleanup');
  };
  const release = async (token: unknown) => {
    const first = singleton.releaseWindowsSingletonOwner(token); check(first === singleton.releaseWindowsSingletonOwner(token), 'native');
    check((await first).closure === 'closed', 'cleanup');
  };
  if (mode === 'load') { const binding = make(); check(binding.dependencyVersion === '3.3.3' && binding.pendingMoveCount === 0 && binding.quarantinedMutexCount === 0, 'native'); }
  else if (mode === 'owner' || mode === 'fresh') {
    const token = acquire(); singleton.assertWindowsSingletonOwnerHeld(token, data);
    if (mode === 'owner') { await receipt(0, 'held'); await go(0); }
    await release(token); const next = acquire(); await release(next);
    await receipt(mode === 'owner' ? 1 : 0, 'done', {cleanup: 'closed'}); return;
  } else if (mode === 'contender') {
    let refused = false;
    try { const unexpected = acquire(); await release(unexpected); }
    catch (error) { refused = error instanceof singleton.WindowsSingletonOwnerError && error.reason === 'already-exists' && error.lastError === 183 && error.custody === 'closed' && error.cleanup?.closure === 'closed'; }
    check(refused, 'native'); loadedBinary(verified);
    await receipt(0, 'done', {cleanup: 'closed', dwords: [183]}); return;
  } else if (mode === 'move') {
    const binding = make(); await closedWrite(join(data, 'source.txt'), BODY[1]); await closedWrite(join(data, 'target.txt'), BODY[0]);
    const first = binding.moveReplaceWriteThrough(join(data, 'source.txt'), join(data, 'target.txt'));
    const result = await first.completion; check(result.kind === 'win32' && result.value !== 0 && first.state === 'callback-complete' && binding.pendingMoveCount === 0, 'native');
    check((await bytes(join(data, 'target.txt'), 4096)).toString('utf8') === BODY[1], 'native');
    try { await lstat(join(data, 'source.txt')); throw new QualificationFault('native'); } catch (error) { check(object(error) && error.code === 'ENOENT', 'native'); }
    const missing = async (binding: ReturnType<typeof make>, parent: boolean) => {
      const submission = binding.moveReplaceWriteThrough(join(data, parent ? 'missing/leaf.txt' : 'absent.txt'), join(data, 'target.txt'));
      // V8 work and real synchronous Win32 activity while async work is pending.
      const mutex = binding.createMutex(singleton.windowsSingletonName(`${data}\\${parent ? 'm2' : 'm1'}`));
      check(mutex.kind === 'win32' && mutex.value !== null, 'native'); if (mutex.kind === 'win32' && mutex.value !== null) check(binding.closeHandle(mutex.value).closure === 'closed', 'cleanup');
      await immediate(); JSON.stringify(Array.from({length: 64}, (_, index) => ({index})));
      const observation = await submission.completion;
      check(observation.kind === 'win32' && observation.value === 0 && observation.lastError === (parent ? 3 : 2) && binding.pendingMoveCount === 0, 'native');
    };
    await missing(binding, false); await missing(binding, true); await Promise.all([missing(make(), false), missing(make(), true)]);
    await receipt(0, 'done', {cleanup: 'closed', callbacks: 5, dwords: [2, 3, 2, 3]}); return;
  } else if (mode === 'profile') {
    const token = profile(); let callbacks = 0;
    for (const which of ['identity', 'ack'] as const) for (const text of ['', BODY[0], 'x'.repeat(4096)]) {
      check((await marker.publishWindowsAtomicMarker(token, which, text)).outcome === 'published', 'native'); callbacks++;
      check((await bytes(join(data, LEAVES[which]), 4096)).equals(Buffer.from(text)), 'native');
    }
    for (const invalid of ['x'.repeat(4097), '\ud800']) {
      let refused = false; try { marker.publishWindowsAtomicMarker(token, 'identity', invalid); } catch (error) { refused = error instanceof marker.WindowsAtomicMarkerError && error.reason === 'text'; } check(refused, 'native');
    }
    await clean(token); await receipt(0, 'done', {cleanup: 'closed', callbacks}); return;
  } else if (mode === 'writer') {
    const token = profile(); await marker.publishWindowsAtomicMarker(token, selector, BODY[0]); await receipt(0, 'published', {callbacks: 1});
    for (let index = 0; index < LIMITS.replacements; index++) {
      await go(index); check((await marker.publishWindowsAtomicMarker(token, selector, BODY[(index + 1) % 2]!)).outcome === 'published', 'native');
      await receipt(index + 1, 'published', {callbacks: 1, replacements: 1});
    }
    await go(LIMITS.replacements); await clean(token); await receipt(LIMITS.replacements + 1, 'done', {cleanup: 'closed'}); return;
  } else if (mode === 'shutdown' || mode === 'native-phase') {
    const token = profile(); const publication = marker.publishWindowsAtomicMarker(token, 'identity', BODY[1]);
    let published = false; void publication.then(() => { published = true; }, () => {});
    let observed = false;
    if (mode === 'native-phase') {
      for (let index = 0; index < LIMITS.reads && !published; index++) {
        if (marker.windowsAtomicMarkerStatus(token).phase === 'native') { observed = true; break; } await immediate();
      }
    }
    const shutdown = marker.shutdownWindowsAtomicMarkerProfile(token); check(shutdown === marker.shutdownWindowsAtomicMarkerProfile(token), 'native');
    let premature = false; void shutdown.then(() => { if (!published) premature = true; });
    check(marker.windowsAtomicMarkerStatus(token).sealed, 'native'); let sealed = false;
    try { marker.publishWindowsAtomicMarker(token, 'ack', BODY[0]); } catch (error) { sealed = error instanceof marker.WindowsAtomicMarkerError && error.reason === 'sealed'; } check(sealed, 'native');
    await publication; check(published, 'native'); const final = await shutdown; check(!premature, 'native');
    check(final.closure === 'closed' && final.ownerRelease?.closure === 'closed' && !final.debt.handle && !final.debt.temporary, 'cleanup');
    const next = acquire(); await release(next);
    await receipt(0, 'done', {cleanup: 'closed', callbacks: 1, nativePhase: observed, status: mode === 'native-phase' && !observed ? 'INCONCLUSIVE' : 'PASS'}); return;
  } else throw new QualificationFault('arguments');
  await receipt(0, 'done', {cleanup: 'closed'});
}
export async function main(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  const mode = admitHost({mainThread: isMainThread, platform: process.platform, arch: process.arch, version: process.versions.node}, args);
  if (mode === 'instructions') {
    process.stdout.write('Windows qualification: NOT RUN. Read docs/windows-runtime/qualification-plan.md. Compile the explicit reviewed graph; prepare exact reviewed artifacts separately. Native opt-in: --native --source-root <checkout> --fixture-base <approved existing ASCII local directory>. No install, native load, or fixture work occurs by default.\n'); return;
  }
  check(process.execArgv.length === 1 && process.execArgv[0] === '--no-strip-types' &&
    !process.env.NODE_OPTIONS && !process.env.NODE_PATH, 'arguments');
  budget = new QualificationBudget(mode === 'native' ? LIMITS.runMs : LIMITS.caseMs);
  if (mode === 'native') await supervisor(args[2]!, args[4]!); else await child(args);
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === self) {
  void main().catch(async error => { try { await writeChildFailure(error); } catch { /* No fabricated failure receipt after protocol/I/O debt. */ } process.stdout.write(JSON.stringify({schemaVersion: 1, status: childFailure === null ? 'NOT RUN' : 'FAIL', reason: error instanceof QualificationFault ? error.reason : 'native', ...(budget === null ? {} : {pendingIo: budget.pending, uncertainIo: budget.uncertainIo, retainedUncertain: childFailure !== null || budget.uncertainIo, uncertainty: {native: childFailure !== null, file: childFailure !== null || budget.uncertainIo, process: childFailure !== null}})}) + '\n'); process.exitCode = 1; });
}
