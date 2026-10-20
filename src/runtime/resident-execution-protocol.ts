/** Inactive, unimported preparation: text codec only. No resident or execution authority.
 * Owned UTF-8 byte input, reservation arithmetic and runtime integration are deferred.
 */
export const RESIDENT_PROTOCOL = "persistent-resident-v1" as const;
export type UInt = string;
export type Address = Readonly<{ ownerEpoch: string; sessionId: string }>;
export type CommandKey = Readonly<Address & { sequence: UInt }>;
export type RequestBody =
  | Readonly<{ kind: "submit"; sequence: UInt; intentId: UInt; intentKind: "response" | "mutation"; observedIntentRevision: UInt }>
  | Readonly<{ kind: "reconcile" | "cancel"; command: CommandKey }>
  | Readonly<{ kind: "release-terminal-prefix"; throughSequence: UInt }>
  | Readonly<{ kind: "close"; mode: "drain" | "cancel-pending" }>
  | Readonly<{ kind: "inspect" }>;
export type Ownership = "retained" | "joined";
export type AcceptedObservation =
  | Readonly<{ kind: "pending"; revision: UInt; phase: "queued" | "preparing" | "write-started" | "settling"; cancellationRequested: boolean }>
  | Readonly<{ kind: "definitely-unsent"; revision: UInt; reason: "cancelled-before-start" | "closed-before-start" | "authority-invalid-before-start" | "preparation-failed-before-start"; custody: "confirmed" | "unknown"; ownership: Ownership }>
  | Readonly<{ kind: "flushed"; revision: UInt; custody: "confirmed" | "unknown"; ownership: Ownership }>
  | Readonly<{ kind: "unknown"; revision: UInt; boundary: "write" | "custody" | "owner-loss"; ownership: Ownership }>;
export type Observation = AcceptedObservation | Readonly<{ kind: "not-accepted" | "not-seen" | "retired-no-replay" }>;
export type NonAcceptanceReason = "inactive" | "closing" | "capacity" | "intent-unavailable" | "intent-mismatch" | "intent-already-bound" | "previously-rejected";
export type Submission = Readonly<{ kind: "accepted"; observation: AcceptedObservation }>
  | Readonly<{ kind: "not-accepted"; reason: NonAcceptanceReason }>
  | Readonly<{ kind: "identity-conflict" | "retired-no-replay" }>;
export type OwnerStatus = Readonly<{
  admission: "inactive" | "open" | "closing" | "closed";
  transportHealth: "connected" | "disconnected";
  acceptedCount: UInt; unresolvedCount: UInt; retainedMetadataBytes: UInt; retainedLogicalBytes: UInt;
  lastSeenSequence: UInt; retiredThroughSequence: UInt;
}>;
export type ReplyBody =
  | Readonly<{ kind: "protocol-rejected"; reason: "malformed" | "unsupported-version" | "oversize" | "wrong-address" | "sequence-gap" | "rate-limited" }>
  | Readonly<{ kind: "submission"; command: CommandKey; disposition: Submission }>
  | Readonly<{ kind: "observation"; command: CommandKey; observation: Observation }>
  | Readonly<{ kind: "cancel-result"; command: CommandKey; status: "recorded"; observation: AcceptedObservation }>
  | Readonly<{ kind: "cancel-result"; command: CommandKey; status: "already-terminal"; observation: Exclude<AcceptedObservation, Readonly<{ kind: "pending" }>> }>
  | Readonly<{ kind: "cancel-result"; command: CommandKey; status: "not-accepted"; observation: Readonly<{ kind: "not-accepted" }> }>
  | Readonly<{ kind: "cancel-result"; command: CommandKey; status: "not-seen"; observation: Readonly<{ kind: "not-seen" }> }>
  | Readonly<{ kind: "cancel-result"; command: CommandKey; status: "retired-no-replay"; observation: Readonly<{ kind: "retired-no-replay" }> }>
  | Readonly<{ kind: "release-result"; throughSequence: UInt; status: "released" | "blocked" }>
  | Readonly<{ kind: "owner-status"; status: OwnerStatus }>;
