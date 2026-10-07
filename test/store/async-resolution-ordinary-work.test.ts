import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { asyncLifecycleOrdinary } from "../../src/store/async-resolution-ordinary.ts";
import { parseSerdeValue } from "../../src/store/async-resolution-json-helpers.ts";

function check(rawJson: string): boolean {
  return asyncLifecycleOrdinary(parseSerdeValue(rawJson));
}

function checkWork(workJson: string): boolean {
  return check(`{"version":1,"work":${workJson}}`);
}

const VALID_SLASH_NAMES = [
  "help",
  "list",
  "archived_list",
  "use",
  "status",
  "settings",
  "where",
  "context",
  "usage",
  "new",
  "ask",
  "interview",
  "doctor",
  "approval",
  "runners",
  "retract",
  "mirror_check",
  "bridge_sync",
  "qa_buttons",
] as const;

describe("asyncLifecycleOrdinary - version and root work harness boundaries", () => {
  it("accepts version 1 with valid work", () => {
    assert.equal(
      check('{"version":1,"work":{"Slash":{"name":"help","values":{}}}}'),
      true
    );
  });

  it("rejects non-version-1, invalid version representations, or missing version", () => {
    const invalidVersions: string[] = [
      '{"work":{"Slash":{"name":"help","values":{}}}}',
      '{"version":0,"work":{"Slash":{"name":"help","values":{}}}}',
      '{"version":2,"work":{"Slash":{"name":"help","values":{}}}}',
      '{"version":-1,"work":{"Slash":{"name":"help","values":{}}}}',
      '{"version":"1","work":{"Slash":{"name":"help","values":{}}}}',
      '{"version":1.0,"work":{"Slash":{"name":"help","values":{}}}}',
      '{"version":null,"work":{"Slash":{"name":"help","values":{}}}}',
    ];
    for (const raw of invalidVersions) {
      assert.equal(check(raw), false, `expected rejection for version: ${raw}`);
    }
  });

  it("rejects non-object root payload", () => {
    const invalidRoots: string[] = ["null", "[]", '"str"', "123", "true"];
    for (const bad of invalidRoots) {
      assert.equal(check(bad), false, `expected rejection for root: ${bad}`);
    }
  });
});

describe("asyncLifecycleOrdinary - work wrapper structure boundaries", () => {
  it("rejects non-object work values", () => {
    const invalidWorkValues: string[] = [
      "null",
      "[]",
      '"Slash"',
      "123",
      "true",
    ];
    for (const bad of invalidWorkValues) {
      assert.equal(checkWork(bad), false, `expected rejection for work: ${bad}`);
    }
  });

  it("rejects work object with 0 keys or more than 1 key", () => {
    assert.equal(checkWork("{}"), false);
    assert.equal(
      checkWork('{"Slash":{"name":"help","values":{}},"extra":1}'),
      false
    );
    assert.equal(
      checkWork('{"Slash":{"name":"help","values":{}},"Autocomplete":{"command_name":"c","option_name":"o","current":"v"}}'),
      false
    );
  });

  it("rejects work wrapper when variant body is not a non-null non-array object", () => {
    const badBodies: string[] = ["null", '"help"', "123", "true", "[]"];
    for (const bad of badBodies) {
      assert.equal(
        checkWork(`{"Slash":${bad}}`),
        false,
        `expected rejection for Slash body: ${bad}`
      );
      assert.equal(
        checkWork(`{"Autocomplete":${bad}}`),
        false,
        `expected rejection for Autocomplete body: ${bad}`
      );
    }
  });

  it("rejects unknown work variant keys", () => {
    const unknownVariants: string[] = [
      '{"Unknown":{}}',
      '{"Command":{"Help":{}}}',
      '{"Plan":{"Respond":"ok"}}',
      '{"slash":{"name":"help","values":{}}}',
      '{"autocomplete":{"command_name":"c","option_name":"o","current":"v"}}',
    ];
    for (const raw of unknownVariants) {
      assert.equal(checkWork(raw), false, `expected rejection for unknown variant: ${raw}`);
    }
  });

  it("verifies minimal Component routing integration without duplicating suite 125", () => {
    assert.equal(
      checkWork('{"Component":{"Input":{"thread_id":"tid","value":"val"}}}'),
      true
    );
    assert.equal(
      checkWork('{"Component":{"BoundInput":{"thread_fingerprint":"tf","request_fingerprint":"rf","value":"val"}}}'),
      true
    );
    assert.equal(checkWork('{"Component":{"InvalidVariant":{}}}'), false);
    assert.equal(checkWork('{"Component":null}'), false);
    assert.equal(checkWork('{"Component":[]}'), false);
  });
});

