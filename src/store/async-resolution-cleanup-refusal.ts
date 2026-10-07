import {
  asBool,
  asJsonObject,
  asStr,
  asU64,
  getOwn,
  I64_MAX,
} from "./async-resolution-json-helpers.ts";

/**
 * Versioned evidence for one pre-delete refusal, matching Rust `CleanupRefusal`.
 */
export interface CleanupRefusal {
  readonly room: bigint;
  readonly reason: string;
}

/**
 * Exact nine allowed protection reasons matching Rust `CleanupRefusal::from_outcome`.
 */
export const CLEANUP_REFUSAL_REASONS = [
  "queued requests",
  "prompt intake",
  "ingress",
  "undelivered result",
  "undelivered progress",
  "busy choice",
  "undelivered goal progress",
  "unattributable delivery receipt (invalid or missing channel identity)",
  "unsettled delivery receipt (unknown, retryable or blocked)",
] as const;

export type CleanupRefusalReason = (typeof CLEANUP_REFUSAL_REASONS)[number];

const VALID_REASONS: ReadonlySet<string> = new Set<string>(CLEANUP_REFUSAL_REASONS);

/**
 * Type guard validating that a string is one of the nine authoritative protection reasons.
 */
export function isCleanupRefusalReason(
  reason: string,
): reason is CleanupRefusalReason {
  return VALID_REASONS.has(reason);
}

/**
 * Pure leaf parser from parsed outcome matching Rust `ingress::CleanupRefusal::from_outcome`.
 *
 * Validates:
 * - Outcome is a non-null, non-array JSON object
 * - Own `kind` is string "mirror_cleanup_refused"
 * - Own `version` is u64 integer 1n
 * - Own `sync_completed` is boolean false
 * - Own `delete_dispatched` is boolean false
 * - Own `earlier_changes_possible` is boolean true
 * - Own `blocked_room_id` is u64 > 0n and fits in signed i64 (<= 9223372036854775807n)
 * - Own `protection_reason` matches exactly one of the nine allowed reason strings
 *
 * Returns `CleanupRefusal` on full validation match, or `undefined` on any failure.
 */
export function cleanupRefusalFromOutcome(
  outcome: unknown,
): CleanupRefusal | undefined {
  const obj = asJsonObject(outcome);
  if (obj === undefined) {
    return undefined;
  }

  const kind = asStr(getOwn(obj, "kind"));
  if (kind === undefined) {
    return undefined;
  }
  if (kind !== "mirror_cleanup_refused") {
    return undefined;
  }

  const version = asU64(getOwn(obj, "version"));
  if (version === undefined) {
    return undefined;
  }
  if (version !== 1n) {
    return undefined;
  }

  const syncCompleted = asBool(getOwn(obj, "sync_completed"));
  if (syncCompleted === undefined) {
    return undefined;
  }
  if (syncCompleted !== false) {
    return undefined;
  }

  const deleteDispatched = asBool(getOwn(obj, "delete_dispatched"));
  if (deleteDispatched === undefined) {
    return undefined;
  }
  if (deleteDispatched !== false) {
    return undefined;
  }

  const earlierChangesPossible = asBool(
    getOwn(obj, "earlier_changes_possible"),
  );
  if (earlierChangesPossible === undefined) {
    return undefined;
  }
  if (earlierChangesPossible !== true) {
    return undefined;
  }

  const room = asU64(getOwn(obj, "blocked_room_id"));
  if (room === undefined) {
    return undefined;
  }
  if (room <= 0n || room > I64_MAX) {
    return undefined;
  }

  const reason = asStr(getOwn(obj, "protection_reason"));
  if (reason === undefined) {
    return undefined;
  }
  if (!VALID_REASONS.has(reason)) {
    return undefined;
  }

  return {
    room,
    reason,
  };
}

export const cleanup_refusal_from_outcome = cleanupRefusalFromOutcome;
