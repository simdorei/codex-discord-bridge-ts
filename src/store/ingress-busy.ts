import type {DatabaseSync} from "node:sqlite";
import {openInitialized} from "./owned-driver.ts";
import {admitIngressRecordedIn,type IngressAdmission} from "./ingress-admission.ts";
import {verifyRecordedAdmissionIn} from "./ingress-admission-order.ts";
import {snapshotNewIngress,type NewIngress} from "./ingress-types.ts";
import {getIngressIn} from "./ingress-read.ts";
import {BusyChoiceUnavailableError,parseBusyChoice,serializeBusyChoice,type BusyChoice} from "./busy-choice.ts";
import {getOwn,isJsonObject} from "./async-resolution-json-helpers.ts";
import {serializeSerdeValue} from "../core/serde-json.ts";
import {parseSerdeValue} from "../core/serde-json-parse.ts";
import {decodeI64,decodeTimestamp,decodeTextField,textDecoderFor} from "./sqlite-values.ts";
function activeChoice(db:DatabaseSync,id:string,now:number):BusyChoice|null{
  const q=db.prepare(`SELECT choice_id,owner_user_id,channel_id,target_thread_id,prompt,allow_steer,created_at,expires_at,
    CAST(choice_id AS BLOB) AS raw_id,CAST(target_thread_id AS BLOB) AS raw_target,CAST(prompt AS BLOB) AS raw_prompt,(SELECT encoding FROM pragma_encoding) AS encoding
    FROM busy_choices WHERE choice_id=? AND expires_at>? AND claimed_at IS NULL`);q.setReadBigInts(true);const r=q.get(id,now);if(r===undefined)return null;
  const decoder=textDecoderFor(r.encoding);return {choiceId:decodeTextField(r.choice_id,r.raw_id,"choice_id",false,decoder)!,ownerUserId:decodeI64(r.owner_user_id,"owner_user_id"),channelId:decodeI64(r.channel_id,"channel_id"),
    targetThreadId:decodeTextField(r.target_thread_id,r.raw_target,"target_thread_id",true,decoder),prompt:decodeTextField(r.prompt,r.raw_prompt,"prompt",false,decoder)!,allowSteer:decodeI64(r.allow_steer,"allow_steer")!==0n,createdAt:decodeTimestamp(r.created_at,"created_at"),expiresAt:decodeTimestamp(r.expires_at,"expires_at")};
}
/** Freeze button identity before ACK; durable receipts outlive transient choices and jobs. */
export async function admitBusyInteraction(path:string,input:NewIngress,choiceId:string,action:string):Promise<IngressAdmission>{
  const request=snapshotNewIngress(input);
  for(const value of [choiceId,action])if(typeof value!=="string"||/[\uD800-\uDFFF]/u.test(value))throw new TypeError("Expected well-formed text");
  const missing=()=>new BusyChoiceUnavailableError(choiceId);if(!["queue","steer","stop","ignore"].includes(action))throw missing();
  const db=await openInitialized(path);try{
    db.exec("BEGIN IMMEDIATE");const canonical=`busy-choice:${choiceId}`;
    const receiptRow=db.prepare(`SELECT owner_id,payload_json,CAST(owner_id AS BLOB) AS raw_owner,CAST(payload_json AS BLOB) AS raw_payload,(SELECT encoding FROM pragma_encoding) AS encoding FROM discord_ingress_owner_receipts WHERE owner_key=?`).get(canonical);
    const receipt=receiptRow===undefined?null:{owner:decodeTextField(receiptRow.owner_id,receiptRow.raw_owner,"owner_id",false,textDecoderFor(receiptRow.encoding))!,payload:decodeTextField(receiptRow.payload_json,receiptRow.raw_payload,"payload_json",false,textDecoderFor(receiptRow.encoding))!};
    const parentRow=db.prepare(`SELECT ingress_id,CAST(ingress_id AS BLOB) AS raw,(SELECT encoding FROM pragma_encoding) AS encoding FROM discord_ingress_journal WHERE canonical_owner=?
      AND phase != 'canonical_duplicate' AND COALESCE(state='completed' AND owner_id IS NULL AND json_extract(outcome_json,'$.kind')='busy_control_preflight_rejected' AND json_type(outcome_json,'$.control_dispatched')='false',0)=0 ORDER BY created_at,ingress_id LIMIT 1`).get(canonical);
    const parent=parentRow===undefined?null:decodeTextField(parentRow.ingress_id,parentRow.raw,"ingress_id",false,textDecoderFor(parentRow.encoding))!;
    let choice:BusyChoice|null;
    if(receipt!==null)choice=parseBusyChoice(receipt.payload);
    else if(parent!==null){const original=getIngressIn(db,parent);if(original===null)throw missing();choice=parseBusyChoice(serializeSerdeValue(getOwn(original.payload,"busy_choice")??null));}
    else choice=activeChoice(db,choiceId,request.now);
    if(choice===null||choice.ownerUserId!==request.ownerUserId||choice.channelId!==request.channelId)throw missing();
    if(!isJsonObject(request.payload))throw new TypeError("Expected parsed ingress object");
    request.canonicalOwner=canonical;request.targetThreadId=choice.targetThreadId;request.payload.busy_choice=parseSerdeValue(serializeBusyChoice(choice));request.payload.busy_action=action;
    const [admission,proof]=admitIngressRecordedIn(db,request);
    if(admission.created&&admission.record!==null&&admission.record.state!=="held"&&(receipt!==null||parent!==null)){
      db.prepare("UPDATE discord_ingress_journal SET state='owned',phase='canonical_duplicate',owner_kind=?,owner_id=? WHERE ingress_id=?").run(receipt===null?"ingress":"prompt",receipt===null?parent:receipt.owner,request.ingressId);
      admission.created=false;admission.canonicalRepeatCreated=true;admission.record=getIngressIn(db,request.ingressId);
    }
    admission.busyChoice=choice;if(proof!==null)verifyRecordedAdmissionIn(db,proof);db.exec("COMMIT");return admission;
  }finally{if(db.isTransaction){try{db.exec("ROLLBACK");}catch{/* close rolls back */}}db.close();}
}