describe("asyncLifecycleOrdinary - work Slash name validation", () => {
  it("accepts all 19 valid slash names with empty values map", () => {
    for (const name of VALID_SLASH_NAMES) {
      assert.equal(
        checkWork(`{"Slash":{"name":"${name}","values":{}}}`),
        true,
        `expected valid slash name: ${name}`
      );
    }
  });

  it("rejects unknown, case-variant, control, and non-string slash names", () => {
    const invalidNames: string[] = [
      '""',
      '"unknown"',
      '"custom"',
      '"ping"',
      '"foo"',
      '"Help"',
      '"HELP"',
      '"List"',
      '"Settings"',
      '"Status"',
      '"RestartCodex"',
      '"ForceRestartCodex"',
      '"HostReboot"',
      '"Identity"',
      '"Resources"',
      '"restart_codex"',
      "123",
      "true",
      "false",
      "null",
      "[]",
      "{}",
    ];
    for (const rawName of invalidNames) {
      assert.equal(
        checkWork(`{"Slash":{"name":${rawName},"values":{}}}`),
        false,
        `expected rejection for slash name: ${rawName}`
      );
    }
  });

  it("rejects Slash when name field is missing", () => {
    assert.equal(checkWork('{"Slash":{"values":{}}}'), false);
  });
});

describe("asyncLifecycleOrdinary - work Slash Integer boundary matrix", () => {
  it("accepts valid i64 integers at zero, unit, 32-bit, and 64-bit boundaries", () => {
    const validIntegers: string[] = [
      "0",
      "1",
      "-1",
      "42",
      "-42",
      "2147483647",
      "-2147483648",
      "4294967295",
      "9223372036854775807",
      "-9223372036854775808",
    ];
    for (const rawInt of validIntegers) {
      assert.equal(
        checkWork(`{"Slash":{"name":"help","values":{"v":{"Integer":${rawInt}}}}}`),
        true,
        `expected valid integer: ${rawInt}`
      );
    }
  });

  it("rejects out-of-range integers exceeding i64 range", () => {
    const outOfRange: string[] = [
      "9223372036854775808",
      "9223372036854775809",
      "-9223372036854775809",
      "-9223372036854775810",
      "18446744073709551615",
      "18446744073709551616",
    ];
    for (const rawInt of outOfRange) {
      assert.equal(
        checkWork(`{"Slash":{"name":"help","values":{"v":{"Integer":${rawInt}}}}}`),
        false,
        `expected out-of-range rejection: ${rawInt}`
      );
    }
  });

  it("rejects decimals, exponents, and negative zero in Integer variant", () => {
    const invalidFormats: string[] = [
      "0.0",
      "1.0",
      "-1.0",
      "42.5",
      "0.5",
      "-0.5",
      "1e0",
      "1e3",
      "1E3",
      "10e0",
      "1e-1",
      "-0",
    ];
    for (const rawNum of invalidFormats) {
      assert.equal(
        checkWork(`{"Slash":{"name":"help","values":{"v":{"Integer":${rawNum}}}}}`),
        false,
        `expected rejection for non-integer format: ${rawNum}`
      );
    }
  });

  it("rejects non-numeric primitives and structures for Integer variant", () => {
    const invalidTypes: string[] = [
      '"42"',
      '""',
      "true",
      "false",
      "null",
      "{}",
      "[]",
      "[42]",
      '{"val":42}',
    ];
    for (const rawVal of invalidTypes) {
      assert.equal(
        checkWork(`{"Slash":{"name":"help","values":{"v":{"Integer":${rawVal}}}}}`),
        false,
        `expected rejection for invalid integer type: ${rawVal}`
      );
    }
  });
});

