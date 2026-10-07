import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { I64_MIN, I64_MAX, U64_MAX } from '../protocol/ids.ts';

function isWellFormedString(s: string): boolean {
  if (typeof (s as unknown as { isWellFormed?: () => boolean }).isWellFormed === 'function') {
    return (s as unknown as { isWellFormed: () => boolean }).isWellFormed();
  }
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 >= s.length) return false;
      const next = s.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function formatSerdeNumber(val: number): string {
  if (!Number.isFinite(val)) {
    throw new TypeError(`serializeSerdeValue does not allow non-finite numbers: ${val}`);
  }
  if (Object.is(val, -0)) {
    return '-0.0';
  }
  if (val === 0) {
    return '0.0';
  }
  const abs = Math.abs(val);
  if (abs >= 1e16 || abs < 1e-5) {
    return val.toExponential();
  }
  const s = val.toString();
  return Number.isInteger(val) ? `${s}.0` : s;
}

function formatSerdeBigInt(val: bigint): string {
  if (val < I64_MIN || val > U64_MAX) {
    throw new RangeError(`BigInt value out of serde_json integer range: ${val.toString()}`);
  }
  return val.toString();
}

function formatSerdeString(val: string): string {
  if (!isWellFormedString(val)) {
    throw new TypeError(`String contains lone surrogate: ${JSON.stringify(val)}`);
  }
  return JSON.stringify(val);
}

function compareUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function serializeInternal(
  value: unknown,
  stack: Set<object>,
  isTopLevel: boolean,
  excludeSet?: ReadonlySet<string>
): string {
  if (value === null) {
    return 'null';
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }

  if (typeof value === 'string') {
    return formatSerdeString(value);
  }

  if (typeof value === 'number') {
    return formatSerdeNumber(value);
  }

  if (typeof value === 'bigint') {
    return formatSerdeBigInt(value);
  }

  if (typeof value === 'undefined') {
    throw new TypeError('undefined is not supported in serde_json Value');
  }

  if (typeof value === 'symbol') {
    throw new TypeError('Symbols are not supported in serde_json Value');
  }

  if (typeof value === 'function') {
    throw new TypeError('Functions are not supported in serde_json Value');
  }

  if (typeof value !== 'object') {
    throw new TypeError(`Unsupported value type: ${typeof value}`);
  }

  if (stack.has(value)) {
    throw new TypeError('Cyclic reference detected in serde_json Value');
  }

  if (Array.isArray(value)) {
    const symbols = Object.getOwnPropertySymbols(value);
    if (symbols.length > 0) {
      throw new TypeError('Array own symbol keys are not supported');
    }

    const propNames = Object.getOwnPropertyNames(value);
    const len = value.length;
    if (propNames.length !== len + 1) {
      throw new TypeError('Array must not be sparse or contain non-index properties');
    }

    for (let i = 0; i < len; i++) {
      const desc = Object.getOwnPropertyDescriptor(value, String(i));
      if (!desc || desc.get !== undefined || desc.set !== undefined || !('value' in desc)) {
        throw new TypeError(`Array getters are not supported: index ${i}`);
      }
      if (!desc.enumerable) {
        throw new TypeError(`Non-enumerable array elements are not supported: index ${i}`);
      }
    }

    stack.add(value);
    try {
      const parts: string[] = [];
      for (let i = 0; i < len; i++) {
        const desc = Object.getOwnPropertyDescriptor(value, String(i))!;
        parts.push(serializeInternal(desc.value, stack, false));
      }
      return `[${parts.join(',')}]`;
    } finally {
      stack.delete(value);
    }
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError('Only plain objects (Object.prototype or null prototype) are supported');
  }

  const symbolKeys = Object.getOwnPropertySymbols(value);
  if (symbolKeys.length > 0) {
    throw new TypeError('Object own symbol keys are not supported');
  }

  const propNames = Object.getOwnPropertyNames(value);
  for (const key of propNames) {
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (!desc || desc.get !== undefined || desc.set !== undefined || !('value' in desc)) {
      throw new TypeError(`Object getters are not supported: property "${key}"`);
    }
    if (!desc.enumerable) {
      throw new TypeError(`Non-enumerable properties are not supported: property "${key}"`);
    }
    if (!isWellFormedString(key)) {
      throw new TypeError(`Object key contains lone surrogate: "${key}"`);
    }
  }

  let keysToSerialize = propNames;
  if (isTopLevel && excludeSet && excludeSet.size > 0) {
    keysToSerialize = propNames.filter((k) => !excludeSet.has(k));
  }

  keysToSerialize.sort(compareUtf8);

  stack.add(value);
  try {
    if (isTopLevel && excludeSet && excludeSet.size > 0) {
      for (const key of propNames) {
        if (excludeSet.has(key)) {
          const desc = Object.getOwnPropertyDescriptor(value, key)!;
          serializeInternal(desc.value, stack, false);
        }
      }
    }
    const pairs: string[] = [];
    for (const key of keysToSerialize) {
      const desc = Object.getOwnPropertyDescriptor(value, key)!;
      const keyStr = JSON.stringify(key);
      const valStr = serializeInternal(desc.value, stack, false);
      pairs.push(`${keyStr}:${valStr}`);
    }
    return `{${pairs.join(',')}}`;
  } finally {
    stack.delete(value);
  }
}

export function serializeSerdeValue(value: unknown): string {
  const stack = new Set<object>();
  return serializeInternal(value, stack, true);
}

export function toCanonicalJson(value: unknown, exclude: readonly string[] = []): string {
  const stack = new Set<object>();
  const excludeSet = new Set(exclude);
  return serializeInternal(value, stack, true, excludeSet);
}

export function sha256SerdeValue(value: unknown): string {
  const serialized = serializeSerdeValue(value);
  return createHash('sha256').update(serialized, 'utf8').digest('hex');
}
