import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CLEANUP_REFUSAL_REASONS,
  cleanupRefusalFromOutcome,
  isCleanupRefusalReason,
} from "../../src/store/async-resolution-cleanup-refusal.ts";
import {
  asyncLifecycleDeclaredControl,
  control,
} from "../../src/store/async-resolution-declared-control.ts";
import {
  I64_MAX,
  parseSerdeValue,
} from "../../src/store/async-resolution-json-helpers.ts";

function makeRefusalJson(
  patch?: Readonly<Record<string, string | null>>,
  extra?: string,
): string {
  const fields: Record<string, string> = {
    kind: '"mirror_cleanup_refused"',
    version: "1",
    sync_completed: "false",
    delete_dispatched: "false",
    earlier_changes_possible: "true",
    blocked_room_id: "42",
    protection_reason: '"ingress"',
  };
  if (patch !== undefined) {
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) {
        delete fields[key];
      } else {
        fields[key] = value;
      }
    }
  }
  const parts = Object.entries(fields).map(([k, v]) => `"${k}":${v}`);
  if (extra !== undefined) {
    parts.push(extra);
  }
  return `{${parts.join(",")}}`;
}

describe("async-resolution declared control", () => {
  describe("control helper", () => {
    const cases: readonly (readonly [string, boolean])[] = [
      ['"Stop"', true],
      ['"Archive"', true],
      ['{"Stop": null}', true],
      ['{"Archive": 1}', true],
      ['{"Stop": {}}', true],
      ['{"Archive": false}', true],
      ['"stop"', false],
      ['"archive"', false],
      ['"Other"', false],
      ["{}", false],
      ['{"other": 1}', false],
      ["null", false],
      ["123", false],
      ["true", false],
      ['["Stop"]', false],
    ];

    for (const [json, expected] of cases) {
      it(`evaluates control(${json}) -> ${expected}`, () => {
        assert.strictEqual(control(parseSerdeValue(json)), expected);
      });
    }
  });

  describe("asyncLifecycleDeclaredControl four paths and negatives", () => {
    const cases: readonly (readonly [string, boolean])[] = [
      ['{"plan":{"Execute":"Stop"}}', true],
      ['{"plan":{"Execute":"Archive"}}', true],
      ['{"plan":{"Execute":{"Stop":null}}}', true],
      ['{"plan":{"Execute":{"Archive":1}}}', true],
      ['{"lifecycle_binding":{"command":"Stop"}}', true],
      ['{"lifecycle_binding":{"command":"Archive"}}', true],
      ['{"lifecycle_binding":{"command":{"Stop":true}}}', true],
      ['{"lifecycle_binding":{"command":{"Archive":{}}}}', true],
      ['{"work":{"Slash":{"name":"stop"}}}', true],
      ['{"work":{"Slash":{"name":"archive"}}}', true],
      ['{"command":"stop"}', true],
      ['{"command":"archive"}', true],
      ['{"work":{"Slash":{"name":"Stop"}}}', false],
      ['{"work":{"Slash":{"name":"Archive"}}}', false],
      ['{"command":"Stop"}', false],
      ['{"command":"Archive"}', false],
      ['{"command":"status"}', false],
      ['{"command":"start"}', false],
      ['{"command":"pause"}', false],
      ['{"command":"stop_all"}', false],
      ['{"work":{"Slash":{"name":"status"}}}', false],
      ['{"work":{"Slash":{"name":"start"}}}', false],
      ['{"plan":{"Execute":"Run"}}', false],
      ['{"plan":{"Execute":{"Run":1}}}', false],
      ['{"lifecycle_binding":{"command":"Run"}}', false],
      ["null", false],
      ["[]", false],
      ['["Stop"]', false],
      ["123", false],
      ['"stop"', false],
      ["{}", false],
      ['{"plan":{}}', false],
      ['{"work":{}}', false],
      ['{"work":{"Slash":null}}', false],
      ['{"lifecycle_binding":{}}', false],
    ];

    for (const [json, expected] of cases) {
      it(`evaluates payload ${json} -> ${expected}`, () => {
        assert.strictEqual(
          asyncLifecycleDeclaredControl(parseSerdeValue(json)),
          expected,
        );
      });
    }
  });
});

