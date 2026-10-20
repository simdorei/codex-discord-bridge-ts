import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { AsyncResolutionHeldError } from "./async-resolution-admission.ts";
import { StoreIntegrityError } from "./schema-assembly.ts";
import { decodeI64, textDecoderFor } from "./sqlite-values.ts";

export interface AsyncObligation {
  question_id: string; thread_id: string; origin_job_id: string; turn_id: string;
  version: bigint; revision: bigint; answer_state: string; execution_state: string;
  admission_state: string; policy: string; claim_sha256: string;
  original_seal: string | null; claim: string; original_error: string;
}
const TEXT_COLUMNS = ["question_id", "thread_id", "origin_job_id", "turn_id", "answer_state",
  "execution_state", "admission_state", "policy", "original_seal", "claim_json", "owner_json", "original_error"] as const;
const PROJECTION = TEXT_COLUMNS.map(c => `typeof(${c}) AS ${c}_type,CAST(${c} AS BLOB) AS ${c}_bytes`).join(",");

/** Digest of exact claim/seal/owner strings, including NULL versus empty domains. */
export function asyncClaimDigest(claim: string, seal: string | null, owner: string | null): string {
  const hash = createHash("sha256");
  for (const value of [claim, seal, owner]) {
    if (value === null) { hash.update(new Uint8Array([0])); continue; }
    const bytes = Buffer.from(value, "utf8"), prefix = Buffer.alloc(9);
    prefix[0] = 1; prefix.writeBigUInt64LE(BigInt(bytes.length), 1);
    hash.update(prefix); hash.update(bytes);
  }
  return hash.digest("hex");
}

/** Borrowed read. Decode all returned rows before checking the 128-record bound. */
export function readAsyncObligationsIn(db: DatabaseSync, thread: string, unsettled = true): AsyncObligation[] {
  if (typeof thread !== "string" || /[\uD800-\uDFFF]/u.test(thread)) throw new TypeError("Expected a well-formed thread");
  const probe = db.prepare("SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='cdr_async_execution_obligations') AS present");
  probe.setReadBigInts(true);
  if (decodeI64(probe.get()?.present, "present") === 0n) return [];
  const source = unsettled ? "cdr_async_unsettled_obligations" : "cdr_async_execution_obligations";
  const statement = db.prepare(`SELECT ${PROJECTION},format_version,revision FROM ${source}
    WHERE thread_id=? ORDER BY question_id LIMIT 129`);
  statement.setReadBigInts(true);
  let decoder: ReturnType<typeof textDecoderFor> | undefined;
  function text(row: Record<string, unknown>, column: string, optional: true): string | null;
  function text(row: Record<string, unknown>, column: string, optional?: false): string;
  function text(row: Record<string, unknown>, column: string, optional = false): string | null {
    const type = row[column + "_type"], bytes = row[column + "_bytes"];
    if (optional && type === "null" && bytes === null) return null;
    if (type !== "text" || !(bytes instanceof Uint8Array)) throw new StoreIntegrityError(`Expected SQLite TEXT for ${column}`);
    decoder ??= textDecoderFor(db.prepare("PRAGMA encoding").get()?.encoding);
    try { return decoder.decode(bytes); }
    catch { throw new StoreIntegrityError(`Invalid SQLite text encoding for ${column}`); }
  }
  const rows: AsyncObligation[] = [];
  for (const row of statement.iterate(thread)) {
    // Rust reads these three before other row fields. They are not parsed as JSON.
    const claim = text(row, "claim_json"), seal = text(row, "original_seal", true), owner = text(row, "owner_json", true);
    const digest = asyncClaimDigest(claim, seal, owner);
    rows.push({question_id: text(row, "question_id"), thread_id: text(row, "thread_id"),
      origin_job_id: text(row, "origin_job_id"), turn_id: text(row, "turn_id"),
      version: decodeI64(row.format_version, "format_version"), revision: decodeI64(row.revision, "revision"),
      answer_state: text(row, "answer_state"), execution_state: text(row, "execution_state"),
      admission_state: text(row, "admission_state"), policy: text(row, "policy"),
      claim_sha256: digest, original_seal: seal, claim, original_error: text(row, "original_error")});
  }
  if (rows.length > 128) throw new AsyncResolutionHeldError(thread, "target evidence page exceeds bounded review limit");
  return rows;
}
