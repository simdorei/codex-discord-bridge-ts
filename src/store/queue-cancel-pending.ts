import type {DatabaseSync,SQLInputValue} from "node:sqlite";
import {openInitialized} from "./owned-driver.ts";
import {StoreIntegrityError} from "./schema-assembly.ts";
import {schemaCurrentCancellation} from "./schema-extensions-b2.ts";
import {ensureNoUnresolvedHandoff,ensureSourceNotMoved,requireNoUnresolvedHandoffExistingIn,requireSourceNotMovedExistingIn} from "./fork-handoff-admission.ts";
import {usingExistingStore,withStoreTransaction,commitStore} from "./owned-scope.ts";
import {COLUMNS as QUEUE_FIELDS} from "./queue-read.ts";
import {targetIsHeldIn} from "./dead-generation-admission.ts";
import {DeadGenerationTargetHeldError} from "./queue-mark-running.ts";
import {mirroredThreadIdIn} from "./busy-choice.ts";
import {ingressCancellationOwnersIn} from "./ingress-cancellation-owners.ts";
import {decodeI64,decodeOptionalI64,decodeTextField,textDecoderFor} from "./sqlite-values.ts";
const CANDIDATES=`SELECT job_id,kind,discord_message_id,eligible,CAST(job_id AS BLOB) AS raw_job,CAST(kind AS BLOB) AS raw_kind,(SELECT encoding FROM pragma_encoding) AS encoding FROM (
 SELECT job_id,'queue' AS kind,discord_message_id,created_at,state='pending' AND turn_id IS NULL AND (attempt_count=0 OR (
 execution_generation IS NULL AND turn_observation_generation IS NULL AND goal_waiting=0 AND baseline_turn_ids='[]'
 AND last_error='app-server returned error -32600 for thread/resume: thread ' || target_thread_id || ' already has an active writer')) AS eligible
 FROM codex_turn_queue WHERE target_thread_id=?1 AND channel_id=?2 AND owner_user_id=?3
 UNION ALL SELECT job_id,'intake',discord_message_id,created_at,1 FROM codex_prompt_intakes WHERE target_thread_id=?1 AND channel_id=?2 AND owner_user_id=?3
 UNION ALL SELECT 'ingress:' || ingress_id,'ingress',event_id,created_at,state IN ('staged','acknowledged') FROM discord_ingress_journal
 WHERE target_thread_id=?1 AND channel_id=?2 AND owner_user_id=?3 AND owner_id IS NULL AND state IN ('staged','acknowledged','executing','held')
 AND json_type(payload_json,'$.version')='integer' AND json_extract(payload_json,'$.version')=1 AND (
 (kind='message' AND (json_type(payload_json,'$.plan.Execute.Ask.prompt')='text' OR json_type(payload_json,'$.plan.Execute.Interview.prompt')='text'))
 OR (kind='interaction' AND json_extract(payload_json,'$.work.Slash.name') IN ('ask','interview') AND json_type(payload_json,'$.work.Slash.values.prompt.String')='text')))
 ORDER BY created_at DESC,job_id DESC,kind`;
