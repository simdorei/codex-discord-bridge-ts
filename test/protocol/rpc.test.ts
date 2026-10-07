import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classify,
  encodeError,
  encodeNotification,
  encodeRequest,
  encodeResponse,
  errorValue,
  notificationValue,
  parseIncomingMessage,
  requestValue,
  responseValue,
  validateRpcErrorPayload,
  type IncomingMessage,
  type NotificationMessage,
  type ResponseMessage,
  type RpcErrorPayload,
  type ServerRequestMessage,
} from '../../src/protocol/rpc.ts';
import {
  I64_MAX,
  I64_MIN,
  requestIdEquals,
  ServerRequestOccurrence,
  type RequestId,
} from '../../src/protocol/ids.ts';

describe('classify and parseIncomingMessage branches and defaults', () => {
  it('classifies serverRequest with params and defaults absent params to empty object', () => {
    const withParams = classify({
      id: 'req-1',
      method: 'workspace/inspect',
      params: { filter: 'active' },
    });
    assert.equal(withParams.kind, 'serverRequest');
    const sr1 = withParams as ServerRequestMessage;
    assert.equal(sr1.id, 'req-1');
    assert.equal(sr1.method, 'workspace/inspect');
    assert.deepStrictEqual(sr1.params, { filter: 'active' });
    assert.ok(sr1.occurrence instanceof ServerRequestOccurrence);

    const withoutParams = classify({
      id: 100n,
      method: 'system/ping',
    });
    assert.equal(withoutParams.kind, 'serverRequest');
    const sr2 = withoutParams as ServerRequestMessage;
    assert.equal(sr2.id, 100n);
    assert.equal(sr2.method, 'system/ping');
    assert.deepStrictEqual(sr2.params, {});

    const withNullParams = classify({
      id: 101n,
      method: 'system/reset',
      params: null,
    });
    assert.equal(withNullParams.kind, 'serverRequest');
    assert.strictEqual((withNullParams as ServerRequestMessage).params, null);
  });

  it('classifies response ok with result and defaults absent result to empty object', () => {
    const withResult = classify({
      id: 'res-1',
      result: { status: 'ready' },
    });
    assert.equal(withResult.kind, 'response');
    const r1 = withResult as ResponseMessage;
    assert.equal(r1.id, 'res-1');
    assert.equal(r1.result.ok, true);
    if (r1.result.ok) {
      assert.deepStrictEqual(r1.result.value, { status: 'ready' });
    }

    const withoutResult = classify({
      id: 200n,
    });
    assert.equal(withoutResult.kind, 'response');
    const r2 = withoutResult as ResponseMessage;
    assert.equal(r2.id, 200n);
    assert.equal(r2.result.ok, true);
    if (r2.result.ok) {
      assert.deepStrictEqual(r2.result.value, {});
    }

    const withNullResult = classify({
      id: 201n,
      result: null,
    });
    assert.equal(withNullResult.kind, 'response');
    const r3 = withNullResult as ResponseMessage;
    assert.equal(r3.result.ok, true);
    if (r3.result.ok) {
      assert.strictEqual(r3.result.value, null);
    }
  });

  it('classifies notification and defaults absent params to empty object', () => {
    const withParams = classify({
      method: 'log',
      params: { message: 'hello' },
    });
    assert.equal(withParams.kind, 'notification');
    const n1 = withParams as NotificationMessage;
    assert.equal(n1.method, 'log');
    assert.deepStrictEqual(n1.params, { message: 'hello' });

    const withoutParams = classify({
      method: 'heartbeat',
    });
    assert.equal(withoutParams.kind, 'notification');
    const n2 = withoutParams as NotificationMessage;
    assert.equal(n2.method, 'heartbeat');
    assert.deepStrictEqual(n2.params, {});

    const withNullParams = classify({
      method: 'clear',
      params: null,
    });
    assert.equal(withNullParams.kind, 'notification');
    assert.strictEqual((withNullParams as NotificationMessage).params, null);
  });

  it('ignores primitives, arrays, empty objects, and non-string methods without id', () => {
    assert.deepStrictEqual(classify(null), { kind: 'ignored' });
    assert.deepStrictEqual(classify(undefined), { kind: 'ignored' });
    assert.deepStrictEqual(classify(123), { kind: 'ignored' });
    assert.deepStrictEqual(classify('hello'), { kind: 'ignored' });
    assert.deepStrictEqual(classify(true), { kind: 'ignored' });
    assert.deepStrictEqual(classify([]), { kind: 'ignored' });
    assert.deepStrictEqual(classify([1, 2, 3]), { kind: 'ignored' });
    assert.deepStrictEqual(classify({}), { kind: 'ignored' });
    assert.deepStrictEqual(classify({ method: 123 }), { kind: 'ignored' });
    assert.deepStrictEqual(classify({ method: null }), { kind: 'ignored' });
    assert.deepStrictEqual(classify({ method: true, params: { a: 1 } }), { kind: 'ignored' });
  });

  it('handles present id with non-string method as response ok with default empty object', () => {
    const classified = classify({
      id: 300n,
      method: 12345,
    });
    assert.equal(classified.kind, 'response');
    const resp = classified as ResponseMessage;
    assert.equal(resp.id, 300n);
    assert.equal(resp.result.ok, true);
    if (resp.result.ok) {
      assert.deepStrictEqual(resp.result.value, {});
    }
  });
});