describe("async-resolution cleanup refusal", () => {
  describe("isCleanupRefusalReason", () => {
    it("accepts all 9 authoritative reasons", () => {
      assert.strictEqual(CLEANUP_REFUSAL_REASONS.length, 9);
      for (const reason of CLEANUP_REFUSAL_REASONS) {
        assert.strictEqual(isCleanupRefusalReason(reason), true);
      }
    });

    it("rejects invalid reasons", () => {
      const invalid = ["", "unknown", "ingress ", "INGRESS", "queued requests "];
      for (const reason of invalid) {
        assert.strictEqual(isCleanupRefusalReason(reason), false);
      }
    });
  });

  describe("cleanupRefusalFromOutcome valid extraction", () => {
    it("extracts valid outcome with room as bigint and matching reason", () => {
      const parsed = cleanupRefusalFromOutcome(
        parseSerdeValue(makeRefusalJson()),
      );
      assert.notStrictEqual(parsed, undefined);
      assert.strictEqual(typeof parsed?.room, "bigint");
      assert.strictEqual(parsed?.room, 42n);
      assert.strictEqual(parsed?.reason, "ingress");
      assert.deepEqual(parsed, { room: 42n, reason: "ingress" });
    });

    it("accepts all 9 reasons in full outcome payload", () => {
      for (const reason of CLEANUP_REFUSAL_REASONS) {
        const json = makeRefusalJson({
          protection_reason: JSON.stringify(reason),
        });
        const parsed = cleanupRefusalFromOutcome(parseSerdeValue(json));
        assert.deepEqual(parsed, { room: 42n, reason });
      }
    });

    it("accepts outcome with extra valid own fields", () => {
      const json = makeRefusalJson(
        undefined,
        '"extra_note":"preserve","audit_id":999',
      );
      const parsed = cleanupRefusalFromOutcome(parseSerdeValue(json));
      assert.deepEqual(parsed, { room: 42n, reason: "ingress" });
    });
  });

  describe("cleanupRefusalFromOutcome room bounds", () => {
    it("accepts maximum signed i64 room", () => {
      const json = makeRefusalJson({ blocked_room_id: I64_MAX.toString() });
      const parsed = cleanupRefusalFromOutcome(parseSerdeValue(json));
      assert.deepEqual(parsed, { room: I64_MAX, reason: "ingress" });
    });

    const invalidRooms: readonly (readonly [string, string])[] = [
      ["room 0", "0"],
      ["above max i64", (I64_MAX + 1n).toString()],
      ["negative room", "-1"],
      ["decimal non-integer", "42.5"],
      ["string room", '"42"'],
      ["null room", "null"],
    ];

    for (const [label, val] of invalidRooms) {
      it(`rejects ${label} (${val})`, () => {
        const json = makeRefusalJson({ blocked_room_id: val });
        assert.strictEqual(
          cleanupRefusalFromOutcome(parseSerdeValue(json)),
          undefined,
        );
      });
    }
  });

  describe("cleanupRefusalFromOutcome version validation", () => {
    const invalidVersions: readonly (readonly [string, string])[] = [
      ["decimal version 1.0", "1.0"],
      ["version 2", "2"],
      ["version 0", "0"],
      ["negative version -1", "-1"],
      ["string version", '"1"'],
      ["null version", "null"],
    ];

    for (const [label, val] of invalidVersions) {
      it(`rejects ${label}`, () => {
        const json = makeRefusalJson({ version: val });
        assert.strictEqual(
          cleanupRefusalFromOutcome(parseSerdeValue(json)),
          undefined,
        );
      });
    }
  });

  describe("cleanupRefusalFromOutcome required flags and fields", () => {
    const invalidPatches: readonly (readonly [
      string,
      Record<string, string | null>,
    ])[] = [
      ["sync_completed true", { sync_completed: "true" }],
      ["sync_completed null", { sync_completed: "null" }],
      ["sync_completed missing", { sync_completed: null }],
      ["delete_dispatched true", { delete_dispatched: "true" }],
      ["delete_dispatched null", { delete_dispatched: "null" }],
      ["delete_dispatched missing", { delete_dispatched: null }],
      ["earlier_changes_possible false", { earlier_changes_possible: "false" }],
      ["earlier_changes_possible null", { earlier_changes_possible: "null" }],
      ["earlier_changes_possible missing", { earlier_changes_possible: null }],
      ["kind invalid", { kind: '"mirror_accepted"' }],
      ["kind missing", { kind: null }],
      ["protection_reason invalid", { protection_reason: '"not a reason"' }],
      ["protection_reason missing", { protection_reason: null }],
      ["blocked_room_id missing", { blocked_room_id: null }],
      ["version missing", { version: null }],
    ];

    for (const [label, patch] of invalidPatches) {
      it(`rejects when ${label}`, () => {
        const json = makeRefusalJson(patch);
        assert.strictEqual(
          cleanupRefusalFromOutcome(parseSerdeValue(json)),
          undefined,
        );
      });
    }

    const nonObjects = ["null", "[]", '"mirror_cleanup_refused"', "123", "true"];
    for (const raw of nonObjects) {
      it(`rejects non-object outcome ${raw}`, () => {
        assert.strictEqual(
          cleanupRefusalFromOutcome(parseSerdeValue(raw)),
          undefined,
        );
      });
    }
  });
});
