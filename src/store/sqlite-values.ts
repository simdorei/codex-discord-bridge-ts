import { I64_MAX, I64_MIN } from "../protocol/ids.ts";
import { StoreIntegrityError } from "./schema-assembly.ts";

const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
export interface SqliteTextDecoder { decode(bytes: Uint8Array): string; }

// Match SQLite's default UTF-16 -> UTF-8 conversion before Rust's UTF-8
// validation. This intentionally does not use WHATWG surrogate replacement.
function sqliteUtf16Decoder(littleEndian: boolean): SqliteTextDecoder {
  return {
    decode(bytes: Uint8Array): string {
      const end = bytes.length - (bytes.length % 2);
      const unit = (offset: number): number => littleEndian
        ? bytes[offset]! | (bytes[offset + 1]! << 8)
        : (bytes[offset]! << 8) | bytes[offset + 1]!;
      let result = "";
      for (let offset = 0; offset < end; offset += 2) {
        let point = unit(offset);
        if (point >= 0xd800 && point < 0xe000) {
          if (offset + 2 >= end) {
            throw new TypeError("SQLite conversion yields invalid UTF-8");
          }
          const next = unit(offset + 2);
          point = (next & 0x03ff) + ((point & 0x003f) << 10)
            + (((point & 0x03c0) + 0x0040) << 10);
          offset += 2;
        }
        result += String.fromCodePoint(point);
      }
      return result;
    },
  };
}
const utf16leDecoder = sqliteUtf16Decoder(true);
const utf16beDecoder = sqliteUtf16Decoder(false);

export function textDecoderFor(encoding: unknown): SqliteTextDecoder {
  switch (encoding) {
    case "UTF-8": return utf8Decoder;
    case "UTF-16le": return utf16leDecoder;
    case "UTF-16be": return utf16beDecoder;
    default: throw new StoreIntegrityError("Unsupported SQLite text encoding");
  }
}

export function decodeTextField(
  nativeVal: unknown,
  rawBlob: unknown,
  fieldName: string,
  optional: boolean,
  decoder: SqliteTextDecoder,
): string | null {
  if (optional && nativeVal === null) {
    if (rawBlob !== null) {
      throw new StoreIntegrityError(
        `Mismatch for optional column ${fieldName}: native is null but raw blob is not null`,
      );
    }
    return null;
  }
  if (typeof nativeVal !== "string") {
    throw new StoreIntegrityError(
      `Expected string for column ${fieldName}, received ${nativeVal === null ? "null" : typeof nativeVal}`,
    );
  }
  if (!(rawBlob instanceof Uint8Array)) {
    throw new StoreIntegrityError(
      `Expected Uint8Array for raw alias of column ${fieldName}, received ${rawBlob === null ? "null" : typeof rawBlob}`,
    );
  }
  let decoded: string;
  try {
    decoded = decoder.decode(rawBlob);
  } catch (err) {
    throw new StoreIntegrityError(
      `Invalid text encoding in column ${fieldName}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (decoded !== nativeVal) {
    throw new StoreIntegrityError(
      `Text decode mismatch in column ${fieldName}: native text does not match decoded bytes`,
    );
  }
  return decoded;
}

export function decodeI64(val: unknown, fieldName: string): bigint {
  if (typeof val !== "bigint") {
    throw new StoreIntegrityError(
      `Expected integer bigint for column ${fieldName}, received ${val === null ? "null" : typeof val}`,
    );
  }
  if (val < I64_MIN || val > I64_MAX) {
    throw new StoreIntegrityError(
      `Integer overflow for column ${fieldName}: value ${val.toString()} out of i64 range`,
    );
  }
  return val;
}

export function decodeOptionalI64(val: unknown, fieldName: string): bigint | null {
  if (val === null) {
    return null;
  }
  return decodeI64(val, fieldName);
}

export function decodeBool(val: unknown, fieldName: string): boolean {
  if (typeof val !== "bigint") {
    throw new StoreIntegrityError(
      `Expected integer bigint for boolean column ${fieldName}, received ${val === null ? "null" : typeof val}`,
    );
  }
  return val !== 0n;
}

export function decodeTimestamp(val: unknown, fieldName: string): number {
  let num: number;
  if (typeof val === "number") {
    num = val;
  } else if (typeof val === "bigint") {
    num = Number(val);
  } else {
    throw new StoreIntegrityError(
      `Expected numeric timestamp for column ${fieldName}, received ${val === null ? "null" : typeof val}`,
    );
  }
  return num;
}