describe('error precedence and dominance', () => {
  it('own error field presence dominates result field', () => {
    const classified = classify({
      id: 400n,
      result: { data: 'stale' },
      error: {
        code: -32603n,
        message: 'Internal error',
        data: { reason: 'panic' },
      },
    });
    assert.equal(classified.kind, 'response');
    const resp = classified as ResponseMessage;
    assert.equal(resp.id, 400n);
    assert.equal(resp.result.ok, false);
    if (!resp.result.ok) {
      assert.equal(resp.result.error.code, -32603n);
      assert.equal(resp.result.error.message, 'Internal error');
      assert.deepStrictEqual(resp.result.error.data, { reason: 'panic' });
    }
  });

  it('error: null dominates result and throws invalid error payload', () => {
    assert.throws(() => {
      classify({
        id: 401n,
        result: { ok: true },
        error: null,
      });
    }, TypeError);

    assert.throws(() => {
      classify({
        id: 402n,
        error: null,
      });
    }, TypeError);
  });

  it('id plus method with error classifies as response error rather than serverRequest', () => {
    const classified = classify({
      id: 403n,
      method: 'echo',
      error: {
        code: -32000n,
        message: 'Custom error',
      },
    });
    assert.equal(classified.kind, 'response');
    const resp = classified as ResponseMessage;
    assert.equal(resp.result.ok, false);
    if (!resp.result.ok) {
      assert.equal(resp.result.error.code, -32000n);
      assert.equal(resp.result.error.message, 'Custom error');
      assert.strictEqual(resp.result.error.data, null);
    }
  });

  it('id plus method with result classifies as response ok rather than serverRequest', () => {
    const classified = classify({
      id: 404n,
      method: 'echo',
      result: { echoed: true },
    });
    assert.equal(classified.kind, 'response');
    const resp = classified as ResponseMessage;
    assert.equal(resp.result.ok, true);
    if (resp.result.ok) {
      assert.deepStrictEqual(resp.result.value, { echoed: true });
    }
  });

  it('no ID plus string method is notification regardless of result and error fields', () => {
    const classified = classify({
      method: 'notice',
      result: { ignored: true },
      error: { code: 1n, message: 'ignored' },
      params: { event: 'fired' },
    });
    assert.equal(classified.kind, 'notification');
    const notif = classified as NotificationMessage;
    assert.equal(notif.method, 'notice');
    assert.deepStrictEqual(notif.params, { event: 'fired' });
  });
});

