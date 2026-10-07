import type {DatabaseSync} from "node:sqlite";
import {openInitialized} from "./owned-driver.ts";
import {getIngressIn,unfinishedPriorIngressesIn} from "./ingress-read.ts";
import {StoreIntegrityError} from "./schema-assembly.ts";
import {decodeI64} from "./sqlite-values.ts";
import {cleanupRefusalFromOutcome} from "./async-resolution-cleanup-refusal.ts";
import {getOwn} from "./async-resolution-json-helpers.ts";
const ARCHIVED_PRESERVES=`SELECT EXISTS(SELECT 1 FROM cdr_archived_cleanup_evidence e
 JOIN cdr_cleanup_fences f ON f.token=e.token AND f.channel_id=e.channel_id AND f.target_thread_id=e.target_thread_id
 JOIN discord_ingress_journal j ON j.ingress_id=e.ingress_id AND j.channel_id=e.channel_id AND j.target_thread_id=e.target_thread_id AND j.payload_json=e.payload_json AND j.outcome_json=e.outcome_json
 WHERE e.ingress_id=? AND j.owner_user_id=json_extract(e.row_snapshot_json,'$.owner_user_id')
 AND j.canonical_owner IS json_extract(e.row_snapshot_json,'$.canonical_owner') AND j.event_id IS json_extract(e.row_snapshot_json,'$.event_id')
 AND j.runtime_id IS json_extract(e.row_snapshot_json,'$.runtime_id') AND j.hold_reason=json_extract(e.row_snapshot_json,'$.hold_reason') AND j.updated_at=json_extract(e.row_snapshot_json,'$.updated_at')
 AND j.state='held' AND j.phase='result_recorded' AND j.owner_kind IS NULL AND j.owner_id IS NULL AND j.confirmation_delivered=0) AS held`;
function text(v:unknown):void{if(typeof v!=="string"||/[\uD800-\uDFFF]/u.test(v))throw new TypeError("Expected well-formed text");}
function firstChars(value:string,limit:number):string{let result="",count=0;for(const char of value){if(count++>=limit)break;result+=char;}return result;}
async function writer<T>(path:string,run:(db:DatabaseSync)=>T):Promise<T>{const db=await openInitialized(path);try{db.exec("BEGIN IMMEDIATE");const result=run(db);db.exec("COMMIT");return result;}finally{if(db.isTransaction){try{db.exec("ROLLBACK");}catch{/* close rolls back */}}db.close();}}
export function archivedIngressPreservedIn(db:DatabaseSync,key:string):boolean{const q=db.prepare(ARCHIVED_PRESERVES);q.setReadBigInts(true);return decodeI64(q.get(key)?.held,"held")!==0n;}
/** The owning writer transaction rolls back state and the one notice together. */
export function holdIngressIn(db:DatabaseSync,key:string,reason:string,notExecuted:boolean,now:number):void{
  if(!db.isTransaction)throw new StoreIntegrityError("Borrowed mutation requires an active transaction");
  const record=getIngressIn(db,key);if(record===null)throw new StoreIntegrityError(`missing ingress hold: ${key}`);
  if(archivedIngressPreservedIn(db,key))return;
  if(record.ownerId!==null){db.prepare("UPDATE codex_new_first_replies SET ack_recovery_allowed=1 WHERE ingress_id=? AND confirmation_delivered=0").run(key);return;}
  const refusal=cleanupRefusalFromOutcome(record.outcome);
  if(refusal!==undefined){
    const detail=record.holdReason.startsWith("Mirror sync stopped:")?record.holdReason:`Mirror sync stopped: room ${refusal.room} protected by ${refusal.reason}; notification confirmation not recorded. No deletion dispatched for this room; earlier changes may have completed. No automatic retry. Recovery boundary: ${firstChars(reason,150)}`;
    db.prepare("UPDATE discord_ingress_journal SET state='held',hold_reason=?,updated_at=? WHERE ingress_id=?").run(detail,now,key);return;
  }
  const description=record.state==="completed"||record.phase==="result_recorded"?"The action completed, but its confirmation was not recorded. It will not execute again.":
    notExecuted||record.phase==="archive_fenced"?"The request was saved but was not executed. It will not be retried automatically.":"The execution outcome is unknown. The request was saved and will not be retried automatically.";
  const publicReason=firstChars(record.phase==="archive_fenced"?record.holdReason:reason,500);
  db.prepare("UPDATE discord_ingress_journal SET state='held',hold_reason=?,updated_at=? WHERE ingress_id=?").run(publicReason,now,key);
  const q=db.prepare("SELECT notice_staged FROM discord_ingress_journal WHERE ingress_id=?");q.setReadBigInts(true);if(decodeI64(q.get(key)?.notice_staged,"notice_staged")!==0n)return;
  const id=`ingress-hold:${key}`,attachments=getOwn(record.payload,"attachments"),note=Array.isArray(attachments)&&attachments.length>0?"\nAttachment metadata is saved; unavailable files need re-upload.":"";
  const content=`Saved Discord request requires review\nrequest_id: ${key}\n${description}\nphase: ${record.phase}\ntarget: ${record.targetThreadId??"not yet known"}\nreason: ${publicReason}\nUse !runners to inspect your saved requests.${note}`;
  db.prepare("INSERT INTO codex_delivery_outbox(delivery_id,job_id,target_thread_id,turn_id,channel_id,content,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run(id,id,record.targetThreadId??"",id,record.channelId,content,now,now);
  db.prepare("UPDATE discord_ingress_journal SET notice_staged=1 WHERE ingress_id=?").run(key);
}
export function holdIngress(path:string,key:string,reason:string,notExecuted:boolean,now:number):Promise<void>{
  for(const value of [path,key,reason])text(value);if(typeof notExecuted!=="boolean"||typeof now!=="number")throw new TypeError("Expected hold flag/timestamp");return writer(path,db=>holdIngressIn(db,key,reason,notExecuted,now));
}
/** PRECONDITION: exclusive runtime guard, before intake. Not wired to startup until that guard exists. */
export function recoverPriorRuntimeIngress(path:string,runtime:string,now:number):Promise<number>{
  text(path);text(runtime);if(typeof now!=="number")throw new TypeError("Expected numeric timestamp");return writer(path,db=>{
    const records=unfinishedPriorIngressesIn(db,runtime);
    db.prepare("UPDATE codex_new_first_replies SET ack_recovery_allowed=1 WHERE confirmation_delivered=0 AND ingress_id IN (SELECT ingress_id FROM discord_ingress_journal WHERE runtime_id IS NOT ?)").run(runtime);
    for(const record of records)holdIngressIn(db,record.ingressId,"runtime ended before custody handoff or confirmation was recorded",record.state==="staged"||record.state==="acknowledged",now);
    return records.length;
  });
}
