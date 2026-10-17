import {createHash} from 'node:crypto';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
export const BUSY_CREATE_REQUEST_BYTES=524288,BUSY_CREATE_REPLY_BYTES=262144;
export interface BusyCreateWrite{
 readonly ingressKey:string;readonly eventId:bigint;readonly channelId:bigint;readonly ownerUserId:bigint;
 readonly thread:string;readonly prompt:string;readonly allowSteer:boolean;readonly mapped:boolean;
 readonly turn:string|null;readonly job:string|null;readonly now:number;
}
export interface BusyCreateIngress{readonly ingressKey:string;readonly eventId:bigint}
function text(value:unknown,limit=16384):asserts value is string{requireDiscordText(value);if(value.length>limit||Buffer.byteLength(value)>limit)throw new RangeError('Busy creation text exceeds native budget');}
function id(value:unknown):asserts value is bigint{if(typeof value!=='bigint'||value<0n||value>=1n<<63n)throw new TypeError('Expected original busy nonnegative i64 identity');}
export function captureBusyCreateIngress(input:BusyCreateIngress):BusyCreateIngress{
 if(boundedSerdeByteCount(input,32768)===null)throw new RangeError('Busy ingress exceeds native budget');const q=cloneOwnedSerdeValue(input);
 if(q===null||typeof q!=='object'||Array.isArray(q)||Object.keys(q).length!==2)throw new TypeError('Expected exact original busy ingress');
 const ingressKey=own(q,'ingressKey'),eventId=own(q,'eventId');text(ingressKey);id(eventId);if(ingressKey==='')throw new TypeError('Original busy ingress is required');return Object.freeze({ingressKey,eventId});
}
export function captureBusyCreate(input:BusyCreateWrite):BusyCreateWrite{
 if(boundedSerdeByteCount(input,BUSY_CREATE_REQUEST_BYTES)===null)throw new RangeError('Busy creation exceeds native budget');const q=cloneOwnedSerdeValue(input);
 if(q===null||typeof q!=='object'||Array.isArray(q)||Object.keys(q).length!==11)throw new TypeError('Expected exact busy creation fields');
 const ingress=captureBusyCreateIngress({ingressKey:own(q,'ingressKey') as string,eventId:own(q,'eventId') as bigint}),channelId=own(q,'channelId'),ownerUserId=own(q,'ownerUserId'),thread=own(q,'thread'),prompt=own(q,'prompt'),allowSteer=own(q,'allowSteer'),mapped=own(q,'mapped'),turn=own(q,'turn'),job=own(q,'job'),now=own(q,'now');
 id(channelId);id(ownerUserId);text(thread);text(prompt,131072);if(turn!==null)text(turn);if(job!==null)text(job);
 if(typeof allowSteer!=='boolean'||typeof mapped!=='boolean'||typeof now!=='number'||!Number.isFinite(now)||now<0||!Number.isFinite(now+1800))throw new TypeError('Invalid original busy scope');
 return Object.freeze({...ingress,channelId,ownerUserId,thread,prompt,allowSteer,mapped,turn,job,now});
}
export function busyCreateBinding(id:string,path:string,choiceId:string,op:BusyCreateWrite){
 return Object.freeze({id,path,operation:'BusyCreate' as const,choiceId,ingressKey:op.ingressKey,eventId:op.eventId,channelId:op.channelId,ownerUserId:op.ownerUserId,thread:op.thread,allowSteer:op.allowSteer,mapped:op.mapped,turn:op.turn,job:op.job,now:op.now,expiresAt:op.now+1800,promptDigest:createHash('sha256').update(op.prompt,'utf8').digest('hex')});
}
