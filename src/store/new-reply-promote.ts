import type { DatabaseSync } from "node:sqlite";
import { types } from "node:util";
import { serializeSerdeValue } from "../core/serde-json.ts";
import type { Identity, IngressKind } from "./new-reply-identity.ts";
import { getIn } from "./new-reply-read.ts";
import type { NewQueueJob } from "./queue-enqueue.ts";
import { StoreIntegrityError } from "./schema-assembly.ts";

export interface NewReplyPromotionIngress {
  ingressId: string;
  kind: IngressKind;
  eventId: bigint | null;
  channelId: bigint;
  sourceMessageId: bigint | null;
  outcome: unknown;
}

const I64_MIN = -9223372036854775808n;
const I64_MAX = 9223372036854775807n;
const U64_MAX = 18446744073709551615n;

function isWellFormedUnicode(s: string): boolean {
  const len = s.length;
  for (let i = 0; i < len; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 >= len) {
        return false;
      }
      const next = s.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        return false;
      }
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function checkString(val: unknown, name: string): string {
  if (typeof val !== "string" || !isWellFormedUnicode(val)) {
    throw new TypeError(`Expected well-formed string for ${name}`);
  }
  return val;
}

function checkI64(val: unknown, name: string): bigint {
  if (typeof val !== "bigint" || val < I64_MIN || val > I64_MAX) {
    throw new TypeError(`Expected signed i64 bigint for ${name}`);
  }
  return val;
}

function checkOptionalI64(val: unknown, name: string): bigint | null {
  if (val === null) {
    return null;
  }
  return checkI64(val, name);
}

function checkKind(val: unknown): IngressKind {
  if (val === "message" || val === "interaction" || val === "action") {
    return val;
  }
  throw new TypeError("Invalid IngressKind");
}

function asI64(v: unknown): bigint | null {
  if (typeof v !== "bigint") {
    return null;
  }
  if (v < I64_MIN || v > I64_MAX) {
    return null;
  }
  return v;
}

function asU64(v: unknown): bigint | null {
  if (typeof v !== "bigint") {
    return null;
  }
  if (v < 0n || v > U64_MAX) {
    return null;
  }
  return v;
}

function getOwnDataField(obj: unknown, key: string): unknown {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj) || types.isProxy(obj)) {
    throw new TypeError("Expected plain data object");
  }
  const proto = Object.getPrototypeOf(obj);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError("Expected plain data object");
  }
  const desc = Object.getOwnPropertyDescriptor(obj, key);
  if (
    desc === undefined ||
    desc.get !== undefined ||
    desc.set !== undefined ||
    !desc.enumerable ||
    !("value" in desc)
  ) {
    throw new TypeError(`Expected own enumerable data property for ${key}`);
  }
  return desc.value;
}

function getEvidenceField(v: unknown, key: string): string {
  if (v === null || typeof v !== "object" || Array.isArray(v) || types.isProxy(v)) {
    throw new StoreIntegrityError(`new evidence field missing: ${key}`);
  }
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) {
    throw new StoreIntegrityError(`new evidence field missing: ${key}`);
  }
  const desc = Object.getOwnPropertyDescriptor(v, key);
  if (desc === undefined || desc.get !== undefined || desc.set !== undefined || !desc.enumerable) {
    throw new StoreIntegrityError(`new evidence field missing: ${key}`);
  }
  const val = desc.value;
  if (typeof val !== "string" || val.length === 0 || !isWellFormedUnicode(val)) {
    throw new StoreIntegrityError(`new evidence field missing: ${key}`);
  }
  return val;
}

function getCreationGeneration(outcome: unknown): bigint {
  if (outcome === null || typeof outcome !== "object" || Array.isArray(outcome)) {
    throw new StoreIntegrityError("new creation generation missing");
  }
  const desc = Object.getOwnPropertyDescriptor(outcome, "thread_start_generation");
  if (desc === undefined || desc.get !== undefined || desc.set !== undefined || !desc.enumerable) {
    throw new StoreIntegrityError("new creation generation missing");
  }
  const val = asI64(desc.value);
  if (val === null) {
    throw new StoreIntegrityError("new creation generation missing");
  }
  return val;
}

function getCreationVersion(creation: unknown): bigint | null {
  if (creation === null || typeof creation !== "object" || Array.isArray(creation)) {
    return null;
  }
  const desc = Object.getOwnPropertyDescriptor(creation, "version");
  if (desc === undefined || desc.get !== undefined || desc.set !== undefined || !desc.enumerable) {
    return null;
  }
  return asU64(desc.value);
}

function getCreationOriginChannelId(creation: unknown): bigint | null {
  if (creation === null || typeof creation !== "object" || Array.isArray(creation)) {
    return null;
  }
  const desc = Object.getOwnPropertyDescriptor(creation, "origin_channel_id");
  if (desc === undefined || desc.get !== undefined || desc.set !== undefined || !desc.enumerable) {
    return null;
  }
  return asI64(desc.value);
}

