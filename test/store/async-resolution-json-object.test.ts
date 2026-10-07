import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { JsonObject } from "../../src/store/async-resolution-json-helpers.ts";
import {
  asBool,
  asJsonObject,
  asStr,
  as_bool,
  as_object,
  as_str,
  getOwn,
  hasExactFieldCount,
  hasOwn,
  isJsonObject,
  jsonPointer,
  optionalStrings,
  optional_strings,
  ownFieldCount,
  ownKeys,
  parseSerdeValue,
  pointer,
  single,
  singleJsonObject,
  singleObject,
  singleWrapper,
  strings,
  tryParseJson,
  tryParseSerdeJson,
  u32Field,
  u32_field,
} from "../../src/store/async-resolution-json-helpers.ts";

describe("async-resolution-json-object", () => {
  it("guards json object types correctly", () => {
    const guards: ReadonlyArray<readonly [unknown, boolean]> = [
      [{}, true],
      [{ a: 1 }, true],
      [Object.create(null), true],
      [null, false],
      [[], false],
      [[1, 2], false],
      ["string", false],
      [123, false],
      [true, false],
      [false, false],
      [undefined, false],
      [() => {}, false],
      [Symbol("test"), false],
    ];
    for (const [input, expected] of guards) {
      assert.equal(isJsonObject(input), expected);
    }

    const validObj: JsonObject = { key: "val" };
    assert.equal(asJsonObject(validObj), validObj);
    assert.equal(as_object(validObj), validObj);
    assert.equal(asJsonObject(null), undefined);
    assert.equal(as_object([]), undefined);
    assert.equal(asJsonObject("str"), undefined);

    assert.equal(asStr("hello"), "hello");
    assert.equal(as_str("hello"), "hello");
    assert.equal(asStr(123), undefined);
    assert.equal(asStr(null), undefined);

    assert.equal(asBool(true), true);
    assert.equal(as_bool(false), false);
    assert.equal(asBool("true"), undefined);
    assert.equal(asBool(1), undefined);
  });

  it("handles own keys, field counts, and __proto__ own property", () => {
    const obj = { a: 1, b: "two" };
    assert.equal(hasOwn(obj, "a"), true);
    assert.equal(hasOwn(obj, "toString"), false);
    assert.equal(getOwn(obj, "a"), 1);
    assert.equal(getOwn(obj, "toString"), undefined);
    assert.deepEqual(ownKeys(obj), ["a", "b"]);
    assert.equal(ownFieldCount(obj), 2);
    assert.equal(hasExactFieldCount(obj, 2), true);
    assert.equal(hasExactFieldCount(obj, 1), false);
    assert.equal(hasExactFieldCount(obj, 3), false);

    for (const nonObj of [null, undefined, [], [1], "test", 42, false]) {
      assert.equal(hasOwn(nonObj, "a"), false);
      assert.equal(getOwn(nonObj, "a"), undefined);
      assert.deepEqual(ownKeys(nonObj), []);
      assert.equal(ownFieldCount(nonObj), 0);
      assert.equal(hasExactFieldCount(nonObj, 0), false);
    }

    const protoOwn = JSON.parse('{"__proto__":999}') as unknown;
    assert.equal(hasOwn(protoOwn, "__proto__"), true);
    assert.equal(getOwn(protoOwn, "__proto__"), 999);
    assert.deepEqual(ownKeys(protoOwn), ["__proto__"]);
    assert.equal(ownFieldCount(protoOwn), 1);
    assert.equal(hasExactFieldCount(protoOwn, 1), true);

    const normalObj = {};
    assert.equal(hasOwn(normalObj, "__proto__"), false);
    assert.equal(getOwn(normalObj, "__proto__"), undefined);
    assert.deepEqual(ownKeys(normalObj), []);
    assert.equal(ownFieldCount(normalObj), 0);

    const u32Data = { valid: 42n, max: 4294967295n, num: 42, overflow: 4294967296n, neg: -1n };
    assert.equal(u32Field(u32Data, "valid"), true);
    assert.equal(u32_field(u32Data, "max"), true);
    assert.equal(u32Field(u32Data, "num"), false);
    assert.equal(u32Field(u32Data, "overflow"), false);
    assert.equal(u32Field(u32Data, "neg"), false);
    assert.equal(u32Field(u32Data, "missing"), false);
    assert.equal(u32Field(null, "valid"), false);
  });

  it("handles single and singleObject wrappers with body guards", () => {
    assert.deepEqual(single({ cmd: "run" }), ["cmd", "run"]);
    assert.deepEqual(singleWrapper({ cmd: "run" }), ["cmd", "run"]);
    assert.deepEqual(single({ BridgeSync: null }), ["BridgeSync", null]);
    assert.deepEqual(single({ Status: [] }), ["Status", []]);
    assert.equal(single({}), undefined);
    assert.equal(single({ a: 1, b: 2 }), undefined);
    assert.equal(single(null), undefined);
    assert.equal(single([]), undefined);

    const commandObj = { Command: { id: "42" } };
    assert.deepEqual(singleObject(commandObj), ["Command", { id: "42" }]);
    assert.deepEqual(singleJsonObject(commandObj), ["Command", { id: "42" }]);

    assert.equal(singleObject({ BridgeSync: null }), undefined);
    assert.equal(singleJsonObject({ BridgeSync: null }), undefined);
    assert.equal(singleObject({ Status: [] }), undefined);
    assert.equal(singleJsonObject({ Status: [] }), undefined);

    assert.equal(singleObject({ cmd: "primitive" }), undefined);
    assert.equal(singleObject({ cmd: 123 }), undefined);
    assert.equal(singleObject({ cmd: true }), undefined);
    assert.equal(singleObject({}), undefined);
    assert.equal(singleObject({ a: {}, b: {} }), undefined);
    assert.equal(singleObject(null), undefined);
    assert.equal(singleObject([]), undefined);
  });

  it("distinguishes strings and optionalStrings types and presence", () => {
    const doc = { str: "hello", empty: "", num: 1, nil: null, flag: true };

    assert.equal(strings(doc, ["str", "empty"]), true);
    assert.equal(strings(doc, []), true);
    assert.equal(strings(doc, ["str", "num"]), false);
    assert.equal(strings(doc, ["str", "nil"]), false);
    assert.equal(strings(doc, ["str", "missing"]), false);
    assert.equal(strings(null, ["str"]), false);
    assert.equal(strings(["hello"], ["0"]), false);

    assert.equal(optionalStrings(doc, ["str", "nil"]), true);
    assert.equal(optional_strings(doc, ["str", "nil", "missing"]), true);
    assert.equal(optionalStrings(doc, ["missing1", "missing2"]), true);
    assert.equal(optionalStrings(doc, ["str", "num"]), false);
    assert.equal(optionalStrings(doc, ["flag"]), false);
    assert.equal(optionalStrings({ sub: {} }, ["sub"]), false);
    assert.equal(optionalStrings({ sub: [] }, ["sub"]), false);
    assert.equal(optionalStrings({ sub: undefined }, ["sub"]), false);
    assert.equal(optionalStrings(null, ["str"]), true);
    assert.equal(optional_strings("primitive", ["str"]), true);
  });

  it("navigates json pointer with empty, missing, objects, arrays, and escapes", () => {
    const doc = {
      "": "empty-key",
      "a/b": 10,
      "m~n": 20,
      "c~0/d": 30,
      nested: { target: "found", list: ["zero", "one", { deep: 99 }] },
      leaf: 42,
    };

    assert.equal(pointer(doc, ""), doc);
    assert.equal(jsonPointer(doc, ""), doc);
    assert.equal(pointer("text", ""), "text");
    assert.equal(pointer(null, ""), null);

    assert.equal(pointer(doc, "nested"), undefined);
    assert.equal(pointer(doc, "nested/target"), undefined);

    assert.equal(pointer(doc, "/nested/target"), "found");
    assert.equal(pointer(doc, "/nested/missing"), undefined);
    assert.equal(pointer(doc, "/missing/deep"), undefined);
    assert.equal(pointer(doc, "/leaf/child"), undefined);

    assert.equal(pointer(doc, "/nested/list/0"), "zero");
    assert.equal(pointer(doc, "/nested/list/1"), "one");
    assert.deepEqual(pointer(doc, "/nested/list/2"), { deep: 99 });
    assert.equal(pointer(doc, "/nested/list/2/deep"), 99);
    assert.equal(pointer(doc, "/nested/list/3"), undefined);
    assert.equal(pointer(doc, "/nested/list/-1"), undefined);
    assert.equal(pointer(doc, "/nested/list/01"), undefined);
    assert.equal(pointer(doc, "/nested/list/idx"), undefined);

    assert.equal(pointer(doc, "/a~1b"), 10);
    assert.equal(pointer(doc, "/m~0n"), 20);
    assert.equal(pointer(doc, "/c~00~1d"), 30);
    assert.equal(pointer(doc, "/"), "empty-key");

    assert.equal(pointer({}, "/toString"), undefined);
    assert.equal(pointer({}, "/__proto__"), undefined);
    const protoDoc = JSON.parse('{"__proto__":{"sub":777}}') as unknown;
    assert.equal(pointer(protoDoc, "/__proto__/sub"), 777);
  });

  it("verifies parseSerdeValue export and tryParseJson behaviors", () => {
    const parsed = parseSerdeValue<{ text: string; num: bigint }>('{"text":"ok","num":123}');
    assert.equal(parsed.text, "ok");
    assert.equal(parsed.num, 123n);
    assert.throws(() => parseSerdeValue("{invalid"));

    assert.deepEqual(tryParseJson('{"valid":true}'), { valid: true });
    assert.deepEqual(tryParseSerdeJson('{"valid":true}'), { valid: true });
    assert.equal(tryParseJson("{invalid json"), undefined);
    assert.equal(tryParseSerdeJson("{invalid json"), undefined);
    assert.equal(tryParseJson(123 as unknown as string), undefined);
    assert.equal(tryParseJson(null as unknown as string), undefined);
    assert.equal(tryParseJson(undefined as unknown as string), undefined);
  });
});
