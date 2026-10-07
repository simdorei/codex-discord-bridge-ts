import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSerdeValue } from "../../src/store/async-resolution-json-helpers.ts";
import { asyncLifecycleOrdinary } from "../../src/store/async-resolution-ordinary.ts";

function check(raw: string): boolean {
  return asyncLifecycleOrdinary(parseSerdeValue(raw));
}

define: describe("asyncLifecycleOrdinary root boundary contract", () => {
  it("validates root version raw JSON tokens", () => {
    const cases: readonly [string, boolean][] = [
      ['{"version":1,"command":"help"}', true],
      ['{"version":1.0,"command":"help"}', false],
      ['{"version":1e0,"command":"help"}', false],
      ['{"version":0,"command":"help"}', false],
      ['{"command":"help"}', false],
    ];
    for (const [raw, expected] of cases) {
      assert.equal(check(raw), expected, raw);
    }
  });

  it("rejects non-object roots", () => {
    const cases: readonly string[] = [
      '"string"',
      "1",
      "true",
      "null",
      "[]",
      '[{"version":1,"command":"help"}]',
    ];
    for (const raw of cases) {
      assert.equal(check(raw), false, raw);
    }
  });

  it("handles known 4 slots presence, absence, null, and empty root", () => {
    const validSlots: readonly [string, string][] = [
      ["plan", '{"version":1,"plan":{"Respond":"ok"}}'],
      [
        "lifecycle_binding",
        '{"version":1,"lifecycle_binding":{"target":"t","route":"Mapped","command":"Help"}}',
      ],
      [
        "work",
        '{"version":1,"work":{"Autocomplete":{"command_name":"c","option_name":"o","current":"v"}}}',
      ],
      ["command", '{"version":1,"command":"help"}'],
    ];
    for (const [, raw] of validSlots) {
      assert.equal(check(raw), true, raw);
    }

    const nullWithValid: readonly string[] = [
      '{"version":1,"plan":null,"command":"help"}',
      '{"version":1,"lifecycle_binding":null,"command":"help"}',
      '{"version":1,"work":null,"command":"help"}',
      '{"version":1,"command":null,"plan":{"Respond":"ok"}}',
    ];
    for (const raw of nullWithValid) {
      assert.equal(check(raw), true, raw);
    }

    const noRecognized: readonly string[] = [
      '{"version":1}',
      '{"version":1,"plan":null,"lifecycle_binding":null,"work":null,"command":null}',
      '{"version":1,"unknown_slot":"ignored"}',
    ];
    for (const raw of noRecognized) {
      assert.equal(check(raw), false, raw);
    }
  });

  it("ignores unknown root keys even with malformed unknown values", () => {
    const raw =
      '{"version":1,"command":"help","bogus":1e99,"nested":{"broken":[null,false]}}';
    assert.equal(check(raw), true);
  });

  it("fails when any known slot is invalid regardless of key order", () => {
    const pairs: readonly [string, string][] = [
      ['"plan":{"Respond":123}', '"command":"help"'],
      ['"lifecycle_binding":{}', '"command":"help"'],
      ['"work":{}', '"command":"help"'],
      ['"command":"invalid_slash"', '"plan":{"Respond":"ok"}'],
    ];
    for (const [slotA, slotB] of pairs) {
      const order1 = `{"version":1,${slotA},${slotB}}`;
      const order2 = `{"version":1,${slotB},${slotA}}`;
      assert.equal(check(order1), false, order1);
      assert.equal(check(order2), false, order2);
    }
  });

  it("validates plan wrapper shapes and commands", () => {
    const cases: readonly [string, boolean][] = [
      ['{"version":1,"plan":{"Respond":"ok"}}', true],
      ['{"version":1,"plan":{"Respond":123}}', false],
      ['{"version":1,"plan":{"Error":"fail"}}', true],
      ['{"version":1,"plan":{"Error":false}}', false],
      ['{"version":1,"plan":{"Ignore":"drop"}}', true],
      ['{"version":1,"plan":{"Ignore":null}}', false],
      ['{"version":1,"plan":{"Execute":"Help"}}', true],
      ['{"version":1,"plan":{"Execute":{"Status":[]}}}', false],
      ['{"version":1,"plan":{"Execute":{"BridgeSync":null}}}', false],
      ['{"version":1,"plan":{"Respond":"ok","Error":"fail"}}', false],
      ['{"version":1,"plan":{"UnknownKind":"ok"}}', false],
    ];
    for (const [raw, expected] of cases) {
      assert.equal(check(raw), expected, raw);
    }
  });
});
