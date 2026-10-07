import type { DatabaseSync } from "node:sqlite";
import { openInitialized } from "./owned-driver.ts";
import { recordAsyncTerminalNotification, asyncJournalObservationAllowedIn } from "./async-resolution-terminal.ts";
import { StoreIntegrityError } from "./schema-assembly.ts";
import { parseSerdeValue } from "../core/serde-json-parse.ts";
import { getOwn } from "./async-resolution-json-helpers.ts";

// Frozen ingress/stop/control/terminal.rs and mutation_attempt/response/wire.rs.
// These hooks use only a typed terminal and the existing exact resident/job bindings.
function recordControlTerminalIn(db: DatabaseSync,thread: string,turn: string,generation: bigint,resident: string,payload: string): void {
  let value: unknown;
  try {value=parseSerdeValue(payload);} catch {return;}
  const actual=getOwn(value,"turn"),status=getOwn(actual,"status");
  if(getOwn(value,"threadId")!==thread||getOwn(actual,"id")!==turn||
    (status!=="completed"&&status!=="interrupted"&&status!=="failed")) return;
  db.prepare(`UPDATE cdr_stop_controls SET terminal_json=?1,
    phase=CASE WHEN json_extract(record_json,'$.can_settle')=1
      AND NOT EXISTS(SELECT 1 FROM json_each(record_json,'$.jobs') j
        WHERE NOT EXISTS(SELECT 1 FROM cdr_execution_holds h
          WHERE h.job_id=json_extract(j.value,'$.job_id') AND h.target_thread_id=cdr_stop_controls.target_thread_id))
      THEN 'settled' ELSE 'unknown' END
    WHERE target_thread_id=?2 AND turn_id=?3 AND generation=?4 AND resident_owner=?5
      AND EXISTS(SELECT 1 FROM codex_turn_queue q WHERE q.target_thread_id=?2 AND q.turn_id=?3
        AND COALESCE(q.turn_observation_generation,q.app_server_generation)=?4 AND q.state='running')`)
    .run(payload,thread,turn,generation,resident);
  db.prepare(`UPDATE cdr_server_responses SET phase='terminal',terminal_json=?,updated_at=unixepoch()
    WHERE target_thread_id=? AND turn_id=? AND generation=? AND resident_owner=?
      AND EXISTS(SELECT 1 FROM codex_turn_queue q WHERE q.job_id=cdr_server_responses.job_id
        AND q.target_thread_id=cdr_server_responses.target_thread_id AND q.turn_id=cdr_server_responses.turn_id
        AND q.state='running' AND COALESCE(q.turn_observation_generation,q.app_server_generation)=?)`)
    .run(payload,thread,turn,generation,resident,generation);
}

/** Live resident producer only; recovery readers must never call this to invent provenance. */
export async function recordObservedCompletionForResident(
  path: string,thread: string,turn: string,generation: bigint,payload: string,resident: string,
): Promise<boolean> {
  // Deliberately two transactions, matching Rust: accepted proof survives a later journal failure.
  await recordAsyncTerminalNotification(path,thread,turn,generation,resident,payload);
  if(resident==="") throw new StoreIntegrityError("empty completion resident");
  const db=await openInitialized(path);let committed=false;
  try {
    db.exec("BEGIN IMMEDIATE");
    if(!asyncJournalObservationAllowedIn(db,thread,turn,generation,resident,payload)) return false;
    const inserted=db.prepare(`INSERT OR IGNORE INTO codex_observed_completions(thread_id,turn_id,generation,payload)
      SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM codex_turn_queue WHERE target_thread_id=? AND turn_id=?
        AND COALESCE(turn_observation_generation,app_server_generation)=? AND state='running')`)
      .run(thread,turn,generation,payload,thread,turn,generation).changes;
    recordControlTerminalIn(db,thread,turn,generation,resident,payload);
    db.prepare(`UPDATE codex_observed_completions SET resident_owner=?1
      WHERE thread_id=?2 AND turn_id=?3 AND generation=?4 AND payload=?5 AND resident_owner IS NULL
        AND EXISTS(SELECT 1 FROM codex_turn_queue WHERE target_thread_id=?2 AND turn_id=?3
          AND COALESCE(turn_observation_generation,app_server_generation)=?4 AND state='running')`)
      .run(resident,thread,turn,generation,payload);
    db.exec("COMMIT");committed=true;return BigInt(inserted)===1n;
  } finally {
    if(!committed&&db.isTransaction) {try{db.exec("ROLLBACK");}catch{/* close rolls back */}}
    db.close();
  }
}