const OUTCOME="json_set(CASE WHEN json_type(outcome_json)='object' THEN outcome_json WHEN outcome_json IS NULL OR json_type(outcome_json)='null' THEN '{}' ELSE json_object('prior_result',json(outcome_json)) END,'$.kind','request_cancelled','$.job_id',?)";
interface Candidate{job:string;kind:string;event:bigint|null;eligible:boolean}
function integer(v:unknown):void{if(typeof v!=="bigint"||v<-(1n<<63n)||v>=(1n<<63n))throw new TypeError("Expected i64 identity");}
function text(v:unknown):void{if(typeof v!=="string"||/[\uD800-\uDFFF]/u.test(v))throw new TypeError("Expected well-formed text");}
function receipt(db:DatabaseSync,item:Candidate,target:string,channel:bigint,owner:bigint,now:number):void{
  db.prepare("INSERT INTO codex_request_cancellations(job_id,target_thread_id,channel_id,owner_user_id,discord_message_id,cancelled_at) VALUES(?,?,?,?,?,?)").run(item.job,target,channel,owner,item.event,now);
}
function cancelUnstarted(db:DatabaseSync,item:Candidate,target:string,channel:bigint,owner:bigint,now:number):void{
  if(!item.job.startsWith("ingress:"))throw new StoreIntegrityError("invalid pending ingress cancellation identity");const key=item.job.slice(8);
  const q=db.prepare("SELECT EXISTS(SELECT 1 FROM codex_turn_queue WHERE job_id=?1 OR discord_message_id=?2) OR EXISTS(SELECT 1 FROM codex_prompt_intakes WHERE job_id=?1 OR discord_message_id=?2) AS held");q.setReadBigInts(true);
  if(decodeI64(q.get(item.job,item.event)?.held,"held")!==0n)throw new StoreIntegrityError("ingress has conflicting execution ownership; nothing was cancelled");
  receipt(db,item,target,channel,owner,now);
  const changed=db.prepare(`UPDATE discord_ingress_journal SET state='completed',phase='cancelled',owner_kind='cancellation',owner_id=?,outcome_json=${OUTCOME},updated_at=? WHERE ingress_id=? AND event_id IS ? AND target_thread_id=? AND channel_id=? AND owner_user_id=? AND state IN ('staged','acknowledged') AND owner_id IS NULL`).run(item.job,item.job,now,key,item.event,target,channel,owner).changes;
  if(BigInt(changed)!==1n)throw new StoreIntegrityError("ingress execution already started or cancellation ownership changed");
}
/** Original actor's latest eligible pending request, never an implicit interruption of started work. */
export async function cancelLatestPending(path:string,target:string,channel:bigint,owner:bigint,now:number,requireMirror=false):Promise<string|null>{
  text(path);text(target);integer(channel);integer(owner);if(typeof requireMirror!=="boolean")throw new TypeError("Expected mirror policy");if(!Number.isFinite(now)||now<0)throw new StoreIntegrityError("invalid cancellation timestamp");
  const db=await openInitialized(path);try{
    db.exec("BEGIN IMMEDIATE");if(requireMirror&&mirroredThreadIdIn(db,channel)!==target)throw new StoreIntegrityError("retract room mapping changed; nothing was cancelled");
    ensureNoUnresolvedHandoff(db,target);ensureSourceNotMoved(db,target);if(targetIsHeldIn(db,target))throw new DeadGenerationTargetHeldError(target);
    const q=db.prepare(CANDIDATES);q.setReadBigInts(true);const candidates:Candidate[]=q.all(target,channel,owner).map(r=>{const decoder=textDecoderFor(r.encoding);return {job:decodeTextField(r.job_id,r.raw_job,"job_id",false,decoder)!,kind:decodeTextField(r.kind,r.raw_kind,"kind",false,decoder)!,event:decodeOptionalI64(r.discord_message_id,"discord_message_id"),eligible:decodeI64(r.eligible,"eligible")!==0n};});
    const selected=candidates.find(c=>c.eligible);if(selected===undefined){if(candidates.length!==0)throw new StoreIntegrityError("request execution has started or its outcome is unknown; nothing was cancelled");db.exec("COMMIT");return null;}
    if(selected.kind==="ingress")cancelUnstarted(db,selected,target,channel,owner,now);
    else{
      const count=db.prepare("SELECT (SELECT COUNT(*) FROM codex_turn_queue WHERE job_id=?1 OR (?2 IS NOT NULL AND discord_message_id=?2)) + (SELECT COUNT(*) FROM codex_prompt_intakes WHERE job_id=?1 OR (?2 IS NOT NULL AND discord_message_id=?2)) AS n");count.setReadBigInts(true);
      const uncertain=db.prepare("SELECT EXISTS(SELECT 1 FROM codex_delivery_outbox WHERE job_id=?) AS held");uncertain.setReadBigInts(true);
      const occurrences=decodeI64(count.get(selected.job,selected.event)?.n,"occurrences"),held=decodeI64(uncertain.get(selected.job)?.held,"held");
      if(occurrences!==1n||held!==0n)throw new StoreIntegrityError("request has conflicting or uncertain ownership evidence; nothing was cancelled");
      const owners=ingressCancellationOwnersIn(db,selected.job,selected.event,target,channel,owner);receipt(db,selected,target,channel,owner,now);
      const table=selected.kind==="intake"?"codex_prompt_intakes":"codex_turn_queue";
      if(BigInt(db.prepare(`DELETE FROM ${table} WHERE job_id=?`).run(selected.job).changes)!==1n)throw new StoreIntegrityError("cancellation ownership changed");
      for(const key of owners)db.prepare(`UPDATE discord_ingress_journal SET state='completed',phase='cancelled',outcome_json=${OUTCOME},updated_at=? WHERE ingress_id=?`).run(selected.job,now,key);
    }
    db.exec("COMMIT");return selected.job;
  }finally{if(db.isTransaction){try{db.exec("ROLLBACK");}catch{/* close rolls back */}}db.close();}
}

