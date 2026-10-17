import {snapshotStoredIngress as snapshot,storedIngressEqual as equal} from "./ingress-snapshot.ts";
import type {DatabaseSync} from "node:sqlite";
import {openInitialized} from "./owned-driver.ts";
import {usingInitializedStore,usingExistingStore,withStoreTransaction,commitStore} from "./owned-scope.ts";
import {requireDiscordText} from "../discord/text.ts";
import {getIngressIn,type StoredIngress} from "./ingress-read.ts";
import {StoreIntegrityError} from "./schema-assembly.ts";
import {mirroredThreadIdIn} from "./busy-choice.ts";
import {trimUnicodeWhitespace as trim} from "./queue-preflight-failure.ts";
import {getOwn,isJsonObject,pointer} from "./async-resolution-json-helpers.ts";
import {serdeValueEqual} from "../core/serde-value-equal.ts";
import {SystemTimeError} from "./queue-mark-running.ts";
/** Native persistence must reject oversized stored evidence before SQLite returns
 * any text/blob to JS. The scalar preflight and full read share the caller's
 * transaction, including claim readback after triggers. This is a conservative
 * refusal budget, never permission to truncate original custody. */
function boundedRecoveryRecordIn(db:DatabaseSync,key:string):StoredIngress|null{
 if(!db.isTransaction)throw new StoreIntegrityError("Recovery evidence budget requires owning transaction");
 const fields=["ingress_id","kind","event_id","application_id","channel_id","owner_user_id","source_message_id","payload_json","runtime_id","state","phase","target_thread_id","canonical_owner","owner_kind","owner_id","outcome_json","confirmation_delivered","hold_reason","created_at","updated_at"];
 const bytes=fields.map(field=>`COALESCE(length(CAST(${field} AS BLOB)),0)`).join("+");
 const query=db.prepare(`SELECT ${bytes} AS evidence_bytes FROM discord_ingress_journal WHERE ingress_id=?`);query.setReadBigInts(true);
 const row=query.get(key);
 if(row===undefined)return null;
 if(typeof row.evidence_bytes!=="bigint"||row.evidence_bytes<0n||row.evidence_bytes>1048576n)throw new StoreIntegrityError("Recovery stored evidence exceeds byte budget");
 return getIngressIn(db,key);
}
function refused():never{throw new StoreIntegrityError("recovery admission changed or was already used; no retarget or replay");}
export function validateRecoveryBindingIn(db:DatabaseSync,binding:unknown,channel:bigint):void{
  const target=getOwn(binding,"target"),command=getOwn(binding,"command");
  if(typeof target!=="string"||trim(target)===""||!isJsonObject(command)||Object.keys(command).length!==1||channel<=0n)refused();
  const fields=getOwn(command,"Recover")??getOwn(command,"Repair");if(!isJsonObject(fields)||Object.keys(fields).length!==1)refused();
  const reference=getOwn(fields,"reference");if(reference===undefined)refused();const explicit=typeof reference==="string"&&trim(reference)!=="";if(!explicit&&reference!==null)refused();
  switch(getOwn(binding,"route")){
    case "Explicit":if(!explicit)refused();break;
    case "Mapped":if(explicit||mirroredThreadIdIn(db,channel)!==target)refused();break;
    case "Selected":if(explicit||mirroredThreadIdIn(db,channel)!==null)refused();break;
    default:refused();
  }
}
function validateRecord(db:DatabaseSync,record:StoredIngress):void{
  const event=record.eventId,binding=getOwn(record.payload,"lifecycle_binding");
  if(event===null||event<=0n||binding===undefined||record.kind!=="message"||record.ingressId!==`message:${event}`||record.sourceMessageId!==event||record.ownerUserId<=0n||record.ownerId!==null||record.ownerKind!==null||
    getOwn(record.payload,"version")!==1n||!serdeValueEqual(pointer(record.payload,"/plan/Execute"),getOwn(binding,"command"))||record.targetThreadId!==getOwn(binding,"target"))refused();
  validateRecoveryBindingIn(db,binding,record.channelId);
}
const brand:unique symbol=Symbol("recovery custody");
export interface RecoveryClaim {readonly [brand]:true}
const claims=new WeakMap<RecoveryClaim,StoredIngress>();
/** Borrowed claim transaction; returns the exact post-write record for a trusted
 * native transport. The record by itself is not a runtime capability. */