describe('RequestId type fidelity: 7 vs "7" and wire token preservation', () => {
  it('preserves distinct identity of bigint 7n vs string "7"', () => {
    const fromIntJson = parseIncomingMessage('{"id": 7, "method": "test"}');
    assert.equal(fromIntJson.kind, 'serverRequest');
    const srInt = fromIntJson as ServerRequestMessage;
    assert.equal(typeof srInt.id, 'bigint');
    assert.equal(srInt.id, 7n);

    const fromStrJson = parseIncomingMessage('{"id": "7", "method": "test"}');
    assert.equal(fromStrJson.kind, 'serverRequest');
    const srStr = fromStrJson as ServerRequestMessage;
    assert.equal(typeof srStr.id, 'string');
    assert.equal(srStr.id, '7');

    assert.equal(requestIdEquals(srInt.id, srStr.id), false);
  });

  it('encodes bigint vs string IDs with exact wire tokens', () => {
    const intWire = encodeRequest(7n, 'ping');
    assert.equal(intWire, '{"id":7,"method":"ping","params":{}}');

    const strWire = encodeRequest('7', 'ping');
    assert.equal(strWire, '{"id":"7","method":"ping","params":{}}');
  });
});

describe('large integers and i64 range bounds', () => {
  it('preserves 9007199254740993 without precision loss', () => {
    const text = '{"id": 9007199254740993, "result": {"count": 9007199254740993}}';
    const msg = parseIncomingMessage(text);
    assert.equal(msg.kind, 'response');
    const resp = msg as ResponseMessage;
    assert.equal(resp.id, 9007199254740993n);
    assert.equal(resp.result.ok, true);
    if (resp.result.ok) {
      assert.deepStrictEqual(resp.result.value, { count: 9007199254740993n });
    }

    const reEncoded = encodeResponse(resp.id, resp.result.ok ? resp.result.value : {});
    assert.equal(reEncoded, '{"id":9007199254740993,"result":{"count":9007199254740993}}');
  });

  it('accepts I64_MIN and I64_MAX as valid IDs and error codes', () => {
    const minReq = classify({ id: I64_MIN, method: 'min' });
    assert.equal(minReq.kind, 'serverRequest');
    assert.equal((minReq as ServerRequestMessage).id, I64_MIN);

    const maxReq = classify({ id: I64_MAX, method: 'max' });
    assert.equal(maxReq.kind, 'serverRequest');
    assert.equal((maxReq as ServerRequestMessage).id, I64_MAX);

    const minErr = validateRpcErrorPayload({ code: I64_MIN, message: 'min' });
    assert.equal(minErr.code, I64_MIN);

    const maxErr = validateRpcErrorPayload({ code: I64_MAX, message: 'max' });
    assert.equal(maxErr.code, I64_MAX);
  });

  it('rejects i64 overflow and underflow for ID and error code', () => {
    const overflow = I64_MAX + 1n;
    const underflow = I64_MIN - 1n;

    assert.throws(() => classify({ id: overflow, method: 'm' }), RangeError);
    assert.throws(() => classify({ id: underflow, method: 'm' }), RangeError);

    assert.throws(() => validateRpcErrorPayload({ code: overflow, message: 'm' }), RangeError);
    assert.throws(() => validateRpcErrorPayload({ code: underflow, message: 'm' }), RangeError);

    assert.throws(() => parseIncomingMessage('{"id": 9223372036854775808, "method": "m"}'), RangeError);
  });
});

describe('fractions, exponents, null, and boolean IDs', () => {
  it('rejects floating-point and exponent number IDs', () => {
    assert.throws(() => parseIncomingMessage('{"id": 1.5, "result": {}}'), TypeError);
    assert.throws(() => parseIncomingMessage('{"id": 1e5, "result": {}}'), TypeError);
    assert.throws(() => classify({ id: 1.5 }), TypeError);
    assert.throws(() => classify({ id: 100 }), TypeError);
  });

  it('rejects null and boolean IDs on wire and object', () => {
    assert.throws(() => parseIncomingMessage('{"id": null, "method": "m"}'), TypeError);
    assert.throws(() => parseIncomingMessage('{"id": true, "method": "m"}'), TypeError);
    assert.throws(() => parseIncomingMessage('{"id": false, "method": "m"}'), TypeError);
    assert.throws(() => classify({ id: null }), TypeError);
    assert.throws(() => classify({ id: true }), TypeError);
    assert.throws(() => classify({ id: false }), TypeError);
  });

  it('validates present id even when no method is supplied', () => {
    assert.throws(() => classify({ id: null }), TypeError);
    assert.throws(() => classify({ id: 2.718 }), TypeError);
  });
});

