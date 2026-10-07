import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  validateRequestId,
  requestIdEquals,
  requestIdKey,
  parseLosslessJson,
  stringifyLosslessJson,
  serializeRequestId,
  ServerRequestOccurrence,
  parseDiscordU64,
  discordIdToI64,
  mapDiscordCustodyIds,
  I64_MIN,
  I64_MAX,
  U64_MAX,
} from '../../src/protocol/ids.ts';
import type { DiscordCustodyInput } from '../../src/protocol/ids.ts';

describe('RequestId', () => {
  it('validates string and bigint within i64 range', () => {
    assert.equal(validateRequestId('req-123'), 'req-123');
    assert.equal(validateRequestId(''), '');
    assert.equal(validateRequestId('escaped\n\t"quote"'), 'escaped\n\t"quote"');
    assert.equal(validateRequestId('non-bmp-\u{1F600}'), 'non-bmp-\u{1F600}');
    assert.equal(validateRequestId(0n), 0n);
    assert.equal(validateRequestId(I64_MIN), I64_MIN);
    assert.equal(validateRequestId(I64_MAX), I64_MAX);
    assert.equal(validateRequestId(9007199254740993n), 9007199254740993n);
  });

  it('rejects bigint outside i64 range', () => {
    assert.throws(() => validateRequestId(I64_MAX + 1n), RangeError);
    assert.throws(() => validateRequestId(I64_MIN - 1n), RangeError);
  });

  it('rejects JavaScript numbers and non-ID types', () => {
    assert.throws(() => validateRequestId(7), TypeError);
    assert.throws(() => validateRequestId(1.0), TypeError);
    assert.throws(() => validateRequestId(1e0), TypeError);
    assert.throws(() => validateRequestId(9007199254740993), TypeError);
    assert.throws(() => validateRequestId(NaN), TypeError);
    assert.throws(() => validateRequestId(-0), TypeError);
    assert.throws(() => validateRequestId(Infinity), TypeError);
    assert.throws(() => validateRequestId(-Infinity), TypeError);
    assert.throws(() => validateRequestId(null), TypeError);
    assert.throws(() => validateRequestId(undefined), TypeError);
    assert.throws(() => validateRequestId(true), TypeError);
    assert.throws(() => validateRequestId(false), TypeError);
    assert.throws(() => validateRequestId({}), TypeError);
    assert.throws(() => validateRequestId([]), TypeError);
  });

  it('separates integer and string representation in equality and keys', () => {
    assert.equal(requestIdEquals(7n, '7'), false);
    assert.equal(requestIdEquals(7n, 7n), true);
    assert.equal(requestIdEquals('7', '7'), true);
    assert.notEqual(requestIdKey(7n), requestIdKey('7'));
    assert.equal(requestIdKey(7n), 'i:7');
    assert.equal(requestIdKey('7'), 's:7');
  });

  it('validates input IDs in requestIdKey and requestIdEquals against caller forged keys', () => {
    assert.throws(() => requestIdKey(I64_MAX + 1n as unknown as string), RangeError);
    assert.throws(() => requestIdKey(I64_MIN - 1n as unknown as string), RangeError);
    assert.throws(() => requestIdKey(7 as unknown as string), TypeError);
    assert.throws(() => requestIdKey(null as unknown as string), TypeError);

    assert.throws(() => requestIdEquals(I64_MAX + 1n as unknown as bigint, 7n), RangeError);
    assert.throws(() => requestIdEquals(7n, I64_MAX + 1n as unknown as bigint), RangeError);
    assert.throws(() => requestIdEquals(I64_MIN - 1n as unknown as bigint, 7n), RangeError);
    assert.throws(() => requestIdEquals(7 as unknown as bigint, 7n), TypeError);
    assert.throws(() => requestIdEquals(7n, 7 as unknown as bigint), TypeError);
  });

  it('serializes RequestId and validates i64 bounds and escapes', () => {
    assert.equal(serializeRequestId('req-1'), '"req-1"');
    assert.equal(serializeRequestId('non-bmp-\u{1F600}'), '"non-bmp-\u{1F600}"');
    assert.equal(serializeRequestId(7n), '7');
    assert.equal(serializeRequestId(0n), '0');
    assert.equal(serializeRequestId(I64_MIN), '-9223372036854775808');
    assert.equal(serializeRequestId(I64_MAX), '9223372036854775807');
    assert.equal(serializeRequestId(9007199254740993n), '9007199254740993');

    assert.throws(() => serializeRequestId(I64_MAX + 1n), RangeError);
    assert.throws(() => serializeRequestId(I64_MIN - 1n), RangeError);
    assert.throws(() => serializeRequestId(7 as unknown as bigint), TypeError);
  });
});

