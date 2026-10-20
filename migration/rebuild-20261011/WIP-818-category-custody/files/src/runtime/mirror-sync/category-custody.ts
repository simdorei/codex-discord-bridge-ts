import {types} from 'node:util';
import {NativeMirrorStore} from './store-native.ts';
import type {DiscordMirrorContainerTransport} from './container-http.ts';
import type {MirrorInventoryChannel} from '../../discord/mirror-inventory-request.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {ownContainerReceipt,confirmedContainerChannel,type MirrorContainerReceipt} from '../../store/mirror-container-creation.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
function id(v:bigint):bigint{if(typeof v!=='bigint'||v<=0n||v>=1n<<63n)throw new TypeError('Expected positive database-compatible Discord id');return v;}
function category(input:MirrorInventoryChannel,guild:bigint):MirrorInventoryChannel{
 const c=cloneOwnedSerdeValue(input) as MirrorInventoryChannel;
 if(c===null||typeof c!=='object'||Array.isArray(c)||c.guildId!==guild||c.kind!==4n||c.parentId!==null)throw new Error('stored category has wrong guild, kind, or parent');id(c.id);return c;
}
function method<T extends Function>(remote:unknown,key:string):T{const f=own(remote,key);if(typeof f!=='function'||types.isProxy(f)||types.isGeneratorFunction(f))throw new TypeError('Expected owned container transport');return f as T;}
async function native<T>(p:Promise<T>):Promise<T>{if(!types.isPromise(p))throw new TypeError('Expected native transport promise');return p;}
/** Category creation custody only. Caller owns shared sync lock and operation
 * deadline. A confirmed missing room never authorizes repeat creation until the
 * durable receipt was bound and this operation observes exact-ID absence. */
export class MirrorCategoryCustody{
 readonly category:(guild:bigint,channels:readonly MirrorInventoryChannel[],signal:AbortSignal)=>Promise<bigint>;
 constructor(store:NativeMirrorStore,remote:DiscordMirrorContainerTransport){
  const read=method<DiscordMirrorContainerTransport['channel']>(remote,'channel'),create=method<DiscordMirrorContainerTransport['create']>(remote,'create');
  this.category=async(guild,input,signal)=>{
   id(guild);signal.throwIfAborted();const channels=cloneOwnedSerdeValue(input) as readonly MirrorInventoryChannel[];if(!Array.isArray(channels))throw new TypeError('Expected channel list');
   const saved=await NativeMirrorStore.prototype.execute.call(store,{kind:'CategoryReceipt',args:[guild]},signal),previous=saved===null?null:ownContainerReceipt(saved as MirrorContainerReceipt);
   if(previous!==null){
    const expected=id(confirmedContainerChannel(previous)),found=await native<MirrorInventoryChannel|null>(Reflect.apply(read,remote,[expected,signal]));
    signal.throwIfAborted();if(found!==null){const c=category(found,guild);if(c.id!==expected)throw new Error('category response identity changed');await NativeMirrorStore.prototype.execute.call(store,{kind:'BindCategory',args:[previous]},signal);return expected;}
    if(previous.phase!=='bound')throw new Error('confirmed category is missing before binding; creation not repeated');
   }else{
    const matches=channels.filter(c=>c.kind===4n&&c.name==='Codex');if(matches.length>1)throw new Error('multiple Codex categories; resolve duplicate first');
    if(matches.length===1)return category(matches[0]!,guild).id;
   }
   const receipt=ownContainerReceipt(await NativeMirrorStore.prototype.execute.call(store,{kind:'BeginCategory',args:[guild,previous]},signal) as MirrorContainerReceipt);
   const created=category(await native<MirrorInventoryChannel>(Reflect.apply(create,remote,[guild,null,4n,'Codex',null,signal])),guild);
   const confirmed=ownContainerReceipt(await NativeMirrorStore.prototype.execute.call(store,{kind:'ConfirmContainer',args:[receipt,id(created.id)]},signal) as MirrorContainerReceipt);
   await NativeMirrorStore.prototype.execute.call(store,{kind:'BindCategory',args:[confirmed]},signal);return created.id;
  };Object.freeze(this);
 }
}
Object.freeze(MirrorCategoryCustody.prototype);
