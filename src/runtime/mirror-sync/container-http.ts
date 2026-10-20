import {DiscordChannelClient} from '../../discord/channel-client.ts';
import type {MirrorInventoryChannel} from '../../discord/mirror-inventory-request.ts';
async function bounded<T>(phase:string,external:AbortSignal,work:(signal:AbortSignal)=>Promise<T>):Promise<T>{
 external.throwIfAborted();const timeout=new AbortController(),reason=new Error('mirror sync Discord request failed: phase='+phase+'; whole-operation deadline=10s expired during HTTP/rate-limit/body wait; outcome unconfirmed; earlier sync changes may have completed'),timer=setTimeout(()=>timeout.abort(reason),10000);
 try{return await work(AbortSignal.any([external,timeout.signal]));}finally{clearTimeout(timer);}
}
/** Shared-client category/text HTTP operations only. Creation receipts and
 * identity readback belong to the higher-level container custody coordinator. */
export class DiscordMirrorContainerTransport{
 readonly channel:(id:bigint,signal:AbortSignal)=>Promise<MirrorInventoryChannel|null>;
 readonly create:(guild:bigint,parent:bigint|null,kind:0n|4n,name:string,topic:string|null,signal:AbortSignal)=>Promise<MirrorInventoryChannel>;
 readonly update:(id:bigint,name:string,topic:string|null,signal:AbortSignal)=>Promise<void>;
 constructor(client:DiscordChannelClient){
  this.channel=(id,external)=>bounded('channel-read',external,signal=>DiscordChannelClient.prototype.getMirrorInventoryChannel.call(client,id,signal));
  this.create=(guild,parent,kind,name,topic,external)=>bounded('room-create',external,signal=>DiscordChannelClient.prototype.createMirrorContainer.call(client,guild,parent,kind,name,topic,signal));
  this.update=(id,name,topic,external)=>bounded('room-update',external,signal=>DiscordChannelClient.prototype.updateMirrorContainer.call(client,id,name,topic,signal));
  Object.freeze(this);
 }
}
Object.freeze(DiscordMirrorContainerTransport.prototype);