describe('Lossless JSON', () => {
  it('preserves canonical integers as bigint before rounding', () => {
    const parsed = parseLosslessJson<{ id: bigint }>('{"id":9007199254740993}');
    assert.equal(typeof parsed.id, 'bigint');
    assert.equal(parsed.id, 9007199254740993n);
  });

  it('preserves -0 as float and parses floats/exponents as numbers', () => {
    const parsed = parseLosslessJson<{ negZero: number; floatVal: number; expVal: number }>(
      '{"negZero":-0,"floatVal":1.0,"expVal":1e0}'
    );
    assert.ok(Object.is(parsed.negZero, -0));
    assert.equal(typeof parsed.floatVal, 'number');
    assert.equal(typeof parsed.expVal, 'number');
    assert.throws(() => validateRequestId(parsed.floatVal), TypeError);
    assert.throws(() => validateRequestId(parsed.expVal), TypeError);
  });

  it('handles compound nested bigints and serializes losslessly', () => {
    const data = {
      id: 9007199254740993n,
      i64Max: I64_MAX,
      i64Min: I64_MIN,
      msg: 'hello "world" \u{1F600}',
      nested: { count: 42n, ratio: 2.5 },
    };
    const json = stringifyLosslessJson(data);
    assert.ok(json.includes('9007199254740993'));
    assert.ok(json.includes('9223372036854775807'));
    assert.ok(json.includes('-9223372036854775808'));
    const roundtrip = parseLosslessJson<typeof data>(json);
    assert.equal(roundtrip.id, 9007199254740993n);
    assert.equal(roundtrip.i64Max, I64_MAX);
    assert.equal(roundtrip.i64Min, I64_MIN);
    assert.equal(roundtrip.nested.count, 42n);
    assert.equal(roundtrip.nested.ratio, 2.5);
  });

  it('retains floating numeric kinds on serialization and prevents float to integer conversion', () => {
    const data = {
      integralFloat: 1.0,
      negZero: -0,
      expFloat: 1e20,
      fracFloat: 2.5,
    };
    const json = stringifyLosslessJson(data);
    assert.ok(json.includes('"integralFloat":1.0'));
    assert.ok(json.includes('"negZero":-0.0'));
    assert.ok(!json.includes('1e20.0'));
    assert.ok(!json.includes('1e+20.0'));

    const roundtrip = parseLosslessJson<typeof data>(json);
    assert.equal(typeof roundtrip.integralFloat, 'number');
    assert.equal(roundtrip.integralFloat, 1.0);
    assert.equal(typeof roundtrip.negZero, 'number');
    assert.ok(Object.is(roundtrip.negZero, -0));
    assert.equal(typeof roundtrip.expFloat, 'number');
    assert.equal(roundtrip.expFloat, 1e20);
    assert.equal(typeof roundtrip.fracFloat, 'number');
    assert.equal(roundtrip.fracFloat, 2.5);
  });

  it('enforces serde_json range for bigint serialization', () => {
    assert.equal(stringifyLosslessJson(U64_MAX), '18446744073709551615');
    assert.equal(stringifyLosslessJson(I64_MIN), '-9223372036854775808');
    assert.throws(() => stringifyLosslessJson(U64_MAX + 1n), RangeError);
    assert.throws(() => stringifyLosslessJson(I64_MIN - 1n), RangeError);
  });

  it('parses u64 boundaries into bigint and out-of-range tokens into f64 numbers', () => {
    const u64MaxParsed = parseLosslessJson<bigint>('18446744073709551615');
    assert.equal(typeof u64MaxParsed, 'bigint');
    assert.equal(u64MaxParsed, U64_MAX);

    const i64MinParsed = parseLosslessJson<bigint>('-9223372036854775808');
    assert.equal(typeof i64MinParsed, 'bigint');
    assert.equal(i64MinParsed, I64_MIN);

    const overU64 = parseLosslessJson<number>('18446744073709551616');

    assert.equal(typeof overU64, 'number');
    assert.throws(() => validateRequestId(overU64), TypeError);

    const underI64 = parseLosslessJson<number>('-9223372036854775809');
    assert.equal(typeof underI64, 'number');
    assert.throws(() => validateRequestId(underI64), TypeError);
  });

  it('rejects nonfinite numbers on parsing', () => {
    assert.throws(() => parseLosslessJson('1e400'), SyntaxError);
    assert.throws(() => parseLosslessJson('-1e400'), SyntaxError);
    assert.throws(() => parseLosslessJson('{"val":1e400}'), SyntaxError);
    assert.throws(() => parseLosslessJson('[1e400]'), SyntaxError);
  });

  it('rejects unsupported types and nonfinite numbers on stringification', () => {
    assert.throws(() => stringifyLosslessJson(undefined), TypeError);
    assert.throws(() => stringifyLosslessJson(() => {}), TypeError);
    assert.throws(() => stringifyLosslessJson(Symbol('sym')), TypeError);

    assert.throws(() => stringifyLosslessJson({ val: undefined }), TypeError);
    assert.throws(() => stringifyLosslessJson({ fn: () => {} }), TypeError);
    assert.throws(() => stringifyLosslessJson({ sym: Symbol('s') }), TypeError);

    assert.throws(() => stringifyLosslessJson([undefined]), TypeError);
    assert.throws(() => stringifyLosslessJson([() => {}]), TypeError);
    assert.throws(() => stringifyLosslessJson([Symbol('s')]), TypeError);

    assert.throws(() => stringifyLosslessJson(NaN), TypeError);
    assert.throws(() => stringifyLosslessJson(Infinity), TypeError);
    assert.throws(() => stringifyLosslessJson(-Infinity), TypeError);
    assert.throws(() => stringifyLosslessJson({ n: NaN }), TypeError);
    assert.throws(() => stringifyLosslessJson([Infinity]), TypeError);
  });

  it('preserves native JSON parsing for syntax, duplicates, escapes, and prototype pollution immunity', () => {
    assert.throws(() => parseLosslessJson('{malformed'), SyntaxError);

    const dup = parseLosslessJson<{ a: number }>('{"a":1,"a":2}');
    assert.equal(dup.a, 2n);

    const parsedProto = parseLosslessJson<{ __proto__: { polluted: boolean } }>('{"__proto__":{"polluted":true}}');
    assert.ok(parsedProto);
    assert.equal(Object.prototype.hasOwnProperty('polluted'), false);
    assert.equal((({} as Record<string, unknown>).polluted), undefined);
  });
});

