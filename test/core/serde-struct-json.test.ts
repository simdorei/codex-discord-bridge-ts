import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSerdeStruct, type StructShape } from "../../src/core/serde-struct-json.ts";
const owner: StructShape = {fields: [["turn", "string"], ["generation", "i64"], ["job", "value"]]};
const proof: StructShape = {fields: [["version", "i64"], ["owner", owner], ["verified", "bool"]]};
const input = '{"version":1,"owner":{"turn":"turn","generation":9223372036854775807,"job":{}},"verified":true}';
test("typed structs preserve exact integers and accept map/sequence representations", () => {
  const a = parseSerdeStruct(input, proof);
  const b = parseSerdeStruct('[1,["turn",9223372036854775807,{}],true]', proof);
  assert.deepEqual(a, b); assert.equal(Object.getPrototypeOf(a), null);
  assert.equal((a.owner as Record<string, unknown>).generation, 9223372036854775807n);
});
test("duplicate known fields, including escaped names and nested structs, reject", () => {
  for (const raw of [input.replace('"version":1', '"version":1,"ver\\u0073ion":1'),
    input.replace('"turn":"turn"', '"turn":"turn","turn":"turn"')]) assert.throws(() => parseSerdeStruct(raw, proof));
});
test("unknown fields use IgnoredAny rather than Value constraints", () => {
  const noise = '"unknown":1e999,"unknown":"\\ud800","deep":' + '['.repeat(300) + '0' + ']'.repeat(300);
  assert.deepEqual(parseSerdeStruct(input.replace('{', '{' + noise + ','), proof), parseSerdeStruct(input, proof));
  for (const bad of ['01', '1e', '"\\uQQQQ"', '[0,]']) {
    assert.throws(() => parseSerdeStruct(input.replace('{', '{"unknown":' + bad + ','), proof));
  }
});
test("known Value retains duplicate-last-wins but validates overwritten numeric and string tokens", () => {
  const valid = parseSerdeStruct(input.replace('"job":{}', '"job":{"x":1,"x":2}'), proof);
  assert.equal(((valid.owner as Record<string, unknown>).job as Record<string, unknown>).x, 2n);
  for (const raw of ['{"x":1e999,"x":0}', '{"x":"\\ud800","x":0}']) {
    assert.throws(() => parseSerdeStruct(input.replace('"job":{}', '"job":' + raw), proof));
  }
});
test("required fields, exact primitive types and sequence arity are enforced", () => {
  for (const n of ['-0','1.0','1e0','9223372036854775808','-9223372036854775809','null','"1"']) {
    assert.throws(() => parseSerdeStruct(input.replace('"version":1', '"version":' + n), proof));
  }
  for (const raw of ['{}','[]','[1,[],true]','[1,["t",1,{}],true,0]', input.replace(',"verified":true',''), input.replace('true','1')]) {
    assert.throws(() => parseSerdeStruct(raw, proof));
  }
});
test("known Value shares parent recursion budget; ignored nesting does not consume it", () => {
  for (const [n, ok] of [[124, true], [125, false]] as const) {
    // Two parent structs + job object + n nested arrays.
    const raw = input.replace('"job":{}', '"job":{"x":' + '['.repeat(n) + '0' + ']'.repeat(n) + '}');
    if (ok) assert.doesNotThrow(() => parseSerdeStruct(raw, proof));
    else assert.throws(() => parseSerdeStruct(raw, proof));
  }
});
test("unknown field names still require valid Unicode, and structural characters inside strings are inert", () => {
  assert.throws(() => parseSerdeStruct(input.replace('{','{"\\ud800":0,'), proof));
  const raw = input.replace('{', '{"noise":{"a":["} , \\\" [",{}]},');
  assert.deepEqual(parseSerdeStruct(raw, proof), parseSerdeStruct(input, proof));
});
