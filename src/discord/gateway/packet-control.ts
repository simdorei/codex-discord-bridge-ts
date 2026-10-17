import {rustTrim,parseRustU64} from '../../config/remote.ts';
import {parseSerdeField,type StructField} from '../../core/serde-struct-json.ts';
import {modelShape,modelStruct} from '../model/fields.ts';
import {discordHelloField} from '../model/gateway-ready.ts';
export interface GatewayPacketMetadata{readonly opcode:number;readonly sequence:bigint|null;readonly eventType:string|null}
const packets=new WeakMap<object,string>();
export class GatewayPacketError extends Error{readonly kind:'Opcode'|'DispatchType'|'Sequence'|'Payload';constructor(kind:'Opcode'|'DispatchType'|'Sequence'|'Payload',cause?:unknown){super('Gateway packet could not be decoded',{cause});this.name='GatewayPacketError';this.kind=kind;}}
function integer(text:string,key:string,max:bigint):bigint|null{const position=text.indexOf(key);if(position<0)return null;const from=position+key.length,end=text.slice(from).search(/[,}]/u);if(end<0)return null;const value=parseRustU64(rustTrim(text.slice(from,from+end)));return value!==null&&value<=max?value:null;}
function eventType(text:string):string|null{const position=text.indexOf('"t":');if(position<0)return null;const from=position+4,offset=text.slice(from).search(/\P{White_Space}/u);if(offset<0||text[from+offset]!=='"')return null;const start=from+offset+1,end=text.indexOf('"',start);return end<0?null:text.slice(start,end);}
/** Exact pinned Twilight metadata scan, NOT full JSON/dispatch validation. It
 * searches literal key substrings (including nested ones), allows Rust integer
 * spelling/whitespace, and does not unescape event type text. This source behavior
 * is deliberately kept separate from full event validation and authorization. */
export function scanGatewayPacket(text:string):GatewayPacketMetadata{
 if(typeof text!=='string'||/[\uD800-\uDFFF]/u.test(text))throw new TypeError('Expected Gateway text');const opcode=integer(text,'"op":',255n);if(opcode===null)throw new GatewayPacketError('Opcode');
 const metadata=Object.freeze({opcode:Number(opcode),sequence:integer(text,'"s":',(1n<<64n)-1n),eventType:eventType(text)});packets.set(metadata,text);return metadata;
}
export type GatewaySessionControl={readonly kind:'Ready';readonly sequence:bigint;readonly resumeUrl:string;readonly sessionId:string}|{readonly kind:'Dispatch';readonly sequence:bigint;readonly eventType:string}|{readonly kind:'Heartbeat'|'HeartbeatAck'|'Reconnect'}|{readonly kind:'Hello';readonly heartbeatIntervalMs:bigint}|{readonly kind:'InvalidSession';readonly resumable:boolean}|{readonly kind:'Unhandled';readonly opcode:number};
const minimalReady=modelStruct(modelShape([['resume_gateway_url','string'],['session_id','string']]));
/** Minimal session-processing decoder. A caller must mark received activity after
 * scanning, BEFORE this step can fail, matching Shard::process ordering. READY
 * here changes session state from minimal data; it is not full Ready admission. */
export function decodeGatewaySessionControl(metadata:GatewayPacketMetadata):GatewaySessionControl{
 const text=packets.get(metadata);if(text===undefined)throw new TypeError('Expected owned Gateway packet metadata');
 const payload=(field:StructField):unknown=>{try{return (parseSerdeField(text,modelShape([['d',field]])) as Record<string,unknown>).d;}catch(cause){throw new GatewayPacketError('Payload',cause);}};
 switch(metadata.opcode){
  case 0:{if(metadata.eventType===null)throw new GatewayPacketError('DispatchType');if(metadata.sequence===null)throw new GatewayPacketError('Sequence');if(metadata.eventType==='READY'){const value=payload(minimalReady) as Record<string,unknown>;return Object.freeze({kind:'Ready',sequence:metadata.sequence,resumeUrl:value.resume_gateway_url as string,sessionId:value.session_id as string});}return Object.freeze({kind:'Dispatch',sequence:metadata.sequence,eventType:metadata.eventType});}
  case 1:return Object.freeze({kind:'Heartbeat'});
  case 7:return Object.freeze({kind:'Reconnect'});
  case 9:return Object.freeze({kind:'InvalidSession',resumable:payload('bool') as boolean});
  case 10:return Object.freeze({kind:'Hello',heartbeatIntervalMs:(payload(discordHelloField) as Record<string,unknown>).heartbeat_interval as bigint});
  case 11:return Object.freeze({kind:'HeartbeatAck'});
  default:return Object.freeze({kind:'Unhandled',opcode:metadata.opcode});
 }
}
/** Rust u8.saturating_pow: delays start at one second and cap at 255 seconds. */
export function gatewayReconnectDelayMs(attempt:number):number{if(!Number.isInteger(attempt)||attempt<0||attempt>255)throw new TypeError('Expected u8 reconnect attempt');return Math.min(255,2**attempt)*1000;}
export function gatewayCloseAllowsReconnect(code:number|null):boolean{if(code!==null&&(!Number.isInteger(code)||code<0||code>65535))throw new TypeError('Expected optional u16 close code');return code===null||![4004,4010,4011,4012,4013,4014].includes(code);}
export function gatewayLocalCloseRetainsSession(code:number):boolean{if(!Number.isInteger(code)||code<0||code>65535)throw new TypeError('Expected u16 close code');return code!==1000&&code!==1001;}
