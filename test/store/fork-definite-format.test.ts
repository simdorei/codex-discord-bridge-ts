import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFINITE_FORK_ERROR_PREFIX,
  UNRESOLVED_FORK_ERROR_PREFIX,
  boundedForkError,
  definiteMessage,
  definiteNotice,
  previousNonForkError,
} from "../../src/store/fork-definite-format.ts";

describe("fork-definite-format", () => {
  it("exports exact definite and unresolved prefix constants", () => {
    assert.equal(
      DEFINITE_FORK_ERROR_PREFIX,
      "[cdr-rust:app-server-fork-definite:v1] ",
    );
    assert.equal(
      UNRESOLVED_FORK_ERROR_PREFIX,
      "[cdr-rust:app-server-fork-unresolved:v1] ",
    );
  });

  it("formats definiteMessage preserving raw unbounded arguments with and without previous error", () => {
    assert.equal(
      definiteMessage("app-server crashed", ""),
      "[cdr-rust:app-server-fork-definite:v1] app-server crashed",
    );
    assert.equal(
      definiteMessage("app-server crashed", "connection reset by peer"),
      "[cdr-rust:app-server-fork-definite:v1] app-server crashed\nPrevious error: connection reset by peer",
    );

    const rawFork = "  \t\nraw fork error with whitespace  \n";
    const rawPrev = "  \r\nraw previous error with whitespace  \t";
    assert.equal(
      definiteMessage(rawFork, rawPrev),
      `[cdr-rust:app-server-fork-definite:v1] ${rawFork}\nPrevious error: ${rawPrev}`,
    );

    const bigFork = "f".repeat(1200);
    const bigPrev = "p".repeat(1200);
    const msg = definiteMessage(bigFork, bigPrev);
    assert.equal(
      msg,
      `[cdr-rust:app-server-fork-definite:v1] ${bigFork}\nPrevious error: ${bigPrev}`,
    );
    assert.equal(msg.length, 2456);
  });

  it("formats definiteNotice with exact notice text and raw unbounded arguments", () => {
    assert.equal(
      definiteNotice("crash", ""),
      "The Codex ownership fork definitely failed before a target was created. This request remains durable and can be retried safely.\nFork error: crash",
    );
    assert.equal(
      definiteNotice("crash", "timeout"),
      "The Codex ownership fork definitely failed before a target was created. This request remains durable and can be retried safely.\nFork error: crash\nPrevious error: timeout",
    );

    const rawFork = " \t raw fork \n ";
    const rawPrev = " \r raw prev \t ";
    assert.equal(
      definiteNotice(rawFork, rawPrev),
      "The Codex ownership fork definitely failed before a target was created. This request remains durable and can be retried safely.\nFork error:  \t raw fork \n \nPrevious error:  \r raw prev \t ",
    );

    const bigFork = "a".repeat(1100);
    const bigPrev = "b".repeat(1100);
    const notice = definiteNotice(bigFork, bigPrev);
    assert.equal(
      notice,
      `The Codex ownership fork definitely failed before a target was created. This request remains durable and can be retried safely.\nFork error: ${bigFork}\nPrevious error: ${bigPrev}`,
    );
  });

  it("boundedForkError returns exact fallback string on empty or Rust whitespace-only input", () => {
    const fallback = "app-server fork failed without an error message";
    assert.equal(boundedForkError(""), fallback);
    assert.equal(boundedForkError("   \t\r\n\v\f   "), fallback);
    assert.equal(boundedForkError("\u0085"), fallback);
    assert.equal(boundedForkError(" \u0085 \u0085 "), fallback);

    const allRustSpaces =
      "\u0009\u000A\u000B\u000C\u000D\u0020\u0085\u00A0\u1680" +
      "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A" +
      "\u2028\u2029\u202F\u205F\u3000";
    assert.equal(boundedForkError(allRustSpaces), fallback);
  });

  it("boundedForkError trims Rust whitespace including 0x0085 but retains FEFF and 200B", () => {
    assert.equal(
      boundedForkError("\u0085something went wrong\u0085"),
      "something went wrong",
    );
    assert.equal(
      boundedForkError(" \u0085 \u0020internal error\u3000\u0085 "),
      "internal error",
    );
    assert.equal(
      boundedForkError("\uFEFFunexpected token\u200B"),
      "\uFEFFunexpected token\u200B",
    );
    assert.equal(
      boundedForkError(" \uFEFF \u200B "),
      "\uFEFF \u200B",
    );
  });

  it("boundedForkError truncates to 1000 Unicode scalars at emoji boundaries without splitting surrogates", () => {
    const exact1000 = "x".repeat(1000);
    assert.equal(boundedForkError(exact1000), exact1000);

    const over1000 = "x".repeat(1005);
    assert.equal(boundedForkError(over1000), "x".repeat(1000));

    const emojiInput = "a".repeat(999) + "\uD83C\uDF89\uD83D\uDE80";
    const emojiBounded = boundedForkError(emojiInput);
    const expectedEmoji = "a".repeat(999) + "\uD83C\uDF89";
    assert.equal(emojiBounded, expectedEmoji);
    assert.equal(emojiBounded.length, 1001);
    assert.equal(emojiBounded.charCodeAt(1000), 0xdf89);

    const emojis = "\uD83D\uDE00".repeat(1002);
    const boundedEmojis = boundedForkError(emojis);
    assert.equal(boundedEmojis, "\uD83D\uDE00".repeat(1000));
    assert.equal(boundedEmojis.length, 2000);
  });

  it("previousNonForkError trims plain stored error and truncates to 1000 scalars", () => {
    assert.equal(
      previousNonForkError("  connection dropped  "),
      "connection dropped",
    );
    assert.equal(
      previousNonForkError("\u0085\u0020database locked\u0085 "),
      "database locked",
    );

    const plainOver = "e".repeat(1050);
    assert.equal(previousNonForkError(plainOver), "e".repeat(1000));

    const plainEmoji = "z".repeat(999) + "\uD83D\uDC4D\uD83D\uDC4E";
    assert.equal(
      previousNonForkError(plainEmoji),
      "z".repeat(999) + "\uD83D\uDC4D",
    );
  });

  it("previousNonForkError returns empty string for definite and unresolved prefixes without label", () => {
    assert.equal(
      previousNonForkError("[cdr-rust:app-server-fork-definite:v1] fork died"),
      "",
    );
    assert.equal(
      previousNonForkError("[cdr-rust:app-server-fork-unresolved:v1] unknown state"),
      "",
    );
    assert.equal(
      previousNonForkError("  \u0085[cdr-rust:app-server-fork-definite:v1] failed\u0085  "),
      "",
    );
    assert.equal(
      previousNonForkError("\t\n[cdr-rust:app-server-fork-unresolved:v1] pending\r\n"),
      "",
    );
  });

  it("previousNonForkError extracts candidate from the last Previous error label", () => {
    assert.equal(
      previousNonForkError(
        "[cdr-rust:app-server-fork-definite:v1] failure\nPrevious error: socket hang up",
      ),
      "socket hang up",
    );
    assert.equal(
      previousNonForkError(
        "[cdr-rust:app-server-fork-unresolved:v1] failure\nPrevious error: request timeout",
      ),
      "request timeout",
    );

    const multiple =
      "[cdr-rust:app-server-fork-definite:v1] fail\nPrevious error: first error\nPrevious error: final cause";
    assert.equal(previousNonForkError(multiple), "final cause");
  });

  it("previousNonForkError rejects exact nested prefix but preserves leading whitespace without candidate-trim", () => {
    const nestedDefinite =
      "[cdr-rust:app-server-fork-definite:v1] err\nPrevious error: [cdr-rust:app-server-fork-definite:v1] nested fail";
    assert.equal(previousNonForkError(nestedDefinite), "");

    const nestedUnresolved =
      "[cdr-rust:app-server-fork-definite:v1] err\nPrevious error: [cdr-rust:app-server-fork-unresolved:v1] nested fail";
    assert.equal(previousNonForkError(nestedUnresolved), "");

    const leadingWhitespaceCandidate =
      "[cdr-rust:app-server-fork-definite:v1] err\nPrevious error:   [cdr-rust:app-server-fork-definite:v1] nested fail";
    assert.equal(
      previousNonForkError(leadingWhitespaceCandidate),
      "  [cdr-rust:app-server-fork-definite:v1] nested fail",
    );

    const trailingTrimOfWhole =
      "[cdr-rust:app-server-fork-definite:v1] err\nPrevious error: some root cause   \u0085";
    assert.equal(
      previousNonForkError(trailingTrimOfWhole),
      "some root cause",
    );
  });

  it("previousNonForkError accepts spoofed candidates and distinguishes plain error from unresolved prefix", () => {
    const spoofedV2 =
      "[cdr-rust:app-server-fork-definite:v1] err\nPrevious error: [cdr-rust:app-server-fork-definite:v2] other";
    assert.equal(
      previousNonForkError(spoofedV2),
      "[cdr-rust:app-server-fork-definite:v2] other",
    );

    const encodedCandidate =
      "[cdr-rust:app-server-fork-definite:v1] err\nPrevious error: %5Bcdr-rust:app-server-fork-definite:v1%5D err";
    assert.equal(
      previousNonForkError(encodedCandidate),
      "%5Bcdr-rust:app-server-fork-definite:v1%5D err",
    );

    assert.equal(
      previousNonForkError("unresolved DNS address"),
      "unresolved DNS address",
    );
    assert.equal(
      previousNonForkError("[cdr-rust:app-server-fork-unresolved:v1] unresolved DNS address"),
      "",
    );
  });

  it("rejects non-string inputs with TypeError across all formatting functions without coercion", () => {
    const invalidInputs: unknown[] = [
      null,
      undefined,
      123,
      true,
      false,
      123n,
      Symbol("sym"),
      { toString: () => "malicious" },
      ["array"],
    ];

    for (const bad of invalidInputs) {
      assert.throws(
        () => previousNonForkError(bad as string),
        TypeError,
      );
      assert.throws(
        () => boundedForkError(bad as string),
        TypeError,
      );
      assert.throws(
        () => definiteMessage(bad as string, "valid"),
        TypeError,
      );
      assert.throws(
        () => definiteMessage("valid", bad as string),
        TypeError,
      );
      assert.throws(
        () => definiteNotice(bad as string, "valid"),
        TypeError,
      );
      assert.throws(
        () => definiteNotice("valid", bad as string),
        TypeError,
      );
    }
  });

  it("rejects lone surrogates with TypeError across all formatting functions while accepting valid surrogate pairs", () => {
    const loneSurrogates = [
      "\uD800",
      "\uDC00",
      "\uD800abc",
      "abc\uDC00",
      "\uD800\uD800",
      "\uDC00\uDC00",
      "\uDC00\uD800",
      "prefix\uD800suffix",
    ];

    for (const bad of loneSurrogates) {
      assert.throws(
        () => previousNonForkError(bad),
        TypeError,
      );
      assert.throws(
        () => boundedForkError(bad),
        TypeError,
      );
      assert.throws(
        () => definiteMessage(bad, "ok"),
        TypeError,
      );
      assert.throws(
        () => definiteMessage("ok", bad),
        TypeError,
      );
      assert.throws(
        () => definiteNotice(bad, "ok"),
        TypeError,
      );
      assert.throws(
        () => definiteNotice("ok", bad),
        TypeError,
      );
    }

    const validEmoji = "Valid \uD83D\uDE00 error \uD83C\uDF89";
    assert.doesNotThrow(() => previousNonForkError(validEmoji));
    assert.doesNotThrow(() => boundedForkError(validEmoji));
    assert.doesNotThrow(() => definiteMessage(validEmoji, ""));
    assert.doesNotThrow(() => definiteNotice(validEmoji, ""));
  });
});
