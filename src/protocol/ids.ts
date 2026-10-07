import { randomUUID } from 'node:crypto';
import { parseSerdeValue } from '../core/serde-json-parse.ts';

export type RequestId = string | bigint;

export const I64_MIN = -9223372036854775808n;
export const I64_MAX = 9223372036854775807n;
export const U64_MAX = 18446744073709551615n;

interface JsonWithRaw {
  rawJSON(text: string): unknown;
}

function isWellFormedString(s: string): boolean {
  return (s as unknown as { isWellFormed(): boolean }).isWellFormed();
}

export function validateRequestId(value: unknown): RequestId {
  if (typeof value === 'string') {
    if (!isWellFormedString(value)) {
      throw new TypeError(`RequestId string contains lone surrogate: ${value}`);
    }
    return value;
  }
  if (typeof value === 'bigint') {
    if (value < I64_MIN || value > I64_MAX) {
      throw new RangeError(`RequestId integer out of i64 range: ${value.toString()}`);
    }
    return value;
  }
  if (typeof value === 'number') {
    throw new TypeError(`RequestId rejects JavaScript numbers (received ${value})`);
  }
  throw new TypeError(`RequestId must be string or bigint, received ${value === null ? 'null' : typeof value}`);
}

export function requestIdEquals(a: RequestId, b: RequestId): boolean {
  validateRequestId(a);
  validateRequestId(b);
  return typeof a === typeof b && a === b;
}

export function requestIdKey(id: RequestId): string {
  validateRequestId(id);
  return typeof id === 'string' ? `s:${id}` : `i:${id.toString()}`;
}

export function parseLosslessJson<T = unknown>(text: string): T {
  try {
    return parseSerdeValue<T>(text);
  } catch (error) {
    if (error instanceof RangeError) {
      throw new SyntaxError(error.message, { cause: error });
    }
    throw error;
  }
}

export function stringifyLosslessJson(value: unknown): string {
  if (value === undefined) {
    throw new TypeError('Lossless JSON does not support undefined values');
  }
  if (typeof value === 'function') {
    throw new TypeError('Lossless JSON does not support function values');
  }
  if (typeof value === 'symbol') {
    throw new TypeError('Lossless JSON does not support symbol values');
  }

  const result = JSON.stringify(value, (key: string, val: unknown) => {
    if (!isWellFormedString(key)) {
      throw new TypeError(`Lossless JSON does not support malformed UTF-16 in key: "${key}"`);
    }
    if (typeof val === 'string' && !isWellFormedString(val)) {
      throw new TypeError(`Lossless JSON does not support malformed UTF-16 in string value: "${val}"`);
    }
    if (val === undefined) {
      throw new TypeError(`Lossless JSON does not support undefined values (key: "${key}")`);
    }
    if (typeof val === 'function') {
      throw new TypeError(`Lossless JSON does not support function values (key: "${key}")`);
    }
    if (typeof val === 'symbol') {
      throw new TypeError(`Lossless JSON does not support symbol values (key: "${key}")`);
    }
    if (typeof val === 'number') {
      if (!Number.isFinite(val)) {
        throw new TypeError(`Lossless JSON does not allow non-finite numbers: ${val}`);
      }
      if (Object.is(val, -0)) {
        return (JSON as unknown as JsonWithRaw).rawJSON('-0.0');
      }
      const s = val.toString();
      if (!s.includes('.') && !s.includes('e') && !s.includes('E')) {
        return (JSON as unknown as JsonWithRaw).rawJSON(`${s}.0`);
      }
      return (JSON as unknown as JsonWithRaw).rawJSON(s);
    }
    if (typeof val === 'bigint') {
      if (val < I64_MIN || val > U64_MAX) {
        throw new RangeError(`BigInt value out of serde_json integer range: ${val.toString()}`);
      }
      return (JSON as unknown as JsonWithRaw).rawJSON(val.toString());
    }
    return val;
  });

  if (result === undefined) {
    throw new TypeError('Lossless JSON serialization resulted in undefined');
  }

  return result;
}

export function serializeRequestId(id: RequestId): string {
  validateRequestId(id);
  return stringifyLosslessJson(id);
}