describe('ServerRequestOccurrence', () => {
  it('enforces exact 16 bytes and copies to prevent caller mutation', () => {
    const raw = new Uint8Array(16).fill(1);
    const occ = ServerRequestOccurrence.fromBytes(raw);
    raw[0] = 99;
    assert.equal(occ.asBytes()[0], 1);

    const out = occ.asBytes();
    out[0] = 42;
    assert.equal(occ.asBytes()[0], 1);

    assert.throws(() => ServerRequestOccurrence.fromBytes(new Uint8Array(15)), RangeError);
    assert.throws(() => ServerRequestOccurrence.fromBytes(new Uint8Array(17)), RangeError);
    assert.throws(() => ServerRequestOccurrence.fromBytes(new Uint8Array(0)), RangeError);
  });

  it('accepts Buffer of exactly 16 bytes as Uint8Array subclass', () => {
    const buf = Buffer.alloc(16, 7);
    const occ = ServerRequestOccurrence.fromBytes(buf);
    assert.equal(occ.asBytes()[0], 7);
  });

  it('rejects runtime non-Uint8Array inputs including ArrayLike and wrapped values', () => {
    const arrayLike = Array.from({ length: 16 }, () => 1);
    assert.throws(() => ServerRequestOccurrence.fromBytes(arrayLike as unknown as Uint8Array), TypeError);

    const fractional = [1.5, 2.5, 3.5, 4.5, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
    assert.throws(() => ServerRequestOccurrence.fromBytes(fractional as unknown as Uint8Array), TypeError);

    const wrapped = { 0: 1, length: 16 };
    assert.throws(() => ServerRequestOccurrence.fromBytes(wrapped as unknown as Uint8Array), TypeError);

    assert.throws(() => ServerRequestOccurrence.fromBytes(null as unknown as Uint8Array), TypeError);
    assert.throws(() => ServerRequestOccurrence.fromBytes(undefined as unknown as Uint8Array), TypeError);
    assert.throws(() => ServerRequestOccurrence.fromBytes('0123456789abcdef' as unknown as Uint8Array), TypeError);
  });

  it('generates fresh v4 UUID bytes independent of wire ID with index guards', () => {
    const occ1 = ServerRequestOccurrence.random();
    const occ2 = ServerRequestOccurrence.random();
    const b1 = occ1.asBytes();
    const b2 = occ2.asBytes();
    assert.equal(b1.length, 16);
    assert.equal(b2.length, 16);
    assert.notDeepEqual(b1, b2);

    const byte6 = b1[6];
    const byte8 = b1[8];
    if (byte6 === undefined || byte8 === undefined) {
      assert.fail('UUID byte indices 6 and 8 must be defined');
    }
    assert.equal(byte6 >> 4, 4);
    assert.equal(byte8 >> 6, 2);
  });

  it('tests equality comprehensively across instances and invalid types', () => {
    const bytesA = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    const bytesB = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    const bytesC = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16]);

    const occA = ServerRequestOccurrence.fromBytes(bytesA);
    const occB = ServerRequestOccurrence.fromBytes(bytesB);
    const occC = ServerRequestOccurrence.fromBytes(bytesC);

    assert.ok(occA.equals(occA));
    assert.ok(occA.equals(occB));
    assert.ok(occB.equals(occA));
    assert.ok(!occA.equals(occC));
    assert.ok(!occA.equals(null));
    assert.ok(!occA.equals(undefined));
    assert.ok(!occA.equals({}));
    assert.ok(!occA.equals(bytesA));
  });
});