describe('ServerRequestOccurrence freshness and defensive byte isolation', () => {
  it('generates distinct random occurrence for each classification', () => {
    const req1 = classify({ id: 1n, method: 'ping' }) as ServerRequestMessage;
    const req2 = classify({ id: 1n, method: 'ping' }) as ServerRequestMessage;

    assert.notStrictEqual(req1.occurrence, req2.occurrence);
    assert.equal(req1.occurrence.equals(req2.occurrence), false);
    assert.notDeepStrictEqual(req1.occurrence.asBytes(), req2.occurrence.asBytes());
  });

  it('provides defensive 16-byte copy through asBytes()', () => {
    const req = classify({ id: 1n, method: 'ping' }) as ServerRequestMessage;
    const bytes1 = req.occurrence.asBytes();
    assert.equal(bytes1.length, 16);

    const originalZero = bytes1[0];
    bytes1[0] = (originalZero ?? 0) ^ 0xff;
    const bytes2 = req.occurrence.asBytes();
    assert.equal(bytes2[0], originalZero);
  });
});

describe('RpcErrorPayload strict validation', () => {
  it('rejects unknown fields in error payload', () => {
    assert.throws(() => {
      validateRpcErrorPayload({
        code: 10n,
        message: 'bad',
        extraField: true,
      });
    }, TypeError);
  });

  it('rejects missing code or message', () => {
    assert.throws(() => {
      validateRpcErrorPayload({ message: 'no code' });
    }, TypeError);

    assert.throws(() => {
      validateRpcErrorPayload({ code: 10n });
    }, TypeError);
  });

  it('rejects number code (bigint required)', () => {
    assert.throws(() => {
      validateRpcErrorPayload({ code: 500, message: 'not bigint' });
    }, TypeError);
  });

  it('normalizes absent and explicit null data to null', () => {
    const absentData = validateRpcErrorPayload({ code: 1n, message: 'ok' });
    assert.strictEqual(absentData.data, null);

    const nullData = validateRpcErrorPayload({ code: 1n, message: 'ok', data: null });
    assert.strictEqual(nullData.data, null);

    const undefData = validateRpcErrorPayload({ code: 1n, message: 'ok', data: undefined });
    assert.strictEqual(undefData.data, null);
  });

  it('accepts arbitrary JSON data and rejects invalid JSON structures', () => {
    const validData = validateRpcErrorPayload({
      code: 1n,
      message: 'ok',
      data: { details: ['item1', 2n], active: true },
    });
    assert.deepStrictEqual(validData.data, { details: ['item1', 2n], active: true });

    assert.throws(() => {
      validateRpcErrorPayload({
        code: 1n,
        message: 'bad',
        data: { fn: () => {} },
      });
    }, TypeError);

    assert.throws(() => {
      validateRpcErrorPayload({
        code: 1n,
        message: 'bad',
        data: { sym: Symbol('bad') },
      });
    }, TypeError);

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    assert.throws(() => {
      validateRpcErrorPayload({
        code: 1n,
        message: 'bad',
        data: circular,
      });
    }, TypeError);
  });
});

