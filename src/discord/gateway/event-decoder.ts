import {parseSerdeField,type StructField,type StructFieldDecoder} from '../../core/serde-struct-json.ts';
import {discordSimpleDispatchField} from '../model/gateway-dispatch-simple.ts';
import {discordRelatedDispatchField} from '../model/gateway-dispatch-related.ts';
import {discordMemberDispatchField} from '../model/gateway-dispatch-members.ts';
import {discordGuildCreateField,discordPartialGuildField} from '../model/guild.ts';
import {discordRateLimitedField} from '../model/gateway-rate-limited.ts';
import {discordAuditLogEntryField} from '../model/audit-log.ts';
import {discordReadyField,discordHelloField} from '../model/gateway-ready.ts';
import {discordMessageField} from '../model/message.ts';
import {discordInteractionField} from '../model/interaction.ts';
import {decodeGatewayInteractionDispatch,decodeGatewayReadyDispatchIdentity,type DecodedGatewayInteraction} from './decoded-interaction.ts';
import {decodeGatewayMessageDispatch} from './decoded-message.ts';
import {scanGatewayPacket} from './packet-control.ts';
import {decodeGatewayDispatchPayload} from './dispatch-envelope.ts';
import {GATEWAY_DISPATCH_TYPES} from './dispatch-types.ts';
import type {DecodedGatewayEvent} from './ingress.ts';
const ignored:StructFieldDecoder=()=>null;
const extra=new Map<string,StructField>([['READY',discordReadyField],['MESSAGE_CREATE',discordMessageField],['INTERACTION_CREATE',discordInteractionField],['GUILD_CREATE',discordGuildCreateField],['GUILD_UPDATE',discordPartialGuildField],['RATE_LIMITED',discordRateLimitedField],['GUILD_AUDIT_LOG_ENTRY_CREATE',discordAuditLogEntryField],['RESUMED',ignored]]);
function field(name:string):StructField|undefined{return extra.get(name)??discordSimpleDispatchField(name)??discordRelatedDispatchField(name)??discordMemberDispatchField(name);}
for(const name of GATEWAY_DISPATCH_TYPES)if(field(name)===undefined)throw new Error('Missing pinned Gateway dispatch schema: '+name);
const eventNames=new Set([...GATEWAY_DISPATCH_TYPES,'UNAVAILABLE_GUILD']);
const opcodes=new Set([0,1,2,3,4,6,7,8,9,10,11]),controls=new Set([1,7,9,10,11]);
const ignoreMap:StructFieldDecoder=(_raw,_depth,context)=>{context.map(()=>{});return null;};
function lastData(payload:StructField):StructFieldDecoder{return (_raw,_depth,context)=>{let found=false,result:unknown;context.map((name,decode)=>{if(name==='d'){result=decode(payload);found=true;}});if(!found)throw new SyntaxError('Missing Gateway control data');return result;};}
/** Source EventTypeFlags::all filtering occurs before full JSON decoding. null
 * means filtered unknown input, while Ignored means a known fully decoded event.
 * This is the existing valid-JSON model profile; exact diagnostic text and generic
 * serde Content equivalence are not claimed. No command is authorized here. */
export function decodeGatewayEventText(text:string):DecodedGatewayEvent<DecodedGatewayInteraction>|null {
 const metadata=scanGatewayPacket(text),op=metadata.opcode,name=metadata.eventType;
 if(!opcodes.has(op))return null;
 if(!controls.has(op)&&(name===null||!eventNames.has(name)))return null;
 if(op===0){
  if(name==='READY')return Object.freeze({kind:'Ready',identity:decodeGatewayReadyDispatchIdentity(text)});
  if(name==='MESSAGE_CREATE')return Object.freeze({kind:'Message',event:decodeGatewayMessageDispatch(text)});
  if(name==='INTERACTION_CREATE')return Object.freeze({kind:'Interaction',event:decodeGatewayInteractionDispatch(text)});
  // UNAVAILABLE_GUILD is recognized by EventType flags but is not a dispatch
  // deserializer variant in the pinned source. It must error, not silently skip.
  const schema=field(name!);if(schema===undefined)throw new SyntaxError('Unknown Gateway dispatch variant');
  decodeGatewayDispatchPayload(text,name!,schema);return Object.freeze({kind:'Ignored'});
 }
 if(op===1||op===7||op===11)parseSerdeField(text,ignoreMap);
 else if(op===9)parseSerdeField(text,lastData('bool'));
 else if(op===10)parseSerdeField(text,lastData(discordHelloField));
 else throw new SyntaxError('Gateway opcode is not an incoming event');
 return Object.freeze({kind:'Ignored'});
}