describe('Discord ID conversion and custody mapping', () => {
  it('parses u64 and allows 0 without positivity restriction', () => {
    assert.equal(parseDiscordU64(0n), 0n);
    assert.equal(parseDiscordU64('0'), 0n);
    assert.equal(parseDiscordU64(0), 0n);

    assert.equal(discordIdToI64(0n, 'interaction'), 0n);
    assert.equal(discordIdToI64('0', 'channel'), 0n);
    assert.equal(discordIdToI64(0, 'user'), 0n);
    assert.equal(discordIdToI64('1234567890', 'user'), 1234567890n);
    assert.equal(discordIdToI64(1234567890, 'user'), 1234567890n);
  });

  it('parses u64 max and rejects beyond u64', () => {
    assert.equal(parseDiscordU64(U64_MAX), U64_MAX);
    assert.equal(parseDiscordU64('18446744073709551615'), U64_MAX);

    assert.throws(() => parseDiscordU64(U64_MAX + 1n), RangeError);
    assert.throws(() => parseDiscordU64('18446744073709551616'), RangeError);
    assert.throws(() => parseDiscordU64(-1n), RangeError);
  });

  it('rejects invalid u64, malformed string, and unsafe numbers', () => {
    assert.throws(() => parseDiscordU64('-1'), Error);
    assert.throws(() => parseDiscordU64('abc'), Error);
    assert.throws(() => parseDiscordU64(''), Error);
    assert.throws(() => parseDiscordU64(' 123 '), Error);

    assert.throws(() => parseDiscordU64(9007199254740993), RangeError);
    assert.throws(() => parseDiscordU64(-1), RangeError);
    assert.throws(() => parseDiscordU64(-0), RangeError);
    assert.throws(() => parseDiscordU64(1.5), RangeError);
    assert.throws(() => parseDiscordU64(NaN), RangeError);
    assert.throws(() => parseDiscordU64(Infinity), RangeError);
    assert.throws(() => parseDiscordU64(-Infinity), RangeError);

    assert.throws(() => parseDiscordU64(null), TypeError);
    assert.throws(() => parseDiscordU64(undefined), TypeError);
    assert.throws(() => parseDiscordU64(true), TypeError);
    assert.throws(() => parseDiscordU64({}), TypeError);
  });

  it('enforces SQLite i64 overflow bounds with named kind error', () => {
    assert.throws(
      () => discordIdToI64(I64_MAX + 1n, 'interaction'),
      /Discord interaction ID exceeds SQLite range/
    );
    assert.throws(
      () => discordIdToI64('9223372036854775808', 'channel'),
      /Discord channel ID exceeds SQLite range/
    );
    assert.throws(
      () => discordIdToI64(18446744073709551615n, 'user'),
      /Discord user ID exceeds SQLite range/
    );
    assert.throws(
      () => discordIdToI64(I64_MAX + 1n, 'source message'),
      /Discord source message ID exceeds SQLite range/
    );
    assert.throws(
      () => discordIdToI64(I64_MAX + 1n, 'application'),
      /Discord application ID exceeds SQLite range/
    );
  });

  it('maps custody fields to canonical camelCase fields only', () => {
    const mapped = mapDiscordCustodyIds({
      applicationId: '100',
      interactionId: 200n,
      channelId: '300',
      userId: 400,
    });
    assert.equal(mapped.applicationId, 100n);
    assert.equal(mapped.interactionId, 200n);
    assert.equal(mapped.channelId, 300n);
    assert.equal(mapped.userId, 400n);

    assert.equal('sourceMessageId' in mapped, false);

    const raw = mapped as unknown as Record<string, unknown>;
    assert.equal('application_id' in raw, false);
    assert.equal('interaction_id' in raw, false);
    assert.equal('channel_id' in raw, false);
    assert.equal('user_id' in raw, false);
    assert.equal('owner_user_id' in raw, false);
    assert.equal('source_message_id' in raw, false);
  });

  it('maps custody fields with absent source-message when null or undefined', () => {
    const mappedNull = mapDiscordCustodyIds({
      applicationId: 100n,
      interactionId: 200n,
      channelId: 300n,
      userId: 400n,
      sourceMessageId: null,
    });
    assert.equal('sourceMessageId' in mappedNull, false);

    const mappedUndef = mapDiscordCustodyIds({
      applicationId: 100n,
      interactionId: 200n,
      channelId: 300n,
      userId: 400n,
      sourceMessageId: undefined,
    });
    assert.equal('sourceMessageId' in mappedUndef, false);
  });

  it('maps present source-message and checks field overflow errors in stage order', () => {
    const mapped = mapDiscordCustodyIds({
      applicationId: '10',
      interactionId: '1',
      channelId: '2',
      userId: '3',
      sourceMessageId: '4',
    });
    assert.equal(mapped.applicationId, 10n);
    assert.equal(mapped.interactionId, 1n);
    assert.equal(mapped.channelId, 2n);
    assert.equal(mapped.userId, 3n);
    assert.equal(mapped.sourceMessageId, 4n);

    assert.throws(
      () =>
        mapDiscordCustodyIds({
          applicationId: '10',
          interactionId: I64_MAX + 1n,
          channelId: '2',
          userId: '3',
        }),
      /Discord interaction ID exceeds SQLite range/
    );

    assert.throws(
      () =>
        mapDiscordCustodyIds({
          applicationId: '10',
          interactionId: '1',
          channelId: I64_MAX + 1n,
          userId: '3',
        }),
      /Discord channel ID exceeds SQLite range/
    );

    assert.throws(
      () =>
        mapDiscordCustodyIds({
          applicationId: '10',
          interactionId: '1',
          channelId: '2',
          userId: I64_MAX + 1n,
        }),
      /Discord user ID exceeds SQLite range/
    );

    assert.throws(
      () =>
        mapDiscordCustodyIds({
          applicationId: '10',
          interactionId: '1',
          channelId: '2',
          userId: '3',
          sourceMessageId: I64_MAX + 1n,
        }),
      /Discord source message ID exceeds SQLite range/
    );

    assert.throws(
      () =>
        mapDiscordCustodyIds({
          applicationId: I64_MAX + 1n,
          interactionId: '1',
          channelId: '2',
          userId: '3',
        }),
      /Discord application ID exceeds SQLite range/
    );
  });

  it('validates malformed input and each missing or null required field', () => {
    assert.throws(() => mapDiscordCustodyIds(null as unknown as DiscordCustodyInput), TypeError);
    assert.throws(() => mapDiscordCustodyIds(undefined as unknown as DiscordCustodyInput), TypeError);
    assert.throws(() => mapDiscordCustodyIds('string' as unknown as DiscordCustodyInput), TypeError);
    assert.throws(() => mapDiscordCustodyIds(123 as unknown as DiscordCustodyInput), TypeError);
    assert.throws(() => mapDiscordCustodyIds([] as unknown as DiscordCustodyInput), TypeError);

    assert.throws(
      () =>
        mapDiscordCustodyIds({
          applicationId: '1',
          channelId: '2',
          userId: '3',
        } as unknown as DiscordCustodyInput),
      TypeError
    );

    assert.throws(
      () =>
        mapDiscordCustodyIds({
          applicationId: '1',
          interactionId: '2',
          userId: '3',
        } as unknown as DiscordCustodyInput),
      TypeError
    );

    assert.throws(
      () =>
        mapDiscordCustodyIds({
          applicationId: '1',
          interactionId: '2',
          channelId: '3',
        } as unknown as DiscordCustodyInput),
      TypeError
    );

    assert.throws(
      () =>
        mapDiscordCustodyIds({
          interactionId: '1',
          channelId: '2',
          userId: '3',
        } as unknown as DiscordCustodyInput),
      TypeError
    );

    assert.throws(
      () =>
        mapDiscordCustodyIds({
          applicationId: null as unknown as string,
          interactionId: '1',
          channelId: '2',
          userId: '3',
        }),
      TypeError
    );

    assert.throws(
      () =>
        mapDiscordCustodyIds({
          applicationId: '1',
          interactionId: null as unknown as string,
          channelId: '2',
          userId: '3',
        }),
      TypeError
    );

    assert.throws(
      () =>
        mapDiscordCustodyIds({
          applicationId: '1',
          interactionId: '1',
          channelId: null as unknown as string,
          userId: '3',
        }),
      TypeError
    );

    assert.throws(
      () =>
        mapDiscordCustodyIds({
          applicationId: '1',
          interactionId: '1',
          channelId: '2',
          userId: null as unknown as string,
        }),
      TypeError
    );
  });
});


