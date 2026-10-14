import {types} from 'node:util';
import {DiscordChannelClient} from '../../discord/channel-client.ts';
import type {DiscordReceiptTransport} from '../completion/receipt-sender.ts';

const httpRequests=Object.getOwnPropertyDescriptor(DiscordChannelClient.prototype,'activeRequests')!.get!;
const send=DiscordChannelClient.prototype.sendValidated;
const signalAborted=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'aborted')!.get!;

/** Borrow the runtime's branded shared HTTP client as an own-method receipt port.
 * Captured prototype methods cannot be retargeted by client method replacement;
 * the client still supplies its complete response decoder and shared rate owner.
 * Optional adapter cancellation is combined with the actual per-send operation
 * signal, including target deadlines and core/forced worker shutdown. Each returned Promise
 * joins the actual request/body cleanup, without closing the shared client.
 * No cursor bootstrap, worker startup or sessionMirror profile enablement here. */
export function createSessionMirrorHttpTransport(client:DiscordChannelClient,signal?:AbortSignal):DiscordReceiptTransport{
 if(types.isProxy(client))throw new TypeError('Expected shared Discord channel client');
 Reflect.apply(httpRequests,client,[]);
 if(signal!==undefined){
  if(types.isProxy(signal))throw new TypeError('Expected mirror HTTP cancellation signal');
  Reflect.apply(signalAborted,signal,[]);
 }
 return Object.freeze({sendValidated:(request:Parameters<DiscordReceiptTransport['sendValidated']>[0],operation?:AbortSignal)=>{
  if(operation!==undefined){if(types.isProxy(operation))throw new TypeError('Expected mirror HTTP operation signal');Reflect.apply(signalAborted,operation,[]);}
  const abort=signal===undefined?operation:operation===undefined?signal:AbortSignal.any([signal,operation]);
  return Reflect.apply(send,client,[request,abort]) as Promise<bigint>;
 }});
}