describe('Unicode and non-BMP character handling', () => {
  const nonBmpEmoji = '🎉';
  const nonBmpClef = '𝄞';
  const loneSurrogate = String.fromCharCode(0xd800);

  it('roundtrips valid non-BMP Unicode without corruption', () => {
    const encoded = encodeRequest(`id-${nonBmpClef}`, `method/${nonBmpEmoji}`, {
      text: 'greeting 🌍',
    });
    const parsed = parseIncomingMessage(encoded) as ServerRequestMessage;
    assert.equal(parsed.kind, 'serverRequest');
    assert.equal(parsed.id, `id-${nonBmpClef}`);
    assert.equal(parsed.method, `method/${nonBmpEmoji}`);
    assert.deepStrictEqual(parsed.params, { text: 'greeting 🌍' });
  });

  it('rejects lone surrogates in outgoing methods and error messages', () => {
    assert.throws(() => requestValue(1n, `bad_${loneSurrogate}`), TypeError);
    assert.throws(() => notificationValue(`bad_${loneSurrogate}`), TypeError);
    assert.throws(() => {
      validateRpcErrorPayload({
        code: 1n,
        message: `bad_${loneSurrogate}`,
      });
    }, TypeError);
    assert.throws(() => {
      errorValue(1n, {
        code: 1n,
        message: `bad_${loneSurrogate}`,
        data: null,
      });
    }, TypeError);
  });

  it('rejects lone surrogate strings in RequestId', () => {
    assert.throws(() => requestValue(`bad_${loneSurrogate}`, 'validMethod'), TypeError);
    assert.throws(() => responseValue(`bad_${loneSurrogate}`), TypeError);
  });

  it('parseIncomingMessage rejects malformed UTF-16 in JSON keys and values', () => {
    const badKeyJson = '{"bad' + loneSurrogate + '": 1}';
    assert.throws(() => parseIncomingMessage(badKeyJson), SyntaxError);

    const badValJson = '{"method": "bad' + loneSurrogate + '"}';
    assert.throws(() => parseIncomingMessage(badValJson), SyntaxError);
  });
});

describe('prototype collision resistance and caller non-mutation', () => {
  it('ignores prototype properties for id, method, result, error', () => {
    const proto = {
      id: 999n,
      method: 'pollutedMethod',
      result: { proto: true },
      error: { code: 1n, message: 'protoErr', data: null },
    };
    const obj = Object.create(proto);
    assert.deepStrictEqual(classify(obj), { kind: 'ignored' });
  });

  it('handles object with own id and prototype method as response ok', () => {
    const proto = { method: 'pollutedMethod' };
    const obj = Object.create(proto);
    obj.id = 500n;
    const classified = classify(obj);
    assert.equal(classified.kind, 'response');
    const resp = classified as ResponseMessage;
    assert.equal(resp.id, 500n);
    assert.equal(resp.result.ok, true);
    if (resp.result.ok) {
      assert.deepStrictEqual(resp.result.value, {});
    }
  });

  it('handles object with own method and prototype id as notification', () => {
    const proto = { id: 500n };
    const obj = Object.create(proto);
    obj.method = 'notify';
    const classified = classify(obj);
    assert.equal(classified.kind, 'notification');
    assert.equal((classified as NotificationMessage).method, 'notify');
  });

  it('does not mutate caller objects passed to classify', () => {
    const input = {
      id: 600n,
      method: 'action',
      params: { count: 1 },
    };
    classify(input);
    assert.deepStrictEqual(input, {
      id: 600n,
      method: 'action',
      params: { count: 1 },
    });
  });

  it('resists global Object.prototype pollution', () => {
    try {
      (Object.prototype as unknown as Record<string, unknown>).id = 777n;
      (Object.prototype as unknown as Record<string, unknown>).method = 'globalPollution';
      (Object.prototype as unknown as Record<string, unknown>).result = { bad: true };
      (Object.prototype as unknown as Record<string, unknown>).error = {
        code: 1n,
        message: 'bad',
        data: null,
      };

      const empty = {};
      assert.deepStrictEqual(classify(empty), { kind: 'ignored' });

      const legit = { method: 'legit' };
      const classified = classify(legit);
      assert.equal(classified.kind, 'notification');
      assert.equal((classified as NotificationMessage).method, 'legit');
    } finally {
      delete (Object.prototype as unknown as Record<string, unknown>).id;
      delete (Object.prototype as unknown as Record<string, unknown>).method;
      delete (Object.prototype as unknown as Record<string, unknown>).result;
      delete (Object.prototype as unknown as Record<string, unknown>).error;
    }
  });
});

