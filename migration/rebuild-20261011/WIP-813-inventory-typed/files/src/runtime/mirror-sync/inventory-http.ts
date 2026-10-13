import {DiscordChannelClient} from '../../discord/channel-client.ts';
import {mirrorChannelId} from '../../discord/mirror-channel-request.ts';
import type {MirrorInventoryChannel,MirrorThreadsPage} from '../../discord/mirror-inventory-request.ts';
export interface MirrorInventoryThread{readonly channel:MirrorInventoryChannel;readonly ownedByBot:boolean}
async function bounded<T>(phase:string,external:AbortSignal,work:(signal:AbortSignal)=>Promise<T>):Promise<T>{
 external.throwIfAborted();const timeout=new AbortController(),reason=new Error('mirror sync Discord request failed: phase='+phase+'; whole-operation deadline=10s expired during HTTP/rate-limit/body wait; outcome unconfirmed; earlier sync changes may have completed'),timer=setTimeout(()=>timeout.abort(reason),10000);
 try{return await work(AbortSignal.any([external,timeout.signal]));}finally{clearTimeout(timer);}
}
/** Read-only complete inventory. Shared rate/HTTP owners; no partial return on
 * malformed pagination, late HTTP failure or cancellation. No whole-sync claim. */
export class DiscordMirrorInventoryTransport{
 readonly channels:(guild:bigint,signal:AbortSignal)=>Promise<readonly MirrorInventoryChannel[]>;
 readonly threadInventory:(guild:bigint,parent:bigint,signal:AbortSignal)=>Promise<readonly MirrorInventoryThread[]>;
 constructor(client:DiscordChannelClient){
  this.channels=(guild,external)=>bounded('guild-channel-list',external,signal=>DiscordChannelClient.prototype.getMirrorGuildChannels.call(client,guild,signal));
  this.threadInventory=(guild,parent,external)=>bounded('thread-inventory',external,async signal=>{
   mirrorChannelId(guild);mirrorChannelId(parent);
   const bot=await DiscordChannelClient.prototype.getMirrorBotId.call(client,signal),active=await DiscordChannelClient.prototype.getMirrorActiveThreads.call(client,guild,signal),channels=new Map<bigint,MirrorInventoryChannel>();
   for(const c of active.threads)if(c.parentId===parent)channels.set(c.id,c);
   let before:string|null=null;
   for(;;){
    signal.throwIfAborted();const page:MirrorThreadsPage=await DiscordChannelClient.prototype.getMirrorArchivedThreads.call(client,parent,before,signal);const next:string|null=page.threads.at(-1)?.archiveBefore??null;
    for(const c of page.threads)channels.set(c.id,c);
    if(page.hasMore===false)break;if(page.hasMore===null)throw new Error('archived thread response omitted has_more');
    if(next===null||next===before)throw new Error('archived thread pagination did not advance');before=next;
   }
   signal.throwIfAborted();return Object.freeze([...channels.values()].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0).map(channel=>Object.freeze({channel,ownedByBot:channel.ownerId===bot})));
  });Object.freeze(this);
 }
}
Object.freeze(DiscordMirrorInventoryTransport.prototype);
