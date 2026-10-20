import {parseSerdeValue} from '../core/serde-json-parse.ts';
import {requireDiscordText} from '../discord/text.ts';
import {RemoteProtocolError} from './handshake.ts';

/** Internal decoders operate only on a freshly parsed, bounded Serde value.
 * They are not an arbitrary-object inspection API or execution authorization. */
export type Decoder<T> = (value: unknown) => T;
export function jsonError(detail: string): never { throw new RemoteProtocolError('Json', detail); }
export function validationError(field: string, detail: string): never {
 throw new RemoteProtocolError('Validation', `${field}: ${detail}`);
}
export function requestObject(raw: string, maxBytes: number): Record<string, unknown> {
 requireDiscordText(raw);
 if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 12_000_000) throw new RangeError('Invalid remote frame byte budget');
 if (raw.length > maxBytes || Buffer.byteLength(raw) > maxBytes) throw new RangeError('Remote protocol frame exceeds byte budget');
 let parsed: unknown;
 try { parsed = parseSerdeValue(raw); }
 catch (error) { throw new RemoteProtocolError('Json', 'malformed JSON', null, error); }
 return object(parsed);
}
export function object(value: unknown): Record<string, unknown> {
 if (value === null || typeof value !== 'object' || Array.isArray(value)) return jsonError('expected object');
 return value as Record<string, unknown>;
}
export const text: Decoder<string> = value => typeof value === 'string' ? value : jsonError('expected string');
export const boolean: Decoder<boolean> = value => typeof value === 'boolean' ? value : jsonError('expected boolean');
export function integer(min: bigint, max: bigint): Decoder<bigint> {
 return value => typeof value === 'bigint' && value >= min && value <= max ? value : jsonError('integer representation or range mismatch');
}
export function enumeration<const T extends readonly string[]>(choices: T): Decoder<T[number]> {
 return value => typeof value === 'string' && choices.includes(value) ? value : jsonError('unknown enum variant');
}
export function nullable<T>(decode: Decoder<T>): Decoder<T | null> { return value => value === null ? null : decode(value); }
export const strings: Decoder<readonly string[]> = value => {
 if (!Array.isArray(value)) return jsonError('expected string array');
 return Object.freeze(value.map(text));
};
export const stringMap: Decoder<Readonly<Record<string, string>>> = value => {
 const source = object(value), result: Record<string, string> = Object.create(null);
 for (const key of Object.keys(source).sort(utf8Compare)) result[key] = text(source[key]);
 return Object.freeze(result);
};
export function utf8Compare(a: string, b: string): number { return Buffer.compare(Buffer.from(a), Buffer.from(b)); }
export function required<T>(source: Record<string, unknown>, key: string, decode: Decoder<T>): T {
 if (!Object.hasOwn(source, key)) return jsonError(`missing ${key}`);
 return decode(source[key]);
}
export function defaulted<T>(source: Record<string, unknown>, key: string, decode: Decoder<T>, fallback: T): T {
 return Object.hasOwn(source, key) ? decode(source[key]) : fallback;
}
export function fields(source: Record<string, unknown>, allowed: readonly string[]): void {
 if (Object.keys(source).some(key => key !== 'kind' && !allowed.includes(key))) jsonError('unknown request field');
}
export function length(field: string, value: string, min: number, max: number): void {
 let count = 0; for (const _ of value) { count++; if (count > max) break; }
 if (count < min || count > max) validationError(field, `length must be between ${min} and ${max}`);
}
export function count(field: string, actual: number, min: number, max: number): void {
 if (actual < min || actual > max) validationError(field, `item count must be between ${min} and ${max}`);
}
export function identifier(field: string, value: string, pattern: RegExp): void {
 // JS $ also matches before a final newline; requiring the full match preserves Rust's strict anchor.
 if (pattern.exec(value)?.[0] !== value) validationError(field, 'invalid identifier');
}