describe('outgoing builder functions and encoders', () => {
  it('requestValue and encodeRequest construct valid payloads without jsonrpc field', () => {
    const value = requestValue(800n, 'calc', { a: 1, b: 2 });
    assert.deepStrictEqual(value, {
      id: 800n,
      method: 'calc',
      params: { a: 1, b: 2 },
    });
    assert.equal(Object.hasOwn(value, 'jsonrpc'), false);

    const encoded = encodeRequest(800n, 'calc', { a: 1, b: 2 });
    assert.equal(encoded, '{"id":800,"method":"calc","params":{"a":1.0,"b":2.0}}');
    assert.equal(encoded.includes('jsonrpc'), false);

    const encodedBigInt = encodeRequest(800n, 'calc', { a: 1n, b: 2n });
    assert.equal(encodedBigInt, '{"id":800,"method":"calc","params":{"a":1,"b":2}}');
  });

  it('notificationValue and encodeNotification construct valid payloads without jsonrpc field', () => {
    const value = notificationValue('alert');
    assert.deepStrictEqual(value, {
      method: 'alert',
      params: {},
    });
    assert.equal(Object.hasOwn(value, 'jsonrpc'), false);

    const encoded = encodeNotification('alert');
    assert.equal(encoded, '{"method":"alert","params":{}}');
    assert.equal(encoded.includes('jsonrpc'), false);
  });

  it('responseValue and encodeResponse construct valid payloads without jsonrpc field', () => {
    const value = responseValue('r-1', null);
    assert.deepStrictEqual(value, {
      id: 'r-1',
      result: null,
    });
    assert.equal(Object.hasOwn(value, 'jsonrpc'), false);

    const encoded = encodeResponse('r-1', null);
    assert.equal(encoded, '{"id":"r-1","result":null}');
    assert.equal(encoded.includes('jsonrpc'), false);
  });

  it('errorValue and encodeError construct valid payloads without jsonrpc field', () => {
    const errPayload: RpcErrorPayload = {
      code: -32601n,
      message: 'Method not found',
      data: null,
    };
    const value = errorValue(900n, errPayload);
    assert.deepStrictEqual(value, {
      id: 900n,
      error: errPayload,
    });
    assert.equal(Object.hasOwn(value, 'jsonrpc'), false);

    const encoded = encodeError(900n, errPayload);
    assert.equal(encoded, '{"error":{"code":-32601,"data":null,"message":"Method not found"},"id":900}');
    assert.equal(encoded.includes('jsonrpc'), false);
  });

  it('supports nested large integer parameters in encodeRequest', () => {
    const encoded = encodeRequest(1n, 'nested', {
      large: 9007199254740993n,
      nestedList: [9007199254740994n],
    });
    assert.equal(
      encoded,
      '{"id":1,"method":"nested","params":{"large":9007199254740993,"nestedList":[9007199254740994]}}'
    );

    const parsed = parseIncomingMessage(encoded) as ServerRequestMessage;
    assert.equal(parsed.kind, 'serverRequest');
    assert.deepStrictEqual(parsed.params, {
      large: 9007199254740993n,
      nestedList: [9007199254740994n],
    });
  });
});

