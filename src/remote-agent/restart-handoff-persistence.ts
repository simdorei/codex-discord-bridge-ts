import {writeWindowsAtomicFile} from '../runtime/windows/windows-atomic-file.ts';
import {WindowsFilePin} from '../runtime/windows/windows-file-pin.ts';
import {windowsDpapiProtector} from '../runtime/windows/dpapi.ts';
import {randomUUID} from 'node:crypto';
import {open, realpath, rename, stat, unlink} from 'node:fs/promises';
import {basename, dirname, isAbsolute} from 'node:path';
import {types} from 'node:util';
import {writePosixAtomicMarker} from '../runtime/atomic-marker.ts';
import {formatRemoteUtcDateTime} from './datetime-format.ts';
import type {RemoteUtcDateTime} from './datetime.ts';
import {
 RestartHandoffCodecError, MAX_RESTART_HANDOFF_BYTES, MAX_RESTART_HANDOFF_PLAINTEXT_BYTES,
 encodeRestartHandoffPayload, encodeRestartHandoffEnvelope, decodeRestartHandoffEnvelope,
 decodeRestartHandoffPayload, restartHandoffGatewayFingerprint,
 type RestartHandoffBinding, type RestartHandoffProject,
} from './restart-handoff-codec.ts';

type Transform = (bytes: Uint8Array) => Uint8Array | Promise<Uint8Array>;
/** Explicit trusted protection only. No default, credential lookup, or claim of
 * platform/current-user protection. Callbacks are invoked without a receiver. */
export interface RestartHandoffProtector {
 readonly protect: Transform;
 readonly unprotect: Transform;
}
type ErrorCode = 'UnsupportedPlatform' | 'ProtectionFailed' | 'UnprotectionFailed' |
 'PublicationFailed' | 'ClaimFailed' | 'ReadFailed' | 'ProjectRootUnavailable' | 'CleanupFailed';
