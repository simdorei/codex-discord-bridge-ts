import type { DatabaseSync } from "node:sqlite";
import { I64_MAX, I64_MIN } from "../protocol/ids.ts";
import type { StoredQueueJob } from "./queue-read.ts";
import { StoreIntegrityError } from "./schema-assembly.ts";
import { decodeBool } from "./sqlite-values.ts";

function assertStrictUnicode(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new StoreIntegrityError(
      `Expected string for ${name}, received ${value === null ? "null" : typeof value}`,
    );
  }
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (code !== undefined && code >= 0xd800 && code <= 0xdfff) {
      throw new StoreIntegrityError(`Invalid Unicode surrogate in ${name}`);
    }
  }
  return value;
}

function assertI64(value: unknown, name: string): bigint {
  if (typeof value !== "bigint") {
    throw new StoreIntegrityError(
      `Expected integer bigint for ${name}, received ${value === null ? "null" : typeof value}`,
    );
  }
  if (value < I64_MIN || value > I64_MAX) {
    throw new StoreIntegrityError(
      `Integer overflow for ${name}: value ${value.toString()} out of i64 range`,
    );
  }
  return value;
}

export function targetIsHeldIn(db: DatabaseSync, target: string): boolean {
  const validTarget = assertStrictUnicode(target, "target");
  const stmt = db.prepare(
    "SELECT EXISTS(SELECT 1 FROM codex_dead_generation_holds WHERE target_thread_id = ?)",
  );
  stmt.setReadBigInts(true);
  const row = stmt.get(validTarget) as Record<string, unknown> | undefined;
  if (!row) {
    throw new StoreIntegrityError("Expected row from target_is_held query");
  }
  const val = Object.values(row)[0];
  return decodeBool(val, "target_is_held");
}

export function generationIsSealedIn(
  db: DatabaseSync,
  generation: bigint,
): boolean {
  const validGeneration = assertI64(generation, "generation");
  const stmt = db.prepare(
    "SELECT EXISTS(SELECT 1 FROM codex_dead_generation_incidents incident JOIN codex_app_server_runtime runtime ON runtime.runtime_id = incident.runtime_id WHERE runtime.singleton = 1 AND incident.generation = ?)",
  );
  stmt.setReadBigInts(true);
  const row = stmt.get(validGeneration) as Record<string, unknown> | undefined;
  if (!row) {
    throw new StoreIntegrityError("Expected row from generation_is_sealed query");
  }
  const val = Object.values(row)[0];
  return decodeBool(val, "generation_is_sealed");
}

export function jobCanMutate(db: DatabaseSync, job: StoredQueueJob): boolean {
  if (!job || typeof job !== "object") {
    throw new StoreIntegrityError("Expected StoredQueueJob object");
  }
  if (targetIsHeldIn(db, job.targetThreadId)) {
    return false;
  }
  return !generationIsSealedIn(db, job.appServerGeneration);
}