export class ServerRequestOccurrence {
  readonly #bytes: Uint8Array;

  private constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  static fromBytes(bytes: Uint8Array): ServerRequestOccurrence {
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError(
        `ServerRequestOccurrence requires Uint8Array, received ${bytes === null ? 'null' : typeof bytes}`
      );
    }
    if (bytes.length !== 16) {
      throw new RangeError(`ServerRequestOccurrence requires exactly 16 bytes, received length ${bytes.length}`);
    }
    const copy = new Uint8Array(16);
    copy.set(bytes);
    return new ServerRequestOccurrence(copy);
  }

  asBytes(): Uint8Array {
    const copy = new Uint8Array(16);
    copy.set(this.#bytes);
    return copy;
  }

  static random(): ServerRequestOccurrence {
    const hex = randomUUID().replace(/-/g, '');
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
      bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return new ServerRequestOccurrence(bytes);
  }

  equals(other: unknown): boolean {
    if (!(other instanceof ServerRequestOccurrence)) return false;
    for (let i = 0; i < 16; i++) {
      const a = this.#bytes[i];
      const b = other.#bytes[i];
      if (a !== b) return false;
    }
    return true;
  }
}

export function parseDiscordU64(value: unknown): bigint {
  if (typeof value === 'bigint') {
    if (value < 0n || value > U64_MAX) {
      throw new RangeError(`Discord ID out of u64 range: ${value.toString()}`);
    }
    return value;
  }
  if (typeof value === 'string') {
    if (!/^\d+$/.test(value)) {
      throw new Error(`Malformed Discord ID: ${value}`);
    }
    const b = BigInt(value);
    if (b > U64_MAX) {
      throw new RangeError(`Discord ID out of u64 range: ${value}`);
    }
    return b;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
      throw new RangeError(`Invalid Discord ID number: ${value}`);
    }
    return BigInt(value);
  }
  throw new TypeError(`Invalid Discord ID type: ${value === null ? 'null' : typeof value}`);
}

export function discordIdToI64(value: unknown, kind: string): bigint {
  const u64 = parseDiscordU64(value);
  if (u64 > I64_MAX) {
    throw new Error(`Discord ${kind} ID exceeds SQLite range`);
  }
  return u64;
}

export interface DiscordCustodyInput {
  applicationId: string | bigint | number;
  interactionId: string | bigint | number;
  channelId: string | bigint | number;
  userId: string | bigint | number;
  sourceMessageId?: string | bigint | number | null | undefined;
}

export interface DiscordCustodyOutput {
  applicationId: bigint;
  interactionId: bigint;
  channelId: bigint;
  userId: bigint;
  sourceMessageId?: bigint;
}

export function mapDiscordCustodyIds(input: DiscordCustodyInput): DiscordCustodyOutput {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Invalid Discord custody input: expected non-null object');
  }

  const raw = input as unknown as Record<string, unknown>;

  if (raw.interactionId === undefined || raw.interactionId === null) {
    throw new TypeError('Missing required interactionId');
  }
  const interactionId = discordIdToI64(raw.interactionId, 'interaction');

  if (raw.channelId === undefined || raw.channelId === null) {
    throw new TypeError('Missing required channelId');
  }
  const channelId = discordIdToI64(raw.channelId, 'channel');

  if (raw.userId === undefined || raw.userId === null) {
    throw new TypeError('Missing required userId');
  }
  const userId = discordIdToI64(raw.userId, 'user');

  let sourceMessageId: bigint | undefined;
  if (raw.sourceMessageId !== undefined && raw.sourceMessageId !== null) {
    sourceMessageId = discordIdToI64(raw.sourceMessageId, 'source message');
  }

  if (raw.applicationId === undefined || raw.applicationId === null) {
    throw new TypeError('Missing required applicationId');
  }
  const applicationId = discordIdToI64(raw.applicationId, 'application');

  const out: DiscordCustodyOutput = {
    applicationId,
    interactionId,
    channelId,
    userId,
  };
  if (sourceMessageId !== undefined) {
    out.sourceMessageId = sourceMessageId;
  }
  return out;
}
