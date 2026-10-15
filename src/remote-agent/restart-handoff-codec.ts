import {createHash, timingSafeEqual} from 'node:crypto';
import {types} from 'node:util';
import {parseSerdeField, type StructField, type StructFieldDecoder} from '../core/serde-struct-json.ts';
import {parseRemoteUtcDateTime, type RemoteUtcDateTime} from './datetime.ts';
import {formatRemoteUtcDateTime} from './datetime-format.ts';

export const RESTART_HANDOFF_FORMAT_VERSION = 1n;
export const RESTART_HANDOFF_PROTOCOL_VERSION = 10n;
export const RESTART_HANDOFF_TTL_SECONDS = 120n;
export const MAX_RESTART_HANDOFF_BYTES = 1_048_576;
export const MAX_RESTART_HANDOFF_PROJECTS = 128;
/** Independent synchronous codec-input bound, NOT Rust's protected-file limit. */
export const MAX_RESTART_HANDOFF_PLAINTEXT_BYTES = 1_048_576;
export interface RestartHandoffBinding {
 readonly bridgeUrl: string;
 readonly deviceId: string;
}
export interface RestartHandoffProject {
 readonly threadId: string;
 readonly root: string;
 readonly expiresAt: RemoteUtcDateTime;
}
export interface RestartHandoffPayload {
 readonly formatVersion: bigint;
 readonly protocolVersion: bigint;
 readonly gatewayFingerprint: string;
 readonly createdAt: RemoteUtcDateTime;
 readonly resumeUntil: RemoteUtcDateTime;
 readonly projects: readonly RestartHandoffProject[];
}
export interface RestartHandoffEnvelope {
 readonly formatVersion: bigint;
 readonly ciphertext: string;
}
type ErrorCode = 'TooLarge' | 'Malformed' | 'UnsupportedFormat' | 'ProtocolMismatch' |
 'GatewayMismatch' | 'Expired' | 'NoProjects' | 'ProjectExpired';
const messages: Record<ErrorCode, string> = {
 TooLarge: 'restart handoff exceeds the size limit',
 Malformed: 'restart handoff is malformed',
 UnsupportedFormat: 'unsupported restart handoff format',
 ProtocolMismatch: 'restart handoff protocol mismatch',
 GatewayMismatch: 'restart handoff gateway mismatch',
 Expired: 'restart handoff expired',
 NoProjects: 'restart handoff has no projects',
 ProjectExpired: 'restart project binding expired',
};
/** Closed diagnostics: no input values, parser cause, paths, URLs or ciphertext. */
export class RestartHandoffCodecError extends Error {
 constructor(readonly code: ErrorCode) { super(messages[code]); this.name = 'RestartHandoffCodecError'; }
}
function fail(code: ErrorCode): never { throw new RestartHandoffCodecError(code); }
function guarded<T>(run: () => T): T {
 try { return run(); } catch (error) {
  if (error instanceof RestartHandoffCodecError) throw error;
  return fail('Malformed');
 }
}
function record(value: unknown, names: readonly string[]): Record<string, unknown> {
 if (value === null || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) return fail('Malformed');
 const proto = Object.getPrototypeOf(value);
 if ((proto !== Object.prototype && proto !== null) || Reflect.ownKeys(value).length !== names.length) return fail('Malformed');
 const captured: Record<string, unknown> = Object.create(null);
 for (const name of names) {
  const field = Object.getOwnPropertyDescriptor(value, name);
  if (field === undefined || !Object.hasOwn(field, 'value') || !field.enumerable) return fail('Malformed');
  captured[name] = field.value;
 }
 return captured;
}
function string(value: unknown): string {
 if (typeof value !== 'string') return fail('Malformed');
 if (value.length > MAX_RESTART_HANDOFF_PLAINTEXT_BYTES) return fail('TooLarge');
 if (/[\uD800-\uDFFF]/u.test(value)) return fail('Malformed');
 if (Buffer.byteLength(value) > MAX_RESTART_HANDOFF_PLAINTEXT_BYTES) return fail('TooLarge');
 return value;
}
function rawText(value: unknown, limit: number): string {
 if (typeof value !== 'string') return fail('Malformed');
 if (value.length > limit || Buffer.byteLength(value) > limit) return fail('TooLarge');
 if (/[\uD800-\uDFFF]/u.test(value)) return fail('Malformed');
 return value;
}
function date(value: unknown): RemoteUtcDateTime {
 const captured = record(value, ['seconds', 'nanosecond']);
 if (typeof captured.seconds !== 'bigint' || typeof captured.nanosecond !== 'bigint') return fail('Malformed');
 const result = Object.freeze({seconds: captured.seconds, nanosecond: captured.nanosecond});
 formatRemoteUtcDateTime(result);
 return result;
}
function notAfter(left: RemoteUtcDateTime, right: RemoteUtcDateTime): boolean {
 return left.seconds < right.seconds || (left.seconds === right.seconds && left.nanosecond <= right.nanosecond);
}
function bindingFingerprint(value: RestartHandoffBinding): string {
 const captured = record(value, ['bridgeUrl', 'deviceId']);
 const url = string(captured.bridgeUrl), id = string(captured.deviceId);
 if (Buffer.byteLength(url) + Buffer.byteLength(id) + 1 > MAX_RESTART_HANDOFF_PLAINTEXT_BYTES) return fail('TooLarge');
 return createHash('sha256').update(url).update('\0').update(id).digest('hex');
}
/** bridgeUrl is the already-normalized Rust Url display string. No URL parsing,
 * token access, trimming, case conversion or endpoint authorization occurs here. */