export function claimIngressRecoverySnapshotIn(db:DatabaseSync,input:StoredIngress,now:number):StoredIngress{
 const expected=snapshot(input);if(!db.isTransaction)throw new StoreIntegrityError("Recovery claim requires owning transaction");
 if(typeof now!=="number"||!Number.isFinite(now)||now<0)throw new SystemTimeError(-now*1000);
 const record=boundedRecoveryRecordIn(db,expected.ingressId);if(record===null||!equal(record,expected)||record.state!=="executing"||record.phase!=="processing")refused();validateRecord(db,record);
 if(BigInt(db.prepare("UPDATE discord_ingress_journal SET phase='recovery_claimed',updated_at=? WHERE ingress_id=? AND state='executing' AND phase='processing' AND owner_id IS NULL").run(now,record.ingressId).changes)!==1n)refused();
 record.phase="recovery_claimed";record.updatedAt=now;const saved=boundedRecoveryRecordIn(db,record.ingressId);if(saved===null||!equal(record,saved))refused();return snapshot(record);
}
/** Existing-only synchronous boundary for the native recovery owner. */
export function claimIngressRecoverySnapshotExisting(path:string,input:StoredIngress,now:number):StoredIngress{
 requireDiscordText(path);const expected=snapshot(input);return usingExistingStore(path,db=>withStoreTransaction(db,"IMMEDIATE",()=>commitStore(claimIngressRecoverySnapshotIn(db,expected,now))),100);
}
/** Trusted worker-side evidence check. Caller must obtain the expected record
 * from its own admitted claim; arbitrary RPC data must never call this leaf. */
export function validateIngressRecoverySnapshotIn(db:DatabaseSync,input:StoredIngress):void{
 const original=snapshot(input);if(original.state!=="executing"||original.phase!=="recovery_claimed")refused();const record=boundedRecoveryRecordIn(db,original.ingressId);if(record===null||!equal(record,original))refused();validateRecord(db,original);
}
/** Single original command, not a retry lease. Selected route still requires runtime selected-snapshot validation. */
export async function claimIngressRecovery(path:string,input:StoredIngress):Promise<RecoveryClaim>{
 const expected=snapshot(input);const record=await usingInitializedStore(path,db=>withStoreTransaction(db,"IMMEDIATE",()=>commitStore(claimIngressRecoverySnapshotIn(db,expected,Date.now()/1000))));
 const claim=Object.freeze({[brand]:true as const});claims.set(claim,record);return claim;
}
/** Call before every consequential step, including inside the cancellation writer transaction. */
export function validateIngressRecoveryIn(db:DatabaseSync,claim:RecoveryClaim):void{
  const original=claims.get(claim);if(original===undefined)refused();const record=getIngressIn(db,original.ingressId);if(record===null||!equal(record,original))refused();validateRecord(db,original);
}
export async function validateIngressRecovery(path:string,claim:RecoveryClaim):Promise<void>{const db=await openInitialized(path);try{validateIngressRecoveryIn(db,claim);}finally{db.close();}}


/** Read and claim the original admitted Recover message in one existing-only
 * native transaction. The caller supplies actor/reference identity, never a
 * reconstructed payload or a refreshed target. selectedTarget is supplied only by
 * the native owner holding a current Bridge epoch; it must match stored custody. */
export function claimOriginalRecoverExisting(path:string,key:string,channel:bigint,owner:bigint,event:bigint,reference:string|null,now:number,selectedTarget:string|null=null):StoredIngress{
 requireDiscordText(path);requireDiscordText(key);if(reference!==null)requireDiscordText(reference);
 for(const n of [channel,owner,event])if(typeof n!=="bigint"||n<=0n||n>=(1n<<63n))throw new TypeError("Expected positive recovery i64 identity");
 if(key!==`message:${event}`)throw new TypeError("Recovery key differs from original event");
 return usingExistingStore(path,db=>withStoreTransaction(db,"IMMEDIATE",()=>{
  const record=boundedRecoveryRecordIn(db,key),command={Recover:{reference}};
  if(record===null||record.channelId!==channel||record.ownerUserId!==owner||record.eventId!==event||record.sourceMessageId!==event||!serdeValueEqual(getOwn(record.payload,"plan"),{Execute:command})||!serdeValueEqual(pointer(record.payload,"/lifecycle_binding/command"),command)||(pointer(record.payload,"/lifecycle_binding/route")==="Selected"&&(selectedTarget===null||record.targetThreadId!==selectedTarget)))refused();
  return commitStore(claimIngressRecoverySnapshotIn(db,record,now));
 }),100);
}
