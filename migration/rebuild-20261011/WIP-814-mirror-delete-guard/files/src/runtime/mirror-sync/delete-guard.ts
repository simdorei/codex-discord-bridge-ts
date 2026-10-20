import {types} from 'node:util';
import {NativeMirrorStore} from './store-native.ts';
import {mirrorDeleteRejectedStatus,type DiscordMirrorDeletionTransport} from './delete-http.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
function dbId(id:bigint):bigint{if(typeof id!=='bigint'||id<=0n||id>=1n<<63n)throw new TypeError('Discord id exceeds database range');return id;}
function targetId(target:string|null):void{if(target!==null)requireDiscordText(target);}
function now():number{const n=Date.now()/1000;if(!Number.isFinite(n)||n<0)throw new RangeError('System clock precedes Unix epoch');return n;}
/** Exact persistent deletion custody. No retry after an unknown HTTP or store
 * acknowledgement; caller supplies the shared sync serialization boundary. */
export class MirrorDeletionGuard{
 readonly #store:NativeMirrorStore;readonly #delete:(id:bigint,signal:AbortSignal)=>Promise<void>;
 constructor(store:NativeMirrorStore,transport:DiscordMirrorDeletionTransport){
  const remove=own(transport,'delete');if(typeof remove!=='function'||types.isProxy(remove)||types.isGeneratorFunction(remove))throw new TypeError('Expected owned mirror deletion transport');
  this.#store=store;this.#delete=(id,signal)=>Reflect.apply(remove,transport,[id,signal]);Object.freeze(this);
 }
 async ensureReconciled(signal:AbortSignal):Promise<void>{
  const rooms=await NativeMirrorStore.prototype.execute.call(this.#store,{kind:'UnconfirmedCleanup',args:[]},signal);
  if(!Array.isArray(rooms))throw new TypeError('Expected unconfirmed cleanup room list');
  if(rooms.length!==0)throw new Error('cleanup outcome is unconfirmed and fenced; manual reconciliation required before sync');
 }
 async fenceMissingRoom(channel:bigint,target:string|null,signal:AbortSignal):Promise<void>{
  const id=dbId(channel);targetId(target);signal.throwIfAborted();
  const phase=await NativeMirrorStore.prototype.execute.call(this.#store,{kind:'CleanupPhase',args:[id]},signal);
  if(phase==='deleted')return;if(phase!==null)throw new Error('previous cleanup outcome is unconfirmed; mapping retained');
  const token=await this.#begin(id,target,signal);await NativeMirrorStore.prototype.execute.call(this.#store,{kind:'CompleteCleanup',args:[id,token]},signal);
 }
 async deleteGuarded(channel:bigint,target:string|null,signal:AbortSignal):Promise<void>{
  const id=dbId(channel);targetId(target);signal.throwIfAborted();const token=await this.#begin(id,target,signal);
  try{const result=this.#delete(channel,signal);if(!types.isPromise(result))throw new TypeError('Deletion transport must return a native Promise');await result;}
  catch(error){
   if(mirrorDeleteRejectedStatus(error)!==undefined){await NativeMirrorStore.prototype.execute.call(this.#store,{kind:'ReleaseCleanup',args:[id,token]},signal);throw error;}
   throw new Error('room '+channel+' cleanup outcome is unconfirmed; durable fence retained, no automatic retry',{cause:error});
  }
  await NativeMirrorStore.prototype.execute.call(this.#store,{kind:'CompleteCleanup',args:[id,token]},signal);
 }
 async #begin(id:bigint,target:string|null,signal:AbortSignal):Promise<string>{
  const token=await NativeMirrorStore.prototype.execute.call(this.#store,{kind:'BeginCleanup',args:[id,target,now()]},signal);
  if(typeof token!=='string')throw new TypeError('Expected bound cleanup token');return token;
 }
}
Object.freeze(MirrorDeletionGuard.prototype);
