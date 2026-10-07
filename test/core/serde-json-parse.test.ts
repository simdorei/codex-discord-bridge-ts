import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseSerdeValue } from '../../src/core/serde-json-parse.ts';
import { serializeSerdeValue } from '../../src/core/serde-json.ts';

function truncate(str: string, maxLen = 32): string {
  return str.length > maxLen ? `${str.slice(0, maxLen)}...[len=${str.length}]` : str;
}

interface AcceptedGolden {
  readonly input: string;
  readonly accepted: true;
  readonly serialized: string;
}

interface RejectedGolden {
  readonly input: string;
  readonly accepted: false;
  readonly error: string;
  readonly expectedError: typeof RangeError | typeof SyntaxError;
}

type EdgeGolden = AcceptedGolden | RejectedGolden;

const EDGE_GOLDENS: readonly EdgeGolden[] = [
  { input: '0', accepted: true, serialized: '0' },
  { input: '-0', accepted: true, serialized: '-0.0' },
  { input: '0.0', accepted: true, serialized: '0.0' },
  { input: '-0.0', accepted: true, serialized: '-0.0' },
  { input: '1', accepted: true, serialized: '1' },
  { input: '-1', accepted: true, serialized: '-1' },
  { input: '1.0', accepted: true, serialized: '1.0' },
  { input: '-1.0', accepted: true, serialized: '-1.0' },
  { input: '9223372036854775807', accepted: true, serialized: '9223372036854775807' },
  { input: '9223372036854775808', accepted: true, serialized: '9223372036854775808' },
  { input: '18446744073709551615', accepted: true, serialized: '18446744073709551615' },
  { input: '18446744073709551616', accepted: true, serialized: '1.8446744073709552e+19' },
  { input: '-9223372036854775808', accepted: true, serialized: '-9223372036854775808' },
  { input: '-9223372036854775809', accepted: true, serialized: '-9.223372036854776e+18' },
  { input: '-18446744073709551615', accepted: true, serialized: '-1.8446744073709552e+19' },
  { input: '184467440737095516160000000000000.125', accepted: true, serialized: '1.844674407370955e+32' },
  { input: '0.123456789012345678901234567890123456789', accepted: true, serialized: '0.12345678901234568' },
  { input: '9.999999999999999e-6', accepted: true, serialized: '0.00001' },
  { input: '9.999999999999977e-6', accepted: true, serialized: '9.999999999999975e-6' },
  { input: '0.000010000000000000003', accepted: true, serialized: '0.000010000000000000004' },
  { input: '1e-324', accepted: true, serialized: '0.0' },
  { input: '5e-324', accepted: true, serialized: '5e-324' },
  { input: '1e-999', accepted: true, serialized: '0.0' },
  { input: '-1e-999', accepted: true, serialized: '-0.0' },
  { input: '0e99999999999999999999', accepted: true, serialized: '0.0' },
  { input: '-0e99999999999999999999', accepted: true, serialized: '-0.0' },
  { input: '1e308', accepted: true, serialized: '1e+308' },
  { input: '1e309', accepted: false, error: 'number out of range', expectedError: RangeError },
  { input: '1e99999999999999999999', accepted: false, error: 'number out of range', expectedError: RangeError },
  { input: '01', accepted: false, error: 'invalid number', expectedError: SyntaxError },
  { input: '+1', accepted: false, error: 'expected value', expectedError: SyntaxError },
  { input: '1.', accepted: false, error: 'EOF while parsing a value', expectedError: SyntaxError },
  { input: '1e', accepted: false, error: 'EOF while parsing a value', expectedError: SyntaxError },
  { input: '1e+', accepted: false, error: 'EOF while parsing a value', expectedError: SyntaxError },
  { input: 'NaN', accepted: false, error: 'expected value', expectedError: SyntaxError },
  { input: 'Infinity', accepted: false, error: 'expected value', expectedError: SyntaxError },
  { input: '{"a":1e999,"a":1}', accepted: false, error: 'number out of range', expectedError: RangeError },
  { input: '{"a":1e-999,"a":1}', accepted: true, serialized: '{"a":1}' },
  { input: '{"a":1,"a":2}', accepted: true, serialized: '{"a":2}' },
  { input: '{"__proto__":{"x":1},"constructor":2}', accepted: true, serialized: '{"__proto__":{"x":1},"constructor":2}' },
  { input: '["text",true,null,9007199254740993,1.0,{"2":2,"10":10}]', accepted: true, serialized: '["text",true,null,9007199254740993,1.0,{"10":10,"2":2}]' },
  { input: '"\\ud800"', accepted: false, error: 'unexpected end of hex escape', expectedError: SyntaxError },
  { input: '"\\udc00"', accepted: false, error: 'lone leading surrogate in hex escape', expectedError: SyntaxError },
  { input: '"\\ud83d\\ude00"', accepted: true, serialized: '"😀"' },
  { input: '{"a":"\\ud800","a":"safe"}', accepted: false, error: 'unexpected end of hex escape', expectedError: SyntaxError },
  { input: '{"\\ud800":1,"a":2}', accepted: false, error: 'unexpected end of hex escape', expectedError: SyntaxError },
  { input: '"\\u0000\\n\\t"', accepted: true, serialized: '"\\u0000\\n\\t"' },
  { input: '"한국어 😀"', accepted: true, serialized: '"한국어 😀"' },
  { input: '["[[[[",0]', accepted: true, serialized: '["[[[[",0]' },
  { input: '['.repeat(126) + '0' + ']'.repeat(126), accepted: true, serialized: '['.repeat(126) + '0' + ']'.repeat(126) },
  { input: '['.repeat(127) + '0' + ']'.repeat(127), accepted: true, serialized: '['.repeat(127) + '0' + ']'.repeat(127) },
  { input: '['.repeat(128) + '0' + ']'.repeat(128), accepted: false, error: 'recursion limit exceeded', expectedError: SyntaxError },
  { input: '['.repeat(129) + '0' + ']'.repeat(129), accepted: false, error: 'recursion limit exceeded', expectedError: SyntaxError },
];