function identityEquals(a: Identity, b: Identity): boolean {
  return (
    a.ingress_id === b.ingress_id &&
    a.job_id === b.job_id &&
    a.thread_id === b.thread_id &&
    a.cwd === b.cwd &&
    a.state_db === b.state_db &&
    a.channel_id === b.channel_id &&
    a.origin_channel_id === b.origin_channel_id &&
    a.event_id === b.event_id &&
    a.kind === b.kind &&
    a.creation_generation === b.creation_generation &&
    a.prompt_sha256 === b.prompt_sha256 &&
    a.acknowledgement === b.acknowledgement
  );
}

function serializeIdentity(identity: Identity): string {
  return (
    "{" +
    `"ingress_id":${serializeSerdeValue(identity.ingress_id)},` +
    `"job_id":${serializeSerdeValue(identity.job_id)},` +
    `"thread_id":${serializeSerdeValue(identity.thread_id)},` +
    `"cwd":${serializeSerdeValue(identity.cwd)},` +
    `"state_db":${serializeSerdeValue(identity.state_db)},` +
    `"channel_id":${serializeSerdeValue(identity.channel_id)},` +
    `"origin_channel_id":${serializeSerdeValue(identity.origin_channel_id)},` +
    `"event_id":${serializeSerdeValue(identity.event_id)},` +
    `"kind":${serializeSerdeValue(identity.kind)},` +
    `"creation_generation":${serializeSerdeValue(identity.creation_generation)},` +
    `"prompt_sha256":${serializeSerdeValue(identity.prompt_sha256)},` +
    `"acknowledgement":${serializeSerdeValue(identity.acknowledgement)}` +
    "}"
  );
}

export function promoteIn(
  db: DatabaseSync,
  saved: NewReplyPromotionIngress,
  job: NewQueueJob,
  digest: string,
): void {
  const outcome = getOwnDataField(saved, "outcome");

  if (outcome === null || outcome === undefined) {
    return;
  }
  if (typeof outcome !== "object" || Array.isArray(outcome)) {
    return;
  }
  if (types.isProxy(outcome)) {
    throw new TypeError("Proxy objects are not supported in Rust data domain");
  }
  const outcomeProto = Object.getPrototypeOf(outcome);
  if (outcomeProto !== Object.prototype && outcomeProto !== null) {
    throw new TypeError("Only plain objects are supported in Rust data domain");
  }

  const seedDesc = Object.getOwnPropertyDescriptor(outcome, "new_reply_seed");
  if (seedDesc === undefined) {
    return;
  }
  if (seedDesc.get !== undefined || seedDesc.set !== undefined || !seedDesc.enumerable) {
    throw new TypeError("Accessor or non-enumerable properties are not supported");
  }
  const seed = seedDesc.value;

  const creationDesc = Object.getOwnPropertyDescriptor(outcome, "new_creation");
  if (creationDesc === undefined) {
    throw new StoreIntegrityError("new creation evidence is missing");
  }
  if (creationDesc.get !== undefined || creationDesc.set !== undefined || !creationDesc.enumerable) {
    throw new TypeError("Accessor or non-enumerable properties are not supported");
  }
  const creation = creationDesc.value;

  const ingressId = checkString(getOwnDataField(saved, "ingressId"), "ingressId");
  const jobId = checkString(getOwnDataField(job, "jobId"), "jobId");
  const threadId = checkString(getOwnDataField(job, "targetThreadId"), "targetThreadId");
  const cwd = getEvidenceField(creation, "cwd");
  const stateDb = getEvidenceField(seed, "state_db");
  const channelId = checkI64(getOwnDataField(job, "channelId"), "channelId");
  const originChannelId = checkI64(getOwnDataField(saved, "channelId"), "channelId");
  const rawEventId = checkOptionalI64(getOwnDataField(saved, "eventId"), "eventId");
  const eventId =
    rawEventId !== null
      ? rawEventId
      : checkOptionalI64(getOwnDataField(saved, "sourceMessageId"), "sourceMessageId");
  const kind = checkKind(getOwnDataField(saved, "kind"));
  const creationGeneration = getCreationGeneration(outcome);
  const promptSha256 = checkString(digest, "digest");
  const acknowledgement = getEvidenceField(seed, "acknowledgement");

  const identity: Identity = {
    ingress_id: ingressId,
    job_id: jobId,
    thread_id: threadId,
    cwd,
    state_db: stateDb,
    channel_id: channelId,
    origin_channel_id: originChannelId,
    event_id: eventId,
    kind,
    creation_generation: creationGeneration,
    prompt_sha256: promptSha256,
    acknowledgement,
  };

  if (getCreationVersion(creation) !== 1n || getCreationOriginChannelId(creation) !== originChannelId) {
    throw new StoreIntegrityError("new creation identity changed");
  }

  const old = getIn(db, jobId);
  if (old !== null) {
    if (!identityEquals(old.identity, identity)) {
      throw new StoreIntegrityError("immutable new first reply identity changed");
    }
    return;
  }

  const identityJson = serializeIdentity(identity);
  db.prepare(
    "INSERT INTO codex_new_first_replies(job_id,ingress_id,identity_json) VALUES(?,?,?)"
  ).run(jobId, ingressId, identityJson);
}
