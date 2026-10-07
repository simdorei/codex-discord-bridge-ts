import type { DatabaseSync } from "node:sqlite";
import type { AppServerForkHandoff } from "./fork-unresolved-read.ts";
import {
  decodeBool,
  decodeI64,
  decodeOptionalI64,
  decodeTextField,
  textDecoderFor,
  type SqliteTextDecoder,
} from "./sqlite-values.ts";

export type { AppServerForkHandoff };

function requireText(value: unknown): asserts value is string {
  if (typeof value !== "string") {
    throw new TypeError("Expected a well-formed string");
  }
  for (const c of value) {
    const p = c.codePointAt(0);
    if (p !== undefined && p >= 0xd800 && p <= 0xdfff) {
      throw new TypeError("Expected a well-formed string");
    }
  }
}

function decodeRequiredText(
  nativeVal: unknown,
  rawBlob: unknown,
  fieldName: string,
  decoder: SqliteTextDecoder,
): string {
  const value = decodeTextField(nativeVal, rawBlob, fieldName, false, decoder);
  if (value === null) {
    throw new TypeError(`Expected non-null string for ${fieldName}`);
  }
  return value;
}

function decodeOptionalText(
  nativeVal: unknown,
  rawBlob: unknown,
  fieldName: string,
  decoder: SqliteTextDecoder,
): string | null {
  return decodeTextField(nativeVal, rawBlob, fieldName, true, decoder);
}

const TEXT_FIELDS = [
  "handoff_id",
  "ambiguous_job_id",
  "source_thread_id",
  "quarantine_reason",
  "last_fork_error",
  "observed_target_thread_id",
  "target_thread_id",
] as const;

const COLUMNS =
  "handoff_id, ambiguous_job_id, source_thread_id, expected_generation, " +
  "discord_channel_id, discord_thread_id, quarantine_reason, last_fork_error, " +
  "fork_failure_ambiguous, observed_target_thread_id, target_thread_id, completed_generation";

const RAW_FIELDS = TEXT_FIELDS.map((name) => `CAST(${name} AS BLOB) AS b_${name}`).join(", ");

const SELECT_BY_ID_SQL =
  `SELECT ${COLUMNS}, ${RAW_FIELDS}, (SELECT encoding FROM pragma_encoding) AS encoding ` +
  `FROM codex_thread_fork_handoffs WHERE handoff_id = ?`;

export function forkHandoffByIdIn(
  db: DatabaseSync,
  handoffId: string,
): AppServerForkHandoff | null {
  requireText(handoffId);

  const stmt = db.prepare(SELECT_BY_ID_SQL);
  stmt.setReadBigInts(true);
  const row = stmt.get(handoffId) as Record<string, unknown> | undefined;
  if (row === undefined) {
    return null;
  }

  const decoder = textDecoderFor(row["encoding"]);

  const decodedHandoffId = decodeRequiredText(
    row["handoff_id"],
    row["b_handoff_id"],
    "handoff_id",
    decoder,
  );
  const ambiguousJobId = decodeOptionalText(
    row["ambiguous_job_id"],
    row["b_ambiguous_job_id"],
    "ambiguous_job_id",
    decoder,
  );
  const sourceThreadId = decodeRequiredText(
    row["source_thread_id"],
    row["b_source_thread_id"],
    "source_thread_id",
    decoder,
  );
  const expectedGeneration = decodeI64(
    row["expected_generation"],
    "expected_generation",
  );
  const discordChannelId = decodeI64(
    row["discord_channel_id"],
    "discord_channel_id",
  );
  const discordThreadId = decodeI64(
    row["discord_thread_id"],
    "discord_thread_id",
  );
  const quarantineReason = decodeRequiredText(
    row["quarantine_reason"],
    row["b_quarantine_reason"],
    "quarantine_reason",
    decoder,
  );
  const lastForkError = decodeRequiredText(
    row["last_fork_error"],
    row["b_last_fork_error"],
    "last_fork_error",
    decoder,
  );
  const forkFailureAmbiguous = decodeBool(
    row["fork_failure_ambiguous"],
    "fork_failure_ambiguous",
  );
  const observedTargetThreadId = decodeOptionalText(
    row["observed_target_thread_id"],
    row["b_observed_target_thread_id"],
    "observed_target_thread_id",
    decoder,
  );
  const targetThreadId = decodeOptionalText(
    row["target_thread_id"],
    row["b_target_thread_id"],
    "target_thread_id",
    decoder,
  );
  const completedGeneration = decodeOptionalI64(
    row["completed_generation"],
    "completed_generation",
  );

  return {
    handoffId: decodedHandoffId,
    ambiguousJobId,
    sourceThreadId,
    expectedGeneration,
    discordChannelId,
    discordThreadId,
    quarantineReason,
    lastForkError,
    forkFailureAmbiguous,
    observedTargetThreadId,
    targetThreadId,
    completedGeneration,
  };
}
