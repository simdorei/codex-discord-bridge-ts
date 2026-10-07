import test, { describe } from "node:test";
import assert from "node:assert/strict";
import {
  CANCELLATION_FAILURE_PREFIX,
  combinedForkCancellationError,
} from "../../src/store/fork-cancellation-format.ts";

describe("combinedForkCancellationError", () => {
  test("empty fork and cancellation errors fall back to default English messages and omit empty previous", () => {
    const result = combinedForkCancellationError("", "", "");
    const expected =
      "[cdr-rust:app-server-fork-cancellation-failure:v1] " +
      "Fork error: fork failed without an error message\n" +
      "Cancellation error: handoff cancellation failed without an error message";
    assert.strictEqual(result, expected);
  });

  test("formats valid error fragments and appends trimmed previous error", () => {
    const result = combinedForkCancellationError(
      "  fork failed: spawn error  ",
      "  abort timed out  ",
      "  prior run failed  ",
    );
    const expected =
      "[cdr-rust:app-server-fork-cancellation-failure:v1] " +
      "Fork error: fork failed: spawn error\n" +
      "Cancellation error: abort timed out\n" +
      "Previous error: prior run failed";
    assert.strictEqual(result, expected);
  });

  test("omits previous error when previousError consists exclusively of Rust whitespace", () => {
    const result = combinedForkCancellationError(
      "fork error",
      "cancel error",
      "   \u0085\t\r\n \u00a0\u3000  ",
    );
    const expected =
      "[cdr-rust:app-server-fork-cancellation-failure:v1] " +
      "Fork error: fork error\n" +
      "Cancellation error: cancel error";
    assert.strictEqual(result, expected);
  });

  test("trims U+0085 as Rust whitespace but preserves U+FEFF and U+200B", () => {
    const result = combinedForkCancellationError(
      " \u0085 \r\n \u0085 ",
      "\uFEFFcancel failed\uFEFF",
      "\u200Bprior failed\u200B",
    );
    const expected =
      "[cdr-rust:app-server-fork-cancellation-failure:v1] " +
      "Fork error: fork failed without an error message\n" +
      "Cancellation error: \uFEFFcancel failed\uFEFF\n" +
      "Previous error: \u200Bprior failed\u200B";
    assert.strictEqual(result, expected);
  });

  test("truncates forkError to 320 scalars without breaking supplementary surrogate pairs", () => {
    const forkInput = "a".repeat(319) + "🚀🌟";
    const result = combinedForkCancellationError(forkInput, "cancel", "");
    const expectedForkFragment = "a".repeat(319) + "🚀";
    const expected =
      "[cdr-rust:app-server-fork-cancellation-failure:v1] " +
      `Fork error: ${expectedForkFragment}\n` +
      "Cancellation error: cancel";
    assert.strictEqual(result, expected);
  });

  test("truncates cancellationError to 320 scalars without breaking supplementary surrogate pairs", () => {
    const cancelInput = "b".repeat(319) + "🪐🌌";
    const result = combinedForkCancellationError("fork", cancelInput, "");
    const expectedCancelFragment = "b".repeat(319) + "🪐";
    const expected =
      "[cdr-rust:app-server-fork-cancellation-failure:v1] " +
      "Fork error: fork\n" +
      `Cancellation error: ${expectedCancelFragment}`;
    assert.strictEqual(result, expected);
  });

  test("truncates previousError to 240 scalars without breaking supplementary surrogate pairs", () => {
    const previousInput = "c".repeat(239) + "🎯🔥";
    const result = combinedForkCancellationError("f", "c", previousInput);
    const expectedPreviousFragment = "c".repeat(239) + "🎯";
    const expected =
      "[cdr-rust:app-server-fork-cancellation-failure:v1] " +
      "Fork error: f\n" +
      "Cancellation error: c\n" +
      `Previous error: ${expectedPreviousFragment}`;
    assert.strictEqual(result, expected);
  });

  test("returns raw unbounded previousError >1000 characters with preserved whitespace when it starts with base", () => {
    const base =
      "[cdr-rust:app-server-fork-cancellation-failure:v1] " +
      "Fork error: f\n" +
      "Cancellation error: c";
    const unboundedPrevious = `${base}\nPrevious error: ${"z".repeat(1200)}   \t\n`;
    const result = combinedForkCancellationError("f", "c", unboundedPrevious);
    assert.strictEqual(result, unboundedPrevious);
    assert.strictEqual(result.length > 1200, true);
    assert.strictEqual(result.endsWith("   \t\n"), true);
  });

  test("idempotently returns base when previousError exactly matches base", () => {
    const base = combinedForkCancellationError("f", "c", "");
    const result = combinedForkCancellationError("f", "c", base);
    assert.strictEqual(result, base);
    const repeatResult = combinedForkCancellationError("f", "c", result);
    assert.strictEqual(repeatResult, base);
  });

  test("appends previous error bounded when previousError mismatches base by one character", () => {
    const base = combinedForkCancellationError("f", "c", "");
    const mismatch = base.slice(0, -1) + "x";
    const result = combinedForkCancellationError("f", "c", mismatch);
    const expected = `${base}\nPrevious error: ${mismatch}`;
    assert.strictEqual(result, expected);
  });

  test("validates all three arguments as strings without invoking object hooks or coercion", () => {
    const hostile = {
      toString(): string {
        throw new Error("hostile toString must not be called");
      },
      valueOf(): string {
        throw new Error("hostile valueOf must not be called");
      },
      startsWith(): boolean {
        throw new Error("hostile startsWith must not be called");
      },
    };

    assert.throws(
      () => combinedForkCancellationError(hostile as unknown as string, "b", "c"),
      { name: "TypeError", message: "forkError must be a string" },
    );
    assert.throws(
      () => combinedForkCancellationError("a", hostile as unknown as string, "c"),
      { name: "TypeError", message: "cancellationError must be a string" },
    );
    assert.throws(
      () => combinedForkCancellationError("a", "b", hostile as unknown as string),
      { name: "TypeError", message: "previousError must be a string" },
    );
    assert.throws(
      () => combinedForkCancellationError(null as unknown as string, "b", "c"),
      { name: "TypeError", message: "forkError must be a string" },
    );
    assert.throws(
      () => combinedForkCancellationError("a", undefined as unknown as string, "c"),
      { name: "TypeError", message: "cancellationError must be a string" },
    );
    assert.throws(
      () => combinedForkCancellationError("a", "b", 123 as unknown as string),
      { name: "TypeError", message: "previousError must be a string" },
    );
  });

  test("validates lone surrogates on all arguments before early return including malformed previous suffix", () => {
    assert.throws(
      () => combinedForkCancellationError("\uD800", "b", "c"),
      { name: "TypeError", message: "forkError contains lone surrogates" },
    );
    assert.throws(
      () => combinedForkCancellationError("a", "\uDC00", "c"),
      { name: "TypeError", message: "cancellationError contains lone surrogates" },
    );
    assert.throws(
      () => combinedForkCancellationError("a", "b", "\uD800"),
      { name: "TypeError", message: "previousError contains lone surrogates" },
    );

    const base =
      "[cdr-rust:app-server-fork-cancellation-failure:v1] " +
      "Fork error: a\n" +
      "Cancellation error: b";

    assert.throws(
      () => combinedForkCancellationError("a", "b", `${base}\uD800`),
      { name: "TypeError", message: "previousError contains lone surrogates" },
    );
    assert.throws(
      () => combinedForkCancellationError("\uD800", "b", base),
      { name: "TypeError", message: "forkError contains lone surrogates" },
    );
  });

  test("exports exact CANCELLATION_FAILURE_PREFIX literal", () => {
    assert.strictEqual(
      CANCELLATION_FAILURE_PREFIX,
      "[cdr-rust:app-server-fork-cancellation-failure:v1] ",
    );
  });
});