describe("asyncLifecycleOrdinary - work Slash Boolean and String boundaries", () => {
  it("accepts valid Boolean primitives and rejects non-boolean values", () => {
    assert.equal(checkWork('{"Slash":{"name":"help","values":{"v":{"Boolean":true}}}}'), true);
    assert.equal(checkWork('{"Slash":{"name":"help","values":{"v":{"Boolean":false}}}}'), true);

    const invalidBooleans: string[] = [
      '"true"',
      '"false"',
      "1",
      "0",
      "-1",
      "null",
      "{}",
      "[]",
    ];
    for (const bad of invalidBooleans) {
      assert.equal(
        checkWork(`{"Slash":{"name":"help","values":{"v":{"Boolean":${bad}}}}}`),
        false,
        `expected boolean rejection: ${bad}`
      );
    }
  });

  it("accepts valid String primitives and rejects non-string values", () => {
    assert.equal(checkWork('{"Slash":{"name":"help","values":{"v":{"String":"hello"}}}}'), true);
    assert.equal(checkWork('{"Slash":{"name":"help","values":{"v":{"String":""}}}}'), true);
    assert.equal(checkWork('{"Slash":{"name":"help","values":{"v":{"String":"spaces and : / 123"}}}}'), true);

    const invalidStrings: string[] = [
      "123",
      "0",
      "true",
      "false",
      "null",
      "{}",
      "[]",
      '["hello"]',
    ];
    for (const bad of invalidStrings) {
      assert.equal(
        checkWork(`{"Slash":{"name":"help","values":{"v":{"String":${bad}}}}}`),
        false,
        `expected string rejection: ${bad}`
      );
    }
  });
});

describe("asyncLifecycleOrdinary - work Slash value wrapper structure and mixed values", () => {
  it("rejects value wrappers with zero keys, multiple keys, or invalid tags", () => {
    const invalidWrappers: string[] = [
      "{}",
      '{"Boolean":true,"String":"extra"}',
      '{"Integer":1,"extra":2}',
      '{"Float":1.5}',
      '{"Number":42}',
      '{"U64":42}',
      '{"I64":42}',
      '{"string":"valid"}',
      '{"boolean":true}',
      '{"integer":1}',
      '"primitive"',
      "42",
      "true",
      "null",
      "[]",
    ];
    for (const rawWrap of invalidWrappers) {
      assert.equal(
        checkWork(`{"Slash":{"name":"help","values":{"v":${rawWrap}}}}`),
        false,
        `expected rejection for value wrapper: ${rawWrap}`
      );
    }
  });

  it("rejects non-object values container", () => {
    const invalidContainers: string[] = [
      "null",
      "[]",
      '"values"',
      "123",
      "true",
    ];
    for (const bad of invalidContainers) {
      assert.equal(
        checkWork(`{"Slash":{"name":"help","values":${bad}}}`),
        false,
        `expected rejection for values container: ${bad}`
      );
    }
  });

  it("rejects missing values field on Slash", () => {
    assert.equal(checkWork('{"Slash":{"name":"help"}}'), false);
  });

  it("accepts mixed valid values and rejects if any entry is invalid", () => {
    const validMixed =
      '{"Slash":{"name":"help","values":{"b":{"Boolean":true},"i":{"Integer":100},"s":{"String":"test"}}}}';
    assert.equal(checkWork(validMixed), true);

    const validMulti =
      '{"Slash":{"name":"list","values":{"f1":{"Boolean":false},"f2":{"Integer":-50},"f3":{"String":""},"f4":{"Integer":9223372036854775807}}}}';
    assert.equal(checkWork(validMulti), true);

    const mixedWithInvalid: string[] = [
      '{"Slash":{"name":"help","values":{"b":{"Boolean":true},"bad":{"Integer":1.5}}}}',
      '{"Slash":{"name":"help","values":{"s":{"String":"ok"},"bad":{"Boolean":"true"}}}}',
      '{"Slash":{"name":"help","values":{"i":{"Integer":1},"bad":{"String":null}}}}',
      '{"Slash":{"name":"help","values":{"b":{"Boolean":true},"bad":{"Unknown":1}}}}',
      '{"Slash":{"name":"help","values":{"b":{"Boolean":true},"bad":null}}}',
      '{"Slash":{"name":"help","values":{"b":{"Boolean":true},"bad":{}}}}',
    ];
    for (const raw of mixedWithInvalid) {
      assert.equal(checkWork(raw), false, `expected mixed rejection: ${raw}`);
    }
  });

  it("permits extra fields on Slash object", () => {
    assert.equal(
      checkWork('{"Slash":{"name":"help","values":{},"extra":123,"flag":true}}'),
      true
    );
  });
});

