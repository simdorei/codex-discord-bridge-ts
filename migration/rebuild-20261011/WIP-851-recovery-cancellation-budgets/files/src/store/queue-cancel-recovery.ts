import type {DatabaseSync,SQLInputValue} from "node:sqlite";
import {types} from "node:util";
import {usingInitializedStore,usingExistingStore,withStoreTransaction,commitStore} from "./owned-scope.ts";
import {requireDiscordText} from "../discord/text.ts";
import {ensureNoUnresolvedHandoff,ensureSourceNotMoved,requireNoUnresolvedHandoffExistingIn,requireSourceNotMovedExistingIn} from "./fork-handoff-admission.ts";
import {ingressCancellationOwnersIn} from "./ingress-cancellation-owners.ts";
import {COLUMNS,selectJob,serializeStoredQueueJob} from "./queue-read.ts";
import {holdIn} from "./execution-hold.ts";
import {recordRecoveryCancellationRevisionIn} from "./stop-revision-recovery.ts";
import {StoreIntegrityError} from "./schema-assembly.ts";
import {decodeI64,decodeOptionalI64,decodeTextField,textDecoderFor} from "./sqlite-values.ts";
import {serializeSerdeValue} from "../core/serde-json.ts";
import {parseSerdeValue} from "../core/serde-json-parse.ts";
export interface RecoveryCancellation {jobs:string[];startedOrUncertain:number}
/** Trusted, synchronous, internal custody check. Never a transport-provided callback. */
export type RecoveryCancellationCheck=(db:DatabaseSync)=>undefined;
function one(db:DatabaseSync,sql:string,...args:SQLInputValue[]):Record<string,unknown>|undefined{const q=db.prepare(sql);q.setReadBigInts(true);return q.get(...args);}
/** Only static internal SQL identifiers enter this byte-only preflight. No raw
 * values are returned before the per-row and cumulative budgets are checked.
 * Repeated reads consume budget again, so trigger changes cannot evade the cap.
 * Existing-only recovery refuses excess evidence; it never truncates a request. */
