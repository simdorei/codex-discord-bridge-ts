import {DiscordChannelClient} from '../../discord/channel-client.ts';
import type {NewMirrorTransport,MirrorChannel} from './new-mirror-link.ts';
import {mirrorChannelId} from '../../discord/mirror-channel-request.ts';
/** Shares the existing channel client's wire/rate/authorization ownership. Every
 * read/create/update has one 10-second budget including rate, header and body waits.
 * Closing the shared client is the composition root's responsibility. */
export class DiscordNewMirrorTransport implements NewMirrorTransport {
 readonly channel:NewMirrorTransport['channel'];readonly createThread:NewMirrorTransport['createThread'];readonly updateThread:NewMirrorTransport['updateThread'];
 constructor(client:DiscordChannelClient){
  async function bounded<T>(phase:string,external:AbortSignal,work:(signal:AbortSignal)=>Promise<T>):Promise<T>{
   external.throwIfAborted();const timeout=new AbortController(),error=new Error(`mirror sync Discord request failed: phase=${phase}; whole-operation deadline=10s expired during HTTP/rate-limit/body wait; outcome unconfirmed; earlier sync changes may have completed`),timer=setTimeout(()=>timeout.abort(error),10000),signal=AbortSignal.any([external,timeout.signal]);
   try{return await work(signal);}finally{clearTimeout(timer);}
  }
  this.channel=(id,signal)=>bounded('channel-read',signal,s=>DiscordChannelClient.prototype.getMirrorChannel.call(client,id,s));
  this.createThread=(guild,parent,name,signal)=>{mirrorChannelId(guild);return bounded('room-create',signal,s=>DiscordChannelClient.prototype.createMirrorThread.call(client,parent,name,s));};
  this.updateThread=(channel:MirrorChannel,name,signal)=>bounded('room-update',signal,s=>DiscordChannelClient.prototype.updateMirrorThread.call(client,channel.id,name,s));Object.freeze(this);
 }
}
Object.freeze(DiscordNewMirrorTransport.prototype);
