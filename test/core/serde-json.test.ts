import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { serializeSerdeValue, toCanonicalJson, sha256SerdeValue } from '../../src/core/serde-json.ts';
import { I64_MIN, I64_MAX, U64_MAX } from '../../src/protocol/ids.ts';

describe('serde-json canonical encoding', () => {
  it('group 1: Rust goldens 1 to 9 (f64 numbers and zmij oracle formatting)', () => {
    const fixtures: Array<{ val: number; serialized: string; sha256: string }> = [
      {
        val: 0,
        serialized: '0.0',
        sha256: '8aed642bf5118b9d3c859bd4be35ecac75b6e873cce34e7b6f554b06f75550d7',
      },
      {
        val: -0,
        serialized: '-0.0',
        sha256: 'c26617c7ccbcaa6631b45d851b8cf56e21d2ca624bdb1193afdbd4b560702cec',
      },
      {
        val: 0.000001,
        serialized: '1e-6',
        sha256: 'f465f55ffed8578e62d598c801779430834a6a908a7b2d25b4b6e9cb1e65b68d',
      },
      {
        val: 0.00001,
        serialized: '0.00001',
        sha256: '661710915adfa7c40b5dbd6b2122dfa65b1accb57a8b7cdee05423ecfe14b0c7',
      },
      {
        val: 1000000000000000,
        serialized: '1000000000000000.0',
        sha256: 'c02731631f61648f06ba5501a9c68e2b0a9186a934ff45f40ab28eb6f3673021',
      },
      {
        val: 10000000000000000,
        serialized: '1e+16',
        sha256: 'a144838520595009e7daf5aff8472573f9ce6a4bcd8c30673675618883464ab0',
      },
      {
        val: 1e21,
        serialized: '1e+21',
        sha256: '241c4643fa70b1dcde1205b71be4e3bebb17e9f880c8e1a33d0ead6c27271d3c',
      },
      {
        val: 5e-324,
        serialized: '5e-324',
        sha256: 'c46e7ca1be4c8734f373a56530787288fa2058d73d07855e9247e949f811a42a',
      },
      {
        val: 1.7976931348623157e308,
        serialized: '1.7976931348623157e+308',
        sha256: 'c2784e1abd6317452708f3fbf9641c16b959561bc621a1d408c23a20aa2cb585',
      },
    ];

    for (const { val, serialized, sha256 } of fixtures) {
      assert.equal(serializeSerdeValue(val), serialized);
      assert.equal(sha256SerdeValue(val), sha256);
    }
  });

  it('group 2: Rust golden 10 (numeric keys, float 1.0, bigint > 2^53, nested object)', () => {
    const input = {
      '2': 2n,
      '10': 10n,
      z: { b: 2n, a: 1n },
      id: 9007199254740993n,
      f: 1.0,
    };
    const expectedSerialized = '{"10":10,"2":2,"f":1.0,"id":9007199254740993,"z":{"a":1,"b":2}}';
    const expectedSha256 = '23ef518ed45170de2d7918e7bac16f9e3acdbbfdae3a0707cce7cba63ee7e465';

    assert.equal(serializeSerdeValue(input), expectedSerialized);
    assert.equal(sha256SerdeValue(input), expectedSha256);
  });

  it('group 3: Rust golden 11 (Unicode BMP U+E000 before supplementary U+10000)', () => {
    const input = {
      '\ue000': 1n,
      '\ud800\udc00': 2n,
      ascii: 3n,
    };
    const expectedSerialized = '{"ascii":3,"\ue000":1,"\ud800\udc00":2}';
    const expectedSha256 = '2ec247be634c6952ad09fd4f6fd15c1f3d6d10fc828cf02ea03cf9d39c4f9f5b';

    assert.equal(serializeSerdeValue(input), expectedSerialized);
    assert.equal(sha256SerdeValue(input), expectedSha256);
  });

  it('group 4: Rust golden 12 (null, control escapes, u64 max, i64 min)', () => {
    const input = {
      null: null,
      quoted: 'a\n\u0000\t"',
      u64: 18446744073709551615n,
      i64: -9223372036854775808n,
    };
    const expectedSerialized =
      '{"i64":-9223372036854775808,"null":null,"quoted":"a\\n\\u0000\\t\\"","u64":18446744073709551615}';
    const expectedSha256 = '41269f190f39f7e69f8eb78b649d5c99f27e44f0dfe81198467c5904801b010c';

    assert.equal(serializeSerdeValue(input), expectedSerialized);
    assert.equal(sha256SerdeValue(input), expectedSha256);
  });

  it('group 5: top-level exclusions removed, nested exclusions retained, input unchanged', () => {
    const original = {
      z: { b: 2n, a: 1n, secret: 99n },
      secret: 3n,
      a: '한글',
    };
    const inputSnapshot = JSON.stringify(original, (_, v) => (typeof v === 'bigint' ? v.toString() : v));

    const canonical = toCanonicalJson(original, ['secret']);
    assert.equal(canonical, '{"a":"한글","z":{"a":1,"b":2,"secret":99}}');

    const afterSnapshot = JSON.stringify(original, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
    assert.equal(afterSnapshot, inputSnapshot);
  });

  it('group 6: numeric-looking keys UTF-8 order differs from JS integer insertion order', () => {
    const obj: Record<string, bigint> = {};
    obj['2'] = 2n;
    obj['10'] = 10n;
    obj['100'] = 100n;
    obj['20'] = 20n;
    obj['01'] = 1n;

    const serialized = serializeSerdeValue(obj);
    assert.equal(serialized, '{"01":1,"10":10,"100":100,"2":2,"20":20}');
  });

  it('group 7: Unicode BMP vs Supplementary plane UTF-8 ordering opposite of UTF-16 code units', () => {
    const obj = {
      '\ud800\udc00': 'supplementary',
      '\ue000': 'bmp',
    };
    const serialized = serializeSerdeValue(obj);
    assert.equal(serialized, '{"\ue000":"bmp","\ud800\udc00":"supplementary"}');
  });

  it('group 8: arrays keep order and shared acyclic references are allowed', () => {
    const arr = [3n, 1n, 2n];
    assert.equal(serializeSerdeValue(arr), '[3,1,2]');

    const shared = { node: 'leaf', value: 42n };
    const root = {
      left: shared,
      right: shared,
    };
    assert.equal(serializeSerdeValue(root), '{"left":{"node":"leaf","value":42},"right":{"node":"leaf","value":42}}');
  });

  it('group 9: cyclic object and cyclic array references are rejected', () => {
    const cyclicObj: Record<string, unknown> = {};
    cyclicObj.self = cyclicObj;
    assert.throws(() => serializeSerdeValue(cyclicObj), TypeError);

    const cyclicArr: unknown[] = [];
    cyclicArr.push(cyclicArr);
    assert.throws(() => serializeSerdeValue(cyclicArr), TypeError);

    const a: Record<string, unknown> = {};
    const b: Record<string, unknown> = { a };
    a.b = b;
    assert.throws(() => serializeSerdeValue(a), TypeError);
  });

  it('group 10: undefined, functions, and symbols rejected at root, in object, in array, and as symbol keys', () => {
    assert.throws(() => serializeSerdeValue(undefined), TypeError);
    assert.throws(() => serializeSerdeValue(() => {}), TypeError);
    assert.throws(() => serializeSerdeValue(Symbol('test')), TypeError);

    assert.throws(() => serializeSerdeValue({ bad: undefined }), TypeError);
    assert.throws(() => serializeSerdeValue({ bad: () => {} }), TypeError);
    assert.throws(() => serializeSerdeValue({ bad: Symbol('prop') }), TypeError);
    assert.throws(() => serializeSerdeValue({ [Symbol('symKey')]: 1n }), TypeError);

    assert.throws(() => serializeSerdeValue([undefined]), TypeError);
    assert.throws(() => serializeSerdeValue([() => {}]), TypeError);
    assert.throws(() => serializeSerdeValue([Symbol('elem')]), TypeError);

    assert.throws(() => toCanonicalJson({ secret: undefined }, ['secret']), TypeError);
    assert.throws(() => toCanonicalJson({ secret: NaN }, ['secret']), TypeError);
    assert.throws(() => toCanonicalJson({ secret: Infinity }, ['secret']), TypeError);
    assert.throws(() => toCanonicalJson({ secret: U64_MAX + 1n }, ['secret']), RangeError);
    assert.throws(() => toCanonicalJson({ secret: I64_MIN - 1n }, ['secret']), RangeError);

    const cyclicObj: Record<string, unknown> = { a: 1n };
    cyclicObj.secret = cyclicObj;
    assert.throws(() => toCanonicalJson(cyclicObj, ['secret']), TypeError);

    const cyclicSubtree: Record<string, unknown> = {};
    cyclicSubtree.self = cyclicSubtree;
    assert.throws(() => toCanonicalJson({ secret: cyclicSubtree }, ['secret']), TypeError);

    const validExcluded = {
      a: 1n,
      secret: { nested: 'value', count: 42n },
    };
    assert.equal(toCanonicalJson(validExcluded, ['secret']), '{"a":1}');
  });

  it('group 11: getters rejected on plain objects and arrays without executing getter function', () => {
    let getterExecuted = false;
    const obj = {};
    Object.defineProperty(obj, 'trap', {
      get() {
        getterExecuted = true;
        return 'triggered';
      },
      enumerable: true,
    });
    assert.throws(() => serializeSerdeValue(obj), TypeError);
    assert.equal(getterExecuted, false);

    let arrayGetterExecuted = false;
    const arr = [1n];
    Object.defineProperty(arr, '0', {
      get() {
        arrayGetterExecuted = true;
        return 1n;
      },
      enumerable: true,
    });
    assert.throws(() => serializeSerdeValue(arr), TypeError);
    assert.equal(arrayGetterExecuted, false);
  });

  it('group 12: non-plain class instances rejected, null prototype allowed', () => {
    assert.throws(() => serializeSerdeValue(new Date()), TypeError);
    assert.throws(() => serializeSerdeValue(new RegExp('^test$')), TypeError);
    assert.throws(() => serializeSerdeValue(new Map()), TypeError);
    assert.throws(() => serializeSerdeValue(new Set()), TypeError);
    assert.throws(() => serializeSerdeValue(new Error('err')), TypeError);
    assert.throws(() => serializeSerdeValue(new Number(1)), TypeError);
    assert.throws(() => serializeSerdeValue(new String('s')), TypeError);
    assert.throws(() => serializeSerdeValue(new Boolean(true)), TypeError);

    class CustomClass {
      val = 10n;
    }
    assert.throws(() => serializeSerdeValue(new CustomClass()), TypeError);

    const nullProto = Object.create(null);
    nullProto.prop = 'valid';
    assert.equal(serializeSerdeValue(nullProto), '{"prop":"valid"}');
  });

  it('group 13: sparse arrays and arrays with non-index properties rejected', () => {
    const sparse1 = new Array(3);
    assert.throws(() => serializeSerdeValue(sparse1), TypeError);

    const sparse2 = [1n, , 3n];
    assert.throws(() => serializeSerdeValue(sparse2), TypeError);

    const extraPropArr = [1n, 2n];
    (extraPropArr as unknown as { extra: string }).extra = 'not-allowed';
    assert.throws(() => serializeSerdeValue(extraPropArr), TypeError);
  });

  it('group 14: malformed Unicode lone surrogates rejected in strings and object keys', () => {
    assert.throws(() => serializeSerdeValue('\ud800'), TypeError);
    assert.throws(() => serializeSerdeValue('\udc00'), TypeError);
    assert.throws(() => serializeSerdeValue('bad\ud800end'), TypeError);
    assert.throws(() => serializeSerdeValue({ ['\ud800']: 'val' }), TypeError);
  });

  it('group 15: non-finite numbers (NaN, Infinity, -Infinity) rejected', () => {
    assert.throws(() => serializeSerdeValue(NaN), TypeError);
    assert.throws(() => serializeSerdeValue(Infinity), TypeError);
    assert.throws(() => serializeSerdeValue(-Infinity), TypeError);
    assert.throws(() => serializeSerdeValue({ num: NaN }), TypeError);
  });

  it('group 16: BigInt integer bounds (-i64..u64 inclusive accepted, out-of-range rejected)', () => {
    assert.equal(serializeSerdeValue(I64_MIN), '-9223372036854775808');
    assert.equal(serializeSerdeValue(0n), '0');
    assert.equal(serializeSerdeValue(I64_MAX), '9223372036854775807');
    assert.equal(serializeSerdeValue(U64_MAX), '18446744073709551615');

    assert.throws(() => serializeSerdeValue(I64_MIN - 1n), RangeError);
    assert.throws(() => serializeSerdeValue(U64_MAX + 1n), RangeError);
  });
});