export function restartHandoffGatewayFingerprint(binding: RestartHandoffBinding): string {
 return guarded(() => bindingFingerprint(binding));
}
function project(value: unknown): RestartHandoffProject {
 const captured = record(value, ['threadId', 'root', 'expiresAt']);
 return Object.freeze({threadId: string(captured.threadId), root: string(captured.root), expiresAt: date(captured.expiresAt)});
}
function vector(value: unknown): readonly unknown[] {
 if (value === null || typeof value !== 'object' || types.isProxy(value) || !Array.isArray(value)) return fail('Malformed');
 if (Object.getPrototypeOf(value) !== Array.prototype) return fail('Malformed');
 // Reading the native array length cannot invoke caller code after proxy rejection.
 if (value.length > MAX_RESTART_HANDOFF_PROJECTS) return fail('TooLarge');
 if (Reflect.ownKeys(value).length !== value.length + 1) return fail('Malformed');
 const captured: unknown[] = [];
 for (let i = 0; i < value.length; i++) {
  const field = Object.getOwnPropertyDescriptor(value, String(i));
  if (field === undefined || !Object.hasOwn(field, 'value') || !field.enumerable) return fail('Malformed');
  captured.push(field.value);
 }
 return captured;
}
/** Exact source writer field order. Returns null for no projects, as Rust skips
 * writing. This is plaintext ONLY IN MEMORY; no protector or storage is called.
 * Order and duplicate project IDs are retained. No binding/root authority issued. */
export function encodeRestartHandoffPayload(
 projects: readonly RestartHandoffProject[], binding: RestartHandoffBinding, now: RemoteUtcDateTime,
): string | null {
 return guarded(() => {
  const values = vector(projects);
  if (values.length === 0) return null;
  const fingerprint = bindingFingerprint(binding), created = date(now);
  // Chrono positive-duration arithmetic exits a represented leap second by
  // dropping its extra second, rather than adding it again to the POSIX second.
  const until = date({seconds: created.seconds + RESTART_HANDOFF_TTL_SECONDS, nanosecond: created.nanosecond % 1_000_000_000n});
  let retained = 0;
  const wireProjects = values.map(value => {
   const item = project(value);
   retained += Buffer.byteLength(item.threadId) + Buffer.byteLength(item.root);
   if (retained > MAX_RESTART_HANDOFF_PLAINTEXT_BYTES) return fail('TooLarge');
   return {thread_id: item.threadId, root: item.root, expires_at: formatRemoteUtcDateTime(item.expiresAt)};
  });
  return rawText(JSON.stringify({
   format_version: 1, protocol_version: 10, gateway_fingerprint: fingerprint,
   created_at: formatRemoteUtcDateTime(created), resume_until: formatRemoteUtcDateTime(until), projects: wireProjects,
  }), MAX_RESTART_HANDOFF_PLAINTEXT_BYTES);
 });
}
type Fields = readonly (readonly [string, StructField])[];
/** Derived Serde structs accept maps OR exact-position sequences. Unknown map
 * fields and duplicate known fields fail before semantic payload validation. */
