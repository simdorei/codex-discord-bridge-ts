import { parseSerdeValue } from "../core/serde-json-parse.ts";

/**
 * Bounds for Rust primitive integer types matching serde_json representations.
 * In `parseSerdeValue`, true integers within these ranges are returned as `bigint`.
 * Floats, exponents, out-of-range values, and -0 are parsed as `number`.
 */
export const U64_MIN = 0n;
export const U64_MAX = 18446744073709551615n;

export const I64_MIN = -9223372036854775808n;
export const I64_MAX = 9223372036854775807n;

export const U32_MIN = 0n;
export const U32_MAX = 4294967295n;

/**
 * Validates that a value is a bigint in the Rust u64 range [0, 2^64 - 1].
 * Returns the bigint value, or `undefined` on ANY failure (including null, number,
 * decimals, exponents, -0, negative numbers, or numbers exceeding u64::MAX).
 * No null coercion is performed.
 */
export function asU64(value: unknown): bigint | undefined {
  if (typeof value === "bigint" && value >= U64_MIN && value <= U64_MAX) {
    return value;
  }
  return undefined;
}
export const as_u64 = asU64;

/**
 * Validates that a value is a bigint in the Rust i64 range [-2^63, 2^63 - 1].
 * Includes non-negative integers up to i64::MAX.
 * Returns the bigint value, or `undefined` on ANY failure.
 * No null coercion is performed.
 */
export function asI64(value: unknown): bigint | undefined {
  if (typeof value === "bigint" && value >= I64_MIN && value <= I64_MAX) {
    return value;
  }
  return undefined;
}
export const as_i64 = asI64;

/**
 * Validates that a value is a bigint in the Rust u32 range [0, 2^32 - 1].
 * Returns the bigint value, or `undefined` on ANY failure.
 * No null coercion is performed.
 */
export function asU32(value: unknown): bigint | undefined {
  if (typeof value === "bigint" && value >= U32_MIN && value <= U32_MAX) {
    return value;
  }
  return undefined;
}
export const as_u32 = asU32;

/**
 * Validates that a value is a string primitive.
 * Returns the string, or `undefined` on ANY failure.
 */
export function asStr(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
export const as_str = asStr;

/**
 * Validates that a value is a boolean primitive.
 * Returns the boolean, or `undefined` on ANY failure.
 */
export function asBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
export const as_bool = asBool;

/**
 * Type representing a parsed JSON object (non-null, non-array object).
 */
export type JsonObject = { [key: string]: unknown };

/**
 * Guard confirming that value is a non-null, non-array JSON object.
 */
export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Returns value as a JsonObject if valid, or `undefined` otherwise.
 */
export function asJsonObject(value: unknown): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}
export const as_object = asJsonObject;

/**
 * Checks whether an object contains a specified property as an own member,
 * preventing prototype inheritance / prototype pollution.
 */
export function hasOwn(obj: unknown, key: string): boolean {
  return isJsonObject(obj) && Object.hasOwn(obj, key);
}

/**
 * Retrieves an own property value from an object, returning `undefined` if
 * the property is missing or inherited from the prototype.
 */
export function getOwn(obj: unknown, key: string): unknown {
  if (isJsonObject(obj) && Object.hasOwn(obj, key)) {
    return obj[key];
  }
  return undefined;
}

/**
 * Returns the own property names of a JSON object.
 */
export function ownKeys(obj: unknown): string[] {
  if (!isJsonObject(obj)) {
    return [];
  }
  return Object.keys(obj);
}

/**
 * Returns the count of own properties on a JSON object.
 */
export function ownFieldCount(obj: unknown): number {
  if (!isJsonObject(obj)) {
    return 0;
  }
  return Object.keys(obj).length;
}

/**
 * Checks if a JSON object has exactly the specified number of own properties.
 */
export function hasExactFieldCount(obj: unknown, count: number): boolean {
  return isJsonObject(obj) && Object.keys(obj).length === count;
}

