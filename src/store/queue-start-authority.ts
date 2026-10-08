import type {DatabaseSync} from "node:sqlite";
import {cloneOwnedSerdeValue} from "../core/owned-serde-value.ts";
import {parseSerdeValue} from "../core/serde-json-parse.ts";
import {serdeValueEqual} from "../core/serde-value-equal.ts";
import {getOwn} from "./async-resolution-json-helpers.ts";
import {I64_MIN,I64_MAX} from "../protocol/ids.ts";
import {selectJob,serializeStoredQueueJob} from "./queue-read.ts";
import {jobCanMutate} from "./dead-generation-admission.ts";
import {requireUnheldIn} from "./execution-hold.ts";
import {ensureNoUnresolvedHandoff,ensureSourceNotMoved} from "./fork-handoff-admission.ts";
import {assertAsyncAdmissionIn} from "./async-resolution-admission.ts";
import {decodeBool} from "./sqlite-values.ts";
import {StoreIntegrityError} from "./schema-assembly.ts";
const fields=["job_id","target_thread_id","channel_id","owner_user_id","discord_message_id","app_server_generation","execution_generation","turn_observation_generation","goal_waiting","prompt","state","attempt_count","turn_id","baseline_turn_ids","last_error","created_at","updated_at"] as const;
function revoked():never{throw new StoreIntegrityError("original queue start authority changed or is held; no replay");}
/** Uses only the final writer's connection and original claim. Delivery flags are
 * deliberately excluded. Existing fork/async guards preserve their own contracts. */
export function validateQueueStartAuthorityIn(db:DatabaseSync,input:unknown,target:string,generation:bigint):void{
  const claim=cloneOwnedSerdeValue(input),id=getOwn(claim,"job_id");
  if(typeof target!=="string"||/[\uD800-\uDFFF]/u.test(target)||typeof generation!=="bigint"||generation<I64_MIN||generation>I64_MAX)revoked();
  if(typeof id!=="string"||id==="")revoked();const current=selectJob(db,id),actual=parseSerdeValue(serializeStoredQueueJob(current));
  if(current.targetThreadId!==target||current.appServerGeneration!==generation||current.executionGeneration!==generation||current.state!=="Starting"||current.turnId!==null||current.goalWaiting||fields.some(field=>!serdeValueEqual(getOwn(actual,field),getOwn(claim,field)))||!jobCanMutate(db,current))revoked();
  requireUnheldIn(db,id);
  const q=db.prepare(`SELECT EXISTS(SELECT 1 FROM codex_request_cancellations WHERE job_id=?1 OR (?2 IS NOT NULL AND discord_message_id=?2)) OR EXISTS(SELECT 1 FROM codex_archive_fences WHERE target_thread_id=?3) AS held`);q.setReadBigInts(true);
  if(decodeBool(q.get(id,current.discordMessageId,target)?.held,"queue start fence"))revoked();
  ensureNoUnresolvedHandoff(db,target);ensureSourceNotMoved(db,target);assertAsyncAdmissionIn(db,target);
}
