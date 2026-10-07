import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { readAsyncObligationsIn, type AsyncObligation } from "./async-resolution-records.ts";
import { asyncExecutionOwnerIn, exactAsyncOwnerIn } from "./async-resolution-ownership.ts";
import { canonicalTerminal, decodeTerminalProof, type ExecutionOwner, type TerminalEvidence } from "./async-resolution-proof.ts";
import { AsyncResolutionHeldError } from "./async-resolution-admission.ts";
import { completionEvidenceGeneration, selectJob, storedQueueJobsEqual, type StoredQueueJob } from "./queue-read.ts";
import { decodeI64, decodeOptionalI64, decodeTextField, textDecoderFor } from "./sqlite-values.ts";
import { StoreIntegrityError } from "./schema-assembly.ts";

export interface TerminalReleaseOwner { observer: string; generation: bigint }
function text(db: DatabaseSync, row: Record<string, unknown>, name: string): string | null {
  return decodeTextField(row[name],row[name+"_raw"],name,true,textDecoderFor(db.prepare("PRAGMA encoding").get()?.encoding));
}
function verified(db: DatabaseSync, row: AsyncObligation, owner: ExecutionOwner): readonly [string, TerminalEvidence] | null {
  const conflict=db.prepare("SELECT EXISTS(SELECT 1 FROM cdr_async_terminal_candidates WHERE question_id=? AND revision=? AND kind='conflict') AS present");
  conflict.setReadBigInts(true);
  if(decodeI64(conflict.get(row.question_id,row.revision)?.present,"present")!==0n) return null;
  const query=db.prepare(`SELECT length(CAST(terminal_proof_json AS BLOB)) AS size,
    CASE WHEN length(CAST(terminal_proof_json AS BLOB))<=131072 THEN terminal_proof_json END AS proof,
    CAST(CASE WHEN length(CAST(terminal_proof_json AS BLOB))<=131072 THEN terminal_proof_json END AS BLOB) AS proof_raw
    FROM cdr_async_execution_obligations WHERE question_id=?`);
  query.setReadBigInts(true); const stored=query.get(row.question_id);
  if(!stored) throw new StoreIntegrityError("Missing async obligation proof row");
  const size=decodeOptionalI64(stored.size,"size");
  // Rust query_row converts the complete tuple before enforcing size.
  const raw=text(db,stored,"proof");
  if(size!==null&&size>131072n) throw new AsyncResolutionHeldError(row.thread_id,"oversized terminal proof must remain preserved");
  if(raw===null) return null;
  const evidence=decodeTerminalProof(row,owner,raw);
  return evidence===null?null:[raw,evidence];
}
/** Same caller-owned IMMEDIATE transaction as completion, before job deletion. */
export function settleOwnedAsyncIn(db: DatabaseSync, expected: StoredQueueJob, release: TerminalReleaseOwner | null): void {
  if(release===null || expected.turnId===null || expected.goalWaiting || completionEvidenceGeneration(expected)!==release.generation) return;
  if(!db.isTransaction) throw new StoreIntegrityError("Borrowed mutation requires an active transaction");
  const actual=selectJob(db,expected.jobId);
  if(!storedQueueJobsEqual(actual,expected)) return;
  for(const row of readAsyncObligationsIn(db,expected.targetThreadId)) {
    if(row.origin_job_id!==expected.jobId || row.version!==1n || row.execution_state!=="unresolved" || !exactAsyncOwnerIn(db,row)) continue;
    const owner=asyncExecutionOwnerIn(db,row);
    if(owner.turn_id!==expected.turnId||owner.observer!==release.observer||owner.generation!==release.generation) continue;
    const proof=verified(db,row,owner); if(proof===null) continue;
    if(row.revision===9223372036854775807n) throw new AsyncResolutionHeldError(row.thread_id,"terminal revision overflow");
    const changed=db.prepare(`UPDATE cdr_async_execution_obligations SET execution_state='terminal',
      admission_state=CASE WHEN policy='ordinary' THEN 'settled' ELSE 'held' END,
      answer_state=CASE WHEN answer_state='unresolved' THEN 'terminal_without_receipt' ELSE answer_state END,
      revision=revision+1 WHERE question_id=? AND revision=? AND terminal_proof_json=? AND execution_state='unresolved'`)
      .run(row.question_id,row.revision,proof[0]).changes;
    if(BigInt(changed)!==1n) throw new AsyncResolutionHeldError(row.thread_id,"terminal settlement lost its exact revision");
    db.prepare("INSERT INTO cdr_async_terminal_settlements(question_id,revision,proof_json) VALUES(?,?,?)").run(row.question_id,row.revision+1n,proof[0]);
    db.prepare(`UPDATE cdr_async_questions SET state='closed_unknown' WHERE id=? AND state='dispatching'
      AND dispatch_mode='steer' AND preparation_json=?`).run(row.question_id,row.original_seal);
  }
}
/** Read-only retention decision; any unprovable unresolved owner keeps its journal. */
export function retainAsyncTerminalJournalIn(db: DatabaseSync, thread: string, turn: string): boolean {
  const query=db.prepare(`SELECT generation,
    CASE WHEN length(CAST(payload AS BLOB))<=131072 THEN payload END AS payload,
    CAST(CASE WHEN length(CAST(payload AS BLOB))<=131072 THEN payload END AS BLOB) AS payload_raw,
    resident_owner,CAST(resident_owner AS BLOB) AS resident_owner_raw
    FROM codex_observed_completions WHERE thread_id=? AND turn_id=?`);
  query.setReadBigInts(true); const journal=query.get(thread,turn); if(!journal) return false;
  const generation=decodeI64(journal.generation,"generation"),payload=text(db,journal,"payload"),resident=text(db,journal,"resident_owner");
  for(const row of readAsyncObligationsIn(db,thread)) {
    if(row.execution_state!=="unresolved") continue;
    let owner: ExecutionOwner;
    try { owner=asyncExecutionOwnerIn(db,row); } catch { return true; }
    if(owner.turn_id!==turn) continue;
    let proof: readonly [string,TerminalEvidence] | null;
    try { proof=verified(db,row,owner); } catch { return true; }
    if(proof===null||payload===null) return true;
    let metadata: unknown;
    try { metadata=canonicalTerminal(thread,turn,payload); } catch { return true; }
    if(generation!==proof[1].generation||resident!==proof[1].observer||!isDeepStrictEqual(metadata,proof[1].canonical_terminal)) return true;
  }
  return false;
}
