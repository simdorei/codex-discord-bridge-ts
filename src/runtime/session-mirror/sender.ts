import {createHash} from 'node:crypto';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {rustTrim,serdeField,serdeObject} from '../../app-server/value.ts';
import {requireDiscordText} from '../../discord/text.ts';
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
  const hash=createHash('sha256').update(rustTrim(text),'utf8').update('\0').digest('hex');
  return identity(SESSION_MIRROR_ASSISTANT_TEXT_NONCE_DOMAIN,scope,hash);
}
/** Await every receipt; no retries, timers, cursor writes or detached work. Transport
 * ownership and public error rendering remain with the shared completion boundary. */
export async function sendSessionMirrorText(path:string,transport:DiscordReceiptTransport,channel:bigint,input:SessionMirrorIdentity,text:string):Promise<void>{
  if(input===null||typeof input!=='object'||!identities.has(input))throw new TypeError('Expected factory-created session mirror identity');
  if(typeof channel!=='bigint'||channel<=0n||channel>=(1n<<64n))throw new RangeError('Discord channel identifier must be non-zero u64');
  const {domain,logicalKey}=input;
  await deliverTextIndexed(text,{retryDelaysMs:[],chunkMarkers:true},(chunkIndex,content)=>sendReceiptChunk(path,transport,channel,{domain,logicalKey,chunkIndex,content}));
}
