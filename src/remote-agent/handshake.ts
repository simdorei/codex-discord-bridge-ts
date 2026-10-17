import {boundedSerdeByteCount} from '../core/serde-byte-count.ts';
import {parseSerdeValue} from '../core/serde-json-parse.ts';
import {serializeSerdeValue} from '../core/serde-json.ts';
import {asU64} from '../store/async-resolution-json-helpers.ts';
import {requireDiscordText} from '../discord/text.ts';
export const REMOTE_PROTOCOL_VERSION=10n;
export class RemoteProtocolError extends Error{
 readonly kind:'Json'|'UnsupportedVersion'|'Validation';readonly received:bigint|null;
 constructor(kind:RemoteProtocolError['kind'],detail:string,received:bigint|null=null,cause?:unknown){super(kind==='UnsupportedVersion'?`protocol version ${received} is unsupported; expected 10`:kind==='Json'?'invalid protocol JSON: '+detail:'protocol validation failed: '+detail,{cause});this.name='RemoteProtocolError';this.kind=kind;this.received=received;}
}
export interface BridgeHello{readonly type:'hello';readonly protocol_version:10n;readonly device_id:string;}
export type GatewayAcknowledgement={readonly type:'hello_ack';readonly protocol_version:10n}|{readonly type:'project_ack';readonly project_scope:string;readonly binding_id:string};
const bad=(detail:string):never=>{throw new RemoteProtocolError('Json',detail);};
function value(raw:string,maxBytes:number):Record<string,unknown>{
 requireDiscordText(raw);if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>12000000)throw new RangeError('Invalid remote frame byte budget');
 if(raw.length>maxBytes||Buffer.byteLength(raw)>maxBytes)throw new RangeError('Remote protocol frame exceeds byte budget');
 let parsed:unknown;try{parsed=parseSerdeValue(raw);}catch(error){throw new RemoteProtocolError('Json','malformed JSON',null,error);}
 if(parsed===null||typeof parsed!=='object'||Array.isArray(parsed))return bad('expected message object');
 const object=parsed as Record<string,unknown>,received=asU64(Object.hasOwn(object,'protocol_version')?object.protocol_version:undefined);
 if(received!==undefined&&received!==10n)throw new RemoteProtocolError('UnsupportedVersion','',received);
 return object;
}
function shape(value:Record<string,unknown>,required:readonly string[],optional:readonly string[]=[]):void{
 if(required.some(k=>!Object.hasOwn(value,k))||Object.keys(value).some(k=>!required.includes(k)&&!optional.includes(k)))bad('missing or unknown message fields');
}
function string(value:unknown):string{if(typeof value!=='string')return bad('expected string field');return value;}
/** Narrow v10 handshake contracts only. Not the full GatewayCommand/BridgeResult
 * parser; callers must not treat rejecting a command here as full protocol QA.
 * Explicit frame-byte budget is supplied by the owner. Parsing belongs in its
 * bounded native decode profile before a large-frame production integration. */
export function parseBridgeHello(raw:string,maxBytes:number):BridgeHello{
 const v=value(raw,maxBytes);shape(v,['type','protocol_version','device_id']);if(v.type!=='hello'||v.protocol_version!==10n)bad('expected protocol 10 hello');
 return Object.freeze({type:'hello',protocol_version:10n,device_id:string(v.device_id)});
}
export function parseGatewayAcknowledgement(raw:string,maxBytes:number):GatewayAcknowledgement{
 const v=value(raw,maxBytes);
 if(v.type==='hello_ack'){
  shape(v,['type'],['protocol_version']);if(Object.hasOwn(v,'protocol_version')&&v.protocol_version!==10n)bad('expected unsigned protocol 10');
  return Object.freeze({type:'hello_ack',protocol_version:10n});
 }
 if(v.type==='project_ack'){
  shape(v,['type','project_scope','binding_id']);const project_scope=string(v.project_scope),binding_id=string(v.binding_id);
  const count=[...binding_id].length;if(count<16||count>64)throw new RemoteProtocolError('Validation','binding_id: length must be between 16 and 64');
  return Object.freeze({type:'project_ack',project_scope,binding_id});
 }
 return bad('expected gateway acknowledgement');
}
export function serializeBridgeHello(deviceId:string,maxBytes=12000000):string{
 requireDiscordText(deviceId);if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>12000000)throw new RangeError('Invalid remote frame byte budget');
 const prefix='{"type":"hello","protocol_version":10,"device_id":',available=maxBytes-prefix.length-1;
 if(available<0||boundedSerdeByteCount(deviceId,available)===null)throw new RangeError('Remote hello exceeds byte budget');
 return prefix+serializeSerdeValue(deviceId)+'}';
}
