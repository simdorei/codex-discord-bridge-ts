import {isMappedSlashPrompt} from "./ingress-new-input.ts";
import {mirroredThreadIdIn} from "./busy-choice.ts";
import type {DatabaseSync} from "node:sqlite";
import {openInitialized} from "./owned-driver.ts";
import {getIngressIn,ingressByOriginIn,type StoredIngress} from "./ingress-read.ts";
import {snapshotNewIngress,type NewIngress} from "./ingress-types.ts";
import {recordNewAdmissionIn,verifyRecordedAdmissionIn,type RecordedAdmission} from "./ingress-admission-order.ts";
import {captureStopOriginIn} from "./stop-revision-read.ts";
import {newThreadOriginIn} from "./new-thread-origin.ts";
import {prepareNewPromptArmIn} from "./ingress-new-prompt-arm.ts";
import {trimUnicodeWhitespace as trim} from "./queue-preflight-failure.ts";
import {getOwn,isJsonObject,pointer} from "./async-resolution-json-helpers.ts";
import {serializeSerdeValue} from "../core/serde-json.ts";
import {StoreIntegrityError} from "./schema-assembly.ts";
import {decodeI64,decodeTextField,textDecoderFor} from "./sqlite-values.ts";
export interface IngressAdmission {created:boolean;canonicalRepeatCreated:false;record:StoredIngress|null;busyChoice:null}
function validate(r:NewIngress):void{
  if(trim(r.ingressId)===""||trim(r.ingressId)!==r.ingressId||r.channelId<=0n||r.ownerUserId<=0n||!Number.isFinite(r.now)||r.now<0||
    (r.eventId!==null&&r.eventId<=0n)||(r.kind!=="action"&&r.eventId===null)||!isJsonObject(r.payload))throw new StoreIntegrityError("invalid ingress custody identity");
}
function captureOrigins(db:DatabaseSync,r:NewIngress):void{
  const p=r.payload as Record<string,unknown>;
  if(isJsonObject(getOwn(p,"settings_binding"))||isJsonObject(getOwn(p,"lifecycle_binding")))p.stop_origin=captureStopOriginIn(db,r.targetThreadId);
  if(getOwn(p,"new_origin")===undefined&&(getOwn(p,"command")==="new"||pointer(p,"/plan/Execute/New")!==undefined||pointer(p,"/work/Slash/name")==="new"))p.new_origin=newThreadOriginIn(db,r.channelId);
}
/** Retain the returned original proof through every later custody write; never recapture it. */
export function admitIngressRecordedIn(db:DatabaseSync,input:NewIngress):readonly [IngressAdmission,RecordedAdmission|null]{
  const original=snapshotNewIngress(input);validate(original);if(!db.isTransaction)throw new StoreIntegrityError("Borrowed mutation requires an active transaction");
  // Rust Option::or eagerly reads by-origin even when the by-id result already exists.
  const byId=getIngressIn(db,original.ingressId),byOrigin=original.eventId===null?null:ingressByOriginIn(db,original.eventId),existing=byId??byOrigin;
  if(existing!==null){
    if(existing.channelId!==original.channelId||existing.ownerUserId!==original.ownerUserId||existing.kind!==original.kind||existing.eventId!==original.eventId)throw new StoreIntegrityError("ingress identity conflicts with its original owner");
    return [{created:false,canonicalRepeatCreated:false,record:existing,busyChoice:null},null];
  }
  if(original.kind==="message"){
    const q=db.prepare("SELECT EXISTS(SELECT 1 FROM discord_processed_messages WHERE message_id=?) AS held");q.setReadBigInts(true);
    if(decodeI64(q.get(original.eventId)?.held,"held")!==0n)return [{created:false,canonicalRepeatCreated:false,record:null,busyChoice:null},null];
  }
  captureOrigins(db,original);const request=prepareNewPromptArmIn(db,original);
  const row=db.prepare("SELECT runtime_id,CAST(runtime_id AS BLOB) AS raw,(SELECT encoding FROM pragma_encoding) AS encoding FROM codex_app_server_runtime WHERE singleton=1").get();
  const runtime=row===undefined?null:decodeTextField(row.runtime_id,row.raw,"runtime_id",false,textDecoderFor(row.encoding))!;
  db.prepare(`INSERT INTO discord_ingress_journal (ingress_id,kind,event_id,application_id,channel_id,owner_user_id,source_message_id,payload_json,runtime_id,state,phase,target_thread_id,canonical_owner,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,'staged','staged',?,?,?,?)`).run(request.ingressId,request.kind,request.eventId,request.applicationId,request.channelId,request.ownerUserId,request.sourceMessageId,serializeSerdeValue(request.payload),runtime,request.targetThreadId,request.canonicalOwner,request.now,request.now);
  const proof=recordNewAdmissionIn(db,request,runtime);
  if(request.kind==="message")db.prepare("INSERT INTO discord_processed_messages (message_id,seen_at) VALUES (?,?)").run(request.eventId,request.now);
  verifyRecordedAdmissionIn(db,proof);return [{created:true,canonicalRepeatCreated:false,record:getIngressIn(db,request.ingressId),busyChoice:null},proof];
}
export async function admitIngress(path:string,input:NewIngress):Promise<IngressAdmission>{
  const request=snapshotNewIngress(input);validate(request);const db=await openInitialized(path);
  try{db.exec("BEGIN IMMEDIATE");const [admitted]=admitIngressRecordedIn(db,request);db.exec("COMMIT");return admitted;}
  finally{if(db.isTransaction){try{db.exec("ROLLBACK");}catch{/* close rolls back */}}db.close();}
}

/** Capture a supported slash prompt's actual mapping in the original admission transaction. */
export async function admitMappedSlashIngress(path:string,input:NewIngress):Promise<IngressAdmission>{
  const request=snapshotNewIngress(input);
  if(!isMappedSlashPrompt(request.kind,request.payload)||request.targetThreadId!==null)throw new StoreIntegrityError("unsupported mapped slash admission envelope");
  const db=await openInitialized(path);try{
    db.exec("BEGIN IMMEDIATE");request.targetThreadId=mirroredThreadIdIn(db,request.channelId);
    const [admitted]=admitIngressRecordedIn(db,request);db.exec("COMMIT");return admitted;
  }finally{if(db.isTransaction){try{db.exec("ROLLBACK");}catch{/* close rolls back */}}db.close();}
}