const INTAKE_FIELDS="job_id,target_thread_id,channel_id,owner_user_id,discord_message_id,raw_prompt,auto_queue_when_busy,require_current_mirror,attempt_count,last_error,retry_after,claim_token,claim_expires_at,created_at,updated_at";
const INGRESS_FIELDS="ingress_id,kind,event_id,application_id,channel_id,owner_user_id,source_message_id,payload_json,runtime_id,state,phase,target_thread_id,canonical_owner,owner_kind,owner_id,outcome_json,confirmation_delivered,hold_reason,created_at,updated_at";
const HANDOFF_FIELDS="handoff_id,ambiguous_job_id,source_thread_id,expected_generation,discord_channel_id,discord_thread_id,quarantine_reason,last_fork_error,fork_failure_ambiguous,observed_target_thread_id,target_thread_id,completed_generation,created_at,completed_at";
const SCOPE="target_thread_id=?1 AND channel_id=?2 AND owner_user_id=?3";
const UNOWNED_SCOPE=SCOPE+" AND owner_id IS NULL AND state IN ('staged','acknowledged','executing','held')";
const OWNER_SCOPE="owner_id=?1 OR (?2 IS NOT NULL AND event_id=?2)";
const MAX_ID_BYTES=16384;
function boundedIdentity(value:string,maxBytes=MAX_ID_BYTES):void {
  text(value);if(value.length>maxBytes||Buffer.byteLength(value,"utf8")>maxBytes)throw new StoreIntegrityError("retract identity exceeds byte budget");
}
function scalar(db:DatabaseSync,sql:string,...args:SQLInputValue[]):bigint {
  const q=db.prepare(sql);q.setReadBigInts(true);return decodeI64(q.get(...args)?.n,"count");
}
/** Byte-only preflight: never return an unbounded SQLite value to JS or JSON.
 * CAST AS BLOB measures SQLite's actual UTF-8/UTF-16 storage, including malformed
 * BLOB values in nominally numeric columns. Repeated reads spend budget again.
 * Static table/column/where expressions below are never caller-controlled. */
