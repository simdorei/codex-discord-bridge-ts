import {decodeGatewayDispatchPayload} from './dispatch-envelope.ts';
import {discordMessageField} from '../model/message.ts';
import {decodeDiscordMessage} from '../model/message.ts';
export interface DecodedGatewayMessage{readonly id:bigint;readonly channel_id:bigint;readonly content:string;readonly timestamp:{readonly unixNanoseconds:bigint};readonly [key:string]:unknown}
const messages=new WeakSet<object>();
function freezeOwned(value:unknown):void{if(value===null||typeof value!=='object')return;for(const child of Object.values(value))freezeOwned(child);Object.freeze(value);}
/** Only full valid Message decoding mints this immutable gateway payload. Unknown
 * message fields follow the same ignored-value profile as the HTTP decoder. */
export function decodeGatewayMessage(text:string):DecodedGatewayMessage{const result=decodeDiscordMessage(text);freezeOwned(result);messages.add(result);return result as unknown as DecodedGatewayMessage;}
export function isDecodedGatewayMessage(value:unknown):value is DecodedGatewayMessage{return value!==null&&typeof value==='object'&&messages.has(value);}

/** Full MESSAGE_CREATE envelope; retains duplicate fields and parent depth. */
export function decodeGatewayMessageDispatch(text:string):DecodedGatewayMessage{const result=decodeGatewayDispatchPayload(text,'MESSAGE_CREATE',discordMessageField) as Record<string,unknown>;freezeOwned(result);messages.add(result);return result as unknown as DecodedGatewayMessage;}
