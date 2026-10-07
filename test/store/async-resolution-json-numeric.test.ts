import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  I64_MAX,
  I64_MIN,
  U32_MAX,
  U32_MIN,
  U64_MAX,
  U64_MIN,
  as_bool,
  as_i64,
  as_str,
  as_u32,
  as_u64,
  asBool,
  asI64,
  asStr,
  asU32,
  asU64,
  parseSerdeValue,
  tryParseJson,
  tryParseSerdeJson,
  u32_field,
  u32Field,
} from "../../src/store/async-resolution-json-helpers.ts";

describe("async-resolution-json numeric and primitive helpers", () => {
  it("exports exact Rust integer boundary constants", () => {
    assert.equal(U64_MIN, 0n);
    assert.equal(U64_MAX, 18446744073709551615n);
    assert.equal(I64_MIN, -9223372036854775808n);
    assert.equal(I64_MAX, 9223372036854775807n);
    assert.equal(U32_MIN, 0n);
    assert.equal(U32_MAX, 4294967295n);
  });

  it("exports snake_case aliases identical to camelCase functions", () => {
    assert.equal(as_u64, asU64);
    assert.equal(as_i64, asI64);
    assert.equal(as_u32, asU32);
    assert.equal(as_str, asStr);
    assert.equal(as_bool, asBool);
    assert.equal(u32_field, u32Field);
    assert.equal(tryParseSerdeJson, tryParseJson);
  });

  describe("asU64", () => {
    const valid: Array<[string, bigint]> = [
      ["0", 0n],
      ["1", 1n],
      ["4294967295", 4294967295n],
      ["9223372036854775807", 9223372036854775807n],
      ["18446744073709551615", 18446744073709551615n],
    ];
    for (const [raw, expected] of valid) {
      it(`accepts parsed valid u64 ${raw}`, () => {
        const val = parseSerdeValue(raw);
        assert.equal(asU64(val), expected);
      });
    }

    const invalidSerde: string[] = [
      "-1",
      "-9223372036854775808",
      "18446744073709551616",
      "0.0",
      "1.5",
      "-0.5",
      "-0",
      "1e2",
      "1e0",
      "null",
      "true",
      '"100"',
      "[]",
      "{}",
    ];
    for (const raw of invalidSerde) {
      it(`rejects serde representation: ${raw}`, () => {
        const val = parseSerdeValue(raw);
        assert.equal(asU64(val), undefined);
      });
    }

    it("rejects out-of-range float and non-serde invalid inputs returning undefined (never null)", () => {
      assert.throws(() => parseSerdeValue("1e500"), RangeError);
      assert.equal(tryParseJson("1e500"), undefined);
      const invalidValues: unknown[] = [
        -1n,
        18446744073709551616n,
        0,
        1,
        1.5,
        -0,
        NaN,
        Infinity,
        null,
        undefined,
        "123",
        true,
        false,
        Symbol("u64"),
        {},
      ];
      for (const val of invalidValues) {
        assert.equal(asU64(val), undefined);
      }
    });
  });

  describe("asI64", () => {
    const valid: Array<[string, bigint]> = [
      ["-9223372036854775808", -9223372036854775808n],
      ["-1", -1n],
      ["0", 0n],
      ["1", 1n],
      ["4294967295", 4294967295n],
      ["9223372036854775807", 9223372036854775807n],
    ];
    for (const [raw, expected] of valid) {
      it(`accepts parsed valid i64 ${raw}`, () => {
        const val = parseSerdeValue(raw);
        assert.equal(asI64(val), expected);
      });
    }

    const invalidSerde: string[] = [
      "-9223372036854775809",
      "9223372036854775808",
      "18446744073709551615",
      "0.0",
      "1.5",
      "-1.5",
      "-0",
      "1e2",
      "null",
      "true",
      '"-1"',
      "[]",
    ];
    for (const raw of invalidSerde) {
      it(`rejects serde representation: ${raw}`, () => {
        const val = parseSerdeValue(raw);
        assert.equal(asI64(val), undefined);
      });
    }

    it("rejects non-serde invalid inputs returning undefined (never null)", () => {
      const invalidValues: unknown[] = [
        -9223372036854775809n,
        9223372036854775808n,
        0,
        -1,
        1.5,
        -0,
        NaN,
        null,
        undefined,
        "0",
        {},
      ];
      for (const val of invalidValues) {
        assert.equal(asI64(val), undefined);
      }
    });
  });

  describe("asU32", () => {
    const valid: Array<[string, bigint]> = [
      ["0", 0n],
      ["1", 1n],
      ["65535", 65535n],
      ["4294967295", 4294967295n],
    ];
    for (const [raw, expected] of valid) {
      it(`accepts parsed valid u32 ${raw}`, () => {
        const val = parseSerdeValue(raw);
        assert.equal(asU32(val), expected);
      });
    }

    const invalidSerde: string[] = [
      "-1",
      "4294967296",
      "9223372036854775807",
      "0.0",
      "1.0",
      "-0",
      "1e2",
      "null",
      '"42"',
      "{}",
    ];
    for (const raw of invalidSerde) {
      it(`rejects serde representation: ${raw}`, () => {
        const val = parseSerdeValue(raw);
        assert.equal(asU32(val), undefined);
      });
    }

    it("rejects non-serde invalid inputs returning undefined (never null)", () => {
      const invalidValues: unknown[] = [
        -1n,
        4294967296n,
        0,
        42,
        null,
        undefined,
        "0",
        true,
      ];
      for (const val of invalidValues) {
        assert.equal(asU32(val), undefined);
      }
    });
  });

  describe("u32Field and u32_field", () => {
    it("validates own properties with u32 values from parseSerdeValue", () => {
      const obj = parseSerdeValue('{"min": 0, "mid": 12345, "max": 4294967295, "over": 4294967296, "neg": -1, "float": 1.5, "str": "0"}');
      assert.equal(u32Field(obj, "min"), true);
      assert.equal(u32Field(obj, "mid"), true);
      assert.equal(u32Field(obj, "max"), true);
      assert.equal(u32Field(obj, "over"), false);
      assert.equal(u32Field(obj, "neg"), false);
      assert.equal(u32Field(obj, "float"), false);
      assert.equal(u32Field(obj, "str"), false);
      assert.equal(u32Field(obj, "missing"), false);
      assert.equal(u32_field(obj, "mid"), true);
    });

    it("enforces own property checks and rejects inherited/prototype keys", () => {
      const proto = { inheritedU32: 100n };
      const child = Object.create(proto) as Record<string, unknown>;
      child["ownU32"] = 200n;
      assert.equal(u32Field(child, "ownU32"), true);
      assert.equal(u32Field(child, "inheritedU32"), false);
      assert.equal(u32Field(child, "toString"), false);
      assert.equal(u32Field(child, "valueOf"), false);
      assert.equal(u32Field(child, "__proto__"), false);
    });

    it("rejects non-object values", () => {
      const nonObjects: unknown[] = [null, undefined, 42, 42n, "{}", true, [10n]];
      for (const val of nonObjects) {
        assert.equal(u32Field(val, "key"), false);
        assert.equal(u32_field(val, "key"), false);
      }
    });
  });

  describe("asStr and as_str", () => {
    it("accepts string primitives including from parseSerdeValue", () => {
      assert.equal(asStr(""), "");
      assert.equal(asStr("hello"), "hello");
      assert.equal(asStr(parseSerdeValue('""')), "");
      assert.equal(asStr(parseSerdeValue('"alpha"')), "alpha");
      assert.equal(as_str("test"), "test");
    });

    it("rejects non-string values returning undefined (never null)", () => {
      const nonStrings: unknown[] = [
        null,
        undefined,
        0,
        1n,
        true,
        false,
        {},
        [],
        parseSerdeValue("0"),
        parseSerdeValue("null"),
      ];
      for (const val of nonStrings) {
        assert.equal(asStr(val), undefined);
        assert.equal(as_str(val), undefined);
      }
    });
  });

  describe("asBool and as_bool", () => {
    it("accepts boolean primitives including from parseSerdeValue", () => {
      assert.equal(asBool(true), true);
      assert.equal(asBool(false), false);
      assert.equal(asBool(parseSerdeValue("true")), true);
      assert.equal(asBool(parseSerdeValue("false")), false);
      assert.equal(as_bool(true), true);
      assert.equal(as_bool(false), false);
    });

    it("rejects non-boolean values returning undefined (never null)", () => {
      const nonBools: unknown[] = [
        null,
        undefined,
        0,
        1,
        0n,
        "",
        "true",
        "false",
        {},
        [],
        parseSerdeValue("null"),
        parseSerdeValue('"true"'),
      ];
      for (const val of nonBools) {
        assert.equal(asBool(val), undefined);
        assert.equal(as_bool(val), undefined);
      }
    });
  });

  describe("tryParseJson and tryParseSerdeJson", () => {
    it("returns parsed serde value on valid input and undefined on failure", () => {
      assert.equal(tryParseJson("123"), 123n);
      assert.equal(tryParseSerdeJson("true"), true);
      assert.deepEqual(tryParseJson('{"a": 1}'), { a: 1n });
      assert.equal(tryParseJson("invalid json"), undefined);
      assert.equal(tryParseJson("{"), undefined);
      assert.equal(tryParseJson("1e500"), undefined);
      assert.equal(tryParseJson(123 as unknown as string), undefined);
    });
  });
});