function recoveryReadBudget(db:DatabaseSync){
 let remaining=8388608n;
 return (table:string,fields:string,where:string,...args:SQLInputValue[]):void=>{
  const bytes=fields.split(",").map(field=>`COALESCE(length(CAST(${field.trim()} AS BLOB)),0)`).join("+");
  const q=db.prepare(`SELECT ${bytes} AS evidence_bytes FROM ${table} WHERE ${where} LIMIT 129`);q.setReadBigInts(true);
  const rows=q.all(...args);if(rows.length>128)throw new StoreIntegrityError("recovery byte budget: too many requests or related ingress records");
  for(const row of rows){const n=row.evidence_bytes;if(typeof n!=="bigint"||n<0n||n>1048576n||n>remaining)throw new StoreIntegrityError("recovery evidence exceeds byte budget");remaining-=n;}
 };
}
const INTAKE_FIELDS="job_id,target_thread_id,channel_id,owner_user_id,discord_message_id,raw_prompt,auto_queue_when_busy,require_current_mirror,attempt_count,last_error,retry_after,claim_token,claim_expires_at,created_at,updated_at";
const INGRESS_FIELDS="ingress_id,kind,event_id,application_id,channel_id,owner_user_id,source_message_id,payload_json,runtime_id,state,phase,target_thread_id,canonical_owner,owner_kind,owner_id,outcome_json,confirmation_delivered,hold_reason,created_at,updated_at";
function receipt(db:DatabaseSync,job:string,target:string,channel:bigint,owner:bigint,event:bigint|null,now:number):void{
  db.prepare("INSERT INTO codex_request_cancellations(job_id,target_thread_id,channel_id,owner_user_id,discord_message_id,cancelled_at) VALUES(?,?,?,?,?,?)").run(job,target,channel,owner,event,now);
}
function cancelRequest(db:DatabaseSync,target:string,channel:bigint,owner:bigint,now:number,job:string,kind:string,event:bigint|null,result:RecoveryCancellation):void{
  const count=decodeI64(one(db,"SELECT (SELECT count(*) FROM codex_turn_queue WHERE job_id=?1 OR (?2 IS NOT NULL AND discord_message_id=?2)) + (SELECT count(*) FROM codex_prompt_intakes WHERE job_id=?1 OR (?2 IS NOT NULL AND discord_message_id=?2)) AS n",job,event)?.n,"count");
  if(count!==1n)throw new StoreIntegrityError("conflicting recovery request identity");
  const owners=ingressCancellationOwnersIn(db,job,event,target,channel,owner);let evidence:unknown;
  if(kind==="queue"){
    const stored=selectJob(db,job);if(stored.state!=="Pending"||stored.executionGeneration!==null||stored.turnId!==null||stored.attemptCount>0n)result.startedOrUncertain++;
    evidence=parseSerdeValue(serializeStoredQueueJob(stored));
  }else{
    const row=db.prepare(`SELECT evidence,CAST(evidence AS BLOB) AS raw,(SELECT encoding FROM pragma_encoding) AS encoding FROM (SELECT json_object('job_id',job_id,'target_thread_id',target_thread_id,'channel_id',channel_id,'owner_user_id',owner_user_id,'discord_message_id',discord_message_id,
      'raw_prompt',raw_prompt,'auto_queue_when_busy',auto_queue_when_busy,'require_current_mirror',require_current_mirror,'attempt_count',attempt_count,'last_error',last_error,'retry_after',retry_after,
      'claim_token',claim_token,'claim_expires_at',claim_expires_at,'created_at',created_at,'updated_at',updated_at) AS evidence FROM codex_prompt_intakes WHERE job_id=?)`).get(job);
    if(row===undefined)throw new StoreIntegrityError("missing recovery intake evidence");evidence=parseSerdeValue(decodeTextField(row.evidence,row.raw,"evidence",false,textDecoderFor(row.encoding))!);
  }
  holdIn(db,job,target,"user requested full recovery; cancelled, never replay; prior effects are not rolled back",serializeSerdeValue({kind,request:evidence,cancelled_at:now}));
  receipt(db,job,target,channel,owner,event,now);db.prepare(`DELETE FROM ${kind==="queue"?"codex_turn_queue":"codex_prompt_intakes"} WHERE job_id=?`).run(job);
  for(const key of owners)db.prepare("UPDATE discord_ingress_journal SET state='completed',phase='cancelled',outcome_json=json_set(CASE WHEN json_type(outcome_json)='object' THEN outcome_json ELSE '{}' END,'$.kind','request_cancelled','$.job_id',?),updated_at=? WHERE ingress_id=?").run(job,now,key);
  result.jobs.push(job);
}
function validateScope(target:string,channel:bigint,owner:bigint,now:number,check:RecoveryCancellationCheck):void{
  for(const v of [target])if(typeof v!=="string"||/[\uD800-\uDFFF]/u.test(v))throw new TypeError("Expected well-formed text");
  for(const v of [channel,owner])if(typeof v!=="bigint"||v<-(1n<<63n)||v>=(1n<<63n))throw new TypeError("Expected i64 identity");
  if(target===""||channel<=0n||owner<=0n||!Number.isFinite(now)||now<0)throw new StoreIntegrityError("invalid recovery cancellation scope");
  if(typeof check!=="function"||types.isProxy(check)||types.isAsyncFunction(check)||types.isGeneratorFunction(check))throw new TypeError("Expected synchronous recovery custody check");

}
/** Borrowed transaction. Never opens/closes, commits, or rolls back its caller.
 * Cancellation evidence and the final recovery revision remain one transaction.
 * Inventory queries cap at129 to prove that <=128 is complete before mutation. */