describe('classify and builders validation and params', () => {
  it('raw classify rejects invalid domain and accepts nonstring method as ignored', () => {
    assert.throws(() => classify({ method: '\uD800' }));
    assert.throws(() => classify({ ['\uD800']: 1 }));
    assert.throws(() => classify({ method: 'test', params: { a: '\uD800' } }));
    assert.throws(() => classify({ method: 'test', params: { a: Infinity } }));
    assert.throws(() => classify({ method: 'test', fn: () => {} }));
    assert.deepStrictEqual(classify({ method: 123 }), { kind: 'ignored' });
  });

  it('builders reject invalid surrogate, nested key, value, Infinity, and function', () => {
    assert.throws(() => requestValue(1n, '\uD800'));
    assert.throws(() => requestValue(1n, 'm', { ['\uD800']: 1 }));
    assert.throws(() => requestValue(1n, 'm', { a: '\uD800' }));
    assert.throws(() => requestValue(1n, 'm', { a: Infinity }));
    assert.throws(() => requestValue(1n, 'm', { fn: () => {} }));
    assert.throws(() => notificationValue('m', { a: Infinity }));
    assert.throws(() => responseValue(1n, { a: '\uD800' }));
  });

  it('builders accept bigint outgoing params', () => {
    const req = requestValue(1n, 'm', { count: 100n });
    assert.deepStrictEqual(req, { id: 1n, method: 'm', params: { count: 100n } });
    const notif = notificationValue('m', { count: 200n });
    assert.deepStrictEqual(notif, { method: 'm', params: { count: 200n } });
  });
});

