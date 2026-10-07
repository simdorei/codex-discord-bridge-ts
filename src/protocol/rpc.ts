import { types } from 'node:util';
import { serializeSerdeValue } from '../core/serde-json.ts';
import {
  I64_MAX,
  I64_MIN,
  parseLosslessJson,
  ServerRequestOccurrence,
  U64_MAX,
  validateRequestId,
  type RequestId,
} from './ids.ts';

export type { RequestId };
export { ServerRequestOccurrence };

export interface RpcErrorPayload {
  readonly code: bigint;
  readonly message: string;
  readonly data: unknown;
}

export interface ServerRequestMessage {
  readonly kind: 'serverRequest';
  readonly id: RequestId;
  readonly occurrence: ServerRequestOccurrence;
  readonly method: string;
  readonly params: unknown;
}

export type ResponseResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: RpcErrorPayload };

export interface ResponseMessage {
  readonly kind: 'response';
  readonly id: RequestId;
  readonly result: ResponseResult;
}

export interface NotificationMessage {
  readonly kind: 'notification';
  readonly method: string;
  readonly params: unknown;
}

export interface IgnoredMessage {
  readonly kind: 'ignored';
}

export type IncomingMessage =
  | ServerRequestMessage
  | ResponseMessage
  | NotificationMessage
  | IgnoredMessage;

function stringWellFormed(value: string): boolean {
  return (value as unknown as {isWellFormed():boolean}).isWellFormed();
}

export function validateRpcErrorPayload(raw: unknown): RpcErrorPayload {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError(
      `RpcErrorPayload must be a non-null object, received ${raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw}`
    );
  }

  const keys = Object.keys(raw);
  for (const key of keys) {
    if (key !== 'code' && key !== 'message' && key !== 'data') {
      throw new TypeError(`RpcErrorPayload contains unknown field: "${key}"`);
    }
  }

  if (!Object.hasOwn(raw, 'code')) {
    throw new TypeError('RpcErrorPayload missing required "code" field');
  }
  const code = (raw as Record<string, unknown>).code;
  if (typeof code !== 'bigint') {
    throw new TypeError(
      `RpcErrorPayload code must be bigint, received ${code === null ? 'null' : typeof code}`
    );
  }
  if (code < I64_MIN || code > I64_MAX) {
    throw new RangeError(`RpcErrorPayload code out of i64 range: ${code.toString()}`);
  }

  if (!Object.hasOwn(raw, 'message')) {
    throw new TypeError('RpcErrorPayload missing required "message" field');
  }
  const message = (raw as Record<string, unknown>).message;
  if (typeof message !== 'string') {
    throw new TypeError(
      `RpcErrorPayload message must be string, received ${message === null ? 'null' : typeof message}`
    );
  }
  if (!stringWellFormed(message)) {
    throw new TypeError(`RpcErrorPayload message contains lone surrogate: "${message}"`);
  }

  let data: unknown = null;
  if (Object.hasOwn(raw, 'data')) {
    const rawData = (raw as Record<string, unknown>).data;
    if (rawData !== undefined && rawData !== null) {
      data = snapshotValue(rawData);
    }
  }

  return {
    code,
    message,
    data,
  };
}

