import {DiscordChannelClient} from '../../discord/channel-client.ts';
import {ownedDiscordTransportFault} from '../../discord/transport-fault.ts';
const rejected=new WeakMap<object,number>();
/** Only a real, parsed authoritative HTTP rejection mints this evidence.
 * Unknown transport, malformed response, cancellation and timeout never do. */
export function mirrorDeleteRejectedStatus(error:unknown):number|undefined {
 return error!==null&&(typeof error==='object'||typeof error==='function')?rejected.get(error):undefined;
}
function rejection(status:number):Error {
 const error=new Error(`mirror sync deletion rejected: HTTP ${status}; deletion was not accepted for this request`);
 error.name='MirrorDeleteRejectedError';rejected.set(error,status);return Object.freeze(error);
}
const statuses=new Set([400,401,403,405,413,415,422,429]);
/** Shared HTTP/rate ownership, one ten-second operation budget. This leaf does
 * not acquire/release a durable cleanup fence or certify a whole sync. */
export class DiscordMirrorDeletionTransport {
 readonly delete:(channel:bigint,external:AbortSignal)=>Promise<void>;
 constructor(client:DiscordChannelClient){
  this.delete=async(channel,external)=>{
   external.throwIfAborted();const timeout=new AbortController(),reason=new Error('mirror sync Discord request failed: phase=room-delete; whole-operation deadline=10s expired during HTTP/rate-limit/body wait; outcome unconfirmed; earlier sync changes may have completed');
   const timer=setTimeout(()=>timeout.abort(reason),10000),signal=AbortSignal.any([external,timeout.signal]);
   try{await DiscordChannelClient.prototype.deleteMirrorChannel.call(client,channel,signal);}
   catch(error){const f=ownedDiscordTransportFault(error);if(f?.kind==='Response'&&f.status!==null&&statuses.has(f.status))throw rejection(f.status);throw error;}
   finally{clearTimeout(timer);}
  };Object.freeze(this);
 }
}
Object.freeze(DiscordMirrorDeletionTransport.prototype);