export type ResidentRequest = Readonly<{ protocol: typeof RESIDENT_PROTOCOL; address: Address; messageId: string; body: RequestBody }>;
export type ResidentReply = Readonly<{ protocol: typeof RESIDENT_PROTOCOL; address: Address; inReplyTo: string; body: ReplyBody }>;
const LIMIT_NAMES = [
  "maxEnvelopeBytes", "maxReplyBytes", "maxIdentifierBytes", "maxSequenceDigits",
  "maxAcceptedCommands", "maxQueuedCommands", "maxActiveCommands", "maxRegisteredIntents",
  "maxRetainedMetadataBytes", "maxRetainedLogicalBytes", "maxSingleIntentLogicalBytes",
  "maxControlMessagesInFlight", "maxQueuedReplyBytes", "maxProtocolMessagesPerWindow", "protocolWindowMs",
] as const;
export type Limits = Readonly<Record<(typeof LIMIT_NAMES)[number], number>>;
export type ProtocolBounds = Readonly<{
  minimumEnvelopeBytes: number; minimumReplyBytes: number;
  maximumEnvelopeBytes: number; maximumReplyBytes: number;
}>;
export interface ResidentProtocolCodec {
  readonly limits: Limits;
  readonly address: Address;
  readonly bounds: ProtocolBounds;
  decodeRequest(text: unknown): ResidentRequest;
  decodeReply(text: unknown): ResidentReply;
  encodeRequest(value: unknown): string;
  encodeReply(value: unknown): string;
  commandKeyOf(value: unknown): CommandKey;
  compareCommandKeys(left: unknown, right: unknown): -1 | 0 | 1;
  sameSubmission(left: unknown, right: unknown): boolean;
}
const bad = (): never => { throw new TypeError("Invalid resident protocol input"); };
const excess = (): never => { throw new RangeError("Resident protocol input exceeds limit"); };
function add(a: number, b: number): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || b < 0 || a > Number.MAX_SAFE_INTEGER - b) return bad();
  return a + b;
}
// A finite representation profile, derived from exact keys and 16-digit safe integers.
export const LIMITS_TEXT_MAX_BYTES = LIMIT_NAMES.reduce((n, key) => add(n, key.length + 2 + 1 + 16), 2 + LIMIT_NAMES.length - 1);
function textBytes(value: unknown, maximum: number): number {
  if (typeof value !== "string") return bad();
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    let width: number;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return bad();
      width = 4;
    } else if (code >= 0xdc00 && code <= 0xdfff) return bad();
    else width = code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
    if (bytes > maximum - width) return excess();
    bytes += width;
  }
  return bytes;
}
type Parsed = string | boolean | number | { [key: string]: Parsed };
type ParsedRecord = { [key: string]: Parsed };
function record(value: Parsed): ParsedRecord {
  if (typeof value !== "object") return bad();
  return value;
}
/** Only scans primitive bounded text; never traverses caller objects. No general JSON extension points. */
function parseText(input: unknown, maximum: number, configuration: boolean): ParsedRecord {
  textBytes(input, maximum);
  const text = input as string;
  let at = 0;
  const whitespace = (): void => { while (at < text.length && (text[at] === " " || text[at] === "\t" || text[at] === "\r" || text[at] === "\n")) at++; };
  const string = (): string => {
    if (text[at] !== '"') return bad();
    const start = at++;
    let escaped = false;
    while (at < text.length) {
      const c = text[at++];
      if (!escaped && c === '"') {
        let result: unknown;
        try { result = JSON.parse(text.slice(start, at)); } catch { return bad(); }
        textBytes(result, maximum); // Also rejects escaped lone surrogates.
        return result as string;
      }
      if (!escaped && c === "\\") escaped = true;
      else escaped = false;
    }
    return bad();
  };
  const object = (depth: number): ParsedRecord => {
    if (depth > (configuration ? 1 : 4) || text[at++] !== "{") return bad();
    const output: ParsedRecord = Object.create(null) as ParsedRecord;
    const seen = new Set<string>();
    whitespace();
    if (text[at] === "}") { at++; return output; }
    for (;;) {
      const key = string();
      if (seen.has(key)) return bad();
      seen.add(key);
      whitespace();
      if (text[at++] !== ":") return bad();
      whitespace();
      let value: Parsed;
      if (configuration) {
        const start = at;
        while (at < text.length && text.charCodeAt(at) >= 48 && text.charCodeAt(at) <= 57) {
          at++;
          if (at - start > 16) return bad();
        }
        const token = text.slice(start, at);
        if (!/^[1-9][0-9]*$/.test(token)) return bad();
        const number = Number(token);
        if (!Number.isSafeInteger(number) || number <= 0) return bad();
        value = number;
      } else if (text[at] === '"') value = string();
      else if (text[at] === "{") value = object(depth + 1);
      else if (text.slice(at, at + 4) === "true") { value = true; at += 4; }
      else if (text.slice(at, at + 5) === "false") { value = false; at += 5; }
      else return bad();
      output[key] = value;
      whitespace();
      if (text[at] === "}") { at++; return output; }
      if (text[at++] !== ",") return bad();
      whitespace();
    }
  };
  whitespace();
  const result = object(1);
  whitespace();
  if (at !== text.length) return bad();
  return result;
}
type Schema =
  | Readonly<{ type: "id" | "bool" }>
  | Readonly<{ type: "uint"; positive: boolean }>
  | Readonly<{ type: "enum"; values: readonly string[] }>
  | Readonly<{ type: "record"; fields: readonly (readonly [string, Schema])[] }>
  | Readonly<{ type: "union"; variants: readonly Schema[] }>;
