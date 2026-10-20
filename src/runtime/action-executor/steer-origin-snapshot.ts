import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {userOriginMarker} from '../../store/mirror-origin.ts';
export const STEER_ORIGIN_REQUEST_BYTES=524288;
export const STEER_ORIGIN_REPLY_BYTES=262144;
/** Correlation to the already-admitted original, never new admission authority. */
export interface SteerOriginWrite{
 readonly ingressKey:string;readonly eventId:bigint;readonly channelId:bigint;readonly ownerUserId:bigint;
 readonly thread:string;readonly turn:string;readonly generation:bigint;readonly prompt:string;readonly now:number;
}
function text(value:unknown,limit=16384):asserts value is string{requireDiscordText(value);if(value.length>limit||Buffer.byteLength(value)>limit)throw new RangeError('Steer origin text exceeds native budget');}
export function captureSteerOrigin(input:SteerOriginWrite):SteerOriginWrite{
 if(boundedSerdeByteCount(input,STEER_ORIGIN_REQUEST_BYTES)===null)throw new RangeError('Steer origin request exceeds native budget');
 const q=cloneOwnedSerdeValue(input);if(q===null||typeof q!=='object'||Array.isArray(q)||Object.keys(q).length!==9)throw new TypeError('Expected exact Steer origin fields');
 const ingressKey=own(q,'ingressKey'),eventId=own(q,'eventId'),channelId=own(q,'channelId'),ownerUserId=own(q,'ownerUserId'),thread=own(q,'thread'),turn=own(q,'turn'),generation=own(q,'generation'),prompt=own(q,'prompt'),now=own(q,'now');
 text(ingressKey);text(thread);text(turn);text(prompt,65536);
 for(const id of [eventId,channelId,ownerUserId])if(typeof id!=='bigint'||id<0n||id>=1n<<63n)throw new TypeError('Expected nonnegative i64 Steer origin identity');
 if(ingressKey===''||typeof generation!=='bigint'||generation<0n||generation>=1n<<64n||typeof now!=='number'||!Number.isFinite(now)||now<0)throw new TypeError('Invalid Steer origin scope');
 return Object.freeze({ingressKey,eventId:eventId as bigint,channelId:channelId as bigint,ownerUserId:ownerUserId as bigint,thread,turn,generation,prompt,now});
}
export function steerOriginBinding(id:string,path:string,op:SteerOriginWrite){
 return Object.freeze({id,path,operation:'SteerOrigin' as const,ingressKey:op.ingressKey,eventId:op.eventId,channelId:op.channelId,ownerUserId:op.ownerUserId,thread:op.thread,turn:op.turn,generation:op.generation,now:op.now,marker:userOriginMarker(op.thread,op.turn,op.prompt)});
}

export type SteerOriginAdmission=Pick<SteerOriginWrite,'ingressKey'|'eventId'|'ownerUserId'>;
/** Capture only passive bounded identity before any target-selection await. */
export function captureSteerOriginAdmission(input:SteerOriginAdmission):SteerOriginAdmission{
 if(boundedSerdeByteCount(input,98304)===null)throw new RangeError('Steer admission identity exceeds native budget');
 const q=cloneOwnedSerdeValue(input);if(q===null||typeof q!=='object'||Array.isArray(q)||Object.keys(q).length!==3)throw new TypeError('Expected exact Steer admission identity');
 const ingressKey=own(q,'ingressKey'),eventId=own(q,'eventId'),ownerUserId=own(q,'ownerUserId');text(ingressKey);
 if(ingressKey==='')throw new TypeError('Original Steer ingress key is required');
 for(const id of [eventId,ownerUserId])if(typeof id!=='bigint'||id<0n||id>=1n<<63n)throw new TypeError('Expected original Steer i64 actor identity');
 return Object.freeze({ingressKey,eventId:eventId as bigint,ownerUserId:ownerUserId as bigint});
}
