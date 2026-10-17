import type {DatabaseSync} from "node:sqlite";
import {createHash} from "node:crypto";
import {getIngressIn,ingressByOriginIn} from "./ingress-read.ts";
import {newCommandPrompt,newExecutionPrompt,frozenSlashTarget} from "./ingress-new-input.ts";
import type {StoredPromptIntake} from "./prompt-intake.ts";
import type {NewQueueJob} from "./queue-enqueue.ts";
import {requireUnheldKeyIn} from "./queue-admission-guards.ts";
import {StoreIntegrityError} from "./schema-assembly.ts";
import {decodeI64,decodeTextField,textDecoderFor} from "./sqlite-values.ts";
import {getOwn} from "./async-resolution-json-helpers.ts";
import {serdeValueEqual} from "../core/serde-value-equal.ts";
import {serializeSerdeValue} from "../core/serde-json.ts";
import {promoteIn} from "./new-reply-promote.ts";

export function linkPromptOwnerByKeyIn(db:DatabaseSync,key:string,intake:StoredPromptIntake):void{
  if(!db.isTransaction)throw new StoreIntegrityError("Borrowed mutation requires an active transaction");
  const ingress=getIngressIn(db,key);if(ingress===null)throw new StoreIntegrityError(`missing ingress handoff: ${key}`);
  requireUnheldKeyIn(db,key);
  let newRoom=false;
  if(newExecutionPrompt(ingress)===intake.rawPrompt&&ingress.targetThreadId===intake.targetThreadId&&
    (ingress.phase==="thread/created"||ingress.phase==="durable_prompt")){
    const query=db.prepare("SELECT EXISTS(SELECT 1 FROM mirror_threads WHERE codex_thread_id=? AND discord_thread_id=?) AS present");query.setReadBigInts(true);
    newRoom=decodeI64(query.get(intake.targetThreadId,intake.channelId)?.present,"new room mapping")!==0n;
  }
  const original=frozenSlashTarget(ingress);
  if((ingress.channelId!==intake.channelId&&!newRoom)||(original!==null&&original!==intake.targetThreadId)||ingress.ownerUserId!==intake.ownerUserId||
    ingress.state==="held"||(ingress.ownerId!==null&&ingress.ownerId!==intake.jobId))throw new StoreIntegrityError(`ingress handoff identity changed: ${key}`);
  db.prepare("UPDATE discord_ingress_journal SET state='owned',phase='durable_prompt',owner_kind='prompt',owner_id=?,target_thread_id=?,updated_at=? WHERE ingress_id=?")
    .run(intake.jobId,intake.targetThreadId,intake.updatedAt,key);
}
export function linkPromptOwnerIn(db:DatabaseSync,intake:StoredPromptIntake):void{
  if(intake.discordMessageId===null)return;
  const ingress=ingressByOriginIn(db,intake.discordMessageId);if(ingress!==null)linkPromptOwnerByKeyIn(db,ingress.ingressId,intake);
}
export function recordNewEvidenceIn(db:DatabaseSync,job:NewQueueJob):void{
  const query=db.prepare(`SELECT ingress_id,CAST(ingress_id AS BLOB) AS raw,(SELECT encoding FROM pragma_encoding) AS encoding
    FROM discord_ingress_journal WHERE owner_kind='prompt' AND owner_id=?`);
  const keys=query.all(job.jobId).map(row=>decodeTextField(row.ingress_id,row.raw,"ingress_id",false,textDecoderFor(row.encoding))!);
  for(const key of keys){
    const saved=getIngressIn(db,key);if(saved===null)throw new StoreIntegrityError("missing new evidence owner");
    if(newCommandPrompt(saved)===null)continue;
    if(saved.targetThreadId!==job.targetThreadId||saved.ownerUserId!==(job.ownerUserId??0n))throw new StoreIntegrityError("new evidence owner identity changed");
    const digest=createHash("sha256").update(job.prompt).digest("hex"),evidence={prompt_sha256:digest,thread_id:job.targetThreadId,channel_id:job.channelId};
    promoteIn(db,saved,job,digest);
    const old=getOwn(saved.outcome,"new_verification");if(old!==undefined&&!serdeValueEqual(old,evidence))throw new StoreIntegrityError("new prepared input evidence changed");
    db.prepare("UPDATE discord_ingress_journal SET outcome_json=json_set(COALESCE(outcome_json,'{}'),'$.new_verification',json(?)) WHERE ingress_id=?")
      .run(serializeSerdeValue(evidence),key);
  }
}
