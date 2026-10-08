import {snapshotStoredIngress as snapshot,storedIngressEqual as equal} from "./ingress-snapshot.ts";
import type {DatabaseSync} from "node:sqlite";
import {openInitialized} from "./owned-driver.ts";
import {getIngressIn,type StoredIngress} from "./ingress-read.ts";
import {StoreIntegrityError} from "./schema-assembly.ts";
import {mirroredThreadIdIn} from "./busy-choice.ts";
import {trimUnicodeWhitespace as trim} from "./queue-preflight-failure.ts";
import {getOwn,isJsonObject,pointer} from "./async-resolution-json-helpers.ts";
import {serdeValueEqual} from "../core/serde-value-equal.ts";
import {SystemTimeError} from "./queue-mark-running.ts";
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
/** Single original command, not a retry lease. Selected route still requires runtime selected-snapshot validation. */
export async function claimIngressRecovery(path:string,input:StoredIngress):Promise<RecoveryClaim>{
  const expected=snapshot(input),db=await openInitialized(path);try{
    db.exec("BEGIN IMMEDIATE");const record=getIngressIn(db,expected.ingressId);if(record===null||!equal(record,expected)||record.state!=="executing"||record.phase!=="processing")refused();validateRecord(db,record);
    const now=Date.now()/1000;if(!Number.isFinite(now)||now<0)throw new SystemTimeError(-now*1000);
    if(BigInt(db.prepare("UPDATE discord_ingress_journal SET phase='recovery_claimed',updated_at=? WHERE ingress_id=? AND state='executing' AND phase='processing' AND owner_id IS NULL").run(now,record.ingressId).changes)!==1n)refused();
    record.phase="recovery_claimed";record.updatedAt=now;db.exec("COMMIT");const claim=Object.freeze({[brand]:true as const});claims.set(claim,record);return claim;
  }finally{if(db.isTransaction){try{db.exec("ROLLBACK");}catch{/* close rolls back */}}db.close();}
}
/** Call before every consequential step, including inside the cancellation writer transaction. */
export function validateIngressRecoveryIn(db:DatabaseSync,claim:RecoveryClaim):void{
  const original=claims.get(claim);if(original===undefined)refused();const record=getIngressIn(db,original.ingressId);if(record===null||!equal(record,original))refused();validateRecord(db,original);
}
export async function validateIngressRecovery(path:string,claim:RecoveryClaim):Promise<void>{const db=await openInitialized(path);try{validateIngressRecoveryIn(db,claim);}finally{db.close();}}