export function cancelForRecoveryIn(db:DatabaseSync,target:string,channel:bigint,owner:bigint,now:number,check:RecoveryCancellationCheck):RecoveryCancellation{
 return cancelForRecoveryBody(db,target,channel,owner,now,check,true);
}
function cancelForRecoveryBody(db:DatabaseSync,target:string,channel:bigint,owner:bigint,now:number,check:RecoveryCancellationCheck,existingOnly:boolean):RecoveryCancellation{
 validateScope(target,channel,owner,now,check);if(!db.isTransaction)throw new StoreIntegrityError("Recovery cancellation requires owning transaction");
 const checked=(db:DatabaseSync):void=>{const result:unknown=check(db);if(types.isPromise(result)){void Promise.prototype.then.call(result,undefined,()=>undefined);throw new TypeError("Expected synchronous recovery custody check");}if(result!==undefined)throw new TypeError("Expected synchronous recovery custody check");};

    checked(db);
    if(existingOnly){
      // This table is lazily created by legacy admission, so complete absence is
      // the same empty handoff inventory. A view or partial table is not absence:
      // read it normally and propagate errors; never repair schema in this lane.
      const present=one(db,"SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='codex_thread_fork_handoffs' AND type IN ('table','view')) AS present");
      if(decodeI64(present?.present,"handoff presence")!==0n){requireNoUnresolvedHandoffExistingIn(db,target);requireSourceNotMovedExistingIn(db,target);}
    }else{ensureNoUnresolvedHandoff(db,target);ensureSourceNotMoved(db,target);}
    const budget=existingOnly?recoveryReadBudget(db):null;
    budget?.("codex_turn_queue",COLUMNS,"target_thread_id=?",target);
    budget?.("codex_prompt_intakes",INTAKE_FIELDS,"target_thread_id=?",target);
    const q=db.prepare(`SELECT job_id,kind,channel_id,owner_user_id,discord_message_id,CAST(job_id AS BLOB) AS raw,(SELECT encoding FROM pragma_encoding) AS encoding FROM (
      SELECT job_id,'queue' AS kind,channel_id,owner_user_id,discord_message_id FROM codex_turn_queue WHERE target_thread_id=?1 UNION ALL
      SELECT job_id,'intake',channel_id,owner_user_id,discord_message_id FROM codex_prompt_intakes WHERE target_thread_id=?1) LIMIT 129`);q.setReadBigInts(true);
    const rows=q.all(target).map(r=>({job:decodeTextField(r.job_id,r.raw,"job_id",false,textDecoderFor(r.encoding))!,kind:String(r.kind),channel:decodeI64(r.channel_id,"channel_id"),owner:decodeOptionalI64(r.owner_user_id,"owner_user_id"),event:decodeOptionalI64(r.discord_message_id,"discord_message_id")}));
    if(rows.length>128||rows.some(r=>r.channel!==channel||r.owner!==owner))throw new StoreIntegrityError("recovery request scope contains another sender/channel or too many requests");
    const result:RecoveryCancellation={jobs:[],startedOrUncertain:0};for(const row of rows){
      budget?.(row.kind==="queue"?"codex_turn_queue":"codex_prompt_intakes",row.kind==="queue"?COLUMNS:INTAKE_FIELDS,"job_id=?",row.job);
      budget?.("discord_ingress_journal",INGRESS_FIELDS,"owner_id=?1 OR (?2 IS NOT NULL AND event_id=?2)",row.job,row.event);
      cancelRequest(db,target,channel,owner,now,row.job,row.kind,row.event,result);
    }
    // Bound all active unowned target records before JSON filtering as well.
    // Large non-prompt control evidence conservatively refuses this operation.
    budget?.("discord_ingress_journal",INGRESS_FIELDS,"target_thread_id=? AND owner_id IS NULL AND state IN ('staged','acknowledged','executing','held')",target);
    const ingress=db.prepare(`SELECT ingress_id,event_id,channel_id,owner_user_id,payload_json,state,CAST(ingress_id AS BLOB) AS raw_id,CAST(payload_json AS BLOB) AS raw_payload,CAST(state AS BLOB) AS raw_state,(SELECT encoding FROM pragma_encoding) AS encoding
      FROM discord_ingress_journal WHERE target_thread_id=? AND owner_id IS NULL AND state IN ('staged','acknowledged','executing','held')
      AND json_type(payload_json,'$.version')='integer' AND json_extract(payload_json,'$.version')=1 AND (
      (kind='message' AND (json_type(payload_json,'$.plan.Execute.Ask.prompt')='text' OR json_type(payload_json,'$.plan.Execute.Interview.prompt')='text'))
      OR (kind='interaction' AND json_extract(payload_json,'$.work.Slash.name') IN ('ask','interview') AND json_type(payload_json,'$.work.Slash.values.prompt.String')='text')) LIMIT 129`);ingress.setReadBigInts(true);
    const unowned=ingress.all(target).map(r=>{const d=textDecoderFor(r.encoding);return {key:decodeTextField(r.ingress_id,r.raw_id,"ingress_id",false,d)!,event:decodeOptionalI64(r.event_id,"event_id"),channel:decodeI64(r.channel_id,"channel_id"),owner:decodeI64(r.owner_user_id,"owner_user_id"),payload:decodeTextField(r.payload_json,r.raw_payload,"payload_json",false,d)!,state:decodeTextField(r.state,r.raw_state,"state",false,d)!};});
    if(result.jobs.length+unowned.length>128||unowned.some(r=>r.channel!==channel||r.owner!==owner))throw new StoreIntegrityError("recovery ingress scope changed; cancellation rolled back");
    for(const r of unowned){const job=`ingress:${r.key}`;holdIn(db,job,target,"user requested full recovery; do not replay",serializeSerdeValue({ingress_id:r.key,payload:parseSerdeValue(r.payload),state:r.state}));receipt(db,job,target,channel,owner,r.event,now);
      db.prepare("UPDATE discord_ingress_journal SET state='completed',phase='cancelled',owner_kind='cancellation',owner_id=?,outcome_json=json_set(CASE WHEN json_type(outcome_json)='object' THEN outcome_json ELSE '{}' END,'$.kind','request_cancelled','$.job_id',?),updated_at=? WHERE ingress_id=?").run(job,job,now,r.key);
      if(r.state==="executing"||r.state==="held")result.startedOrUncertain++;result.jobs.push(job);
    }
    checked(db);recordRecoveryCancellationRevisionIn(db,target,channel,owner,result.jobs,now);return result;
}
/** Existing-only synchronous runtime boundary; invoke only from a native owner.
 * The check must be locally trusted and revalidate the exact original custody. */
export function cancelForRecoveryExisting(path:string,target:string,channel:bigint,owner:bigint,now:number,check:RecoveryCancellationCheck):RecoveryCancellation{
 requireDiscordText(path);validateScope(target,channel,owner,now,check);
 return usingExistingStore(path,db=>withStoreTransaction(db,"IMMEDIATE",()=>commitStore(cancelForRecoveryIn(db,target,channel,owner,now,check))),100);
}
/** Compatibility initialized entry. External controller must independently prove
 * process exit; this only revokes replay authority and preserves evidence. */
export async function cancelForRecovery(path:string,target:string,channel:bigint,owner:bigint,now:number,check:RecoveryCancellationCheck=()=>undefined):Promise<RecoveryCancellation>{
 requireDiscordText(path);validateScope(target,channel,owner,now,check);
 return usingInitializedStore(path,db=>withStoreTransaction(db,"IMMEDIATE",()=>commitStore(cancelForRecoveryBody(db,target,channel,owner,now,check,false))));
}

/** Internal borrowed transaction cancellation leaf; caller must prove exact custody. */
export {cancelRequest as cancelRecoveryRequestIn};
