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

import { decodeI64, decodeTextField, textDecoderFor } from "./sqlite-values.ts";
import { retainAsyncTerminalJournalIn } from "./async-resolution-terminal.ts";
import { takeUnicodeScalarChars } from "./queue-preflight-failure.ts";
export interface ObservedCompletion {threadId:string;turnId:string;generation:bigint;payload:string}
export async function pendingObservedCompletions(path:string):Promise<ObservedCompletion[]> {
  const db=await openInitialized(path);
  try {
    const stmt=db.prepare(`SELECT thread_id,turn_id,generation,payload,CAST(thread_id AS BLOB) AS thread_raw,
      CAST(turn_id AS BLOB) AS turn_raw,CAST(payload AS BLOB) AS payload_raw,
      (SELECT encoding FROM pragma_encoding) AS encoding FROM codex_observed_completions ORDER BY rowid`);
    stmt.setReadBigInts(true);const result:ObservedCompletion[]=[];
    for(const row of stmt.iterate()) {
      const decoder=textDecoderFor(row.encoding);
      result.push({threadId:decodeTextField(row.thread_id,row.thread_raw,"thread_id",false,decoder)!,
        turnId:decodeTextField(row.turn_id,row.turn_raw,"turn_id",false,decoder)!,
        generation:decodeI64(row.generation,"generation"),payload:decodeTextField(row.payload,row.payload_raw,"payload",false,decoder)!});
    }
    return result;
  } finally {db.close();}
}
export async function hasObservedCompletion(path:string,thread:string,turn:string):Promise<boolean> {
  const db=await openInitialized(path);
  try {const stmt=db.prepare("SELECT EXISTS(SELECT 1 FROM codex_observed_completions WHERE thread_id=? AND turn_id=?) AS present");
    stmt.setReadBigInts(true);return decodeI64(stmt.get(thread,turn)?.present,"present")!==0n;
  } finally {db.close();}
}
export async function recordObservedCompletionError(path:string,thread:string,turn:string,error:string):Promise<void> {
  if(typeof error!=="string"||/[\uD800-\uDFFF]/u.test(error)) throw new TypeError("Expected well-formed error text");
  const bounded=takeUnicodeScalarChars(error,1000),db=await openInitialized(path);
  try {db.prepare("UPDATE codex_observed_completions SET last_error=? WHERE thread_id=? AND turn_id=?").run(bounded,thread,turn);}
  finally {db.close();}
}
export async function finishObservedCompletion(path:string,thread:string,turn:string):Promise<void> {
  const read=await openInitialized(path);let retain:boolean;
  try {retain=retainAsyncTerminalJournalIn(read,thread,turn);}finally{read.close();}
  if(retain) return;
  // Preserve the source's two separate opens; this is not an atomic ownership certificate.
  const write=await openInitialized(path);
  try{write.prepare("DELETE FROM codex_observed_completions WHERE thread_id=? AND turn_id=?").run(thread,turn);}
  finally{write.close();}
}

import {usingInitializedStore} from "./owned-scope.ts";
import {I64_MIN,I64_MAX} from "../protocol/ids.ts";
/** Equal numeric generations in different resident lifetimes do not grant release. */
export function hasObservedCompletionResidentEvidence(path:string,thread:string,turn:string,generation:bigint,resident:string):Promise<boolean>{
  for(const value of [thread,turn,resident])if(typeof value!=="string"||/[\uD800-\uDFFF]/u.test(value))throw new TypeError("Expected well-formed resident evidence identity");
  if(typeof generation!=="bigint"||generation<I64_MIN||generation>I64_MAX)throw new RangeError("Expected i64 evidence generation");
  return usingInitializedStore(path,db=>{const q=db.prepare("SELECT EXISTS(SELECT 1 FROM codex_observed_completions WHERE thread_id=?1 AND turn_id=?2 AND generation=?3 AND resident_owner=?4) AS present");q.setReadBigInts(true);return decodeI64(q.get(thread,turn,generation,resident)?.present,"present")!==0n;});
}