describe('builder detached snapshot mutation isolation', () => {
  const makeSample = () => ({
    nested: {
      big: 9007199254740993n,
      flt: 1.5,
      intFlt: 1,
      negZero: -0,
      nil: null,
      arr: [9007199254740993n, 1.5, 1, -0, null],
    },
  });

  it('request params deeply isolated after build in both directions', () => {
    const caller = makeSample();
    const req = requestValue(1n, 'm', caller);
    assert.notStrictEqual(req.params, caller);
    assert.notStrictEqual((req.params as any).nested, caller.nested);
    assert.notStrictEqual((req.params as any).nested.arr, caller.nested.arr);
    assert.strictEqual(Object.isFrozen(caller), false);

    caller.nested.big = 0n;
    caller.nested.flt = 9.5;
    caller.nested.arr.push(999 as any);
    assert.strictEqual((req.params as any).nested.big, 9007199254740993n);
    assert.strictEqual((req.params as any).nested.flt, 1.5);
    assert.strictEqual(Object.is((req.params as any).nested.negZero, -0), true);
    assert.strictEqual(Object.is((req.params as any).nested.arr[3], -0), true);
    assert.strictEqual((req.params as any).nested.arr.length, 5);

    (req.params as any).nested.flt = 5.5;
    assert.strictEqual(caller.nested.flt, 9.5);

    const wire = encodeRequest(req.id, req.method, req.params);
    const parsed = parseIncomingMessage(wire);
    assert.strictEqual(parsed.kind, 'serverRequest');
    if (parsed.kind === 'serverRequest') {
      assert.strictEqual((parsed.params as any).nested.big, 9007199254740993n);
      assert.strictEqual((parsed.params as any).nested.flt, 5.5);
      assert.strictEqual((parsed.params as any).nested.intFlt, 1);
      assert.strictEqual(Object.is((parsed.params as any).nested.negZero, -0), true);
      assert.strictEqual((parsed.params as any).nested.nil, null);
    }
  });

  it('notification params deeply isolated after build in both directions', () => {
    const caller = makeSample();
    const notif = notificationValue('m', caller);
    assert.notStrictEqual(notif.params, caller);
    assert.notStrictEqual((notif.params as any).nested, caller.nested);
    assert.notStrictEqual((notif.params as any).nested.arr, caller.nested.arr);
    assert.strictEqual(Object.isFrozen(caller), false);

    caller.nested.big = 1n;
    caller.nested.arr[0] = 0n;
    assert.strictEqual((notif.params as any).nested.big, 9007199254740993n);
    assert.strictEqual((notif.params as any).nested.arr[0], 9007199254740993n);
    assert.strictEqual(Object.is((notif.params as any).nested.negZero, -0), true);

    (notif.params as any).nested.intFlt = 99;
    assert.strictEqual(caller.nested.intFlt, 1);

    const wire = encodeNotification(notif.method, notif.params);
    const parsed = parseIncomingMessage(wire);
    assert.strictEqual(parsed.kind, 'notification');
    if (parsed.kind === 'notification') {
      assert.strictEqual((parsed.params as any).nested.big, 9007199254740993n);
      assert.strictEqual((parsed.params as any).nested.intFlt, 99);
      assert.strictEqual(Object.is((parsed.params as any).nested.negZero, -0), true);
    }
  });

  it('response result deeply isolated after build in both directions', () => {
    const caller = makeSample();
    const resp = responseValue(2n, caller);
    assert.notStrictEqual(resp.result, caller);
    assert.notStrictEqual((resp.result as any).nested, caller.nested);
    assert.notStrictEqual((resp.result as any).nested.arr, caller.nested.arr);
    assert.strictEqual(Object.isFrozen(caller), false);

    caller.nested.big = 2n;
    caller.nested.arr.pop();
    assert.strictEqual((resp.result as any).nested.big, 9007199254740993n);
    assert.strictEqual((resp.result as any).nested.arr.length, 5);
    assert.strictEqual(Object.is((resp.result as any).nested.negZero, -0), true);

    (resp.result as any).nested.flt = 2.5;
    assert.strictEqual(caller.nested.flt, 1.5);

    const wire = encodeResponse(resp.id, resp.result);
    const parsed = parseIncomingMessage(wire);
    assert.strictEqual(parsed.kind, 'response');
    if (parsed.kind === 'response') {
      assert.strictEqual(parsed.result.ok, true);
      if (parsed.result.ok) {
        assert.strictEqual((parsed.result.value as any).nested.big, 9007199254740993n);
        assert.strictEqual(Object.is((parsed.result.value as any).nested.negZero, -0), true);
        assert.strictEqual((parsed.result.value as any).nested.flt, 2.5);
      }
    }
  });

  it('error payload.data, code, and message isolated after build in both directions', () => {
    const callerData = makeSample();
    const callerError: RpcErrorPayload = {
      code: -32603n,
      message: 'internal error',
      data: callerData,
    };
    const err = errorValue(3n, callerError);
    assert.notStrictEqual(err.error, callerError);
    assert.notStrictEqual(err.error.data, callerData);
    assert.notStrictEqual((err.error.data as any).nested, callerData.nested);
    assert.notStrictEqual((err.error.data as any).nested.arr, callerData.nested.arr);
    assert.strictEqual(Object.isFrozen(callerError), false);
    assert.strictEqual(Object.isFrozen(callerData), false);

    (callerError as any).code = -32000n;
    (callerError as any).message = 'mutated message';
    callerData.nested.big = 7n;
    callerData.nested.arr[1] = 99.9;
    assert.strictEqual(err.error.code, -32603n);
    assert.strictEqual(err.error.message, 'internal error');
    assert.strictEqual((err.error.data as any).nested.big, 9007199254740993n);
    assert.strictEqual((err.error.data as any).nested.arr[1], 1.5);
    assert.strictEqual(Object.is((err.error.data as any).nested.negZero, -0), true);

    (err.error.data as any).nested.flt = 3.5;
    assert.strictEqual(callerData.nested.flt, 1.5);

    const wire = encodeError(err.id, err.error);
    const parsed = parseIncomingMessage(wire);
    assert.strictEqual(parsed.kind, 'response');
    if (parsed.kind === 'response') {
      assert.strictEqual(parsed.result.ok, false);
      if (!parsed.result.ok) {
        assert.strictEqual(parsed.result.error.code, -32603n);
        assert.strictEqual(parsed.result.error.message, 'internal error');
        assert.strictEqual((parsed.result.error.data as any).nested.big, 9007199254740993n);
        assert.strictEqual(Object.is((parsed.result.error.data as any).nested.negZero, -0), true);
        assert.strictEqual((parsed.result.error.data as any).nested.flt, 3.5);
      }
    }

    assert.strictEqual(errorValue(4n, { code: 1n, message: 'm' } as unknown as RpcErrorPayload).error.data, null);
    assert.strictEqual(errorValue(4n, { code: 1n, message: 'm', data: null }).error.data, null);
    assert.strictEqual(errorValue(4n, { code: 1n, message: 'm', data: undefined }).error.data, null);
  });
});
