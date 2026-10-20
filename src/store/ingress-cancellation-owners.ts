import type {DatabaseSync} from "node:sqlite";
import {getIngressIn} from "./ingress-read.ts";
import {newCommandPrompt} from "./ingress-new-input.ts";
import {mirroredThreadIdIn} from "./busy-choice.ts";
import {getOwn,asI64} from "./async-resolution-json-helpers.ts";
import {StoreIntegrityError} from "./schema-assembly.ts";
import {decodeTextField,textDecoderFor} from "./sqlite-values.ts";
function invalid(key:string):never{throw new StoreIntegrityError(`request ${key} has conflicting or uncertain cancellation ownership; nothing was cancelled`);}
/** Validate every original owner under the caller's cancellation transaction. Does not rewrite its original room. */
export function ingressCancellationOwnersIn(db:DatabaseSync,job:string,event:bigint|null,target:string,channel:bigint,owner:bigint):string[]{
  const query=db.prepare("SELECT ingress_id,CAST(ingress_id AS BLOB) AS raw,(SELECT encoding FROM pragma_encoding) AS encoding FROM discord_ingress_journal WHERE owner_id=?1 OR (?2 IS NOT NULL AND event_id=?2)");
  const keys=query.all(job,event).map(r=>decodeTextField(r.ingress_id,r.raw,"ingress_id",false,textDecoderFor(r.encoding))!);
  for(const key of keys){const row=getIngressIn(db,key);if(row===null||row.ownerKind!=="prompt"||row.ownerId!==job||row.ownerUserId!==owner||row.targetThreadId!==target||(row.state!=="owned"&&row.state!=="completed"))invalid(key);
    if(row.channelId===channel)continue;
    const creation=getOwn(row.outcome,"new_creation");
    if(newCommandPrompt(row)===null||asI64(getOwn(creation,"version"))!==1n||asI64(getOwn(creation,"origin_channel_id"))!==row.channelId||mirroredThreadIdIn(db,channel)!==target)invalid(key);
  }
  return keys;
}