/**
 * Checks whether an own property on a JSON object is a valid u32 integer.
 * Equivalent to Rust `value.get(key).and_then(Value::as_u64).is_some_and(|n| u32::try_from(n).is_ok())`.
 */
export function u32Field(value: unknown, key: string): boolean {
  if (!isJsonObject(value) || !Object.hasOwn(value, key)) {
    return false;
  }
  return asU32(value[key]) !== undefined;
}
export const u32_field = u32Field;

/**
 * Checks if an object has exactly one own property key-value pair, matching
 * Rust `single(value: &Value) -> Option<(&str, &Value)>`.
 * Returns `[key, body]` or `undefined`.
 */
export function single(value: unknown): [string, unknown] | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  const keys = Object.keys(value);
  if (keys.length !== 1) {
    return undefined;
  }
  const key = keys[0];
  if (key === undefined) {
    return undefined;
  }
  return [key, value[key]];
}
export const singleWrapper = single;

/**
 * Recognizes a single wrapper whose body is itself a non-null, non-array JSON object.
 * Used for command/work/component wrappers matching Rust `single(value).filter(|(_, body)| body.is_object())`.
 * Returns `[key, body]` or `undefined`.
 */
export function singleObject(value: unknown): [string, JsonObject] | undefined {
  const pair = single(value);
  if (pair !== undefined && isJsonObject(pair[1])) {
    return [pair[0], pair[1]];
  }
  return undefined;
}
export const singleJsonObject = singleObject;

/**
 * Verifies that all specified keys exist as own properties and are string primitives.
 * Matches Rust `strings(value: &Value, keys: &[&str]) -> bool`.
 */
export function strings(value: unknown, keys: readonly string[]): boolean {
  for (const key of keys) {
    if (!hasOwn(value, key) || typeof getOwn(value, key) !== "string") {
      return false;
    }
  }
  return true;
}

/**
 * Verifies that every specified key, if present as an own property, is null or a string primitive.
 * Matches Rust `optional_strings(value: &Value, keys: &[&str]) -> bool`.
 */
export function optionalStrings(value: unknown, keys: readonly string[]): boolean {
  for (const key of keys) {
    if (hasOwn(value, key)) {
      const v = getOwn(value, key);
      if (v !== null && typeof v !== "string") {
        return false;
      }
    }
  }
  return true;
}
export const optional_strings = optionalStrings;

/**
 * Navigates a parsed JSON structure using RFC 6901 JSON Pointer syntax.
 * Uses own-member lookup on objects to prevent prototype access.
 * Returns `undefined` if any intermediate segment is missing or not navigatable.
 * Matches Rust `Value::pointer(&self, pointer: &str) -> Option<&Value>`.
 */
export function pointer(value: unknown, path: string): unknown {
  if (path === "") {
    return value;
  }
  if (!path.startsWith("/")) {
    return undefined;
  }
  const segments = path.slice(1).split("/");
  let current: unknown = value;
  for (const segment of segments) {
    const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (isJsonObject(current)) {
      if (!Object.hasOwn(current, key)) {
        return undefined;
      }
      current = current[key];
    } else if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/.test(key)) {
        return undefined;
      }
      const index = Number(key);
      if (!Number.isSafeInteger(index) || index < 0 || index >= current.length) {
        return undefined;
      }
      current = current[index];
    } else {
      return undefined;
    }
  }
  return current;
}
export const jsonPointer = pointer;

/**
 * Re-exports the authoritative parseSerdeValue parser.
 */
export { parseSerdeValue };

/**
 * Safely parses a JSON string using `parseSerdeValue`.
 * Returns `undefined` if parsing throws an error.
 */
export function tryParseJson(text: string): unknown | undefined {
  if (typeof text !== "string") {
    return undefined;
  }
  try {
    return parseSerdeValue(text);
  } catch {
    return undefined;
  }
}
export const tryParseSerdeJson = tryParseJson;