function strictStruct(fields: Fields): StructFieldDecoder {
 return (raw, _depth, context) => {
  if (raw.trimStart()[0] === '[') return context.struct({fields});
  const result: Record<string, unknown> = Object.create(null), known = new Map(fields);
  context.map((key, decode) => {
   const field = known.get(key);
   if (field === undefined || Object.hasOwn(result, key)) return fail('Malformed');
   result[key] = decode(field);
  });
  if (Object.keys(result).length !== fields.length) return fail('Malformed');
  return result;
 };
}
const u8: StructFieldDecoder = (_raw, _depth, context) => {
 const value = context.decode('u64');
 if (typeof value !== 'bigint' || value > 255n) return fail('Malformed');
 return value;
};
const timestamp: StructFieldDecoder = (_raw, _depth, context) =>
 parseRemoteUtcDateTime(context.decode('string') as string, MAX_RESTART_HANDOFF_PLAINTEXT_BYTES);
const projectSchema = strictStruct([['thread_id', 'string'], ['root', 'string'], ['expires_at', timestamp]]);
const projectsSchema: StructFieldDecoder = (_raw, _depth, context) => context.array(projectSchema);
const payloadSchema = strictStruct([
 ['format_version', u8], ['protocol_version', u8], ['gateway_fingerprint', 'string'],
 ['created_at', timestamp], ['resume_until', timestamp], ['projects', projectsSchema],
]);
const envelopeSchema = strictStruct([['format_version', u8], ['ciphertext', 'string']]);
/** Decode and validate the pure payload. Does NOT canonicalize/check directories,
 * claim/consume a file, restore bindings, prevent replay or create authority. */
export function decodeRestartHandoffPayload(
 raw: string, binding: RestartHandoffBinding, now: RemoteUtcDateTime,
): RestartHandoffPayload {
 return guarded(() => {
  const parsed = parseSerdeField(rawText(raw, MAX_RESTART_HANDOFF_PLAINTEXT_BYTES), payloadSchema) as Record<string, unknown>;
  // Capture trusted context only after full schema decoding, before semantics.
  const current = date(now), fingerprint = bindingFingerprint(binding);
  if (parsed.format_version !== RESTART_HANDOFF_FORMAT_VERSION) return fail('UnsupportedFormat');
  if (parsed.protocol_version !== RESTART_HANDOFF_PROTOCOL_VERSION) return fail('ProtocolMismatch');
  const supplied = Buffer.from(parsed.gateway_fingerprint as string), expected = Buffer.from(fingerprint);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return fail('GatewayMismatch');
  if (notAfter(parsed.resume_until as RemoteUtcDateTime, current)) return fail('Expired');
  const values = parsed.projects as Record<string, unknown>[];
  if (values.length === 0) return fail('NoProjects');
  if (values.length > MAX_RESTART_HANDOFF_PROJECTS) return fail('TooLarge');
  if (values.some(item => notAfter(item.expires_at as RemoteUtcDateTime, current))) return fail('ProjectExpired');
  return Object.freeze({
   formatVersion: parsed.format_version as bigint, protocolVersion: parsed.protocol_version as bigint,
   gatewayFingerprint: parsed.gateway_fingerprint as string, createdAt: parsed.created_at as RemoteUtcDateTime,
   resumeUntil: parsed.resume_until as RemoteUtcDateTime,
   projects: Object.freeze(values.map(item => Object.freeze({
    threadId: item.thread_id as string, root: item.root as string, expiresAt: item.expires_at as RemoteUtcDateTime,
   }))),
  });
 });
}
function base64(value: unknown): string {
 const text = string(value);
 // Buffer's decoder is intentionally permissive; exact re-encoding rejects
 // missing/excess padding, whitespace, URL alphabet and nonzero trailing bits.
 if (Buffer.from(text, 'base64').toString('base64') !== text) return fail('Malformed');
 return text;
}
/** Wrap caller-supplied canonical base64 ciphertext, without encrypting or
 * writing it. Bytes are not evidence that a protector actually produced them. */
export function encodeRestartHandoffEnvelope(ciphertext: string): string {
 return guarded(() => rawText(JSON.stringify({format_version: 1, ciphertext: base64(ciphertext)}), MAX_RESTART_HANDOFF_BYTES));
}
/** Validate protected-envelope syntax only. No unprotect callback is accepted. */
export function decodeRestartHandoffEnvelope(raw: string): RestartHandoffEnvelope {
 return guarded(() => {
  const parsed = parseSerdeField(rawText(raw, MAX_RESTART_HANDOFF_BYTES), envelopeSchema) as Record<string, unknown>;
  if (parsed.format_version !== RESTART_HANDOFF_FORMAT_VERSION) return fail('UnsupportedFormat');
  return Object.freeze({formatVersion: parsed.format_version as bigint, ciphertext: base64(parsed.ciphertext)});
 });
}
