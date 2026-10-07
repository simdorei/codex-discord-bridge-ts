import {createHash} from "node:crypto";
import type {StoredIngress} from "./ingress-read.ts";
import {getIngressIn} from "./ingress-read.ts";
import {openInitialized} from "./owned-driver.ts";
import {StoreIntegrityError} from "./schema-assembly.ts";
import {getOwn,asU64} from "./async-resolution-json-helpers.ts";
import {trimUnicodeWhitespace as trim} from "./queue-preflight-failure.ts";
import {serializeSerdeValue} from "../core/serde-json.ts";
import {serdeValueEqual} from "../core/serde-value-equal.ts";
const digest=(text:string):string=>createHash("sha256").update(text).digest("hex");
const field=(value:unknown,...keys:string[]):unknown=>keys.reduce((v,k)=>getOwn(v,k),value);
export function newCommandPrompt(ingress:StoredIngress):string|null{
  const payload=ingress.payload;
  if(ingress.kind==="action"&&getOwn(payload,"command")==="new")return typeof getOwn(payload,"prompt")==="string"?getOwn(payload,"prompt") as string:null;
  if(asU64(getOwn(payload,"version"))!==1n)return null;
  if(ingress.kind==="message"){const prompt=field(payload,"plan","Execute","New","prompt");return typeof prompt==="string"?prompt:null;}
  if(ingress.kind==="interaction"&&field(payload,"work","Slash","name")==="new"){
    const prompt=field(payload,"work","Slash","values","prompt","String");return typeof prompt==="string"?trim(prompt):null;
  }
  return null;
}
export function frozenSlashTarget(ingress:StoredIngress):string|null{
  const name=field(ingress.payload,"work","Slash","name");
  return ingress.kind==="interaction"&&asU64(getOwn(ingress.payload,"version"))===1n&&(name==="ask"||name==="interview")&&
    typeof field(ingress.payload,"work","Slash","values","prompt","String")==="string"?ingress.targetThreadId:null;
}
function envelopeDigest(record:StoredIngress):string{
  return digest(serializeSerdeValue([record.ingressId,record.kind,record.eventId,record.channelId,record.ownerUserId,record.payload]));
}
function attachments(record:StoredIngress):boolean{
  const values=getOwn(record.payload,"attachments");return record.kind==="message"&&Array.isArray(values)&&values.length>0;
}
export function newExecutionPrompt(record:StoredIngress):string|null{
  const raw=newCommandPrompt(record);if(raw===null)return null;
  const prepared=getOwn(record.outcome,"new_input");
  if(!attachments(record)){
    if(prepared!==undefined)throw new StoreIntegrityError("prepared new attachment envelope changed");return raw;
  }
  if(prepared===undefined)throw new StoreIntegrityError("new attachments have no durable prepared input; no execution permitted");
  const prompt=getOwn(prepared,"prompt");if(typeof prompt!=="string"||trim(prompt)==="")throw new StoreIntegrityError("new prepared input is missing");
  if(getOwn(prepared,"version")!==1n||getOwn(prepared,"source_sha256")!==envelopeDigest(record)||getOwn(prepared,"prompt_sha256")!==digest(prompt))
    throw new StoreIntegrityError("new prepared input or original envelope changed");
  return prompt;
}
export async function recordNewInput(path:string,key:string,raw:string,prompt:string,now:number):Promise<void>{
  for(const value of [path,key,raw,prompt])if(typeof value!=="string"||/[\uD800-\uDFFF]/u.test(value))throw new TypeError("Expected well-formed text");
  if(!Number.isFinite(now)||trim(prompt)==="")throw new StoreIntegrityError("invalid new input preparation");
  const db=await openInitialized(path);let committed=false;
  try{
    db.exec("BEGIN IMMEDIATE");const record=getIngressIn(db,key);if(record===null)throw new StoreIntegrityError("new input owner is missing");
    if(newCommandPrompt(record)!==raw||!attachments(record))throw new StoreIntegrityError("new input preparation does not own the original prompt and attachments");
    const prepared={version:1n,source_sha256:envelopeDigest(record),prompt_sha256:digest(prompt),prompt};
    const existing=getOwn(record.outcome,"new_input");
    if(existing!==undefined){if(!serdeValueEqual(existing,prepared))throw new StoreIntegrityError("new prepared input is immutable");return;}
    if(record.state!=="executing"||record.phase!=="processing")throw new StoreIntegrityError("new attachment input must be frozen before thread/start");
    db.prepare("UPDATE discord_ingress_journal SET outcome_json=json_set(COALESCE(outcome_json,'{}'),'$.new_input',json(?)),updated_at=? WHERE ingress_id=?")
      .run(serializeSerdeValue(prepared),now,key);db.exec("COMMIT");committed=true;
  }finally{if(!committed&&db.isTransaction){try{db.exec("ROLLBACK");}catch{/* close rolls back */}}db.close();}
}
