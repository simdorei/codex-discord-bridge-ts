import { DatabaseSync } from "node:sqlite";

import { ensureForkHandoffTable } from "./fork-handoff-admission.ts";
import { openInitialized } from "./owned-driver.ts";
import { StoreIntegrityError } from "./schema-assembly.ts";
import { decodeTextField, textDecoderFor } from "./sqlite-values.ts";

const stringCharCodeAt = String.prototype.charCodeAt;

function validatePath(path: unknown): asserts path is string {
  if (typeof path !== "string") {
    throw new TypeError("Database path must be a string");
  }
  const len = path.length;
  for (let i = 0; i < len; i++) {
    const code = stringCharCodeAt.call(path, i);
    if (code >= 0xd800 && code <= 0xdbff) {
      i++;
      if (i >= len) {
        throw new TypeError("Database path contains ill-formed UTF-16: unpaired high surrogate");
      }
      const next = stringCharCodeAt.call(path, i);
      if (next < 0xdc00 || next > 0xdfff) {
        throw new TypeError("Database path contains ill-formed UTF-16: unpaired high surrogate");
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError("Database path contains ill-formed UTF-16: unpaired low surrogate");
    }
  }
}

export function exactThreadRoutingEnabledIn(db: DatabaseSync): boolean {
  const stmt = db.prepare(
    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='codex_exact_thread_routing')",
  );
  const row = stmt.get() as Record<string, unknown> | undefined;
  if (row === undefined) {
    return false;
  }
  const values = Object.values(row);
  const first = values[0];
  return first === 1 || first === 1n || first === true;
}

export async function retireCopyOnlyHandoffs(path: string): Promise<bigint> {
  validatePath(path);
  const db = await openInitialized(path);
  let committed = false;
  try {
    db.exec("BEGIN IMMEDIATE;");

    ensureForkHandoffTable(db);

    db.exec(
      "CREATE TABLE IF NOT EXISTS codex_exact_thread_routing (enabled INTEGER NOT NULL CHECK(enabled=1));\n" +
      "INSERT INTO codex_exact_thread_routing SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM codex_exact_thread_routing);"
    );

    const pragmaRow = db.prepare("PRAGMA encoding;").get() as Record<string, unknown> | undefined;
    let encodingVal: unknown;
    if (pragmaRow !== undefined) {
      if ("encoding" in pragmaRow) {
        encodingVal = pragmaRow["encoding"];
      } else {
        const values = Object.values(pragmaRow);
        encodingVal = values[0];
      }
    }
    const decoder = textDecoderFor(encodingVal);

    const query = db.prepare(
      "SELECT handoff_id, CAST(handoff_id AS BLOB) AS handoff_id_blob " +
      "FROM codex_thread_fork_handoffs h " +
      "WHERE ambiguous_job_id IS NULL " +
      "AND NOT EXISTS (SELECT 1 FROM codex_turn_queue q " +
        "WHERE q.target_thread_id IN (h.source_thread_id, h.observed_target_thread_id, h.target_thread_id) " +
        "AND q.state IN ('starting','running','quarantined')) " +
      "AND NOT EXISTS (SELECT 1 FROM codex_dead_generation_holds d " +
        "WHERE d.target_thread_id IN (h.source_thread_id, h.observed_target_thread_id, h.target_thread_id))"
    );

    const rows = query.all() as Array<Record<string, unknown>>;
    const ids: string[] = [];
    for (const row of rows) {
      const decodedId = decodeTextField(
        row["handoff_id"],
        row["handoff_id_blob"],
        "handoff_id",
        false,
        decoder,
      );
      if (typeof decodedId !== "string") {
        throw new StoreIntegrityError("Expected non-null string for handoff_id");
      }
      ids.push(decodedId);
    }

    if (ids.length > 0) {
      db.exec(
        "CREATE TABLE IF NOT EXISTS codex_retired_fork_handoffs AS SELECT * FROM codex_thread_fork_handoffs WHERE 0;\n" +
        "CREATE UNIQUE INDEX IF NOT EXISTS codex_retired_fork_id ON codex_retired_fork_handoffs(handoff_id);"
      );
      const insertStmt = db.prepare(
        "INSERT INTO codex_retired_fork_handoffs SELECT * FROM codex_thread_fork_handoffs WHERE handoff_id = ?",
      );
      const deleteStmt = db.prepare(
        "DELETE FROM codex_thread_fork_handoffs WHERE handoff_id = ?",
      );
      for (const id of ids) {
        insertStmt.run(id);
        deleteStmt.run(id);
      }
    }

    db.exec("COMMIT;");
    committed = true;
    return BigInt(ids.length);
  } catch (err) {
    if (!committed) {
      try {
        db.exec("ROLLBACK;");
      } catch {
        // preserve primary error on rollback failure
      }
    }
    throw err;
  } finally {
    try {
      db.close();
    } catch {
      // cleanup close error must be swallowed after success as Rust Drop and preserve original primary error on failure
    }
  }
}