const messages: Record<ErrorCode, string> = {
 UnsupportedPlatform: 'POSIX restart handoff storage is unavailable on this platform',
 ProtectionFailed: 'restart handoff protection failed',
 UnprotectionFailed: 'restart handoff unprotection failed',
 PublicationFailed: 'restart handoff publication failed',
 ClaimFailed: 'restart handoff claim failed',
 ReadFailed: 'restart handoff read failed',
 ProjectRootUnavailable: 'restart project root unavailable',
 CleanupFailed: 'restart handoff claim cleanup failed',
};
/** Static diagnostics never retain callback/native errors, paths or causes. */
export class RestartHandoffPersistenceError extends Error {
 constructor(readonly code: ErrorCode) { super(messages[code]); this.name = 'RestartHandoffPersistenceError'; }
}
function malformed(): never { throw new RestartHandoffCodecError('Malformed'); }
function tooLarge(): never { throw new RestartHandoffCodecError('TooLarge'); }
function fields(value: unknown, names: readonly string[]): Record<string, unknown> {
 if (value === null || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) return malformed();
 const prototype = Object.getPrototypeOf(value);
 if ((prototype !== Object.prototype && prototype !== null) || Reflect.ownKeys(value).length !== names.length) return malformed();
 const result: Record<string, unknown> = Object.create(null);
 for (const name of names) {
  const field = Object.getOwnPropertyDescriptor(value, name);
  if (field === undefined || !Object.hasOwn(field, 'value') || !field.enumerable) return malformed();
  result[name] = field.value;
 }
 return result;
}
function captureProtector(value: RestartHandoffProtector): RestartHandoffProtector {
 const captured = fields(value, ['protect', 'unprotect']);
 if (typeof captured.protect !== 'function' || types.isProxy(captured.protect) ||
     typeof captured.unprotect !== 'function' || types.isProxy(captured.unprotect)) return malformed();
 return Object.freeze({protect: captured.protect as Transform, unprotect: captured.unprotect as Transform});
}
function capturePath(value: string, windows=false): string {
 // Absolute caller-supplied paths avoid discovering a storage location or
 // allowing process.chdir during protection to change the publication target.
 if (typeof value !== 'string') return malformed();
 if (value.length > MAX_RESTART_HANDOFF_BYTES) return tooLarge();
 if (!(windows?isAbsolute(value):value.startsWith('/')) || value.includes('\0') || /[\uD800-\uDFFF]/u.test(value)) return malformed();
 if (Buffer.byteLength(value) > MAX_RESTART_HANDOFF_BYTES) return tooLarge();
 if ((process.platform === 'win32') !== windows) throw new RestartHandoffPersistenceError('UnsupportedPlatform');
 return value;
}
function captureContext(binding: RestartHandoffBinding, now: RemoteUtcDateTime): {
 binding: RestartHandoffBinding; now: RemoteUtcDateTime;
} {
 const b = fields(binding, ['bridgeUrl', 'deviceId']), d = fields(now, ['seconds', 'nanosecond']);
 if (typeof b.bridgeUrl !== 'string' || typeof b.deviceId !== 'string' ||
     typeof d.seconds !== 'bigint' || typeof d.nanosecond !== 'bigint') return malformed();
 const capturedBinding = Object.freeze({bridgeUrl: b.bridgeUrl, deviceId: b.deviceId});
 const capturedNow = Object.freeze({seconds: d.seconds, nanosecond: d.nanosecond});
 restartHandoffGatewayFingerprint(capturedBinding);
 try { formatRemoteUtcDateTime(capturedNow); } catch { return malformed(); }
 return {binding: capturedBinding, now: capturedNow};
}
const typedArray = Object.getPrototypeOf(Uint8Array.prototype) as object;
const bufferOf = Object.getOwnPropertyDescriptor(typedArray, 'buffer')!.get!;
const offsetOf = Object.getOwnPropertyDescriptor(typedArray, 'byteOffset')!.get!;
const lengthOf = Object.getOwnPropertyDescriptor(typedArray, 'byteLength')!.get!;
function copyBytes(value: unknown, limit: number): Buffer {
 if (types.isProxy(value) || !types.isUint8Array(value)) return malformed();
 // Intrinsic accessors bypass caller-defined buffer/length/iterator properties.
 // Shared memory cannot supply a stable byte snapshot and is not supported.
 const buffer: unknown = bufferOf.call(value);
 if (!types.isArrayBuffer(buffer)) return malformed();
 const length = lengthOf.call(value) as number, offset = offsetOf.call(value) as number;
 if (length > limit) return tooLarge();
 try { return Buffer.from(new Uint8Array(buffer as ArrayBuffer, offset, length)); }
 catch { return malformed(); }
}
async function transform(callback: Transform, input: Buffer, limit: number, code: 'ProtectionFailed' | 'UnprotectionFailed'): Promise<Buffer> {
 let result: unknown;
 try { result = callback(Buffer.from(input)); } catch { throw new RestartHandoffPersistenceError(code); }
 // Synchronous byte results are copied before the first await. Only ordinary
 // native promises are awaited: an arbitrary thenable/accessor is not executed.
 if (types.isPromise(result) && !types.isProxy(result)) {
  const constructor = Object.getOwnPropertyDescriptor(result, 'constructor');
  if (Object.getPrototypeOf(result) !== Promise.prototype || (constructor !== undefined &&
      (!Object.hasOwn(constructor, 'value') || constructor.value !== Promise))) return malformed();
  try { result = await result; } catch { throw new RestartHandoffPersistenceError(code); }
 }
 return copyBytes(result, limit);
}
function strictUtf8(bytes: Buffer): string {
 // ignoreBOM preserves U+FEFF so JSON rejects a leading BOM, like serde_json.
 try { return new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes); }
 catch { return malformed(); }
}
function missing(error: unknown): boolean {
 if (error === null || typeof error !== 'object' || types.isProxy(error)) return false;
 const code = Object.getOwnPropertyDescriptor(error, 'code');
 return code !== undefined && Object.hasOwn(code, 'value') && code.value === 'ENOENT';
}
async function io<T>(code: ErrorCode, operation: () => Promise<T>): Promise<T> {
 try { return await operation(); } catch { throw new RestartHandoffPersistenceError(code); }
}
/** Returns true only after actual protected-envelope publication completes.
 * Empty projects return false without inspecting context/path/protector or IO. */
