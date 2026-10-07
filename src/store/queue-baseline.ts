import type { DatabaseSync } from "node:sqlite";
import type { StoredQueueJob } from "./queue-read.ts";
import { decodeTextField, textDecoderFor } from "./sqlite-values.ts";
import { parseSerdeValue } from "../core/serde-json-parse.ts";

interface BaselineRow {
  baseline_turn_ids: unknown;
  raw_baseline_turn_ids: unknown;
  encoding?: unknown;
}

const QUERY_BASELINE = `
SELECT
  baseline_turn_ids,
  CAST(baseline_turn_ids AS BLOB) AS raw_baseline_turn_ids,
  (SELECT encoding FROM pragma_encoding) AS encoding
FROM codex_turn_queue
WHERE job_id = ?
`;

function assertScalarString(val: unknown, name: string): asserts val is string {
  if (typeof val !== "string") {
    throw new TypeError(
      `Expected string for ${name}, received ${val === null ? "null" : typeof val}`,
    );
  }
  for (let i = 0; i < val.length; i++) {
    const code = val.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 >= val.length) {
        throw new TypeError(`${name} contains lone surrogate`);
      }
      const next = val.charCodeAt(i + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) {
        throw new TypeError(`${name} contains lone surrogate`);
      }
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError(`${name} contains lone surrogate`);
    }
  }
}

export function matchingBaselineJsonIn(
  db: DatabaseSync,
  claimed: Pick<StoredQueueJob, "jobId" | "baselineTurnIds">,
): string | null {
  if (!claimed || typeof claimed !== "object") {
    throw new TypeError("claimed must be an object");
  }
  const jobId = claimed.jobId;
  assertScalarString(jobId, "claimed.jobId");

  const stmt = db.prepare(QUERY_BASELINE);
  const row = stmt.get(jobId) as BaselineRow | undefined;
  if (row === undefined) {
    return null;
  }

  const encoding =
    row.encoding ??
    (db.prepare("PRAGMA encoding").get() as { encoding?: unknown } | undefined)?.encoding;

  const decoder = textDecoderFor(encoding);
  const raw = decodeTextField(
    row.baseline_turn_ids,
    row.raw_baseline_turn_ids,
    "baseline_turn_ids",
    false,
    decoder,
  );
  if (raw === null) {
    return null;
  }

  const actual = parseSerdeValue(raw);

  const rawBaselineTurnIds = claimed.baselineTurnIds;
  if (!Array.isArray(rawBaselineTurnIds)) {
    throw new TypeError("claimed.baselineTurnIds must be an array");
  }
  const snapshot: string[] = [];
  for (let i = 0; i < rawBaselineTurnIds.length; i++) {
    const item = rawBaselineTurnIds[i];
    assertScalarString(item, `claimed.baselineTurnIds[${i}]`);
    snapshot.push(item);
  }

  if (!Array.isArray(actual)) {
    return null;
  }
  if (actual.length !== snapshot.length) {
    return null;
  }
  for (let i = 0; i < snapshot.length; i++) {
    const actualItem = actual[i];
    const expectedItem = snapshot[i];
    if (typeof actualItem !== "string" || actualItem !== expectedItem) {
      return null;
    }
  }

  return raw;
}
