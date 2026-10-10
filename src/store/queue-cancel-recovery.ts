import type {DatabaseSync,SQLInputValue} from "node:sqlite";
import {types} from "node:util";
import {openInitialized} from "./owned-driver.ts";
import {ensureNoUnresolvedHandoff,ensureSourceNotMoved} from "./fork-handoff-admission.ts";
import {ingressCancellationOwnersIn} from "./ingress-cancellation-owners.ts";
import {selectJob,serializeStoredQueueJob} from "./queue-read.ts";
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
/** Explicit full recovery only. External controller must independently prove process exit; this merely revokes replay authority. */
export async function cancelForRecovery(path:string,target:string,channel:bigint,owner:bigint,now:number,check:RecoveryCancellationCheck=()=>undefined):Promise<RecoveryCancellation>{
  for(const v of [path,target])if(typeof v!=="string"||/[\uD800-\uDFFF]/u.test(v))throw new TypeError("Expected well-formed text");
  for(const v of [channel,owner])if(typeof v!=="bigint"||v<-(1n<<63n)||v>=(1n<<63n))throw new TypeError("Expected i64 identity");
  if(target===""||channel<=0n||owner<=0n||!Number.isFinite(now)||now<0)throw new StoreIntegrityError("invalid recovery cancellation scope");
  if(typeof check!=="function"||types.isProxy(check)||types.isAsyncFunction(check)||types.isGeneratorFunction(check))throw new TypeError("Expected synchronous recovery custody check");
  const checked=(db:DatabaseSync):void=>{if(check(db)!==undefined)throw new TypeError("Expected synchronous recovery custody check");};
  const db=await openInitialized(path);try{
    db.exec("BEGIN IMMEDIATE");checked(db);ensureNoUnresolvedHandoff(db,target);ensureSourceNotMoved(db,target);
    const q=db.prepare(`SELECT job_id,kind,channel_id,owner_user_id,discord_message_id,CAST(job_id AS BLOB) AS raw,(SELECT encoding FROM pragma_encoding) AS encoding FROM (
      SELECT job_id,'queue' AS kind,channel_id,owner_user_id,discord_message_id FROM codex_turn_queue WHERE target_thread_id=?1 UNION ALL
      SELECT job_id,'intake',channel_id,owner_user_id,discord_message_id FROM codex_prompt_intakes WHERE target_thread_id=?1)`);q.setReadBigInts(true);
    const rows=q.all(target).map(r=>({job:decodeTextField(r.job_id,r.raw,"job_id",false,textDecoderFor(r.encoding))!,kind:String(r.kind),channel:decodeI64(r.channel_id,"channel_id"),owner:decodeOptionalI64(r.owner_user_id,"owner_user_id"),event:decodeOptionalI64(r.discord_message_id,"discord_message_id")}));
    if(rows.length>128||rows.some(r=>r.channel!==channel||r.owner!==owner))throw new StoreIntegrityError("recovery request scope contains another sender/channel or too many requests");
    const result:RecoveryCancellation={jobs:[],startedOrUncertain:0};for(const row of rows)cancelRequest(db,target,channel,owner,now,row.job,row.kind,row.event,result);
    const ingress=db.prepare(`SELECT ingress_id,event_id,channel_id,owner_user_id,payload_json,state,CAST(ingress_id AS BLOB) AS raw_id,CAST(payload_json AS BLOB) AS raw_payload,CAST(state AS BLOB) AS raw_state,(SELECT encoding FROM pragma_encoding) AS encoding
      FROM discord_ingress_journal WHERE target_thread_id=? AND owner_id IS NULL AND state IN ('staged','acknowledged','executing','held')
      AND json_type(payload_json,'$.version')='integer' AND json_extract(payload_json,'$.version')=1 AND (
      (kind='message' AND (json_type(payload_json,'$.plan.Execute.Ask.prompt')='text' OR json_type(payload_json,'$.plan.Execute.Interview.prompt')='text'))
      OR (kind='interaction' AND json_extract(payload_json,'$.work.Slash.name') IN ('ask','interview') AND json_type(payload_json,'$.work.Slash.values.prompt.String')='text'))`);ingress.setReadBigInts(true);
    const unowned=ingress.all(target).map(r=>{const d=textDecoderFor(r.encoding);return {key:decodeTextField(r.ingress_id,r.raw_id,"ingress_id",false,d)!,event:decodeOptionalI64(r.event_id,"event_id"),channel:decodeI64(r.channel_id,"channel_id"),owner:decodeI64(r.owner_user_id,"owner_user_id"),payload:decodeTextField(r.payload_json,r.raw_payload,"payload_json",false,d)!,state:decodeTextField(r.state,r.raw_state,"state",false,d)!};});
    if(result.jobs.length+unowned.length>128||unowned.some(r=>r.channel!==channel||r.owner!==owner))throw new StoreIntegrityError("recovery ingress scope changed; cancellation rolled back");
    for(const r of unowned){const job=`ingress:${r.key}`;holdIn(db,job,target,"user requested full recovery; do not replay",serializeSerdeValue({ingress_id:r.key,payload:parseSerdeValue(r.payload),state:r.state}));receipt(db,job,target,channel,owner,r.event,now);
      db.prepare("UPDATE discord_ingress_journal SET state='completed',phase='cancelled',owner_kind='cancellation',owner_id=?,outcome_json=json_set(CASE WHEN json_type(outcome_json)='object' THEN outcome_json ELSE '{}' END,'$.kind','request_cancelled','$.job_id',?),updated_at=? WHERE ingress_id=?").run(job,job,now,r.key);
      if(r.state==="executing"||r.state==="held")result.startedOrUncertain++;result.jobs.push(job);
    }
    checked(db);recordRecoveryCancellationRevisionIn(db,target,channel,owner,result.jobs,now);db.exec("COMMIT");return result;
  }finally{if(db.isTransaction){try{db.exec("ROLLBACK");}catch{/* close rolls back */}}db.close();}
}