async function writeRestartHandoff(
 path: string, projects: readonly RestartHandoffProject[], binding: RestartHandoffBinding,
 now: RemoteUtcDateTime, protector: RestartHandoffProtector, windows=false,
): Promise<boolean> {
 const plaintext = encodeRestartHandoffPayload(projects, binding, now);
 if (plaintext === null) return false;
 const destination = capturePath(path,windows), {protect} = captureProtector(protector);
 const ciphertext = await transform(protect, Buffer.from(plaintext, 'utf8'), MAX_RESTART_HANDOFF_BYTES, 'ProtectionFailed');
 const envelope = encodeRestartHandoffEnvelope(ciphertext.toString('base64'));
 // Protection and the complete serialized envelope cap precede mkdir/open.
 await io('PublicationFailed', () => windows?writeWindowsAtomicFile(destination,envelope):writePosixAtomicMarker(destination, envelope));
 return true;
}
async function readBounded(path: string): Promise<Buffer> {
 const pin=process.platform==='win32'?WindowsFilePin.acquire(path,'file',true):undefined;
 let handle;try{handle=await io('ReadFailed', () => open(path, 'r'));}catch(error){pin?.close();throw error;}
 let result: Buffer | undefined, failed = false, primary: unknown;
 try {
  const metadata = await io('ReadFailed', () => handle.stat());
  if (metadata.size > MAX_RESTART_HANDOFF_BYTES) tooLarge();
  const bytes = Buffer.alloc(MAX_RESTART_HANDOFF_BYTES + 1);
  let total = 0;
  while (total < bytes.length) {
   const {bytesRead} = await io('ReadFailed', () => handle.read(bytes, total, bytes.length - total, null));
   if (bytesRead === 0) break;
   total += bytesRead;
  }
  // The fixed max+1 allocation/read also bounds files that grow after fstat.
  if (total > MAX_RESTART_HANDOFF_BYTES) tooLarge();
  result = bytes.subarray(0, total);
 } catch (error) { failed = true; primary = error; }
 try { try{await io('ReadFailed', () => handle.close());}finally{pin?.close();} }
 catch (error) { if (!failed) { failed = true; primary = error; } }
 if (failed) throw primary;
 return result!;
}
async function validateClaim(
 path: string, binding: RestartHandoffBinding, now: RemoteUtcDateTime, unprotect: Transform, rootBase: string,
): Promise<readonly RestartHandoffProject[]> {
 const envelope = decodeRestartHandoffEnvelope(strictUtf8(await readBounded(path)));
 const plaintext = await transform(unprotect, Buffer.from(envelope.ciphertext, 'base64'), MAX_RESTART_HANDOFF_PLAINTEXT_BYTES, 'UnprotectionFailed');
 const payload = decodeRestartHandoffPayload(strictUtf8(plaintext), binding, now);
 const projects: RestartHandoffProject[] = [];
 // All schema/expiry checks above precede every project filesystem lookup.
 // Keep vector order and duplicates; do not install or authorize any binding.
 for (const project of payload.projects) {
  if (project.root === '') throw new RestartHandoffPersistenceError('ProjectRootUnavailable');
  // Raw concatenation preserves symlink/.. traversal; path.resolve/join would
  // normalize it lexically and can change the directory selected by Rust.
  const input = isAbsolute(project.root) ? project.root : rootBase + '/' + project.root;
  const root = await io('ProjectRootUnavailable', () => realpath(input));
  const metadata = await io('ProjectRootUnavailable', () => stat(root));
  if (!metadata.isDirectory()) throw new RestartHandoffPersistenceError('ProjectRootUnavailable');
  projects.push(Object.freeze({...project, root}));
 }
 return Object.freeze(projects);
}
/** Rename claims only the current pathname entry. This is not global replay
 * protection, hostile-filesystem containment, or a restoration capability.
 * Results are withheld until the claimed entry has actually been removed. */
async function claimRestartHandoff(
 resumeRequested: boolean, path: string, binding: RestartHandoffBinding,
 now: RemoteUtcDateTime, protector: RestartHandoffProtector, windows=false,
): Promise<readonly RestartHandoffProject[]> {
 if (typeof resumeRequested !== 'boolean') return malformed();
 if (!resumeRequested) return Object.freeze([]);
 const source = capturePath(path,windows), {binding: capturedBinding, now: capturedNow} = captureContext(binding, now);
 const {unprotect} = captureProtector(protector);
 // Async context pinning only: no environment variable or storage discovery.
 let rootBase: string;
 try { rootBase = process.cwd(); } catch { throw new RestartHandoffPersistenceError('ClaimFailed'); }
 let metadata;
 try { metadata = await stat(source); }
 catch (error) { if (missing(error)) return Object.freeze([]); throw new RestartHandoffPersistenceError('ClaimFailed'); }
 if (!metadata.isFile()) return malformed();
 const claimed = dirname(source) + '/.' + basename(source) + '.claimed.' + randomUUID();
 try { await rename(source, claimed); }
 catch (error) { if (missing(error)) return Object.freeze([]); throw new RestartHandoffPersistenceError('ClaimFailed'); }
 let result: readonly RestartHandoffProject[] | undefined, failed = false, primary: unknown;
 try { result = await validateClaim(claimed, capturedBinding, capturedNow, unprotect, rootBase); }
 catch (error) { failed = true; primary = error; }
 try { await io('CleanupFailed', () => unlink(claimed)); }
 catch (error) { if (!failed) { failed = true; primary = error; } }
 if (failed) throw primary;
 return result!;
}

export function writePosixRestartHandoff(path:string,projects:readonly RestartHandoffProject[],binding:RestartHandoffBinding,now:RemoteUtcDateTime,protector:RestartHandoffProtector):Promise<boolean>{return writeRestartHandoff(path,projects,binding,now,protector);}
export function claimPosixRestartHandoff(resume:boolean,path:string,binding:RestartHandoffBinding,now:RemoteUtcDateTime,protector:RestartHandoffProtector):Promise<readonly RestartHandoffProject[]>{return claimRestartHandoff(resume,path,binding,now,protector);}
export function writeWindowsRestartHandoff(path:string,projects:readonly RestartHandoffProject[],binding:RestartHandoffBinding,now:RemoteUtcDateTime):Promise<boolean>{return writeRestartHandoff(path,projects,binding,now,windowsDpapiProtector(),true);}
export function claimWindowsRestartHandoff(resume:boolean,path:string,binding:RestartHandoffBinding,now:RemoteUtcDateTime):Promise<readonly RestartHandoffProject[]>{return claimRestartHandoff(resume,path,binding,now,windowsDpapiProtector(),true);}
