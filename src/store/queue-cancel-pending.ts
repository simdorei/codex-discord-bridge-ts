import type {DatabaseSync} from "node:sqlite";
import {openInitialized} from "./owned-driver.ts";
import {StoreIntegrityError} from "./schema-assembly.ts";
import {ensureNoUnresolvedHandoff,ensureSourceNotMoved} from "./fork-handoff-admission.ts";
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
