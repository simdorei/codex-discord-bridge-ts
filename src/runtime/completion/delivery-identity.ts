import {createHash} from "node:crypto";
import {deliverTextIndexed,type DeliveryPolicy,type DeliverySleep} from "../../discord/delivery.ts";
import {requireDiscordText} from "../../discord/text.ts";
import type {IdempotentChunk} from "./receipt-sender.ts";

/** Immutable source-derived logical identity; not authorization to send. */
export interface CompletionDeliveryIdentity {readonly domain:string;readonly logicalKey:string}
const identities=new WeakSet<object>();
function identity(domain:string,logicalKey:string):CompletionDeliveryIdentity{
  const result=Object.freeze({domain,logicalKey});identities.add(result);return result;
}
function lengthPrefixed(parts:readonly string[]):string{
  return parts.map(part=>{requireDiscordText(part);return `${Buffer.byteLength(part,"utf8")}:${part};`;}).join("");
}
export function outboxIdentity(deliveryId:string):CompletionDeliveryIdentity{
  requireDiscordText(deliveryId);return identity("completion/v1",deliveryId);
}
export function goalProgressIdentity(threadId:string,turnId:string):CompletionDeliveryIdentity{
  return identity("completion/goal-progress/v1",lengthPrefixed([threadId,turnId]));
}
export function commentaryIdentity(threadId:string,turnId:string,text:string):CompletionDeliveryIdentity{
  requireDiscordText(text);
  // Rust str::trim uses Unicode White_Space: includes NEL, excludes BOM.
  const trimmed=text.replace(/^\p{White_Space}+/u,"").replace(/\p{White_Space}+$/u,"");
  const digest=createHash("sha256").update(trimmed,"utf8").update(Buffer.from([0])).digest("hex");
  return identity("completion/commentary/v1",lengthPrefixed([threadId,turnId,digest]));
}
/** Sequential chunks retain the same logical identity and index across retries. */
export function deliverIdempotentChunks(text:string,policy:DeliveryPolicy,input:CompletionDeliveryIdentity,send:(chunk:IdempotentChunk)=>Promise<void>,sleep?:DeliverySleep):Promise<number>{
  if(input===null||typeof input!=="object"||!identities.has(input))throw new TypeError("Expected factory-created completion identity");
  const {domain,logicalKey}=input;
  return deliverTextIndexed(text,policy,(chunkIndex,content)=>send(Object.freeze({domain,logicalKey,chunkIndex,content})),sleep);
}