describe('Surrogate and boundary regressions', () => {
  it('rejects lone high/low surrogates and mixed invalid tails in validate and serialize', () => {
    const invalidStrings = [
      '\uD800',
      '\uDBFF',
      '\uDC00',
      '\uDFFF',
      '\uD800tail',
      'lead\uDC00',
      '\uD800\uD800',
      '\uDC00\uDC00',
      '\uDC00\uD800',
    ];
    for (const invalid of invalidStrings) {
      assert.throws(() => validateRequestId(invalid), TypeError);
      assert.throws(() => serializeRequestId(invalid), TypeError);
    }
  });

  it('roundtrips valid surrogate pairs, non-BMP, and ordinary escaped IDs', () => {
    const validStrings = [
      'req-valid-123',
      'id-\uD83D\uDE00-pair',
      'id-\u{1F600}-nonbmp',
      'id-with-"quotes"-\n-\t-\\',
    ];
    for (const valid of validStrings) {
      assert.equal(validateRequestId(valid), valid);
      const serialized = serializeRequestId(valid);
      assert.equal(parseLosslessJson<string>(serialized), valid);
    }
  });

  it('rejects malformed surrogate parameter values and keys in parseLosslessJson', () => {
    assert.throws(() => parseLosslessJson('{"id":"req-1","bad":"\\uD800"}'), SyntaxError);
    assert.throws(() => parseLosslessJson('{"id":"req-1","bad":"\\uDC00"}'), SyntaxError);
    assert.throws(() => parseLosslessJson('{"\\uD800":"val","id":"req-1"}'), SyntaxError);
    assert.throws(() => parseLosslessJson('{"\\uDC00":"val","id":"req-1"}'), SyntaxError);
  });

  it('rejects malformed keys and string values in stringifyLosslessJson', () => {
    assert.throws(() => stringifyLosslessJson('\uD800'), TypeError);
    assert.throws(() => stringifyLosslessJson('\uDC00'), TypeError);
    assert.throws(() => stringifyLosslessJson({ bad: '\uD800' }), TypeError);
    assert.throws(() => stringifyLosslessJson({ ['\uD800']: 'val' }), TypeError);
    assert.throws(() => stringifyLosslessJson({ ['\uDC00']: 'val' }), TypeError);
    assert.throws(() => stringifyLosslessJson(['\uD800']), TypeError);
  });

  it('rejects exact occurrence regressions for Array(16) variations via Uint8Array runtime check', () => {
    assert.throws(() => ServerRequestOccurrence.fromBytes(Array(16).fill(256) as unknown as Uint8Array), TypeError);
    assert.throws(() => ServerRequestOccurrence.fromBytes(Array(16).fill(-1) as unknown as Uint8Array), TypeError);
    assert.throws(() => ServerRequestOccurrence.fromBytes(Array(16).fill(0.5) as unknown as Uint8Array), TypeError);
    assert.throws(() => ServerRequestOccurrence.fromBytes(Array(16).fill(NaN) as unknown as Uint8Array), TypeError);
    assert.throws(() => ServerRequestOccurrence.fromBytes(Array(16) as unknown as Uint8Array), TypeError);
  });
});

