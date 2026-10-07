import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FailurePhase,
  UNRESOLVED_FORK_ERROR_PREFIX,
  priorError,
  unresolvedMessage,
  unresolvedNotice,
} from "../../src/store/fork-unresolved-format.ts";

describe("fork-unresolved-format", () => {
  it("unresolvedNotice formats exact strings for all three FailurePhase variants", () => {
    const forkErr = "  database spawn timeout  ";
    const expectedForkOutcome =
      "The Codex ownership fork result is uncertain. This request remains queued and will not run until recovery, preventing a duplicate response.\nFork error:   database spawn timeout  ";
    const expectedFinalize =
      "The Codex ownership fork target was created, but local routing finalization failed. This request remains queued and will not run until recovery, preventing a duplicate response.\nFinalize error:   database spawn timeout  ";
    const expectedCancellation =
      "The Codex ownership fork failed and its cancellation could not be confirmed. This request remains queued and will not run until recovery, preventing a duplicate response.\nFailure details:   database spawn timeout  ";

    assert.equal(
      unresolvedNotice(forkErr, "", FailurePhase.ForkOutcome),
      expectedForkOutcome,
    );
    assert.equal(
      unresolvedNotice(forkErr, "", FailurePhase.Finalize),
      expectedFinalize,
    );
    assert.equal(
      unresolvedNotice(forkErr, "", FailurePhase.Cancellation),
      expectedCancellation,
    );
  });

  it("unresolvedNotice preserves unbounded and untrimmed previous error without notice truncation", () => {
    const forkErr = "worker died: ".concat("x".repeat(1200));
    const prevErr = "  prior failure context: ".concat("y".repeat(600), "  ");
    const expected =
      "The Codex ownership fork result is uncertain. This request remains queued and will not run until recovery, preventing a duplicate response.\nFork error: " +
      forkErr +
      "\nPrevious error: " +
      prevErr;

    const actual = unresolvedNotice(forkErr, prevErr, FailurePhase.ForkOutcome);
    assert.equal(actual, expected);
  });

  it("priorError returns bounded raw trimmed message when storedError lacks unresolved prefix", () => {
    const rawStored = "\u0085  worker terminated with code 137  \u0085";
    assert.equal(
      priorError(rawStored, "any previous"),
      "worker terminated with code 137",
    );

    const longError = "e".repeat(300);
    const expectedBounded = "e".repeat(240);
    assert.equal(priorError(longError, "other"), expectedBounded);
  });

  it("priorError returns empty string when storedError matches previousForkError with no previous error", () => {
    const stored = "[cdr-rust:app-server-fork-unresolved:v1] handoff socket hung up";
    const previousFork = "handoff socket hung up";
    assert.equal(priorError(stored, previousFork), "");
  });

  it("priorError returns empty string when latest fork error has changed", () => {
    const stored =
      "[cdr-rust:app-server-fork-unresolved:v1] original failure\nPrevious error: initial root cause";
    assert.equal(priorError(stored, "different current failure"), "");
  });

  it("priorError recovers genuine previous error when stored message exactly matches expected encoding", () => {
    const stored =
      "[cdr-rust:app-server-fork-unresolved:v1] fork timeout\nPrevious error: process out of memory";
    const previousFork = "fork timeout";
    assert.equal(priorError(stored, previousFork), "process out of memory");
  });

  it("priorError extracts only the last previous error label when multiple labels exist", () => {
    const stored =
      "[cdr-rust:app-server-fork-unresolved:v1] err\nPrevious error: fake nested\nPrevious error: genuine earlier error";
    const previousFork = "err\nPrevious error: fake nested";
    assert.equal(priorError(stored, previousFork), "genuine earlier error");
  });

  it("priorError rejects candidate starting with unresolved prefix or failing exact verification", () => {
    const nestedPrefixStored =
      "[cdr-rust:app-server-fork-unresolved:v1] fork failed\nPrevious error: [cdr-rust:app-server-fork-unresolved:v1] inner";
    assert.equal(priorError(nestedPrefixStored, "fork failed"), "");

    const trailingWhitespaceStored =
      "[cdr-rust:app-server-fork-unresolved:v1] fork failed\nPrevious error: tampered  ";
    assert.equal(priorError(trailingWhitespaceStored, "fork failed"), "tampered");

    const nonCanonicalDoubleLeadingWhitespaceStored =
      "[cdr-rust:app-server-fork-unresolved:v1] fork failed\nPrevious error:   tampered";
    assert.equal(
      priorError(nonCanonicalDoubleLeadingWhitespaceStored, "fork failed"),
      "",
    );
  });

  it("unresolvedMessage strips repeated unresolved prefix occurrences and leading whitespace", () => {
    const duplicated =
      "[cdr-rust:app-server-fork-unresolved:v1] [cdr-rust:app-server-fork-unresolved:v1]   inner fork failure";
    const expected =
      "[cdr-rust:app-server-fork-unresolved:v1] inner fork failure";
    assert.equal(unresolvedMessage(duplicated, ""), expected);
  });

  it("rustTrim trims U+0085 NEXT LINE but preserves U+FEFF BOM and U+200B zero-width space", () => {
    const withNextLine = "\u0085payload\u0085";
    assert.equal(
      unresolvedMessage(withNextLine, ""),
      "[cdr-rust:app-server-fork-unresolved:v1] payload",
    );

    const withBomAndZwsp = "\uFEFF\u200Bspecial\u200B\uFEFF";
    assert.equal(
      unresolvedMessage(withBomAndZwsp, ""),
      "[cdr-rust:app-server-fork-unresolved:v1] \uFEFF\u200Bspecial\u200B\uFEFF",
    );
  });

  it("unresolvedMessage and bounded count supplementary Unicode scalars instead of UTF-16 code units", () => {
    const crab250 = "\u{1F980}".repeat(250);
    const expectedBounded240 = "\u{1F980}".repeat(240);
    const message = unresolvedMessage("fork failed", crab250);
    const expected =
      "[cdr-rust:app-server-fork-unresolved:v1] fork failed\nPrevious error: " +
      expectedBounded240;
    assert.equal(message, expected);
  });

  it("unresolvedMessage allocates exact scalar budget between prefix, latest error, and previous error", () => {
    const prev240 = "\u{1F980}".repeat(240);
    const fork800 = "\u{1F680}".repeat(800);
    const expectedLatest702 = "\u{1F680}".repeat(702);
    const expected =
      "[cdr-rust:app-server-fork-unresolved:v1] " +
      expectedLatest702 +
      "\nPrevious error: " +
      prev240;

    assert.equal(unresolvedMessage(fork800, prev240), expected);
  });

  it("takeUnicodeScalars preserves surrogate pairs and never produces lone half surrogates at boundary", () => {
    const input = "a".repeat(239) + "\u{1F980}" + "extra";
    const expected = "a".repeat(239) + "\u{1F980}";
    const message = unresolvedMessage("fork", input);
    const expectedMessage =
      "[cdr-rust:app-server-fork-unresolved:v1] fork\nPrevious error: " +
      expected;
    assert.equal(message, expectedMessage);

    const prevPart = message.slice(message.lastIndexOf("\nPrevious error: ") + 17);
    assert.equal(prevPart, expected);
    assert.equal(prevPart.charCodeAt(prevPart.length - 2), 0xd83e);
    assert.equal(prevPart.charCodeAt(prevPart.length - 1), 0xdd80);
  });

  it("unresolvedMessage preserves bare prefix without invented fallback when both arguments are empty", () => {
    assert.equal(
      unresolvedMessage("", ""),
      "[cdr-rust:app-server-fork-unresolved:v1] ",
    );
    assert.equal(
      unresolvedMessage("   \u0085  ", "  \t  "),
      "[cdr-rust:app-server-fork-unresolved:v1] ",
    );
  });

  it("unresolvedMessage trims and bounds previousError with limit of 240 scalars", () => {
    const rawPrevious = "  \u0085  " + "z".repeat(300) + "  \u0085  ";
    const expectedPrevious = "z".repeat(240);
    const expected =
      "[cdr-rust:app-server-fork-unresolved:v1] err\nPrevious error: " +
      expectedPrevious;
    assert.equal(unresolvedMessage("err", rawPrevious), expected);
  });

  it("priorError throws TypeError for non-string arguments or strings containing lone surrogates", () => {
    assert.throws(() => priorError(null as unknown as string, "b"), TypeError);
    assert.throws(() => priorError("a", undefined as unknown as string), TypeError);
    assert.throws(() => priorError(123 as unknown as string, "b"), TypeError);
    assert.throws(() => priorError("a", {} as unknown as string), TypeError);

    assert.throws(() => priorError("\uD800", "b"), TypeError);
    assert.throws(() => priorError("a", "valid\uD83Dtext"), TypeError);
    assert.throws(() => priorError("\uDC00", "b"), TypeError);
    assert.throws(() => priorError("a", "valid\uDFFFtext"), TypeError);
  });

  it("unresolvedMessage throws TypeError for non-string arguments or strings containing lone surrogates", () => {
    assert.throws(() => unresolvedMessage(null as unknown as string, "b"), TypeError);
    assert.throws(() => unresolvedMessage("a", undefined as unknown as string), TypeError);
    assert.throws(() => unresolvedMessage(true as unknown as string, "b"), TypeError);
    assert.throws(() => unresolvedMessage("a", 42n as unknown as string), TypeError);

    assert.throws(() => unresolvedMessage("\uD800", "b"), TypeError);
    assert.throws(() => unresolvedMessage("a", "broken\uD800"), TypeError);
    assert.throws(() => unresolvedMessage("\uDC00", "b"), TypeError);
    assert.throws(() => unresolvedMessage("a", "broken\uDC00"), TypeError);
  });

  it("unresolvedNotice throws TypeError for non-string arguments, lone surrogates, or invalid FailurePhase", () => {
    assert.throws(
      () => unresolvedNotice(null as unknown as string, "b", FailurePhase.ForkOutcome),
      TypeError,
    );
    assert.throws(
      () => unresolvedNotice("a", 123 as unknown as string, FailurePhase.Finalize),
      TypeError,
    );
    assert.throws(
      () => unresolvedNotice("\uD800", "b", FailurePhase.Cancellation),
      TypeError,
    );
    assert.throws(
      () => unresolvedNotice("a", "\uDC00", FailurePhase.ForkOutcome),
      TypeError,
    );

    assert.throws(
      () => unresolvedNotice("a", "b", "InvalidPhase" as unknown as FailurePhase),
      TypeError,
    );
    assert.throws(
      () => unresolvedNotice("a", "b", null as unknown as FailurePhase),
      TypeError,
    );
    assert.throws(
      () => unresolvedNotice("a", "b", undefined as unknown as FailurePhase),
      TypeError,
    );
  });

  it("invalid phase never coerces hostile values", () => {
    const sentinel = new Error("hostile coercion attempted");
    let hookCalls = 0;
    let toPrimitiveCalls = 0;
    let toStringCalls = 0;
    let valueOfCalls = 0;
    let getTrapCalls = 0;

    const hostileObject = {
      [Symbol.toPrimitive]() {
        hookCalls++;
        toPrimitiveCalls++;
        throw sentinel;
      },
      toString() {
        hookCalls++;
        toStringCalls++;
        throw sentinel;
      },
      valueOf() {
        hookCalls++;
        valueOfCalls++;
        throw sentinel;
      },
    };

    const hostileProxy = new Proxy(hostileObject, {
      get(target, prop, receiver) {
        getTrapCalls++;
        return Reflect.get(target, prop, receiver);
      },
    });

    assert.throws(
      () =>
        unresolvedNotice(
          "database spawn timeout",
          "",
          hostileObject as unknown as FailurePhase,
        ),
      {
        name: "TypeError",
        message: "invalid failure phase",
      },
    );

    assert.throws(
      () =>
        unresolvedNotice(
          "database spawn timeout",
          "",
          hostileProxy as unknown as FailurePhase,
        ),
      {
        name: "TypeError",
        message: "invalid failure phase",
      },
    );

    assert.equal(hookCalls, 0);
    assert.equal(toPrimitiveCalls, 0);
    assert.equal(toStringCalls, 0);
    assert.equal(valueOfCalls, 0);
    assert.equal(getTrapCalls, 0);
  });
});
