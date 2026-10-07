import type { DatabaseSync } from "node:sqlite";
import { parseSerdeValue } from "../core/serde-json-parse.ts";
import { parseNewReplyIdentity, type Identity } from "./new-reply-identity.ts";
import { StoreIntegrityError } from "./schema-assembly.ts";
import {
  decodeBool,
  decodeI64,
  decodeTextField,
  textDecoderFor,
} from "./sqlite-values.ts";

export type { Identity };

export interface NewReply {
  identity: Identity;
  turnId: string | null;
  acceptedAt: number | null;
  state: string;
  version: bigint;
  scan: unknown;
  lastError: string;
  confirmationDelivered: boolean;
  warningDue: bigint;
  acknowledgementRecoveryAllowed: boolean;
}

const SELECT_SQL =
  "SELECT identity_json, turn_id, accepted_at, state, version, scan_json, last_error, " +
  "confirmation_delivered, warning_due, ack_recovery_allowed, " +
  "CAST(identity_json AS BLOB) AS _blob_identity_json, " +
  "CAST(turn_id AS BLOB) AS _blob_turn_id, " +
  "CAST(state AS BLOB) AS _blob_state, " +
  "CAST(scan_json AS BLOB) AS _blob_scan_json, " +
  "CAST(last_error AS BLOB) AS _blob_last_error, " +
  "(SELECT encoding FROM pragma_encoding) AS _text_encoding " +
  "FROM codex_new_first_replies WHERE job_id = ?";

function assertWellFormedUnicode(val: string, field: string): void {
  for (const ch of val) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined && cp >= 0xd800 && cp <= 0xdfff) {
      throw new StoreIntegrityError(`malformed Unicode scalar in ${field}`);
    }
  }
}

function decodeOptionalF64(val: unknown, fieldName: string): number | null {
  if (val === null) {
    return null;
  }
  if (typeof val === "number") {
    if (Number.isNaN(val)) {
      return null;
    }
    return val;
  }
  if (typeof val === "bigint") {
    return Number(val);
  }
  throw new StoreIntegrityError(
    `Expected numeric f64 for column ${fieldName}, received ${val === null ? "null" : typeof val}`,
  );
}

function decodeRow(row: Record<string, unknown>): NewReply {
  const decoder = textDecoderFor(row._text_encoding);

  const identityJson = decodeTextField(
    row.identity_json,
    row._blob_identity_json,
    "identity_json",
    false,
    decoder,
  )!;
  const turnId = decodeTextField(
    row.turn_id,
    row._blob_turn_id,
    "turn_id",
    true,
    decoder,
  );
  const acceptedAt = decodeOptionalF64(row.accepted_at, "accepted_at");
  const state = decodeTextField(
    row.state,
    row._blob_state,
    "state",
    false,
    decoder,
  )!;
  const version = decodeI64(row.version, "version");
  const scanJson = decodeTextField(
    row.scan_json,
    row._blob_scan_json,
    "scan_json",
    false,
    decoder,
  )!;
  const lastError = decodeTextField(
    row.last_error,
    row._blob_last_error,
    "last_error",
    false,
    decoder,
  )!;
  const confirmationDelivered = decodeBool(
    row.confirmation_delivered,
    "confirmation_delivered",
  );
  const warningDue = decodeI64(row.warning_due, "warning_due");
  const acknowledgementRecoveryAllowed = decodeBool(
    row.ack_recovery_allowed,
    "ack_recovery_allowed",
  );

  const identity = parseNewReplyIdentity(identityJson);
  const scan = parseSerdeValue<unknown>(scanJson);

  return {
    identity,
    turnId,
    acceptedAt,
    state,
    version,
    scan,
    lastError,
    confirmationDelivered,
    warningDue,
    acknowledgementRecoveryAllowed,
  };
}

export function getIn(db: DatabaseSync, jobId: string): NewReply | null {
  assertWellFormedUnicode(jobId, "jobId");
  const stmt = db.prepare(SELECT_SQL);
  stmt.setReadBigInts(true);
  const row = stmt.get(jobId) as Record<string, unknown> | undefined;
  if (row === undefined) {
    return null;
  }
  return decodeRow(row);
}
