import type {DatabaseSync} from "node:sqlite";
import {mirroredThreadIdIn} from "./busy-choice.ts";
import {getOwn,isJsonObject} from "./async-resolution-json-helpers.ts";
import {rustTrim} from "./restart-snapshot-pure.ts";
import {decodeTextField,textDecoderFor} from "./sqlite-values.ts";
import {StoreIntegrityError} from "./schema-assembly.ts";
/** The shared expected=None stop-binding branch; ingress identity validation is separate. */
export function validateStopBindingIn(db:DatabaseSync,target:string,channel:bigint,binding:unknown):void{
  const command=getOwn(binding,"command"),fields=getOwn(command,"Stop"),reference=getOwn(fields,"reference"),explicit=typeof reference==="string"&&rustTrim(reference)!=="";
  const refused=()=>new StoreIntegrityError("stop custody differs or could not be preserved; no stop acceptance");
  if(!isJsonObject(command)||Object.keys(command).length!==1||!isJsonObject(fields)||Object.keys(fields).length!==1||(!explicit&&reference!==null)||getOwn(binding,"target")!==target)throw refused();
  const route=getOwn(binding,"route"),valid=route==="Explicit"?explicit:!explicit&&(route==="Mapped"?mirroredThreadIdIn(db,channel)===target:route==="Selected"&&mirroredThreadIdIn(db,channel)===null);
  if(!valid)throw refused();
}
export function stopHoldSnapshotIn(db:DatabaseSync,job:string):readonly [string,string,string]|null{
  const names=["target_thread_id","reason","evidence_json"] as const;
  const row=db.prepare(`SELECT ${names.join(",")},${names.map(n=>`CAST(${n} AS BLOB) AS ${n}_raw`).join(",")},(SELECT encoding FROM pragma_encoding) AS encoding FROM cdr_execution_holds WHERE job_id=?`).get(job);
  if(row===undefined)return null;const decoder=textDecoderFor(row.encoding);
  return names.map(n=>decodeTextField(row[n],row[`${n}_raw`],n,false,decoder)!) as [string,string,string];
}
