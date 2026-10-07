import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { asyncLifecycleOrdinary } from "../../src/store/async-resolution-ordinary.ts";
import { parseSerdeValue } from "../../src/store/async-resolution-json-helpers.ts";

function runComponent(rawComponent: string): boolean {
  return asyncLifecycleOrdinary(
    parseSerdeValue(`{"version":1,"work":{"Component":${rawComponent}}}`),
  );
}

function runVariant(variant: string, rawFields: string): boolean {
  return runComponent(`{"${variant}":${rawFields}}`);
}

const HEX32 = "0123456789abcdef0123456789abcdef";
const I64_MAX_STR = "9223372036854775807";

describe("async lifecycle ordinary component variants", () => {
  describe("Component harness and variant body envelope", () => {
    it("rejects non-object Component values", () => {
      for (const nonObj of ["null", "[]", '"string"', "123", "true", "false"]) {
        assert.equal(runComponent(nonObj), false);
      }
    });

    it("rejects empty or multi-key Component wrappers and unknown variants", () => {
      assert.equal(runComponent("{}"), false);
      assert.equal(
        runComponent(
          `{"AsyncChoice":{"question_id":"q","option":0},"Busy":{"choice_id":"c","action":"Steer"}}`,
        ),
        false,
      );
      assert.equal(runComponent('{"UnknownVariant":{}}'), false);
    });

    it("rejects non-object bodies for all 8 component variants", () => {
      const variants = [
        "AsyncChoice",
        "RecoveryPublicationDecision",
        "RecoveryAbandonDecision",
        "Busy",
        "Input",
        "BoundInput",
        "Approval",
        "BoundApproval",
      ];
      for (const variant of variants) {
        for (const badBody of ["null", "[]", '"primitive"', "42", "true"]) {
          assert.equal(runVariant(variant, badBody), false);
        }
      }
    });
  });

  describe("AsyncChoice", () => {
    it("accepts valid boundary options and allows extra fields", () => {
      const validCases = [
        '{"question_id":"q1","option":0}',
        '{"question_id":"q1","option":1}',
        '{"question_id":"q1","option":24}',
        '{"question_id":"q1","option":0,"extra_field":"allowed"}',
        '{"question_id":"","option":0}',
      ];
      for (const c of validCases) {
        assert.equal(runVariant("AsyncChoice", c), true);
      }
    });

    it("rejects invalid options: 25, out of range, negative, floats, exponents, non-integers", () => {
      const invalidOptions = [
        '{"question_id":"q1","option":25}',
        '{"question_id":"q1","option":26}',
        '{"question_id":"q1","option":18446744073709551615}',
        '{"question_id":"q1","option":18446744073709551616}',
        '{"question_id":"q1","option":-1}',
        '{"question_id":"q1","option":-9223372036854775808}',
        '{"question_id":"q1","option":0.0}',
        '{"question_id":"q1","option":1.5}',
        '{"question_id":"q1","option":0e0}',
        '{"question_id":"q1","option":1e1}',
        '{"question_id":"q1","option":null}',
        '{"question_id":"q1","option":"0"}',
        '{"question_id":"q1","option":"24"}',
        '{"question_id":"q1","option":true}',
        '{"question_id":"q1","option":[]}',
        '{"question_id":"q1","option":{}}',
        '{"question_id":"q1"}',
      ];
      for (const c of invalidOptions) {
        assert.equal(runVariant("AsyncChoice", c), false);
      }
    });

    it("rejects missing or invalid question_id strings", () => {
      const invalidQuestionIds = [
        '{"option":0}',
        '{"question_id":null,"option":0}',
        '{"question_id":123,"option":0}',
        '{"question_id":true,"option":0}',
        '{"question_id":[],"option":0}',
        '{"question_id":{},"option":0}',
      ];
      for (const c of invalidQuestionIds) {
        assert.equal(runVariant("AsyncChoice", c), false);
      }
    });
  });

  describe("RecoveryPublicationDecision", () => {
    it("accepts exact 3 fields with ApproveExact and KeepHeld up to i64::MAX", () => {
      const validCases = [
        `{"proposal_id":"${HEX32}","revision":1,"decision":"ApproveExact"}`,
        `{"proposal_id":"${HEX32}","revision":1,"decision":"KeepHeld"}`,
        `{"proposal_id":"${HEX32}","revision":${I64_MAX_STR},"decision":"ApproveExact"}`,
        `{"proposal_id":"${HEX32}","revision":${I64_MAX_STR},"decision":"KeepHeld"}`,
      ];
      for (const c of validCases) {
        assert.equal(runVariant("RecoveryPublicationDecision", c), true);
      }
    });

    it("rejects extra fields or missing fields (must have exact 3 fields)", () => {
      const badFieldCounts = [
        `{"proposal_id":"${HEX32}","revision":1,"decision":"ApproveExact","extra":true}`,
        `{"proposal_id":"${HEX32}","revision":1}`,
        `{"proposal_id":"${HEX32}","decision":"ApproveExact"}`,
        `{"revision":1,"decision":"ApproveExact"}`,
        "{}",
      ];
      for (const c of badFieldCounts) {
        assert.equal(runVariant("RecoveryPublicationDecision", c), false);
      }
    });

    it("rejects non-32-lowerhex proposal_ids: length, hyphens, uppercase, LF, non-hex", () => {
      const invalidProposals = [
        "0123456789abcdef0123456789abcde",
        "0123456789abcdef0123456789abcdef0",
        "0123456789ABCDEF0123456789ABCDEF",
        "0123456789abcdef0123456789abcdeF",
        "01234567-89ab-cdef-0123-456789abcdef",
        "0123456789abcdef0123456789abcdef\\n",
        "0123456789abcdef0123456789abcdeg",
        "",
      ];
      for (const p of invalidProposals) {
        assert.equal(
          runVariant(
            "RecoveryPublicationDecision",
            `{"proposal_id":"${p}","revision":1,"decision":"ApproveExact"}`,
          ),
          false,
        );
      }
      for (const badType of ["null", "123", "true", "[]", "{}"]) {
        assert.equal(
          runVariant(
            "RecoveryPublicationDecision",
            `{"proposal_id":${badType},"revision":1,"decision":"ApproveExact"}`,
          ),
          false,
        );
      }
    });

    it("rejects invalid revision: 0, negative, float, exponent, out of range, non-integer", () => {
      const invalidRevisions = [
        "0",
        "-1",
        "-9223372036854775808",
        "9223372036854775808",
        "18446744073709551615",
        "1.0",
        "2.5",
        "1e0",
        "null",
        '"1"',
        "true",
      ];
      for (const rev of invalidRevisions) {
        assert.equal(
          runVariant(
            "RecoveryPublicationDecision",
            `{"proposal_id":"${HEX32}","revision":${rev},"decision":"ApproveExact"}`,
          ),
          false,
        );
      }
    });

    it("rejects wrong decision choices or wrong casing", () => {
      const invalidDecisions = [
        '"AbandonOnly"',
        '"ApproveSession"',
        '"Approve"',
        '"approveExact"',
        '"keepHeld"',
        '"APPROVE_EXACT"',
        '""',
        "null",
        "123",
        "true",
      ];
      for (const dec of invalidDecisions) {
        assert.equal(
          runVariant(
            "RecoveryPublicationDecision",
            `{"proposal_id":"${HEX32}","revision":1,"decision":${dec}}`,
          ),
          false,
        );
      }
    });
  });

  describe("RecoveryAbandonDecision", () => {
    it("accepts exact 3 fields with AbandonOnly and KeepHeld up to i64::MAX", () => {
      const validCases = [
        `{"proposal_id":"${HEX32}","revision":1,"decision":"AbandonOnly"}`,
        `{"proposal_id":"${HEX32}","revision":1,"decision":"KeepHeld"}`,
        `{"proposal_id":"${HEX32}","revision":${I64_MAX_STR},"decision":"AbandonOnly"}`,
        `{"proposal_id":"${HEX32}","revision":${I64_MAX_STR},"decision":"KeepHeld"}`,
      ];
      for (const c of validCases) {
        assert.equal(runVariant("RecoveryAbandonDecision", c), true);
      }
    });

    it("rejects extra fields or missing fields (must have exact 3 fields)", () => {
      const badFieldCounts = [
        `{"proposal_id":"${HEX32}","revision":1,"decision":"AbandonOnly","extra":true}`,
        `{"proposal_id":"${HEX32}","revision":1}`,
        `{"proposal_id":"${HEX32}","decision":"AbandonOnly"}`,
        `{"revision":1,"decision":"AbandonOnly"}`,
        "{}",
      ];
      for (const c of badFieldCounts) {
        assert.equal(runVariant("RecoveryAbandonDecision", c), false);
      }
    });

    it("rejects non-32-lowerhex proposal_ids: length, hyphens, uppercase, LF, non-hex", () => {
      const invalidProposals = [
        "0123456789abcdef0123456789abcde",
        "0123456789abcdef0123456789abcdef0",
        "0123456789ABCDEF0123456789ABCDEF",
        "0123456789abcdef0123456789abcdeF",
        "01234567-89ab-cdef-0123-456789abcdef",
        "0123456789abcdef0123456789abcdef\\n",
        "0123456789abcdef0123456789abcdeg",
        "",
      ];
      for (const p of invalidProposals) {
        assert.equal(
          runVariant(
            "RecoveryAbandonDecision",
            `{"proposal_id":"${p}","revision":1,"decision":"AbandonOnly"}`,
          ),
          false,
        );
      }
      for (const badType of ["null", "123", "true", "[]", "{}"]) {
        assert.equal(
          runVariant(
            "RecoveryAbandonDecision",
            `{"proposal_id":${badType},"revision":1,"decision":"AbandonOnly"}`,
          ),
          false,
        );
      }
    });

    it("rejects invalid revision: 0, negative, float, exponent, out of range, non-integer", () => {
      const invalidRevisions = [
        "0",
        "-1",
        "-9223372036854775808",
        "9223372036854775808",
        "18446744073709551615",
        "1.0",
        "2.5",
        "1e0",
        "null",
        '"1"',
        "true",
      ];
      for (const rev of invalidRevisions) {
        assert.equal(
          runVariant(
            "RecoveryAbandonDecision",
            `{"proposal_id":"${HEX32}","revision":${rev},"decision":"AbandonOnly"}`,
          ),
          false,
        );
      }
    });

    it("rejects wrong decision choices or wrong casing", () => {
      const invalidDecisions = [
        '"ApproveExact"',
        '"AbandonExact"',
        '"abandonOnly"',
        '"keepHeld"',
        '"ABANDON_ONLY"',
        '""',
        "null",
        "123",
        "true",
      ];
      for (const dec of invalidDecisions) {
        assert.equal(
          runVariant(
            "RecoveryAbandonDecision",
            `{"proposal_id":"${HEX32}","revision":1,"decision":${dec}}`,
          ),
          false,
        );
      }
    });
  });

  describe("Busy", () => {
    it("accepts all allowed actions and permits extra fields", () => {
      const validCases = [
        '{"choice_id":"c1","action":"Steer"}',
        '{"choice_id":"c1","action":"Queue"}',
        '{"choice_id":"c1","action":"Ignore"}',
        '{"choice_id":"c1","action":"Steer","extra_key":"permitted","count":10}',
        '{"choice_id":"","action":"Steer"}',
      ];
      for (const c of validCases) {
        assert.equal(runVariant("Busy", c), true);
      }
    });

    it("rejects wrong case, unknown action, missing action, and non-string action", () => {
      const invalidActions = [
        '{"choice_id":"c1","action":"steer"}',
        '{"choice_id":"c1","action":"queue"}',
        '{"choice_id":"c1","action":"ignore"}',
        '{"choice_id":"c1","action":"STEER"}',
        '{"choice_id":"c1","action":"QUEUE"}',
        '{"choice_id":"c1","action":"IGNORE"}',
        '{"choice_id":"c1","action":"Wait"}',
        '{"choice_id":"c1","action":"Approve"}',
        '{"choice_id":"c1","action":"Cancel"}',
        '{"choice_id":"c1","action":""}',
        '{"choice_id":"c1","action":null}',
        '{"choice_id":"c1","action":123}',
        '{"choice_id":"c1","action":true}',
        '{"choice_id":"c1","action":[]}',
        '{"choice_id":"c1","action":{}}',
        '{"choice_id":"c1"}',
      ];
      for (const c of invalidActions) {
        assert.equal(runVariant("Busy", c), false);
      }
    });

    it("rejects missing or invalid choice_id", () => {
      const invalidChoiceIds = [
        '{"action":"Steer"}',
        '{"choice_id":null,"action":"Steer"}',
        '{"choice_id":123,"action":"Steer"}',
        '{"choice_id":true,"action":"Steer"}',
        '{"choice_id":[],"action":"Steer"}',
        '{"choice_id":{},"action":"Steer"}',
      ];
      for (const c of invalidChoiceIds) {
        assert.equal(runVariant("Busy", c), false);
      }
    });
  });

  describe("Input", () => {
    it("accepts valid thread_id and value and permits extra fields", () => {
      const validCases = [
        '{"thread_id":"t1","value":"v1"}',
        '{"thread_id":"","value":""}',
        '{"thread_id":"t1","value":"v1","extra_field":"permitted","num":1}',
      ];
      for (const c of validCases) {
        assert.equal(runVariant("Input", c), true);
      }
    });

    it("rejects missing or non-string thread_id or value", () => {
      const invalidCases = [
        '{"value":"v1"}',
        '{"thread_id":"t1"}',
        "{}",
        '{"thread_id":null,"value":"v1"}',
        '{"thread_id":123,"value":"v1"}',
        '{"thread_id":true,"value":"v1"}',
        '{"thread_id":[],"value":"v1"}',
        '{"thread_id":{},"value":"v1"}',
        '{"thread_id":"t1","value":null}',
        '{"thread_id":"t1","value":123}',
        '{"thread_id":"t1","value":true}',
        '{"thread_id":"t1","value":[]}',
        '{"thread_id":"t1","value":{}}',
      ];
      for (const c of invalidCases) {
        assert.equal(runVariant("Input", c), false);
      }
    });
  });

  describe("BoundInput", () => {
    it("accepts valid triple strings and permits extra fields", () => {
      const validCases = [
        '{"thread_fingerprint":"tf1","request_fingerprint":"rf1","value":"v1"}',
        '{"thread_fingerprint":"","request_fingerprint":"","value":""}',
        '{"thread_fingerprint":"tf1","request_fingerprint":"rf1","value":"v1","extra":"permitted"}',
      ];
      for (const c of validCases) {
        assert.equal(runVariant("BoundInput", c), true);
      }
    });

    it("rejects missing or non-string identity and value fields", () => {
      const invalidCases = [
        '{"request_fingerprint":"rf1","value":"v1"}',
        '{"thread_fingerprint":"tf1","value":"v1"}',
        '{"thread_fingerprint":"tf1","request_fingerprint":"rf1"}',
        "{}",
        '{"thread_fingerprint":null,"request_fingerprint":"rf1","value":"v1"}',
        '{"thread_fingerprint":123,"request_fingerprint":"rf1","value":"v1"}',
        '{"thread_fingerprint":"tf1","request_fingerprint":null,"value":"v1"}',
        '{"thread_fingerprint":"tf1","request_fingerprint":123,"value":"v1"}',
        '{"thread_fingerprint":"tf1","request_fingerprint":"rf1","value":null}',
        '{"thread_fingerprint":"tf1","request_fingerprint":"rf1","value":123}',
        '{"thread_fingerprint":"tf1","request_fingerprint":"rf1","value":true}',
        '{"thread_fingerprint":"tf1","request_fingerprint":"rf1","value":[]}',
        '{"thread_fingerprint":"tf1","request_fingerprint":"rf1","value":{}}',
      ];
      for (const c of invalidCases) {
        assert.equal(runVariant("BoundInput", c), false);
      }
    });
  });

  describe("Approval", () => {
    it("accepts all 4 allowed answers and permits extra fields", () => {
      const validAnswers = ["Approve", "ApproveSession", "Reject", "Cancel"];
      for (const ans of validAnswers) {
        assert.equal(
          runVariant("Approval", `{"thread_id":"t1","answer":"${ans}"}`),
          true,
        );
      }
      assert.equal(
        runVariant(
          "Approval",
          '{"thread_id":"t1","answer":"Approve","extra_key":"permitted"}',
        ),
        true,
      );
      assert.equal(
        runVariant("Approval", '{"thread_id":"","answer":"Approve"}'),
        true,
      );
    });

    it("rejects wrong case, invalid answers, missing answer, and non-string answers", () => {
      const invalidAnswers = [
        '{"thread_id":"t1","answer":"approve"}',
        '{"thread_id":"t1","answer":"approvesession"}',
        '{"thread_id":"t1","answer":"reject"}',
        '{"thread_id":"t1","answer":"cancel"}',
        '{"thread_id":"t1","answer":"APPROVE"}',
        '{"thread_id":"t1","answer":"APPROVE_SESSION"}',
        '{"thread_id":"t1","answer":"REJECT"}',
        '{"thread_id":"t1","answer":"CANCEL"}',
        '{"thread_id":"t1","answer":"ApproveExact"}',
        '{"thread_id":"t1","answer":"AbandonOnly"}',
        '{"thread_id":"t1","answer":"KeepHeld"}',
        '{"thread_id":"t1","answer":"Steer"}',
        '{"thread_id":"t1","answer":""}',
        '{"thread_id":"t1","answer":null}',
        '{"thread_id":"t1","answer":123}',
        '{"thread_id":"t1","answer":true}',
        '{"thread_id":"t1","answer":[]}',
        '{"thread_id":"t1","answer":{}}',
        '{"thread_id":"t1"}',
      ];
      for (const c of invalidAnswers) {
        assert.equal(runVariant("Approval", c), false);
      }
    });

    it("rejects missing or non-string thread_id", () => {
      const invalidThreadIds = [
        '{"answer":"Approve"}',
        '{"thread_id":null,"answer":"Approve"}',
        '{"thread_id":123,"answer":"Approve"}',
        '{"thread_id":true,"answer":"Approve"}',
        '{"thread_id":[],"answer":"Approve"}',
        '{"thread_id":{},"answer":"Approve"}',
      ];
      for (const c of invalidThreadIds) {
        assert.equal(runVariant("Approval", c), false);
      }
    });
  });

  describe("BoundApproval", () => {
    it("accepts all 4 allowed answers and permits extra fields", () => {
      const validAnswers = ["Approve", "ApproveSession", "Reject", "Cancel"];
      for (const ans of validAnswers) {
        assert.equal(
          runVariant(
            "BoundApproval",
            `{"thread_fingerprint":"tf1","request_fingerprint":"rf1","answer":"${ans}"}`,
          ),
          true,
        );
      }
      assert.equal(
        runVariant(
          "BoundApproval",
          '{"thread_fingerprint":"tf1","request_fingerprint":"rf1","answer":"Approve","extra_key":"permitted"}',
        ),
        true,
      );
      assert.equal(
        runVariant(
          "BoundApproval",
          '{"thread_fingerprint":"","request_fingerprint":"","answer":"Approve"}',
        ),
        true,
      );
    });

    it("rejects wrong case, invalid answers, missing answer, and non-string answers", () => {
      const invalidAnswers = [
        '{"thread_fingerprint":"tf1","request_fingerprint":"rf1","answer":"approve"}',
        '{"thread_fingerprint":"tf1","request_fingerprint":"rf1","answer":"approvesession"}',
        '{"thread_fingerprint":"tf1","request_fingerprint":"rf1","answer":"reject"}',
        '{"thread_fingerprint":"tf1","request_fingerprint":"rf1","answer":"cancel"}',
        '{"thread_fingerprint":"tf1","request_fingerprint":"rf1","answer":"APPROVE"}',
        '{"thread_fingerprint":"tf1","request_fingerprint":"rf1","answer":"ApproveExact"}',
        '{"thread_fingerprint":"tf1","request_fingerprint":"rf1","answer":""}',
        '{"thread_fingerprint":"tf1","request_fingerprint":"rf1","answer":null}',
        '{"thread_fingerprint":"tf1","request_fingerprint":"rf1","answer":123}',
        '{"thread_fingerprint":"tf1","request_fingerprint":"rf1"}',
      ];
      for (const c of invalidAnswers) {
        assert.equal(runVariant("BoundApproval", c), false);
      }
    });

    it("rejects missing or non-string identity fields", () => {
      const invalidIdentities = [
        '{"request_fingerprint":"rf1","answer":"Approve"}',
        '{"thread_fingerprint":"tf1","answer":"Approve"}',
        '{"answer":"Approve"}',
        '{"thread_fingerprint":null,"request_fingerprint":"rf1","answer":"Approve"}',
        '{"thread_fingerprint":123,"request_fingerprint":"rf1","answer":"Approve"}',
        '{"thread_fingerprint":true,"request_fingerprint":"rf1","answer":"Approve"}',
        '{"thread_fingerprint":[],"request_fingerprint":"rf1","answer":"Approve"}',
        '{"thread_fingerprint":{},"request_fingerprint":"rf1","answer":"Approve"}',
        '{"thread_fingerprint":"tf1","request_fingerprint":null,"answer":"Approve"}',
        '{"thread_fingerprint":"tf1","request_fingerprint":123,"answer":"Approve"}',
        '{"thread_fingerprint":"tf1","request_fingerprint":true,"answer":"Approve"}',
        '{"thread_fingerprint":"tf1","request_fingerprint":[],"answer":"Approve"}',
        '{"thread_fingerprint":"tf1","request_fingerprint":{},"answer":"Approve"}',
      ];
      for (const c of invalidIdentities) {
        assert.equal(runVariant("BoundApproval", c), false);
      }
    });
  });
});