describe("asyncLifecycleOrdinary - work Autocomplete boundaries", () => {
  it("accepts valid Autocomplete with selected_model missing, null, or string", () => {
    assert.equal(
      checkWork('{"Autocomplete":{"command_name":"use","option_name":"model","current":"gpt"}}'),
      true
    );
    assert.equal(
      checkWork('{"Autocomplete":{"command_name":"use","option_name":"model","current":"gpt","selected_model":null}}'),
      true
    );
    assert.equal(
      checkWork('{"Autocomplete":{"command_name":"use","option_name":"model","current":"gpt","selected_model":"gpt-4"}}'),
      true
    );
    assert.equal(
      checkWork('{"Autocomplete":{"command_name":"use","option_name":"model","current":"gpt","selected_model":""}}'),
      true
    );
    assert.equal(
      checkWork('{"Autocomplete":{"command_name":"","option_name":"","current":""}}'),
      true
    );
  });

  it("permits extra fields on Autocomplete", () => {
    assert.equal(
      checkWork('{"Autocomplete":{"command_name":"use","option_name":"model","current":"gpt","extra_key":"val","num":123}}'),
      true
    );
    assert.equal(
      checkWork('{"Autocomplete":{"command_name":"use","option_name":"model","current":"gpt","selected_model":"m","flag":false}}'),
      true
    );
  });

  it("rejects Autocomplete when required fields are missing", () => {
    assert.equal(
      checkWork('{"Autocomplete":{"option_name":"model","current":"gpt"}}'),
      false
    );
    assert.equal(
      checkWork('{"Autocomplete":{"command_name":"use","current":"gpt"}}'),
      false
    );
    assert.equal(
      checkWork('{"Autocomplete":{"command_name":"use","option_name":"model"}}'),
      false
    );
    assert.equal(checkWork('{"Autocomplete":{}}'), false);
  });

  it("rejects Autocomplete when required fields are not strings", () => {
    const nonStrings: string[] = ["null", "123", "true", "{}", "[]"];
    for (const bad of nonStrings) {
      assert.equal(
        checkWork(`{"Autocomplete":{"command_name":${bad},"option_name":"o","current":"c"}}`),
        false,
        `expected rejection for command_name: ${bad}`
      );
      assert.equal(
        checkWork(`{"Autocomplete":{"command_name":"c","option_name":${bad},"current":"c"}}`),
        false,
        `expected rejection for option_name: ${bad}`
      );
      assert.equal(
        checkWork(`{"Autocomplete":{"command_name":"c","option_name":"o","current":${bad}}}`),
        false,
        `expected rejection for current: ${bad}`
      );
    }
  });

  it("rejects Autocomplete when selected_model is of invalid type", () => {
    const invalidModelTypes: string[] = ["123", "true", "false", "{}", "[]", '["model"]'];
    for (const bad of invalidModelTypes) {
      assert.equal(
        checkWork(`{"Autocomplete":{"command_name":"c","option_name":"o","current":"v","selected_model":${bad}}}`),
        false,
        `expected rejection for selected_model: ${bad}`
      );
    }
  });
});
