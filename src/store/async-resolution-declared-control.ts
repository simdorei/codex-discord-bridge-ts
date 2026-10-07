import {
  asStr,
  getOwn,
  hasOwn,
  isJsonObject,
  pointer,
} from "./async-resolution-json-helpers.ts";

/**
 * Evaluates whether a value represents a declared Stop or Archive control variant.
 * Matches Rust `control(value: Option<&Value>) -> bool` from `lifecycle.rs`:
 * - Literal string "Stop" or "Archive"
 * - Object containing "Stop" or "Archive" as an own key
 */
export function control(value: unknown): boolean {
  if (value === "Stop" || value === "Archive") {
    return true;
  }
  return hasOwn(value, "Stop") || hasOwn(value, "Archive");
}

/**
 * Pure declared control predicate matching Rust `cdr_store::async_resolution::lifecycle`:
 *
 * ```rust
 * let declared = control(payload.pointer("/plan/Execute"))
 *     || control(payload.pointer("/lifecycle_binding/command"))
 *     || matches!(payload.pointer("/work/Slash/name").and_then(Value::as_str), Some("stop" | "archive"))
 *     || matches!(payload.get("command").and_then(Value::as_str), Some("stop" | "archive"));
 * ```
 *
 * Validates the exact four authoritative declared routes on parsed Serde JSON payload tree,
 * overriding ordinary positive classification.
 */
export function asyncLifecycleDeclaredControl(payload: unknown): boolean {
  if (!isJsonObject(payload)) {
    return false;
  }

  if (control(pointer(payload, "/plan/Execute"))) {
    return true;
  }

  if (control(pointer(payload, "/lifecycle_binding/command"))) {
    return true;
  }

  const slashName = asStr(pointer(payload, "/work/Slash/name"));
  if (slashName === "stop" || slashName === "archive") {
    return true;
  }

  const command = asStr(getOwn(payload, "command"));
  if (command === "stop" || command === "archive") {
    return true;
  }

  return false;
}
