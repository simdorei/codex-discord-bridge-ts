import {setTimeout as delay} from "node:timers/promises";
import {requireDiscordText,splitDeliveryChunks} from "./text.ts";
/** Millisecond timer profile; nanosecond or beyond-native-timer policies are not represented. */
export interface DeliveryPolicy {readonly retryDelaysMs:readonly number[];readonly chunkMarkers:boolean}
export const DEFAULT_DELIVERY_POLICY:DeliveryPolicy=Object.freeze({retryDelaysMs:Object.freeze([750,2000]),chunkMarkers:true});
export class DeliveryFailure extends Error{
  readonly part:number;readonly totalParts:number;readonly attempts:number;readonly source:unknown;
  constructor(part:number,totalParts:number,attempts:number,source:unknown){super(`Discord delivery part ${part}/${totalParts} failed after ${attempts} attempts`,{cause:source});this.name="DeliveryFailure";this.part=part;this.totalParts=totalParts;this.attempts=attempts;this.source=source;}
}
export type ChunkSender=(index:number,chunk:string)=>Promise<void>;
export type DeliverySleep=(milliseconds:number)=>Promise<void>;
/** Sequential retry of the same indexed chunk; earlier successful parts never resend in this invocation. */
export async function deliverChunksIndexed(input:readonly string[],policy:DeliveryPolicy,send:ChunkSender,sleep:DeliverySleep=delay):Promise<number>{
  const chunks=[...input],delays=[...policy.retryDelaysMs];for(const chunk of chunks)requireDiscordText(chunk);
  for(const value of delays)if(!Number.isSafeInteger(value)||value<0||value>2147483647)throw new RangeError("Unsupported native millisecond retry delay");
  for(let index=0;index<chunks.length;index++){
    for(let attempt=0;attempt<=delays.length;attempt++){
      try{await send(index,chunks[index]!);break;}catch(source){if(attempt===delays.length)throw new DeliveryFailure(index+1,chunks.length,attempt+1,source);}
      await sleep(delays[attempt]!);
    }
  }
  return chunks.length;
}
export function deliverTextIndexed(text:string,policy:DeliveryPolicy,send:ChunkSender,sleep?:DeliverySleep):Promise<number>{return deliverChunksIndexed(splitDeliveryChunks(text,policy.chunkMarkers),policy,send,sleep);}
export function deliverText(text:string,policy:DeliveryPolicy,send:(chunk:string)=>Promise<void>,sleep?:DeliverySleep):Promise<number>{return deliverTextIndexed(text,policy,(_index,chunk)=>send(chunk),sleep);}
