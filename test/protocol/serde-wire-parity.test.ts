import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { I64_MAX, I64_MIN, parseLosslessJson, U64_MAX } from '../../src/protocol/ids.ts';
import {
  classify,
  encodeError,
  encodeNotification,
  encodeRequest,
  encodeResponse,
  errorValue,
  notificationValue,
  requestValue,
  responseValue,
  type IncomingMessage,
} from '../../src/protocol/rpc.ts';

function f64ToBits(num: number): bigint {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setFloat64(0, num, false);
  return view.getBigUint64(0, false);
}

describe('serde wire parity and lossless JSON protocol integration', () => {
  it('wire parses decimal 9.999999999999999e-6 to 0.00001', () => {
    const parsed = parseLosslessJson<number>('9.999999999999999e-6');
    assert.equal(parsed, 0.00001);
  });

  it('wire parses -0, signed i64 and unsigned u64 boundaries', () => {
    const negZero = parseLosslessJson<number>('-0.0');
    assert.equal(Object.is(negZero, -0), true);

    const minI64 = parseLosslessJson<bigint>('-9223372036854775808');
    assert.equal(minI64, I64_MIN);

    const maxI64 = parseLosslessJson<bigint>('9223372036854775807');
    assert.equal(maxI64, I64_MAX);

    const maxU64 = parseLosslessJson<bigint>('18446744073709551615');
    assert.equal(maxU64, U64_MAX);
  });

  it('enforces depth limit 128 while accepting depth 127', () => {
    const depth127 = '['.repeat(127) + '0' + ']'.repeat(127);
    assert.doesNotThrow(() => parseLosslessJson(depth127));

    const depth128 = '['.repeat(128) + '0' + ']'.repeat(128);
    assert.throws(() => parseLosslessJson(depth128), SyntaxError);
  });

  it('rejects duplicate overwritten keys with numeric overflow', () => {
    assert.throws(() => parseLosslessJson('{"a": 1e999, "a": 1}'), SyntaxError);
  });

  it('accepts huge zero exponent and preserves SyntaxError for float overflow', () => {
    const hugeZero = parseLosslessJson<number>('0e999999999999999999');
    assert.equal(hugeZero, 0);

    assert.throws(() => parseLosslessJson('1e999'), SyntaxError);
  });

  it('retains exact IEEE-754 f64 bits in builders and classify until wire serialization', () => {
    const x = 9.999999999999999e-6;
    const originalBits = f64ToBits(x);

    const req = requestValue(1n, 'm', { n: x });
    assert.equal(f64ToBits((req.params as { n: number }).n), originalBits);

    const notif = notificationValue('m', { n: x });
    assert.equal(f64ToBits((notif.params as { n: number }).n), originalBits);

    const resp = responseValue(1n, { n: x });
    assert.equal(f64ToBits((resp.result as { n: number }).n), originalBits);

    const err = errorValue(1n, { code: -1n, message: 'm', data: { n: x } });
    assert.equal(f64ToBits((err.error.data as { n: number }).n), originalBits);

    const directClassified = classify({ id: 1n, method: 'm', params: { n: x } });
    assert.equal(directClassified.kind, 'serverRequest');
    if (directClassified.kind === 'serverRequest') {
      assert.equal(f64ToBits((directClassified.params as { n: number }).n), originalBits);
    }

    const encoded = encodeRequest(1n, 'm', { n: x });
    assert.equal(encoded, '{"id":1,"method":"m","params":{"n":9.999999999999999e-6}}');

    const wireDecoded = parseLosslessJson<{ id: bigint; method: string; params: { n: number } }>(encoded);
    assert.equal(wireDecoded.params.n, 0.00001);
    assert.notEqual(f64ToBits(wireDecoded.params.n), originalBits);
  });

  it('preserves negative zero and serializes large repeated bigint correctly', () => {
    const negZeroReq = requestValue(1n, 'm', { z: -0 });
    assert.equal(Object.is((negZeroReq.params as { z: number }).z, -0), true);
    assert.equal(encodeRequest(1n, 'm', { z: -0 }), '{"id":1,"method":"m","params":{"z":-0.0}}');

    const big = 18446744073709551615n;
    const repeatedBig = encodeRequest(1n, 'm', { a: big, b: big });
    assert.equal(
      repeatedBig,
      '{"id":1,"method":"m","params":{"a":18446744073709551615,"b":18446744073709551615}}'
    );
  });

  it('ensures caller deep mutation isolation and independent shared alias copies', () => {
    const callerParams = { nested: { count: 10 } };
    const classified = classify({ id: 100n, method: 'test', params: callerParams });
    assert.equal(classified.kind, 'serverRequest');
    if (classified.kind === 'serverRequest') {
      callerParams.nested.count = 999;
      assert.equal((classified.params as { nested: { count: number } }).nested.count, 10);
    }

    const sharedSub = { count: 42 };
    const sharedClassified = classify({
      id: 101n,
      method: 'test',
      params: { p1: sharedSub, p2: sharedSub },
    });
    assert.equal(sharedClassified.kind, 'serverRequest');
    if (sharedClassified.kind === 'serverRequest') {
      const p = sharedClassified.params as { p1: { count: number }; p2: { count: number } };
      assert.deepEqual(p.p1, { count: 42 });
      assert.deepEqual(p.p2, { count: 42 });
      assert.notEqual(p.p1, p.p2);
      p.p1.count = 500;
      assert.equal(p.p2.count, 42);
    }
  });

  it('protects against __proto__ pollution safely', () => {
    const pollutedBefore = (Object.prototype as { testInjected?: unknown }).testInjected;
    assert.equal(pollutedBefore, undefined);

    const malicious = JSON.parse('{"__proto__":{"testInjected":"yes"},"valid":1}');
    const classified = classify({ id: 1n, method: 'm', params: malicious });
    assert.equal((Object.prototype as { testInjected?: unknown }).testInjected, undefined);

    if (classified.kind === 'serverRequest') {
      const p = classified.params as Record<string, unknown>;
      assert.equal(Object.hasOwn(p, '__proto__'), true);
      assert.equal((Object.prototype as { testInjected?: unknown }).testInjected, undefined);
    }
  });

  it('never invokes getters or toJSON methods when validating snapshot', () => {
    let getterInvocations = 0;
    let toJSONInvocations = 0;
    const obj = {
      get bad() {
        getterInvocations++;
        return 1;
      },
      toJSON() {
        toJSONInvocations++;
        return {};
      },
    };

    assert.throws(() => classify({ id: 1n, method: 'm', params: obj }), TypeError);
    assert.equal(getterInvocations, 0);
    assert.equal(toJSONInvocations, 0);
  });

  it('rejects cyclic objects, sparse arrays, class instances, and non-JSON values', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    assert.throws(() => classify({ id: 1n, method: 'm', params: cyclic }), TypeError);

    const sparse = [1, , 3];
    assert.throws(() => classify({ id: 1n, method: 'm', params: sparse }), TypeError);

    class CustomClass {
      readonly field = 1;
    }
    assert.throws(() => classify({ id: 1n, method: 'm', params: new CustomClass() }), TypeError);

    assert.throws(() => classify({ id: 1n, method: 'm', params: new Map() }), TypeError);
    assert.throws(() => classify({ id: 1n, method: 'm', params: new Set() }), TypeError);
    assert.throws(() => classify({ id: 1n, method: 'm', params: { s: Symbol('test') } }), TypeError);
    assert.throws(() => classify({ id: 1n, method: 'm', params: { u: undefined } }), TypeError);
  });

  it('matches exact Rust serde encoder golden strings', () => {
    const req = encodeRequest(1n, 'm', { n: 9.999999999999999e-6 });
    assert.equal(req, '{"id":1,"method":"m","params":{"n":9.999999999999999e-6}}');

    const err = encodeError(1n, { code: -1n, message: 'm', data: null });
    assert.equal(err, '{"error":{"code":-1,"data":null,"message":"m"},"id":1}');
  });

  it('sorts numeric object keys in lexicographical UTF-8 byte order and formats 1e16 to 1e+16', () => {
    const numKeys = encodeRequest(1n, 'm', { '2': 20, '10': 10 });
    assert.equal(numKeys, '{"id":1,"method":"m","params":{"10":10.0,"2":20.0}}');

    const thresholdFloat = encodeRequest(1n, 'm', { f: 1e16 });
    assert.equal(thresholdFloat, '{"id":1,"method":"m","params":{"f":1e+16}}');
  });

  it('ignores root primitives and root arrays per Rust classify contract', () => {
    const ignoredArr: IncomingMessage = classify([1, 2, 3]);
    assert.equal(ignoredArr.kind, 'ignored');

    const ignoredStr: IncomingMessage = classify('hello');
    assert.equal(ignoredStr.kind, 'ignored');

    const ignoredNull: IncomingMessage = classify(null);
    assert.equal(ignoredNull.kind, 'ignored');
  });
});