describe('Lossless JSON token admission and duplicate key validation', () => {
  it('rejects overwritten positive and negative nonfinite numbers', () => {
    assert.throws(() => parseLosslessJson('{"n":1e400,"n":0}'), SyntaxError);
    assert.throws(() => parseLosslessJson('{"n":-1e400,"n":0}'), SyntaxError);
    assert.throws(() => parseLosslessJson('{"n":1e+400,"n":0}'), SyntaxError);
    assert.throws(() => parseLosslessJson('{"n":-1e+400,"n":0}'), SyntaxError);
    assert.throws(() => parseLosslessJson('{"n":0,"n":1e400}'), SyntaxError);
    assert.throws(() => parseLosslessJson('{"n":0,"n":-1e400}'), SyntaxError);
  });

  it('rejects overwritten invalid high, low, and mixed surrogate string values', () => {
    assert.throws(() => parseLosslessJson('{"id":"\\uD800","id":"ok"}'), SyntaxError);
    assert.throws(() => parseLosslessJson('{"id":"\\uDBFF","id":"ok"}'), SyntaxError);
    assert.throws(() => parseLosslessJson('{"id":"\\uDC00","id":"ok"}'), SyntaxError);
    assert.throws(() => parseLosslessJson('{"id":"\\uDFFF","id":"ok"}'), SyntaxError);
    assert.throws(() => parseLosslessJson('{"id":"\\uD800tail","id":"ok"}'), SyntaxError);
    assert.throws(() => parseLosslessJson('{"id":"lead\\uDC00","id":"ok"}'), SyntaxError);
    assert.throws(() => parseLosslessJson('{"id":"\\uD800\\uD800","id":"ok"}'), SyntaxError);
    assert.throws(() => parseLosslessJson('{"id":"\\uDC00\\uDC00","id":"ok"}'), SyntaxError);
    assert.throws(() => parseLosslessJson('{"id":"\\uDC00\\uD800","id":"ok"}'), SyntaxError);
    assert.throws(() => parseLosslessJson('{"id":"\uD800","id":"ok"}'), SyntaxError);
    assert.throws(() => parseLosslessJson('{"id":"\uDC00","id":"ok"}'), SyntaxError);
    assert.throws(() => parseLosslessJson('{"id":"ok","id":"\\uD800"}'), SyntaxError);
  });

  it('rejects malformed duplicate keys whether first or overwritten', () => {
    assert.throws(() => parseLosslessJson('{"\\uD800":1,"\\uD800":2}'), SyntaxError);
    assert.throws(() => parseLosslessJson('{"\\uDC00":1,"\\uDC00":2}'), SyntaxError);
    assert.throws(() => parseLosslessJson('{"\\uD800":1,"k":2}'), SyntaxError);
    assert.throws(() => parseLosslessJson('{"k":1,"\\uD800":2}'), SyntaxError);
    assert.throws(() => parseLosslessJson('{"\\uDC00\\uD800":1,"valid":2}'), SyntaxError);
  });

  it('allows escaped backslash literal before uD800', () => {
    const parsedVal = parseLosslessJson<{ id: string }>('{"id":"\\\\uD800"}');
    assert.equal(parsedVal.id, '\\uD800');

    const parsedOverwritten = parseLosslessJson<{ id: string }>('{"id":"\\\\uD800","id":"ok"}');
    assert.equal(parsedOverwritten.id, 'ok');

    const parsedKey = parseLosslessJson<{ '\\uD800': string }>('{"\\\\uD800":"val"}');
    assert.equal(parsedKey['\\uD800'], 'val');

    const parsedDupKey = parseLosslessJson<{ '\\uD800': number }>('{"\\\\uD800":1,"\\\\uD800":2}');
    assert.equal(parsedDupKey['\\uD800'], 2n);
  });

  it('handles escaped quote boundaries and numbers inside strings without false positives', () => {
    const parsed = parseLosslessJson<{ msg: string; count: bigint }>(
      '{"msg":"He said \\"1e400 -1e400 \\\\\\" inside \\" and -0","count":42}'
    );
    assert.equal(parsed.msg, 'He said "1e400 -1e400 \\" inside " and -0');
    assert.equal(parsed.count, 42n);

    const overwritten = parseLosslessJson<{ msg: string }>(
      '{"msg":"escaped \\"quote\\" with 1e400","msg":"final"}'
    );
    assert.equal(overwritten.msg, 'final');
  });

  it('allows valid surrogate pairs and non-BMP characters even when duplicated', () => {
    const validPairs = parseLosslessJson<{ emoji: string }>(
      '{"emoji":"\\uD83D\\uDE00","emoji":"\\uD83D\\uDE01"}'
    );
    assert.equal(validPairs.emoji, '\uD83D\uDE01');

    const nonBmp = parseLosslessJson<{ emoji: string }>(
      '{"emoji":"\u{1F600}","emoji":"\u{1F602}"}'
    );
    assert.equal(nonBmp.emoji, '\u{1F602}');
  });

  it('keeps last value and precise BigInt for ordinary duplicate valid values', () => {
    const dupInt = parseLosslessJson<{ a: bigint }>('{"a":1,"a":2}');
    assert.equal(dupInt.a, 2n);

    const dupBig = parseLosslessJson<{ a: bigint }>(
      '{"a":9007199254740993,"a":9007199254740995}'
    );
    assert.equal(dupBig.a, 9007199254740995n);

    const dupBounds = parseLosslessJson<{ a: bigint }>(
      '{"a":-9223372036854775808,"a":9223372036854775807}'
    );
    assert.equal(dupBounds.a, I64_MAX);

    const dupFloat = parseLosslessJson<{ a: number }>('{"a":1.5,"a":2.5}');
    assert.equal(dupFloat.a, 2.5);

    const dupNegZero = parseLosslessJson<{ a: number }>('{"a":0,"a":-0}');
    assert.ok(Object.is(dupNegZero.a, -0));
  });

  it('validates tokens in nested duplicate keys and arrays', () => {
    assert.throws(() => parseLosslessJson('{"nested":{"x":1e400,"x":1}}'), SyntaxError);
    assert.throws(() => parseLosslessJson('{"nested":{"x":-1e400,"x":1}}'), SyntaxError);
    assert.throws(() => parseLosslessJson('{"nested":{"x":"\\uD800","x":"ok"}}'), SyntaxError);
    assert.throws(() => parseLosslessJson('[{"x":1e400,"x":1}]'), SyntaxError);
    assert.throws(() => parseLosslessJson('[{"x":"\\uD800","x":"ok"}]'), SyntaxError);
    assert.throws(() => parseLosslessJson('{"arr":[1e400,0]}'), SyntaxError);
    assert.throws(() => parseLosslessJson('{"arr":["\\uD800","ok"]}'), SyntaxError);

    const validNested = parseLosslessJson<{ nested: { x: bigint }; arr: bigint[] }>(
      '{"nested":{"x":1,"x":2},"arr":[10,20]}'
    );
    assert.equal(validNested.nested.x, 2n);
    assert.deepEqual(validNested.arr, [10n, 20n]);
  });

  it('ensures invalid first tokens are never hidden by subsequent tokens', () => {
    assert.throws(() => parseLosslessJson('{"bad":1e400,"good":1}'), SyntaxError);
    assert.throws(() => parseLosslessJson('{"bad":-1e400,"good":1}'), SyntaxError);
    assert.throws(() => parseLosslessJson('{"bad":"\\uD800","good":"ok"}'), SyntaxError);
    assert.throws(() => parseLosslessJson('{"bad":"\\uDC00","good":"ok"}'), SyntaxError);
    assert.throws(() => parseLosslessJson('[-1e400, 1]'), SyntaxError);
    assert.throws(() => parseLosslessJson('["\\uD800", "ok"]'), SyntaxError);
  });
});