const id: Schema = { type: "id" };
const uint: Schema = { type: "uint", positive: false };
const positive: Schema = { type: "uint", positive: true };
const bool: Schema = { type: "bool" };
const enumeration = (...values: string[]): Schema => ({ type: "enum", values });
const shape = (...fields: (readonly [string, Schema])[]): Schema => ({ type: "record", fields });
const union = (...variants: Schema[]): Schema => ({ type: "union", variants });
const tagged = (kind: string, ...fields: (readonly [string, Schema])[]): Schema => shape(["kind", enumeration(kind)], ...fields);
const addressSchema = shape(["ownerEpoch", id], ["sessionId", id]);
const commandSchema = shape(["ownerEpoch", id], ["sessionId", id], ["sequence", positive]);
const ownership = enumeration("retained", "joined");
const custody = enumeration("confirmed", "unknown");
const pending = tagged("pending", ["revision", uint], ["phase", enumeration("queued", "preparing", "write-started", "settling")], ["cancellationRequested", bool]);
const unsent = tagged("definitely-unsent", ["revision", uint], ["reason", enumeration("cancelled-before-start", "closed-before-start", "authority-invalid-before-start", "preparation-failed-before-start")], ["custody", custody], ["ownership", ownership]);
const flushed = tagged("flushed", ["revision", uint], ["custody", custody], ["ownership", ownership]);
const unknown = tagged("unknown", ["revision", uint], ["boundary", enumeration("write", "custody", "owner-loss")], ["ownership", ownership]);
const accepted = union(pending, unsent, flushed, unknown);
const absent = [tagged("not-accepted"), tagged("not-seen"), tagged("retired-no-replay")];
const observation = union(accepted, ...absent);
const rejectedSubmissions = [
  tagged("not-accepted", ["reason", enumeration("inactive", "closing", "capacity", "intent-unavailable", "intent-mismatch", "intent-already-bound", "previously-rejected")]),
  tagged("identity-conflict"), tagged("retired-no-replay"),
];
const submission = union(tagged("accepted", ["observation", accepted]), ...rejectedSubmissions);
const statusSchema = shape(
  ["admission", enumeration("inactive", "open", "closing", "closed")], ["transportHealth", enumeration("connected", "disconnected")],
  ["acceptedCount", uint], ["unresolvedCount", uint], ["retainedMetadataBytes", uint], ["retainedLogicalBytes", uint], ["lastSeenSequence", uint], ["retiredThroughSequence", uint],
);
const requestBody = union(
  tagged("submit", ["sequence", positive], ["intentId", positive], ["intentKind", enumeration("response", "mutation")], ["observedIntentRevision", uint]),
  tagged("reconcile", ["command", commandSchema]), tagged("cancel", ["command", commandSchema]),
  tagged("release-terminal-prefix", ["throughSequence", uint]), tagged("close", ["mode", enumeration("drain", "cancel-pending")]), tagged("inspect"),
);
const cancelSchema = tagged("cancel-result", ["command", commandSchema], ["status", enumeration("recorded", "already-terminal", "not-accepted", "not-seen", "retired-no-replay")], ["observation", observation]);
const cancelSizeSchema = union(
  tagged("cancel-result", ["command", commandSchema], ["status", enumeration("recorded")], ["observation", accepted]),
  tagged("cancel-result", ["command", commandSchema], ["status", enumeration("already-terminal")], ["observation", union(unsent, flushed, unknown)]),
  ...["not-accepted", "not-seen", "retired-no-replay"].map(kind => tagged("cancel-result", ["command", commandSchema], ["status", enumeration(kind)], ["observation", tagged(kind)])),
);
const controls = [
  tagged("protocol-rejected", ["reason", enumeration("malformed", "unsupported-version", "oversize", "wrong-address", "sequence-gap", "rate-limited")]),
  tagged("observation", ["command", commandSchema], ["observation", observation]),
  cancelSchema,
  tagged("release-result", ["throughSequence", uint], ["status", enumeration("released", "blocked")]),
  tagged("owner-status", ["status", statusSchema]),
];
const replyBody = union(tagged("submission", ["command", commandSchema], ["disposition", submission]), ...controls);
const minimumReplyBody = union(tagged("submission", ["command", commandSchema], ["disposition", union(...rejectedSubmissions)]), ...controls);
const envelope = (body: Schema, reply: boolean): Schema => shape(["protocol", enumeration(RESIDENT_PROTOCOL)], ["address", addressSchema], [reply ? "inReplyTo" : "messageId", id], ["body", body]);
const requestSchema = envelope(requestBody, false);
const replySchema = envelope(replyBody, true);
function schemaBytes(schema: Schema, limits: Limits, minimal: boolean): number {
  if (schema === cancelSchema) return schemaBytes(cancelSizeSchema, limits, minimal);
  if (schema.type === "id") return add(2, limits.maxIdentifierBytes);
  if (schema.type === "uint") return add(2, minimal ? 1 : limits.maxSequenceDigits);
  if (schema.type === "bool") return 5;
  if (schema.type === "enum") return Math.max(...schema.values.map(value => JSON.stringify(value).length));
  if (schema.type === "union") return Math.max(...schema.variants.map(value => schemaBytes(value, limits, minimal)));
  if (schema.type !== "record") return bad();
  let bytes = 2;
  for (let i = 0; i < schema.fields.length; i++) {
    const [name, child] = schema.fields[i]!;
    let valueBytes = schemaBytes(child, limits, minimal);
    if (minimal && schema === statusSchema) {
      const cap = name === "acceptedCount" || name === "unresolvedCount" ? limits.maxAcceptedCommands
        : name === "retainedMetadataBytes" ? limits.maxRetainedMetadataBytes
        : name === "retainedLogicalBytes" ? limits.maxRetainedLogicalBytes : undefined;
      if (cap !== undefined) valueBytes = add(2, String(cap).length);
    }
    bytes = add(bytes, add(JSON.stringify(name).length + 1 + (i === 0 ? 0 : 1), valueBytes));
  }
  return bytes;
}
function parseLimits(text: unknown): Limits {
  const parsed = parseText(text, LIMITS_TEXT_MAX_BYTES, true);
  if (Object.keys(parsed).length !== LIMIT_NAMES.length) return bad();
  const values: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const name of LIMIT_NAMES) {
    const value = parsed[name];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return bad();
    values[name] = value;
  }
  const limits = Object.freeze(values) as Limits;
  if (limits.maxIdentifierBytes > limits.maxEnvelopeBytes || limits.maxActiveCommands > limits.maxAcceptedCommands
    || limits.maxAcceptedCommands > limits.maxRegisteredIntents || limits.maxQueuedCommands > limits.maxAcceptedCommands
    || limits.maxSingleIntentLogicalBytes > limits.maxRetainedLogicalBytes) return bad();
  for (const value of [limits.maxAcceptedCommands, limits.maxRetainedMetadataBytes, limits.maxRetainedLogicalBytes]) {
    if (String(value).length > limits.maxSequenceDigits) return bad();
  }
  return limits;
}
function identifier(value: unknown, limits: Limits): string {
  if (typeof value !== "string" || value.length > limits.maxIdentifierBytes || !/^[A-Za-z0-9_-]+$/.test(value)) return bad();
  return value;
}
function frozenRecord<T extends object>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null) as T, value));
}
function branded<T extends object>(set: WeakSet<T>, value: unknown): T {
  if (typeof value !== "object" || value === null || !set.has(value as T)) return bad();
  return value as T;
}
/** Construction accepts only primitive text and primitive ASCII IDs, never caller DTOs. */
export function createResidentProtocolCodec(limitsText: unknown, ownerEpoch: unknown, sessionId: unknown): ResidentProtocolCodec {
  const limits = parseLimits(limitsText);
  const address: Address = frozenRecord({ ownerEpoch: identifier(ownerEpoch, limits), sessionId: identifier(sessionId, limits) });
  const bounds: ProtocolBounds = frozenRecord({
    minimumEnvelopeBytes: schemaBytes(requestSchema, limits, true),
    minimumReplyBytes: schemaBytes(envelope(minimumReplyBody, true), limits, true),
    maximumEnvelopeBytes: schemaBytes(requestSchema, limits, false),
    maximumReplyBytes: schemaBytes(replySchema, limits, false),
  });
  if (bounds.minimumEnvelopeBytes > limits.maxEnvelopeBytes || bounds.minimumReplyBytes > limits.maxReplyBytes) return bad();
  const requests = new WeakSet<ResidentRequest>();
  const replies = new WeakSet<ResidentReply>();
  const keys = new WeakSet<CommandKey>();
  const validate = (schema: Schema, value: Parsed): Parsed => {
    if (schema.type === "id") return identifier(value, limits);
    if (schema.type === "uint") {
      if (typeof value !== "string" || value.length > limits.maxSequenceDigits || !/^(0|[1-9][0-9]*)$/.test(value) || (schema.positive && value === "0")) return bad();
      return value;
    }
    if (schema.type === "bool") return typeof value === "boolean" ? value : bad();
    if (schema.type === "enum") return typeof value === "string" && schema.values.includes(value) ? value : bad();
    if (schema.type === "union") {
      const source = record(value);
      // Nested unions are closed static descriptors, not input-provided schemas.
      const choose = (candidate: Schema): Schema | undefined => {
        if (candidate.type === "union") {
          for (const child of candidate.variants) { const found = choose(child); if (found) return found; }
        } else if (candidate.type === "record") {
          const tag = candidate.fields[0];
          if (tag?.[0] === "kind" && tag[1].type === "enum" && typeof source.kind === "string" && tag[1].values.includes(source.kind)) return candidate;
        }
        return undefined;
      };
      const selected = choose(schema);
      return selected ? validate(selected, value) : bad();
    }
    if (schema.type !== "record") return bad();
    const source = record(value);
    if (Object.keys(source).length !== schema.fields.length) return bad();
    const result: ParsedRecord = Object.create(null) as ParsedRecord;
    for (const [name, child] of schema.fields) {
      if (!Object.hasOwn(source, name)) return bad();
      result[name] = validate(child, source[name]!);
    }
    if ((schema === addressSchema || schema === commandSchema) && (result.ownerEpoch !== address.ownerEpoch || result.sessionId !== address.sessionId)) return bad();
    Object.freeze(result);
    if (schema === commandSchema) keys.add(result as unknown as CommandKey);
    return result;
  };
  const decodeRequest = (text: unknown): ResidentRequest => {
    const value = validate(requestSchema, parseText(text, limits.maxEnvelopeBytes, false)) as unknown as ResidentRequest;
    requests.add(value);
    return value;
  };
  const decodeReply = (text: unknown): ResidentReply => {
    const value = validate(replySchema, parseText(text, limits.maxReplyBytes, false)) as unknown as ResidentReply;
    const body = value.body;
    if (body.kind === "cancel-result") {
      const kind = body.observation.kind;
      if (body.status === "recorded" || body.status === "already-terminal") {
        if (!["pending", "definitely-unsent", "flushed", "unknown"].includes(kind) || (body.status === "already-terminal" && kind === "pending")) return bad();
      } else if (kind !== body.status) return bad();
    }
    replies.add(value);
    return value;
  };
  const encodeRequest = (value: unknown): string => {
    const text = JSON.stringify(branded(requests, value));
    textBytes(text, limits.maxEnvelopeBytes);
    return text;
  };
  const encodeReply = (value: unknown): string => {
    const text = JSON.stringify(branded(replies, value));
    textBytes(text, limits.maxReplyBytes);
    return text;
  };
  const commandKeyOf = (value: unknown): CommandKey => {
    if (typeof value !== "object" || value === null) return bad();
    let body: RequestBody | ReplyBody;
    if (requests.has(value as ResidentRequest)) body = (value as ResidentRequest).body;
    else if (replies.has(value as ResidentReply)) body = (value as ResidentReply).body;
    else return bad();
    if (body.kind === "submit") {
      const key = frozenRecord({ ownerEpoch: address.ownerEpoch, sessionId: address.sessionId, sequence: body.sequence });
      keys.add(key);
      return key;
    }
    if (body.kind === "reconcile" || body.kind === "cancel" || body.kind === "submission" || body.kind === "observation" || body.kind === "cancel-result") return body.command;
    return bad();
  };
  const compareCommandKeys = (left: unknown, right: unknown): -1 | 0 | 1 => {
    const a = branded(keys, left), b = branded(keys, right);
    // Every branded key already has this exact construction-bound epoch/session.
    if (a.sequence === b.sequence) return 0;
    if (a.sequence.length !== b.sequence.length) return a.sequence.length < b.sequence.length ? -1 : 1;
    return a.sequence < b.sequence ? -1 : 1;
  };
  const sameSubmission = (left: unknown, right: unknown): boolean => {
    const a = branded(requests, left), b = branded(requests, right);
    if (a.body.kind !== "submit" || b.body.kind !== "submit") return bad();
    return a.body.sequence === b.body.sequence && a.body.intentId === b.body.intentId && a.body.intentKind === b.body.intentKind && a.body.observedIntentRevision === b.body.observedIntentRevision;
  };
  return frozenRecord({ limits, address, bounds, decodeRequest, decodeReply, encodeRequest, encodeReply, commandKeyOf, compareCommandKeys, sameSubmission });
}