function pendingReadBudget(db:DatabaseSync) {
  let remaining=8388608n;
  return (table:string,fields:string,where:string,ids:readonly string[],...args:SQLInputValue[]):number=>{
    const bytes=fields.split(",").map(field=>`COALESCE(length(CAST(${field.trim()} AS BLOB)),0)`).join("+");
    const idBytes=ids.length===0?"0":ids.map(field=>`COALESCE(length(CAST(${field} AS BLOB)),0)`).join(",");
    const q=db.prepare(`SELECT ${bytes} AS evidence_bytes, max(0,${idBytes}) AS id_bytes FROM ${table} WHERE ${where} LIMIT 129`);q.setReadBigInts(true);
    const rows=q.all(...args);if(rows.length>128)throw new StoreIntegrityError("retract byte budget: too many candidates or ingress owners");
    for(const row of rows){const n=decodeI64(row.evidence_bytes,"evidence bytes"),id=decodeI64(row.id_bytes,"identity bytes");
      if(n<0n||n>1048576n||n>remaining||id<0n||id>BigInt(MAX_ID_BYTES))throw new StoreIntegrityError("retract evidence exceeds byte budget");remaining-=n;
    }
    return rows.length;
  };
}
type PendingReadBudget=ReturnType<typeof pendingReadBudget>;
function preflightMirrorIn(db:DatabaseSync,budget:PendingReadBudget,channel:bigint,reads=1):void {
  // Charge every mapping lookup, including the per-owner /new validations.
  // Exact-room-first/fallback semantics must match mirroredThreadIdIn.
  const exact=scalar(db,"SELECT count(*) AS n FROM mirror_threads WHERE discord_thread_id=?",channel);
  if(exact>1n)throw new StoreIntegrityError("retract room is mapped to multiple Codex threads");
  for(let i=0;i<reads;i++)budget(exact===1n?"mirror_threads":"(SELECT codex_thread_id,discord_channel_id,discord_thread_id,updated_at FROM mirror_threads WHERE discord_channel_id=? ORDER BY updated_at DESC LIMIT 2)","codex_thread_id,discord_channel_id,discord_thread_id,updated_at",exact===1n?"discord_thread_id=?":"1",["codex_thread_id"],channel);
}
function boundedMirrorIn(db:DatabaseSync,budget:PendingReadBudget,channel:bigint):string|null {
  preflightMirrorIn(db,budget,channel);return mirroredThreadIdIn(db,channel);
}
function requireCancellationReceipt(db:DatabaseSync,item:Candidate,target:string,channel:bigint,owner:bigint,now:number):void {
  if(scalar(db,"SELECT count(*) AS n FROM codex_request_cancellations WHERE job_id=? AND target_thread_id=? AND channel_id=? AND owner_user_id=? AND discord_message_id IS ? AND cancelled_at=?",item.job,target,channel,owner,item.event,now)!==1n)
    throw new StoreIntegrityError("cancellation receipt was not retained; nothing was cancelled");
}
function insertCheckedReceipt(db:DatabaseSync,item:Candidate,target:string,channel:bigint,owner:bigint,now:number):void {
  const changed=db.prepare("INSERT INTO codex_request_cancellations(job_id,target_thread_id,channel_id,owner_user_id,discord_message_id,cancelled_at) VALUES(?,?,?,?,?,?)").run(item.job,target,channel,owner,item.event,now).changes;
  if(BigInt(changed)!==1n)throw new StoreIntegrityError("cancellation receipt was not inserted; nothing was cancelled");
  requireCancellationReceipt(db,item,target,channel,owner,now);
}
interface CancelledIngress {key:string;channel:bigint;event:bigint|null;kind:"prompt"|"cancellation"}
function requireCancelledIngress(db:DatabaseSync,budget:PendingReadBudget,expected:CancelledIngress,job:string,target:string,owner:bigint,now:number):void {
  const {key,channel,event,kind}=expected;
  if(budget("discord_ingress_journal",INGRESS_FIELDS,"ingress_id=?",["ingress_id"],key)!==1)
    throw new StoreIntegrityError("cancellation ingress ownership changed");
  if(scalar(db,`SELECT count(*) AS n FROM discord_ingress_journal WHERE ingress_id=? AND state='completed' AND phase='cancelled' AND json_type(outcome_json)='object' AND json_extract(outcome_json,'$.kind')='request_cancelled' AND json_extract(outcome_json,'$.job_id')=? AND target_thread_id=? AND channel_id=? AND owner_user_id=? AND event_id IS ? AND owner_kind=? AND owner_id=? AND updated_at=?`,key,job,target,channel,owner,event,kind,job,now)!==1n)
    throw new StoreIntegrityError("cancellation ingress result was not retained");
}
/** Existing-only Retract write for the isolated native DB owner. Synchronous and
 * atomic, with a 100ms SQLite busy wait (not a whole-operation deadline).
 * At most 128 candidate-evidence rows and 128 matching owners; 1MiB per row,
 * 8MiB cumulative reads, 16KiB input/result IDs and a 32KiB path. Overflow refuses the
 * whole transaction, never a truncated inventory or a different candidate. */
