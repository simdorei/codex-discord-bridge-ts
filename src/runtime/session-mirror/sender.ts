import {normalizedMirrorTextDigest} from './recent-text.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {serdeField,serdeObject} from '../../app-server/value.ts';
import {requireDiscordText,splitDeliveryChunks} from '../../discord/text.ts';
import {serializeSerdeValue} from '../../core/serde-json.ts';
import {receiptHash} from '../../store/delivery-receipt-key.ts';
import type {ExpectedReceipt} from '../../store/confirmed-receipt-batch.ts';
import {deliverTextIndexed} from '../../discord/delivery.ts';
import {sendReceiptChunk,type DiscordReceiptTransport} from '../completion/receipt-sender.ts';
import type {MirrorItem} from './collect.ts';

export const SESSION_MIRROR_ASSISTANT_TEXT_NONCE_DOMAIN='session-mirror/assistant-text/v1';
export const SESSION_MIRROR_EVENT_NONCE_DOMAIN='session-mirror/event/v1';
export interface SessionMirrorIdentity {readonly domain:string;readonly logicalKey:string;}
const identities=new WeakSet<object>();
function identity(domain:string,scope:string,digest:string):SessionMirrorIdentity{
  const result=Object.freeze({domain,logicalKey:`${Buffer.byteLength(scope,'utf8')}:${scope}:${digest}`});identities.add(result);return result;
}
/** Stable identity only, not authorization to deliver or skip ownership checks. */
export function sessionMirrorIdentity(thread:string,input:MirrorItem):SessionMirrorIdentity{
  requireDiscordText(thread);const item=cloneOwnedSerdeValue(input);
  if(!serdeObject(item))throw new TypeError('Expected mirror item');
  const text=serdeField(item,'text'),turn=serdeField(item,'turnId'),id=serdeField(item,'digest'),recent=serdeField(item,'dedupeRecentText');
  requireDiscordText(text);requireDiscordText(id);if(turn!==null)requireDiscordText(turn);
  if(typeof recent!=='boolean')throw new TypeError('Expected mirror text dedupe flag');
  if(!recent)return identity(SESSION_MIRROR_EVENT_NONCE_DOMAIN,thread,id);
  const t=turn??'',scope=`${Buffer.byteLength(thread,'utf8')}:${thread}:${Buffer.byteLength(t,'utf8')}:${t}`;
  const hash=normalizedMirrorTextDigest(text);
  return identity(SESSION_MIRROR_ASSISTANT_TEXT_NONCE_DOMAIN,scope,hash);
}
/** Await every receipt; no retries, timers, cursor writes or detached work. Transport
 * ownership and public error rendering remain with the shared completion boundary.
 * Cancellation prevents later chunk submission but cannot undo an in-flight send.
 * A late confirmed message receipt is still committed before cancellation returns;
 * unknown outcomes remain held and cannot be retried automatically. */
export async function sendSessionMirrorText(path:string,transport:DiscordReceiptTransport,channel:bigint,input:SessionMirrorIdentity,text:string,signal?:AbortSignal):Promise<void>{
  signal?.throwIfAborted();
  validateIdentity(channel,input);
  const {domain,logicalKey}=input;
  await deliverTextIndexed(text,{retryDelaysMs:[],chunkMarkers:true},(chunkIndex,content)=>sendReceiptChunk(path,transport,channel,{domain,logicalKey,chunkIndex,content},[],null,signal));
  signal?.throwIfAborted();
}

function validateIdentity(channel:bigint,input:SessionMirrorIdentity):void{
  if(input===null||typeof input!=='object'||!identities.has(input))throw new TypeError('Expected factory-created session mirror identity');
  if(typeof channel!=='bigint'||channel<=0n||channel>=(1n<<64n))throw new RangeError('Discord channel identifier must be non-zero u64');
}
/** Exact receipt expectations for one bounded mirror send using the same chunk
 * splitter/markers, serde key and content hash as sendSessionMirrorText.
 * This is not evidence that a send happened or that all batch items were supplied.
 * Only this new planning API is bounded; the existing sender contract is unchanged. */
export function sessionMirrorReceiptExpectations(channel:bigint,input:SessionMirrorIdentity,text:string):readonly ExpectedReceipt[]{
  validateIdentity(channel,input);requireDiscordText(text);
  if(text.length>1048576||Buffer.byteLength(text)>1048576)throw new RangeError('Mirror receipt text exceeds one MiB');
  if(input.logicalKey.length>65536||Buffer.byteLength(input.logicalKey)>65536)throw new RangeError('Mirror receipt identity exceeds key budget');
  const chunks=splitDeliveryChunks(text,true);
  if(chunks.length>4096)throw new RangeError('Mirror receipt chunk count exceeds 4096');
  let bytes=0;
  return Object.freeze(chunks.map((content,index)=>{
    const key=serializeSerdeValue([channel,input.domain,input.logicalKey,BigInt(index)]),length=Buffer.byteLength(key);
    bytes+=length+64;if(length>65536||bytes>1048576)throw new RangeError('Mirror receipt batch exceeds key budget');
    return Object.freeze({key,contentHash:receiptHash(content)});
  }));
}