describe('parseSerdeValue parser test suite', () => {
  describe('53 pinned Rust serde_json 1.0.151 edge goldens', () => {
    EDGE_GOLDENS.forEach((tc, idx) => {
      const num = String(idx + 1).padStart(2, '0');
      const inputLabel = truncate(tc.input);
      const expectedLabel = tc.accepted ? truncate(tc.serialized) : tc.error;

      it(`golden #${num}: ${inputLabel} -> ${expectedLabel}`, () => {
        if (tc.accepted) {
          const parsed = parseSerdeValue(tc.input);
          const serialized = serializeSerdeValue(parsed);
          assert.equal(serialized, tc.serialized);
        } else {
          assert.throws(() => parseSerdeValue(tc.input), tc.expectedError);
        }
      });
    });
  });

  describe('integer i64/u64 vs Number float types (exact BigInt distinctions)', () => {
    it('distinguishes integer 0, negative zero -0, float 0.0, and float -0.0', () => {
      const valZero = parseSerdeValue('0');
      assert.equal(typeof valZero, 'bigint');
      assert.equal(valZero, 0n);

      const valNegZero = parseSerdeValue('-0');
      assert.equal(typeof valNegZero, 'number');
      assert.ok(Object.is(valNegZero, -0));

      const valFloatZero = parseSerdeValue('0.0');
      assert.equal(typeof valFloatZero, 'number');
      assert.ok(Object.is(valFloatZero, 0));

      const valNegFloatZero = parseSerdeValue('-0.0');
      assert.equal(typeof valNegFloatZero, 'number');
      assert.ok(Object.is(valNegFloatZero, -0));
    });

    it('distinguishes integer 1/-1 from float 1.0/-1.0', () => {
      const posInt = parseSerdeValue('1');
      assert.equal(typeof posInt, 'bigint');
      assert.equal(posInt, 1n);

      const negInt = parseSerdeValue('-1');
      assert.equal(typeof negInt, 'bigint');
      assert.equal(negInt, -1n);

      const posFloat = parseSerdeValue('1.0');
      assert.equal(typeof posFloat, 'number');
      assert.equal(posFloat, 1.0);

      const negFloat = parseSerdeValue('-1.0');
      assert.equal(typeof negFloat, 'number');
      assert.equal(negFloat, -1.0);
    });

    it('preserves exact integer values beyond Number.MAX_SAFE_INTEGER (2^53)', () => {
      const safePlusOne = parseSerdeValue('9007199254740993');
      assert.equal(typeof safePlusOne, 'bigint');
      assert.equal(safePlusOne, 9007199254740993n);
    });

    it('preserves full i64 and u64 bounds as BigInt', () => {
      const i64Max = parseSerdeValue('9223372036854775807');
      assert.equal(typeof i64Max, 'bigint');
      assert.equal(i64Max, 9223372036854775807n);

      const i64Min = parseSerdeValue('-9223372036854775808');
      assert.equal(typeof i64Min, 'bigint');
      assert.equal(i64Min, -9223372036854775808n);

      const aboveI64 = parseSerdeValue('9223372036854775808');
      assert.equal(typeof aboveI64, 'bigint');
      assert.equal(aboveI64, 9223372036854775808n);

      const u64Max = parseSerdeValue('18446744073709551615');
      assert.equal(typeof u64Max, 'bigint');
      assert.equal(u64Max, 18446744073709551615n);
    });

    it('falls back to f64 Number when integers exceed u64::MAX or fall below i64::MIN', () => {
      const u64Overflow = parseSerdeValue('18446744073709551616');
      assert.equal(typeof u64Overflow, 'number');
      assert.equal(serializeSerdeValue(u64Overflow), '1.8446744073709552e+19');

      const i64Underflow = parseSerdeValue('-9223372036854775809');
      assert.equal(typeof i64Underflow, 'number');
      assert.equal(serializeSerdeValue(i64Underflow), '-9.223372036854776e+18');

      const negU64 = parseSerdeValue('-18446744073709551615');
      assert.equal(typeof negU64, 'number');
      assert.equal(serializeSerdeValue(negU64), '-1.8446744073709552e+19');
    });
  });

  describe('default Rust decimal rounding and fraction truncation', () => {
    it('truncates fractional digits on large integer part overflow', () => {
      const val = parseSerdeValue('184467440737095516160000000000000.125');
      assert.equal(typeof val, 'number');
      assert.equal(serializeSerdeValue(val), '1.844674407370955e+32');
    });

    it('matches default Rust float rounding on long decimal fractions', () => {
      const longDec = parseSerdeValue('0.123456789012345678901234567890123456789');
      assert.equal(typeof longDec, 'number');
      assert.equal(serializeSerdeValue(longDec), '0.12345678901234568');

      const nearZero1 = parseSerdeValue('9.999999999999999e-6');
      assert.equal(typeof nearZero1, 'number');
      assert.equal(serializeSerdeValue(nearZero1), '0.00001');

      const nearZero2 = parseSerdeValue('9.999999999999977e-6');
      assert.equal(typeof nearZero2, 'number');
      assert.equal(serializeSerdeValue(nearZero2), '9.999999999999975e-6');

      const nearZero3 = parseSerdeValue('0.000010000000000000003');
      assert.equal(typeof nearZero3, 'number');
      assert.equal(serializeSerdeValue(nearZero3), '0.000010000000000000004');
    });
  });

  describe('long exponent overflow/underflow, zero significand, and signed zero', () => {
    it('underflows subnormals to zero or preserves minimum subnormal float', () => {
      const zeroSubnormal = parseSerdeValue('1e-324');
      assert.equal(typeof zeroSubnormal, 'number');
      assert.equal(serializeSerdeValue(zeroSubnormal), '0.0');

      const minSubnormal = parseSerdeValue('5e-324');
      assert.equal(typeof minSubnormal, 'number');
      assert.equal(serializeSerdeValue(minSubnormal), '5e-324');
    });

    it('underflows extreme negative exponents to signed zero', () => {
      const posUnder = parseSerdeValue('1e-999');
      assert.equal(typeof posUnder, 'number');
      assert.ok(Object.is(posUnder, 0));
      assert.equal(serializeSerdeValue(posUnder), '0.0');

      const negUnder = parseSerdeValue('-1e-999');
      assert.equal(typeof negUnder, 'number');
      assert.ok(Object.is(negUnder, -0));
      assert.equal(serializeSerdeValue(negUnder), '-0.0');
    });

    it('preserves zero with large exponents without overflow', () => {
      const posZeroExp = parseSerdeValue('0e99999999999999999999');
      assert.equal(typeof posZeroExp, 'number');
      assert.ok(Object.is(posZeroExp, 0));
      assert.equal(serializeSerdeValue(posZeroExp), '0.0');

      const negZeroExp = parseSerdeValue('-0e99999999999999999999');
      assert.equal(typeof negZeroExp, 'number');
      assert.ok(Object.is(negZeroExp, -0));
      assert.equal(serializeSerdeValue(negZeroExp), '-0.0');
    });

    it('accepts 1e308 and throws RangeError on positive exponent overflow', () => {
      const maxExp = parseSerdeValue('1e308');
      assert.equal(typeof maxExp, 'number');
      assert.equal(serializeSerdeValue(maxExp), '1e+308');

      assert.throws(() => parseSerdeValue('1e309'), RangeError);
      assert.throws(() => parseSerdeValue('1e99999999999999999999'), RangeError);
    });
  });

  describe('duplicate keys: pre-scan rejection vs valid overwrite', () => {
    it('refuses invalid numbers or surrogates even if overwritten by subsequent key', () => {
      assert.throws(() => parseSerdeValue('{"a":1e999,"a":1}'), RangeError);
      assert.throws(() => parseSerdeValue('{"a":"\\ud800","a":"safe"}'), SyntaxError);
      assert.throws(() => parseSerdeValue('{"\\ud800":1,"a":2}'), SyntaxError);
    });

    it('applies last-wins semantics when duplicate keys contain valid values', () => {
      const underflowDup = parseSerdeValue<Record<string, unknown>>('{"a":1e-999,"a":1}');
      assert.equal(serializeSerdeValue(underflowDup), '{"a":1}');
      assert.equal(underflowDup['a'], 1n);

      const intDup = parseSerdeValue<Record<string, unknown>>('{"a":1,"a":2}');
      assert.equal(serializeSerdeValue(intDup), '{"a":2}');
      assert.equal(intDup['a'], 2n);
    });
  });

  describe('prototype pollution prevention (__proto__ and constructor)', () => {
    it('treats __proto__ and constructor as plain own properties without polluting Object.prototype', () => {
      const json = '{"__proto__":{"x":1},"constructor":2}';
      const parsed = parseSerdeValue<Record<string, unknown>>(json);

      const unpolluted: Record<string, unknown> = {};
      assert.equal(unpolluted['x'], undefined);

      assert.ok(Object.prototype.hasOwnProperty.call(parsed, '__proto__'));
      assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'constructor'));
      assert.equal(serializeSerdeValue(parsed), '{"__proto__":{"x":1},"constructor":2}');
    });
  });

  describe('recursion depth limit and string bracket isolation', () => {
    it('allows nesting depth of 126 and 127', () => {
      const depth126 = '['.repeat(126) + '0' + ']'.repeat(126);
      assert.equal(serializeSerdeValue(parseSerdeValue(depth126)), depth126);

      const depth127 = '['.repeat(127) + '0' + ']'.repeat(127);
      assert.equal(serializeSerdeValue(parseSerdeValue(depth127)), depth127);
    });

    it('rejects nesting depth of 128 and 129 with SyntaxError', () => {
      const depth128 = '['.repeat(128) + '0' + ']'.repeat(128);
      assert.throws(() => parseSerdeValue(depth128), SyntaxError);

      const depth129 = '['.repeat(129) + '0' + ']'.repeat(129);
      assert.throws(() => parseSerdeValue(depth129), SyntaxError);
    });

    it('ignores bracket characters inside string tokens when tracking depth', () => {
      const input = '["[[[[",0]';
      const parsed = parseSerdeValue<[string, bigint]>(input);
      assert.equal(parsed[0], '[[[[');
      assert.equal(parsed[1], 0n);
      assert.equal(serializeSerdeValue(parsed), input);
    });
  });

  describe('Unicode string handling and surrogate validation', () => {
    it('accepts valid astral Unicode surrogate pairs, control chars, and non-ASCII', () => {
      assert.equal(serializeSerdeValue(parseSerdeValue('"\\ud83d\\ude00"')), '"😀"');
      assert.equal(serializeSerdeValue(parseSerdeValue('"\\u0000\\n\\t"')), '"\\u0000\\n\\t"');
      assert.equal(serializeSerdeValue(parseSerdeValue('"한국어 😀"')), '"한국어 😀"');
    });

    it('rejects lone UTF-16 surrogates with SyntaxError', () => {
      assert.throws(() => parseSerdeValue('"\\ud800"'), SyntaxError);
      assert.throws(() => parseSerdeValue('"\\udc00"'), SyntaxError);
    });
  });

  describe('root primitives and empty containers', () => {
    it('parses null, booleans, root string, empty object, and empty array', () => {
      assert.equal(serializeSerdeValue(parseSerdeValue('null')), 'null');
      assert.equal(serializeSerdeValue(parseSerdeValue('true')), 'true');
      assert.equal(serializeSerdeValue(parseSerdeValue('false')), 'false');
      assert.equal(serializeSerdeValue(parseSerdeValue('"hello"')), '"hello"');
      assert.equal(serializeSerdeValue(parseSerdeValue('[]')), '[]');
      assert.equal(serializeSerdeValue(parseSerdeValue('{}')), '{}');
    });
  });

  describe('invalid JSON grammar, Unicode whitespace, and trailing junk', () => {
    it('rejects invalid JSON grammar with SyntaxError', () => {
      const invalidGrammar: readonly string[] = [
        '01',
        '+1',
        '1.',
        '1e',
        '1e+',
        'NaN',
        'Infinity',
        '{"a":1,}',
        '[1, 2,]',
        '{a: 1}',
      ];
      for (const item of invalidGrammar) {
        assert.throws(() => parseSerdeValue(item), SyntaxError);
      }
    });

    it('rejects BOM, NBSP outside strings, and trailing characters with SyntaxError', () => {
      assert.throws(() => parseSerdeValue(String.fromCodePoint(0xfeff)+"{}"), SyntaxError);
      assert.throws(() => parseSerdeValue(" "+String.fromCodePoint(0x00a0)+" 123"), SyntaxError);
      assert.throws(() => parseSerdeValue('123 trailing'), SyntaxError);
      assert.throws(() => parseSerdeValue('{"a":1} junk'), SyntaxError);
      assert.throws(() => parseSerdeValue('[1, 2] 3'), SyntaxError);
    });
  });

  describe('runtime type check for non-string input', () => {
    it('rejects non-string input at runtime with TypeError', () => {
      const nonStrings: readonly unknown[] = [
        123,
        null,
        undefined,
        {},
        [],
        true,
        false,
        Symbol('serde'),
        () => {},
      ];
      for (const item of nonStrings) {
        assert.throws(() => parseSerdeValue(item as unknown as string), TypeError);
      }
    });
  });

  describe('mixed nested baseline array roundtrip with UTF-8 key sorting', () => {
    it('roundtrips mixed types and sorts object keys canonically', () => {
      const input = '["text",true,null,9007199254740993,1.0,{"2":2,"10":10}]';
      const parsed = parseSerdeValue<[string, boolean, null, bigint, number, Record<string, bigint>]>(input);

      assert.equal(parsed[0], 'text');
      assert.equal(parsed[1], true);
      assert.equal(parsed[2], null);
      assert.equal(typeof parsed[3], 'bigint');
      assert.equal(parsed[3], 9007199254740993n);
      assert.equal(typeof parsed[4], 'number');
      assert.equal(parsed[4], 1.0);

      const serialized = serializeSerdeValue(parsed);
      assert.equal(serialized, '["text",true,null,9007199254740993,1.0,{"10":10,"2":2}]');
    });
  });
});
