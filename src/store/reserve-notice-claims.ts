import type {DatabaseSync} from "node:sqlite";
import {parseReceiptKey,receiptHash,receiptRow,receiptText,receiptExists,receiptTextColumns} from "./delivery-receipt-key.ts";
import {decodeI64,decodeOptionalI64} from "./sqlite-values.ts";
import {mirroredThreadIdIn} from "./busy-choice.ts";
import {targetIsHeldIn} from "./dead-generation-admission.ts";
import {DeadGenerationTargetHeldError} from "./fork-completed-target.ts";
import {StoreIntegrityError} from "./schema-assembly.ts";
/** Legacy notice delivery only. Does not enter or restore automatic Reserve. */
export function validateReserveTransitionClaimIn(db:DatabaseSync,key:string,hash:string):void{
  const parsed=parseReceiptKey(key);if(parsed===null||parsed[1]!=="reserve/transition/v1")return;const [channel,,id,index]=parsed;
  if(index!==0n)throw new StoreIntegrityError("Reserve transition notice has an invalid chunk");
  const row=receiptRow(db,`SELECT target_thread_id,channel_id,content,${receiptTextColumns("target_thread_id","content")} FROM codex_reserve_transition_notices WHERE notice_id=?`,id);
  if(row===undefined)throw new StoreIntegrityError("Reserve transition notice is not pending");
  const thread=receiptText(row,"target_thread_id")!,storedChannel=decodeOptionalI64(row.channel_id,"channel_id"),content=receiptText(row,"content")!;
  if(storedChannel!==channel||receiptHash(content)!==hash)throw new StoreIntegrityError("Reserve transition notice destination or content changed");
  if(mirroredThreadIdIn(db,channel)!==thread)throw new StoreIntegrityError("Reserve transition notice room was remapped");
  if(targetIsHeldIn(db,thread))throw new DeadGenerationTargetHeldError(thread);
}
export function validateReserveStartClaimIn(db:DatabaseSync,key:string,hash:string):string|null{
  const parsed=parseReceiptKey(key);if(parsed===null||parsed[1]!=="reserve/start-failure/v1")return null;const [channel,,job,index]=parsed;
  const row=receiptRow(db,`SELECT n.target_thread_id,n.channel_id,n.content,CAST(n.target_thread_id AS BLOB) AS raw_target_thread_id,CAST(n.content AS BLOB) AS raw_content,(SELECT encoding FROM pragma_encoding) AS encoding
    FROM codex_reserve_start_notices n JOIN codex_turn_queue q ON q.job_id=n.job_id AND q.target_thread_id=n.target_thread_id AND q.channel_id=n.channel_id AND q.attempt_count=n.attempt_count
    WHERE n.job_id=?1 AND q.state='pending' AND q.turn_id IS NULL AND (EXISTS(SELECT 1 FROM cdr_execution_holds h WHERE h.job_id=q.job_id) OR substr(q.last_error,1,length(?2))=?2)`,job,"[cdr-rust:auto-reserve-hold:v1] ");
  if(row===undefined)throw new StoreIntegrityError("Reserve failure notice has no exact held no-turn job");
  const thread=receiptText(row,"target_thread_id")!,originalChannel=decodeI64(row.channel_id,"channel_id"),content=receiptText(row,"content")!;
  if(index!==0n||originalChannel!==channel||receiptHash(content)!==hash)throw new StoreIntegrityError("Reserve failure notice content or destination changed");
  if(targetIsHeldIn(db,thread))throw new DeadGenerationTargetHeldError(thread);
  const mapping=mirroredThreadIdIn(db,channel);if(mapping!==null&&mapping!==thread)throw new StoreIntegrityError("Reserve failure notice room was remapped");
  if(receiptExists(db,"SELECT EXISTS(SELECT 1 FROM discord_ingress_journal WHERE owner_kind='prompt' AND owner_id=? AND phase='cancelled') AS held",job))throw new StoreIntegrityError("Reserve failure notice belongs to cancelled ingress");
  return job;
}
