import {types} from 'node:util';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../../runtime/owned-worker-slot.ts';
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

const historySlot=new OwnedWorkerSlot();
const historyByteLength=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype),'byteLength')!.get!;
export const HISTORY_RESPONSE_MAX_BYTES=2*1024*1024;
export function joinDiscordHistoryDecoder():Promise<void>{return historySlot.join();}
/** Complete REST Message page validation in one owned, zero-queue worker. Native
 * exit is joined even after cancellation; returned DTOs use the same gateway
 * message brand. The input/transfer cap is not a whole-process heap guarantee. */
export async function decodeDiscordHistoryMessages(input:Uint8Array,signal?:AbortSignal):Promise<readonly DecodedGatewayMessage[]>{
 signal?.throwIfAborted();if(types.isProxy(input)||!(input instanceof Uint8Array))throw new TypeError('Expected history bytes');if(Reflect.apply(historyByteLength,input,[])>HISTORY_RESPONSE_MAX_BYTES)throw new RangeError('History response exceeds 2 MiB decoder input budget');if(historySlot.busy)throw new OwnedWorkerBusyError();
 const bytes=new Uint8Array(Reflect.apply(historyByteLength,input,[]));Uint8Array.prototype.set.call(bytes,input);
 const pending=historySlot.run(new URL('../history-page-worker.ts',import.meta.url),bytes,10000,signal);let raw:unknown;
 try{raw=await pending;}catch(error){await historySlot.join();throw error;}
 signal?.throwIfAborted();if(raw===null||typeof raw!=='object')throw new SyntaxError('Invalid history decoder result');const result=raw as {ok?:unknown;value?:unknown};if(result.ok!==true||!Array.isArray(result.value)||result.value.length>10)throw new SyntaxError('Complete Discord history page could not be decoded');
 const values=result.value as Record<string,unknown>[];for(const item of values){if(item===null||typeof item!=='object'||typeof item.id!=='bigint'||typeof item.channel_id!=='bigint'||typeof item.content!=='string')throw new SyntaxError('Invalid owned history message');freezeOwned(item);}
 for(const item of values)messages.add(item);return Object.freeze(values) as unknown as readonly DecodedGatewayMessage[];
}
