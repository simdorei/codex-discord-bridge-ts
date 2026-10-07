import type { DatabaseSync } from "node:sqlite";

const DELETE_QUEUE_UNRESOLVED_NOTICES_SQL =
  "DELETE FROM codex_delivery_outbox WHERE delivery_id IN (" +
  "SELECT CASE state WHEN 'starting' " +
  "THEN 'fork-unresolved-starting:' || job_id " +
  "ELSE 'fork-unresolved:' || job_id END " +
  "FROM codex_turn_queue WHERE target_thread_id = ? " +
  "AND state IN ('pending', 'starting')" +
  ")";

const DELETE_INTAKE_UNRESOLVED_NOTICES_SQL =
  "DELETE FROM codex_delivery_outbox WHERE delivery_id IN (" +
  "SELECT 'fork-unresolved-intake:' || job_id " +
  "FROM codex_prompt_intakes WHERE target_thread_id = ?" +
  ")";

function validateSource(source: string): void {
  if (typeof source !== "string") {
    throw new TypeError("source must be a string");
  }
  for (let i = 0; i < source.length; i++) {
    const code = source.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 < source.length) {
        const next = source.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          i++;
          continue;
        }
      }
      throw new TypeError("source must not contain lone surrogates");
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError("source must not contain lone surrogates");
    }
  }
}

export function clearUnresolvedNoticesIn(db: DatabaseSync, source: string): void {
  validateSource(source);
  db.prepare(DELETE_QUEUE_UNRESOLVED_NOTICES_SQL).run(source);
  db.prepare(DELETE_INTAKE_UNRESOLVED_NOTICES_SQL).run(source);
}
