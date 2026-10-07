import type { DatabaseSync } from "node:sqlite";
import { targetIsHeldIn } from "./dead-generation-admission.ts";
import { DeadGenerationTargetHeldError } from "./fork-completed-target.ts";
import { ensureForkHandoffTable } from "./fork-handoff-admission.ts";
import { StoreIntegrityError } from "./schema-assembly.ts";
import { decodeBool, decodeTextField, textDecoderFor } from "./sqlite-values.ts";

export class ForkHandoffCycleError extends Error {
  readonly kind = "ForkHandoffCycle" as const;
  readonly sourceThreadId: string;

  constructor(sourceThreadId: string) {
    super(`completed app-server fork handoff cycle from ${sourceThreadId}`);
    this.name = "ForkHandoffCycleError";
    this.sourceThreadId = sourceThreadId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function requireWellFormedString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`Expected a well-formed string for ${name}`);
  }
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      i++;
      if (i >= value.length) {
        throw new TypeError(`Expected a well-formed string without lone surrogates for ${name}`);
      }
      const next = value.charCodeAt(i);
      if (next < 0xdc00 || next > 0xdfff) {
        throw new TypeError(`Expected a well-formed string without lone surrogates for ${name}`);
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError(`Expected a well-formed string without lone surrogates for ${name}`);
    }
  }
  return value;
}

interface RoutingTableExistsRow {
  enabled: unknown;
}

interface ForkTargetRow {
  target_thread_id: unknown;
  raw: unknown;
  encoding: unknown;
}

export function canonicalCompletedTargetIn(
  db: DatabaseSync,
  sourceThreadId: string,
): string {
  requireWellFormedString(sourceThreadId, "sourceThreadId");

  const routingCheckStmt = db.prepare(
    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='codex_exact_thread_routing') AS enabled",
  );
  routingCheckStmt.setReadBigInts(true);
  const routingRow = routingCheckStmt.get() as RoutingTableExistsRow | undefined;
  if (!routingRow) {
    throw new StoreIntegrityError("Expected row from routing table check");
  }

  if (decodeBool(routingRow.enabled, "enabled")) {
    if (targetIsHeldIn(db, sourceThreadId)) {
      throw new DeadGenerationTargetHeldError(sourceThreadId);
    }
    return sourceThreadId;
  }

  ensureForkHandoffTable(db);

  let current = sourceThreadId;
  const visited = new Set<string>();

  while (!visited.has(current)) {
    visited.add(current);

    if (targetIsHeldIn(db, current)) {
      throw new DeadGenerationTargetHeldError(current);
    }

    const targetStmt = db.prepare(`SELECT target_thread_id, CAST(target_thread_id AS BLOB) AS raw,
  (SELECT encoding FROM pragma_encoding) AS encoding
FROM codex_thread_fork_handoffs
WHERE source_thread_id = ? AND completed_at IS NOT NULL`);
    targetStmt.setReadBigInts(true);

    const row = targetStmt.get(current) as ForkTargetRow | undefined;
    if (row === undefined) {
      return current;
    }

    const target = decodeTextField(
      row.target_thread_id,
      row.raw,
      "target_thread_id",
      false,
      textDecoderFor(row.encoding),
    );
    if (target === null) {
      throw new StoreIntegrityError(
        "Expected non-null target_thread_id for completed fork handoff",
      );
    }

    current = target;
  }

  throw new ForkHandoffCycleError(sourceThreadId);
}
