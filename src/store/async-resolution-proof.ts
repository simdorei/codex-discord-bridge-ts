import { parseSerdeValue } from "../core/serde-json-parse.ts";
import { parseSerdeStruct, type StructShape } from "../core/serde-struct-json.ts";
import { serializeSerdeValue, sha256SerdeValue } from "../core/serde-json.ts";
import { AsyncResolutionHeldError } from "./async-resolution-admission.ts";

export interface ExecutionOwner {
  turn_id: string;
  generation: bigint;
  observer: string;
  job: unknown;
}
export interface TerminalEvidence {
  version: bigint;
  source: string;
  observer: string;
  generation: bigint;
  thread_id: string;
  turn_id: string;
  canonical_terminal: unknown;
  payload_sha256: string;
  claim_sha256: string;
  revision: bigint;
  owner_verified: boolean;
}
export interface OwnershipHandoff {
  version: bigint;
  revision: bigint;
  claim_sha256: string;
  previous_terminal: string;
  owner: ExecutionOwner;
}
export interface ProofBinding { thread_id: string; revision: bigint; claim_sha256: string }
const OWNER: StructShape = { fields: [["turn_id", "string"], ["generation", "i64"], ["observer", "string"], ["job", "value"]] };
const HANDOFF: StructShape = { fields: [["version", "i64"], ["revision", "i64"], ["claim_sha256", "string"], ["previous_terminal", "string"], ["owner", OWNER]] };
const TERMINAL: StructShape = { fields: [["version", "i64"], ["source", "string"], ["observer", "string"],
  ["generation", "i64"], ["thread_id", "string"], ["turn_id", "string"], ["canonical_terminal", "value"],
  ["payload_sha256", "string"], ["claim_sha256", "string"], ["revision", "i64"], ["owner_verified", "bool"]] };
const LIMIT = 131_072;
function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, key)
    ? (value as Record<string, unknown>)[key] : undefined;
}
/** Decoder only; callers must separately validate hash, revision and live ownership. */
export function decodeOwnershipHandoff(raw: string): OwnershipHandoff {
  return parseSerdeStruct(raw, HANDOFF) as unknown as OwnershipHandoff;
}
export function canonicalTerminal(thread: string, turn: string, payload: string): unknown {
  if (Buffer.byteLength(payload, "utf8") > LIMIT) throw new AsyncResolutionHeldError(thread, "terminal evidence exceeds the bounded payload limit");
  const value: unknown = parseSerdeValue(payload);
  const turnValue = field(value, "turn"), status = field(turnValue, "status");
  if (field(value, "threadId") !== thread || field(turnValue, "id") !== turn ||
      (status !== "completed" && status !== "failed" && status !== "interrupted")) {
    throw new AsyncResolutionHeldError(thread, "notification is not the exact typed terminal");
  }
  return { threadId: thread, turn: { id: turn, status } };
}
/** Pure metadata check, NOT authority to settle. Caller checks conflict and live owner in its transaction. */
export function decodeTerminalProof(row: ProofBinding, owner: ExecutionOwner, raw: string): TerminalEvidence | null {
  if (Buffer.byteLength(raw, "utf8") > LIMIT) throw new AsyncResolutionHeldError(row.thread_id, "oversized terminal proof");
  const evidence = parseSerdeStruct(raw, TERMINAL) as unknown as TerminalEvidence;
  const metadata = canonicalTerminal(row.thread_id, owner.turn_id, serializeSerdeValue(evidence.canonical_terminal));
  if (evidence.version !== 1n || evidence.source !== "resident_notification_v1" || !evidence.owner_verified ||
      evidence.observer !== owner.observer || evidence.generation !== owner.generation ||
      evidence.thread_id !== row.thread_id || evidence.turn_id !== owner.turn_id ||
      evidence.claim_sha256 !== row.claim_sha256 || evidence.revision !== row.revision ||
      evidence.payload_sha256 !== sha256SerdeValue(metadata)) return null;
  return evidence;
}

/** Rust derives serialize struct fields in declaration order, unlike Value maps. */
export function serializeTerminalEvidence(evidence: TerminalEvidence): string {
  return "{" + TERMINAL.fields.map(([key]) => serializeSerdeValue(key) + ":" +
    serializeSerdeValue(evidence[key as keyof TerminalEvidence])).join(",") + "}";
}

export function serializeOwnershipHandoff(handoff: OwnershipHandoff): string {
  const owner="{"+OWNER.fields.map(([key])=>serializeSerdeValue(key)+":"+serializeSerdeValue(handoff.owner[key as keyof ExecutionOwner])).join(",")+"}";
  return "{"+HANDOFF.fields.map(([key])=>serializeSerdeValue(key)+":"+(key==="owner"?owner:serializeSerdeValue(handoff[key as keyof OwnershipHandoff]))).join(",")+"}";
}
