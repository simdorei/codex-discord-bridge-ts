import { createHash } from "node:crypto";
import { openInitialized } from "./owned-driver.ts";
import { trimUnicodeWhitespace as trim } from "./queue-preflight-failure.ts";
import { sha256SerdeValue } from "../core/serde-json.ts";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { readAsyncObligationsIn, type AsyncObligation } from "./async-resolution-records.ts";
import { asyncExecutionOwnerIn, exactAsyncOwnerIn } from "./async-resolution-ownership.ts";
import { canonicalTerminal, decodeTerminalProof, serializeTerminalEvidence, type ExecutionOwner, type TerminalEvidence } from "./async-resolution-proof.ts";
import { AsyncResolutionHeldError } from "./async-resolution-admission.ts";
import { completionEvidenceGeneration, selectJob, storedQueueJobsEqual, type StoredQueueJob } from "./queue-read.ts";
import { decodeI64, decodeOptionalI64, decodeTextField, textDecoderFor } from "./sqlite-values.ts";
import { StoreIntegrityError } from "./schema-assembly.ts";

export interface TerminalReleaseOwner { observer: string; generation: bigint }
function text(db: DatabaseSync, row: Record<string, unknown>, name: string): string | null {
  return decodeTextField(row[name],row[name+"_raw"],name,true,textDecoderFor(db.prepare("PRAGMA encoding").get()?.encoding));
}
function conflicted(db: DatabaseSync, row: AsyncObligation): boolean {
  const query = db.prepare("SELECT EXISTS(SELECT 1 FROM cdr_async_terminal_candidates WHERE question_id=? AND revision=? AND kind='conflict') AS present");
  query.setReadBigInts(true);
  return decodeI64(query.get(row.question_id,row.revision)?.present,"present") !== 0n;
}
function proofText(db: DatabaseSync, row: AsyncObligation): string | null {
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
  return raw;
}
function verified(db: DatabaseSync, row: AsyncObligation, owner: ExecutionOwner): readonly [string, TerminalEvidence] | null {
  if (conflicted(db,row)) return null;
  const raw = proofText(db,row);
  if (raw === null) return null;
  const evidence = decodeTerminalProof(row,owner,raw);
  return evidence === null ? null : [raw,evidence];
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

function retainCandidate(db: DatabaseSync, row: AsyncObligation, kind: "unverified" | "conflict" | "replaced", raw: string): void {
  if (Buffer.byteLength(raw) > 131072) throw new AsyncResolutionHeldError(row.thread_id,"terminal candidate exceeds evidence bound");
  const digest=createHash("sha256").update(raw).digest("hex");
  const exists=db.prepare("SELECT EXISTS(SELECT 1 FROM cdr_async_terminal_candidates WHERE question_id=? AND revision=? AND kind=? AND evidence_sha256=?) AS present");
  exists.setReadBigInts(true);
  if(decodeI64(exists.get(row.question_id,row.revision,kind,digest)?.present,"present")!==0n) return;
  const count=db.prepare("SELECT count(*) AS n FROM cdr_async_terminal_candidates WHERE question_id=? AND kind=?");
  count.setReadBigInts(true);
  const limit=kind==="unverified"?8n:kind==="conflict"?1n:2n;
  if(decodeI64(count.get(row.question_id,kind)?.n,"candidate count")>=limit) {
    if(kind==="replaced") throw new AsyncResolutionHeldError(row.thread_id,"existing invalid proof must be retained for reconciliation");
    return;
  }
  db.prepare("INSERT INTO cdr_async_terminal_candidates(question_id,revision,kind,evidence_sha256,evidence_text) VALUES(?,?,?,?,?)")
    .run(row.question_id,row.revision,kind,digest,raw);
}
function captureNotification(db: DatabaseSync,row: AsyncObligation,owner: ExecutionOwner,metadata: unknown,observer: string,generation: bigint): boolean {
  const ownerVerified=owner.observer===observer && owner.generation===generation && exactAsyncOwnerIn(db,row);
  const raw=serializeTerminalEvidence({version:1n,source:"resident_notification_v1",observer,generation,
    thread_id:row.thread_id,turn_id:owner.turn_id,canonical_terminal:metadata,payload_sha256:sha256SerdeValue(metadata),
    claim_sha256:row.claim_sha256,revision:row.revision,owner_verified:ownerVerified});
  if(!ownerVerified) {retainCandidate(db,row,"unverified",raw);return false;}
  if(conflicted(db,row)) return true;
  const prior=proofText(db,row);
  if(prior!==null) {
    let accepted: TerminalEvidence | null;
    try { accepted=decodeTerminalProof(row,owner,prior); } catch { accepted=null; }
    if(accepted!==null) {
      if(isDeepStrictEqual(accepted.canonical_terminal,metadata)) return false;
      retainCandidate(db,row,"conflict",raw);return true;
    }
    retainCandidate(db,row,"replaced",prior);
  }
  const changed=db.prepare(`UPDATE cdr_async_execution_obligations SET terminal_proof_json=?
    WHERE question_id=? AND revision=? AND execution_state='unresolved' AND terminal_proof_json IS ?`)
    .run(raw,row.question_id,row.revision,prior).changes;
  if(BigInt(changed)!==1n) throw new AsyncResolutionHeldError(row.thread_id,"accepted terminal proof lost its exact claim");
  return false;
}
/** Owned proof transaction; conflict evidence is committed before the conflict error is returned. */
export async function recordAsyncTerminalNotification(path: string,thread: string,turn: string,generation: bigint,observer: string,payload: string): Promise<void> {
  for(const value of [path,thread,turn,observer,payload])
    if(typeof value!=="string"||/[\uD800-\uDFFF]/u.test(value)) throw new TypeError("Expected well-formed text");
  if(typeof generation!=="bigint"||generation<-(1n<<63n)||generation>=(1n<<63n)) throw new TypeError("Expected i64 generation");
  const db=await openInitialized(path);let committed=false,conflict=false;
  try {
    db.exec("BEGIN IMMEDIATE");const matching: [AsyncObligation,ExecutionOwner][]=[];
    for(const row of readAsyncObligationsIn(db,thread)) {
      if(row.version!==1n||row.execution_state!=="unresolved") continue;
      const owner=asyncExecutionOwnerIn(db,row);
      if(owner.turn_id===turn) matching.push([row,owner]);
    }
    if(matching.length===0) return;
    if(trim(observer)===""||Buffer.byteLength(observer)>256||generation<0n)
      throw new AsyncResolutionHeldError(thread,"terminal observer identity is invalid");
    const metadata=canonicalTerminal(thread,turn,payload);
    for(const [row,owner] of matching) {
      // Do not short-circuit: every matching obligation must preserve its evidence.
      const captured=captureNotification(db,row,owner,metadata,observer,generation);
      conflict=conflict||captured;
    }
    db.exec("COMMIT");committed=true;
  } finally {
    if(!committed&&db.isTransaction) {try{db.exec("ROLLBACK");}catch{/* close rolls back */}}
    db.close();
  }
  if(conflict) throw new AsyncResolutionHeldError(thread,"conflicting accepted terminal observations require reconciliation");
}

/** Rechecked inside the later raw-journal transaction, never inferred from numeric generation alone. */
export function asyncJournalObservationAllowedIn(db: DatabaseSync,thread: string,turn: string,generation: bigint,observer: string,payload: string): boolean {
  for(const row of readAsyncObligationsIn(db,thread)) {
    if(row.version!==1n) return false;
    const owner=asyncExecutionOwnerIn(db,row);
    if(owner.turn_id!==turn) continue;
    if(!exactAsyncOwnerIn(db,row)) return false;
    const proof=verified(db,row,owner);
    if(proof===null) return false;
    if(proof[1].observer!==observer||proof[1].generation!==generation||
      !isDeepStrictEqual(proof[1].canonical_terminal,canonicalTerminal(thread,turn,payload))) return false;
  }
  return true;
}

// Shared internal bounded diagnostic storage; never grants execution authority.
export { retainCandidate as retainAsyncTerminalCandidateIn };

export { verified as verifiedAsyncTerminalProofIn };