export function cancelLatestPendingExisting(path:string,target:string,channel:bigint,owner:bigint,now:number,requireMirror=false):string|null {
  boundedIdentity(path,32768);boundedIdentity(target);integer(channel);integer(owner);
  if(typeof requireMirror!=="boolean")throw new TypeError("Expected mirror policy");
  if(!Number.isFinite(now)||now<0)throw new StoreIntegrityError("invalid cancellation timestamp");
  return usingExistingStore(path,db=>withStoreTransaction(db,"IMMEDIATE",()=>{
    const budget=pendingReadBudget(db);
    // Require the mutation schema even for a no-op, without repairing it.
    db.prepare("SELECT job_id,target_thread_id,channel_id,owner_user_id,discord_message_id,cancelled_at FROM codex_request_cancellations LIMIT 0");
    db.prepare("SELECT job_id FROM codex_delivery_outbox LIMIT 0");
    if(!schemaCurrentCancellation(db))throw new StoreIntegrityError("cancellation replay-fence schema is incomplete; no repair attempted");
    if(requireMirror&&boundedMirrorIn(db,budget,channel)!==target)throw new StoreIntegrityError("retract room mapping changed; nothing was cancelled");
    // Like existing-only recovery, a wholly absent legacy lazy table is empty.
    // Present views or partial tables are queried and fail closed, never repaired.
    if(scalar(db,"SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='codex_thread_fork_handoffs' AND type IN ('table','view')) AS n")!==0n){
      if(budget("codex_thread_fork_handoffs",HANDOFF_FIELDS,"source_thread_id=?",["handoff_id","source_thread_id","target_thread_id"],target)>1)throw new StoreIntegrityError("conflicting fork handoff inventory");
      requireNoUnresolvedHandoffExistingIn(db,target);
      budget("codex_thread_fork_handoffs","target_thread_id","source_thread_id=? AND completed_at IS NOT NULL",["target_thread_id"],target);
      requireSourceNotMovedExistingIn(db,target);
    }
    if(targetIsHeldIn(db,target))throw new DeadGenerationTargetHeldError(target);
    const count=budget("codex_turn_queue",QUEUE_FIELDS,SCOPE,["job_id"],target,channel,owner)
      +budget("codex_prompt_intakes",INTAKE_FIELDS,SCOPE,["job_id"],target,channel,owner)
      +budget("discord_ingress_journal",INGRESS_FIELDS,UNOWNED_SCOPE,["'ingress:' || ingress_id"],target,channel,owner);
    if(count>128)throw new StoreIntegrityError("retract byte budget: too many candidate records");
    const q=db.prepare(CANDIDATES+" LIMIT 129");q.setReadBigInts(true);
    const rows=q.all(target,channel,owner);if(rows.length>128)throw new StoreIntegrityError("retract byte budget: too many candidates");
    const candidates:Candidate[]=rows.map(r=>{const d=textDecoderFor(r.encoding),job=decodeTextField(r.job_id,r.raw_job,"job_id",false,d)!;boundedIdentity(job);return {job,kind:decodeTextField(r.kind,r.raw_kind,"kind",false,d)!,event:decodeOptionalI64(r.discord_message_id,"discord_message_id"),eligible:decodeI64(r.eligible,"eligible")!==0n};});
    const selected=candidates.find(c=>c.eligible);if(selected===undefined){
      if(candidates.length!==0)throw new StoreIntegrityError("request execution has started or its outcome is unknown; nothing was cancelled");
      return commitStore(null);
    }
    let ingresses:CancelledIngress[];
    if(selected.kind==="ingress"){
      if(!selected.job.startsWith("ingress:"))throw new StoreIntegrityError("invalid pending ingress cancellation identity");const key=selected.job.slice(8);ingresses=[{key,channel,event:selected.event,kind:"cancellation"}];
      if(scalar(db,"SELECT EXISTS(SELECT 1 FROM codex_turn_queue WHERE job_id=?1 OR discord_message_id=?2) OR EXISTS(SELECT 1 FROM codex_prompt_intakes WHERE job_id=?1 OR discord_message_id=?2) AS n",selected.job,selected.event)!==0n)
        throw new StoreIntegrityError("ingress has conflicting execution ownership; nothing was cancelled");
      insertCheckedReceipt(db,selected,target,channel,owner,now);
      budget("discord_ingress_journal",INGRESS_FIELDS,"ingress_id=?",["ingress_id"],key);
      const changed=db.prepare(`UPDATE discord_ingress_journal SET state='completed',phase='cancelled',owner_kind='cancellation',owner_id=?,outcome_json=${OUTCOME},updated_at=? WHERE ingress_id=? AND event_id IS ? AND target_thread_id=? AND channel_id=? AND owner_user_id=? AND state IN ('staged','acknowledged') AND owner_id IS NULL`).run(selected.job,selected.job,now,key,selected.event,target,channel,owner).changes;
      if(BigInt(changed)!==1n)throw new StoreIntegrityError("ingress execution already started or cancellation ownership changed");
    }else{
      if(selected.kind!=="queue"&&selected.kind!=="intake")throw new StoreIntegrityError("invalid pending cancellation kind");
      const occurrences=scalar(db,"SELECT (SELECT count(*) FROM codex_turn_queue WHERE job_id=?1 OR (?2 IS NOT NULL AND discord_message_id=?2)) + (SELECT count(*) FROM codex_prompt_intakes WHERE job_id=?1 OR (?2 IS NOT NULL AND discord_message_id=?2)) AS n",selected.job,selected.event);
      if(occurrences!==1n||scalar(db,"SELECT EXISTS(SELECT 1 FROM codex_delivery_outbox WHERE job_id=?) AS n",selected.job)!==0n)throw new StoreIntegrityError("request has conflicting or uncertain ownership evidence; nothing was cancelled");
      budget("discord_ingress_journal",INGRESS_FIELDS,OWNER_SCOPE,["ingress_id"],selected.job,selected.event);
      const crossRoomOwners=scalar(db,`SELECT count(*) AS n FROM discord_ingress_journal WHERE (${OWNER_SCOPE}) AND channel_id IS NOT ?3`,selected.job,selected.event,channel);
      if(crossRoomOwners!==0n)preflightMirrorIn(db,budget,channel,Number(crossRoomOwners));
      budget("discord_ingress_journal","ingress_id",OWNER_SCOPE,["ingress_id"],selected.job,selected.event);
      const keys=ingressCancellationOwnersIn(db,selected.job,selected.event,target,channel,owner);
      ingresses=keys.map(key=>{boundedIdentity(key);budget("discord_ingress_journal","channel_id,event_id","ingress_id=?",[],key);const q=db.prepare("SELECT channel_id,event_id FROM discord_ingress_journal WHERE ingress_id=?");q.setReadBigInts(true);const row=q.get(key);return {key,channel:decodeI64(row?.channel_id,"channel_id"),event:decodeOptionalI64(row?.event_id,"event_id"),kind:"prompt"};});
      insertCheckedReceipt(db,selected,target,channel,owner,now);
      const table=selected.kind==="intake"?"codex_prompt_intakes":"codex_turn_queue";
      if(BigInt(db.prepare(`DELETE FROM ${table} WHERE job_id=?`).run(selected.job).changes)!==1n)throw new StoreIntegrityError("cancellation ownership changed");
      for(const expected of ingresses){
        const {key,channel:originalChannel,event}=expected;
        budget("discord_ingress_journal",INGRESS_FIELDS,"ingress_id=?",["ingress_id"],key);
        if(BigInt(db.prepare(`UPDATE discord_ingress_journal SET state='completed',phase='cancelled',outcome_json=${OUTCOME},updated_at=? WHERE ingress_id=? AND owner_kind='prompt' AND owner_id=? AND owner_user_id=? AND target_thread_id=? AND channel_id=? AND event_id IS ? AND state IN ('owned','completed')`).run(selected.job,now,key,selected.job,owner,target,originalChannel,event).changes)!==1n)
          throw new StoreIntegrityError("cancellation ingress ownership changed");
      }
    }
    // Final checks catch ignored writes and later triggers undoing an earlier
    // receipt/delete/ingress mutation. Every JSON read has its own byte preflight.
    requireCancellationReceipt(db,selected,target,channel,owner,now);
    if(scalar(db,"SELECT (SELECT count(*) FROM codex_turn_queue WHERE job_id=?1 OR (?2 IS NOT NULL AND discord_message_id=?2)) + (SELECT count(*) FROM codex_prompt_intakes WHERE job_id=?1 OR (?2 IS NOT NULL AND discord_message_id=?2)) AS n",selected.job,selected.event)!==0n)
      throw new StoreIntegrityError("cancelled request still has execution ownership");
    for(const expected of ingresses)requireCancelledIngress(db,budget,expected,selected.job,target,owner,now);
    return commitStore(selected.job);
  }),100);
}
