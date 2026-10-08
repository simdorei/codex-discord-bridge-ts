import {types} from "node:util";
import {StateAccessFacade as state} from "../../store/state-access-facade.ts";
import {serializeSerdeValue} from "../../core/serde-json.ts";
import {receiptHash,type DeliveryGuard} from "../../store/delivery-receipt-key.ts";
import {idempotentMessageRequestWithComponents,idempotentContentErrorMessage,type IdempotentMessageRequest} from "../../discord/idempotent-message.ts";
import {serializeDiscordComponent,type DiscordComponent} from "../../discord/components.ts";
import {requireDiscordText} from "../../discord/text.ts";
export interface IdempotentChunk {readonly domain:string;readonly logicalKey:string;readonly chunkIndex:bigint|number;readonly content:string}
/** Trusted adapter must validate the complete provider response before returning its nonzero u64 message ID. No production HTTP decoder is supplied here. */
export interface DiscordReceiptTransport {sendValidated(request:IdempotentMessageRequest):Promise<bigint>}
import {DiscordTransportFault,ownedDiscordTransportFault} from "../../discord/transport-fault.ts";
export {DiscordTransportFault,type DiscordFaultKind} from "../../discord/transport-fault.ts";
const heldErrors=new WeakSet<object>();
export class CompletionHeldError extends Error{readonly kind="Held";constructor(reason:string){super(`output held without HTTP attempt: ${reason}`);this.name="CompletionHeldError";heldErrors.add(this);}}
export function isCompletionHeld(error:unknown):boolean{return error!==null&&(typeof error==="object"||typeof error==="function")&&heldErrors.has(error);}
export class CompletionDeliveryError extends Error{readonly kind="Delivery";constructor(detail:string){super(`Discord final delivery failed: ${detail}`);this.name="CompletionDeliveryError";}}
function snapshot(input:IdempotentChunk):{domain:string;logicalKey:string;chunkIndex:bigint;content:string}{
  if(input===null||typeof input!=="object"||types.isProxy(input))throw new TypeError("Expected chunk data");
  const field=(key:string):unknown=>{const d=Object.getOwnPropertyDescriptor(input,key);if(!d||!Object.hasOwn(d,"value"))throw new TypeError("Expected own chunk field");return d.value;};
  const domain=field("domain"),logicalKey=field("logicalKey"),content=field("content"),index=field("chunkIndex");requireDiscordText(domain);requireDiscordText(logicalKey);requireDiscordText(content);
  if((typeof index!=="number"&&typeof index!=="bigint")||(typeof index==="number"&&(!Number.isSafeInteger(index)||index<0)))throw new TypeError("Expected lossless chunk index");
  const chunkIndex=BigInt(index);if(chunkIndex<0n||chunkIndex>=(1n<<64n))throw new RangeError("Expected u64 chunk index");return {domain,logicalKey,content,chunkIndex};
}
function componentSnapshot(input:readonly DiscordComponent[]):DiscordComponent[]{
  if(types.isProxy(input)||!Array.isArray(input))throw new TypeError("Expected component array");const result:DiscordComponent[]=[];
  for(let i=0;i<input.length;i++){const d=Object.getOwnPropertyDescriptor(input,String(i));if(!d||!Object.hasOwn(d,"value"))throw new TypeError("Expected own component entry");serializeDiscordComponent(d.value);result.push(d.value);}return result;
}
/** Caller owns this Promise until transport and receipt storage settle; it must not detach it or equate Promise.race with cancellation. */
export async function sendReceiptChunk(path:string,transport:DiscordReceiptTransport,channel:bigint,input:IdempotentChunk,inputComponents:readonly DiscordComponent[]=[],guard:DeliveryGuard|null=null):Promise<void>{
  const chunk=snapshot(input),components=componentSnapshot(inputComponents);let request:IdempotentMessageRequest;
  try{request=idempotentMessageRequestWithComponents(channel,chunk.content,components,chunk.domain,chunk.logicalKey,chunk.chunkIndex);}
  catch(error){throw new CompletionDeliveryError(idempotentContentErrorMessage(error)??"invalid Discord request");}
  const key=serializeSerdeValue([channel,chunk.domain,chunk.logicalKey,chunk.chunkIndex]);
  const hash=receiptHash(components.length===0?chunk.content:`[${JSON.stringify(chunk.content)},[${components.map(serializeDiscordComponent).join(",")}]]`);
  const receipt=await state.beginDeliveryReceipt(path,key,hash,guard);
  switch(receipt.kind){
    case "Held":throw new CompletionHeldError(receipt.reason);
    case "Delivered":return;
    case "Unknown":throw new CompletionDeliveryError("send outcome unknown; held without automatic resend. Inspect !runners and reconcile the Discord message receipt.");
    case "ContentConflict":throw new CompletionDeliveryError("delivery content changed for an existing chunk identity; held without sending");
    case "RejectedBlocked":throw new CompletionDeliveryError(`Discord delivery requires correction; no new request sent: ${receipt.reason}`);
    case "New":break;
  }
  let message:bigint;
  try{
    message=await transport.sendValidated(request);
    if(typeof message!=="bigint"||message<=0n||message>=(1n<<64n))throw new DiscordTransportFault("Receipt","transport returned an invalid message identity");
  }catch(error){
    const fault=ownedDiscordTransportFault(error);
    const definite=fault!==undefined&&(["BuildingRequest","CreatingHeader","Json","Unauthorized","Validation"].includes(fault.kind)||(fault.kind==="Response"&&[400,401,403,404,405,413,415,422,429].includes(fault.status!)));
    const display=fault?.display??"unclassified Discord transport failure";
    if(definite){if(fault!.kind==="Response"&&fault!.status===429)await state.releaseRejectedDelivery(path,key);else await state.blockRejectedDelivery(path,key,display);
      throw new CompletionDeliveryError(`Discord rejected message; definite rejection recorded separately from unknown delivery: ${display}`);}
    throw new CompletionDeliveryError(`send outcome unconfirmed; automatic resend held: ${display}`);
  }
  if(!await state.confirmDeliveryReceipt(path,key,message.toString()))throw new CompletionDeliveryError("Discord accepted message but its receipt could not be committed; automatic resend held");
}