function cloneJsonTree<T>(value: T, stack: Set<object>): T {
  if (value === null) {
    return null as T;
  }
  const type = typeof value;
  if (type === 'boolean') {
    return value;
  }
  if (type === 'string') {
    if (!stringWellFormed(value as string)) {
      throw new TypeError(`String contains lone surrogate: ${JSON.stringify(value)}`);
    }
    return value;
  }
  if (type === 'number') {
    const num = value as number;
    if (!Number.isFinite(num)) {
      throw new TypeError(`Lossless JSON does not allow non-finite numbers: ${num}`);
    }
    return (Object.is(num, -0) ? -0 : num) as T;
  }
  if (type === 'bigint') {
    const b = value as bigint;
    if (b < I64_MIN || b > U64_MAX) {
      throw new RangeError(`BigInt value out of serde_json integer range: ${b.toString()}`);
    }
    return b as T;
  }
  if (type === 'undefined') {
    throw new TypeError('Lossless JSON does not support undefined values');
  }
  if (type === 'symbol') {
    throw new TypeError('Lossless JSON does not support symbol values');
  }
  if (type === 'function') {
    throw new TypeError('Lossless JSON does not support function values');
  }
  if (type !== 'object') {
    throw new TypeError(`Unsupported value type: ${type}`);
  }

  if (types.isProxy(value as object)) {
    throw new TypeError('Proxy objects are not supported');
  }

  if (stack.has(value as object)) {
    throw new TypeError('Cyclic reference detected in JSON value');
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
    stack.add(value as object);
    try {
      const out = new Array(len);
      for (let i = 0; i < len; i++) {
        const desc = Object.getOwnPropertyDescriptor(value, String(i))!;
        out[i] = cloneJsonTree(desc.value, stack);
      }
      return out as T;
    } finally {
      stack.delete(value as object);
    }
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError('Only plain objects (Object.prototype or null prototype) are supported');
  }

  const symbols = Object.getOwnPropertySymbols(value);
  if (symbols.length > 0) {
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
    if (!stringWellFormed(key)) {
      throw new TypeError(`Object key contains lone surrogate: "${key}"`);
    }
  }

  stack.add(value as object);
  try {
    const out = proto === null ? Object.create(null) : {};
    for (const key of propNames) {
      const desc = Object.getOwnPropertyDescriptor(value, key)!;
      const copied = cloneJsonTree(desc.value, stack);
      Object.defineProperty(out, key, {
        value: copied,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    return out as T;
  } finally {
    stack.delete(value as object);
  }
}

function snapshotValue<T>(value: T): T {
  const stack = new Set<object>();
  return cloneJsonTree(value, stack);
}

function snapshotClassifyRoot(value: object): Record<string, unknown> {
  if (types.isProxy(value)) {
    throw new TypeError('Proxy objects are not supported');
  }

  const symbols = Object.getOwnPropertySymbols(value);
  if (symbols.length > 0) {
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
    if (!stringWellFormed(key)) {
      throw new TypeError(`Object key contains lone surrogate: "${key}"`);
    }
  }

  const stack = new Set<object>();
  stack.add(value);
  try {
    const out: Record<string, unknown> = {};
    for (const key of propNames) {
      const desc = Object.getOwnPropertyDescriptor(value, key)!;
      const copied = cloneJsonTree(desc.value, stack);
      Object.defineProperty(out, key, {
        value: copied,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    return out;
  } finally {
    stack.delete(value);
  }
}

export function classify(value: unknown): IncomingMessage {
  if (value === null || typeof value !== 'object') {
    return { kind: 'ignored' };
  }

  if (types.isProxy(value)) {
    throw new TypeError('Proxy objects are not supported');
  }

  if (Array.isArray(value)) {
    return { kind: 'ignored' };
  }

  const obj = snapshotClassifyRoot(value);

  let id: RequestId | undefined = undefined;
  if (Object.hasOwn(obj, 'id')) {
    id = validateRequestId(obj.id);
  }

  let method: string | undefined = undefined;
  if (Object.hasOwn(obj, 'method')) {
    const m = obj.method;
    if (typeof m === 'string' && stringWellFormed(m)) {
      method = m;
    }
  }

  const hasResult = Object.hasOwn(obj, 'result');
  const hasError = Object.hasOwn(obj, 'error');

  if (id !== undefined && method !== undefined && !hasResult && !hasError) {
    const params = Object.hasOwn(obj, 'params') ? obj.params : {};
    return {
      kind: 'serverRequest',
      id,
      occurrence: ServerRequestOccurrence.random(),
      method,
      params,
    };
  }

  if (id !== undefined) {
    if (hasError) {
      const errorPayload = validateRpcErrorPayload(obj.error);
      return {
        kind: 'response',
        id,
        result: {
          ok: false,
          error: errorPayload,
        },
      };
    }
    const resultValue = hasResult ? obj.result : {};
    return {
      kind: 'response',
      id,
      result: {
        ok: true,
        value: resultValue,
      },
    };
  }

  if (method !== undefined) {
    const params = Object.hasOwn(obj, 'params') ? obj.params : {};
    return {
      kind: 'notification',
      method,
      params,
    };
  }

  return { kind: 'ignored' };
}

export function parseIncomingMessage(text: string): IncomingMessage {
  const value = parseLosslessJson<unknown>(text);
  return classify(value);
}

export function requestValue(
  id: RequestId,
  method: string,
  params?: unknown
): { id: RequestId; method: string; params: unknown } {
  const validId = validateRequestId(id);
  if (typeof method !== 'string') {
    throw new TypeError(
      `Method must be a string, received ${method === null ? 'null' : typeof method}`
    );
  }
  if (!stringWellFormed(method)) {
    throw new TypeError(`Method contains lone surrogate: "${method}"`);
  }
  const finalParams = snapshotValue(params === undefined ? {} : params);
  return {
    id: validId,
    method,
    params: finalParams,
  };
}

export function notificationValue(
  method: string,
  params?: unknown
): { method: string; params: unknown } {
  if (typeof method !== 'string') {
    throw new TypeError(
      `Method must be a string, received ${method === null ? 'null' : typeof method}`
    );
  }
  if (!stringWellFormed(method)) {
    throw new TypeError(`Method contains lone surrogate: "${method}"`);
  }
  const finalParams = snapshotValue(params === undefined ? {} : params);
  return {
    method,
    params: finalParams,
  };
}

export function responseValue(
  id: RequestId,
  result?: unknown
): { id: RequestId; result: unknown } {
  const validId = validateRequestId(id);
  const finalResult = snapshotValue(result === undefined ? {} : result);
  return {
    id: validId,
    result: finalResult,
  };
}

export function errorValue(
  id: RequestId,
  error: RpcErrorPayload
): { id: RequestId; error: RpcErrorPayload } {
  const validId = validateRequestId(id);
  const validError = validateRpcErrorPayload(error);
  return {
    id: validId,
    error: validError,
  };
}

export function encodeRequest(id: RequestId, method: string, params?: unknown): string {
  return serializeSerdeValue(requestValue(id, method, params));
}

export function encodeNotification(method: string, params?: unknown): string {
  return serializeSerdeValue(notificationValue(method, params));
}

export function encodeResponse(id: RequestId, result?: unknown): string {
  return serializeSerdeValue(responseValue(id, result));
}

export function encodeError(id: RequestId, error: RpcErrorPayload): string {
  return serializeSerdeValue(errorValue(id, error));
}
