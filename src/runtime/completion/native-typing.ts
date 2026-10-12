import {types} from 'node:util';
import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../owned-worker-slot.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';import {requireDiscordText} from '../../discord/text.ts';
import type {TypingInventory,TypingInventoryReader,TypingJob} from './typing.ts';
export class NativeTypingInventoryUnavailable extends Error{constructor(){super('Typing state lookup unavailable');this.name='NativeTypingInventoryUnavailable';}}
const text=(v:unknown):string=>{requireDiscordText(v);return v;};
/** Only projection fields are transferred. Full original queue/terminal decoding
 * occurs in the worker before this boundary; these hints never authorize HTTP. */
export class NativeTypingInventoryReader implements TypingInventoryReader{
 readonly #path:string;readonly #timeout:number;readonly #tasks=new Map<Promise<unknown>,AbortController>();#closed=false;
 constructor(path:string,timeoutMs=5000){requireDiscordText(path);if(path.includes('\0')||Buffer.byteLength(path)>32768)throw new TypeError('Invalid typing path');this.#path=pinNativeRuntimePath(path);if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid typing deadline');this.#timeout=timeoutMs;}
 get active():number{return this.#tasks.size;}
 read(signal?:AbortSignal):Promise<TypingInventory>{
  if(signal!==undefined&&(types.isProxy(signal)||!(signal instanceof AbortSignal)))throw new TypeError('Expected AbortSignal');signal?.throwIfAborted();if(this.#closed)throw new NativeTypingInventoryUnavailable();if(this.#tasks.size!==0)throw new OwnedWorkerBusyError();
  const slot=new OwnedWorkerSlot('Maintenance'),controller=new AbortController(),abort=()=>controller.abort(signal!.reason);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const task=(async()=>{try{
   const pending=slot.runMaintenanceRead(new URL('./native-typing-worker.ts',import.meta.url),{path:this.#path},this.#timeout,controller.signal);let raw:unknown;try{raw=await pending;}finally{await slot.join();}controller.signal.throwIfAborted();
   if(boundedSerdeByteCount(raw,16*1024*1024)===null||own(raw,'ok')!==true)throw new NativeTypingInventoryUnavailable();const jobs=own(raw,'jobs'),terminals=own(raw,'terminals');if(!Array.isArray(jobs)||!Array.isArray(terminals))throw new NativeTypingInventoryUnavailable();
   const checkedJobs:TypingJob[]=jobs.map(j=>{const targetThreadId=text(own(j,'targetThreadId')),turn=own(j,'turnId'),turnId=turn===null?null:text(turn),state=own(j,'state'),goalWaiting=own(j,'goalWaiting'),channelId=own(j,'channelId');
    if((state!=='Pending'&&state!=='Starting'&&state!=='Running'&&state!=='Quarantined')||typeof goalWaiting!=='boolean'||typeof channelId!=='bigint'||channelId<-(1n<<63n)||channelId>=(1n<<63n))throw new NativeTypingInventoryUnavailable();return Object.freeze({targetThreadId,turnId,state,goalWaiting,channelId});});
   const checkedTerminals=terminals.map(t=>Object.freeze({threadId:text(own(t,'threadId')),turnId:text(own(t,'turnId'))}));return Object.freeze({jobs:Object.freeze(checkedJobs),terminals:Object.freeze(checkedTerminals)});
  }finally{signal?.removeEventListener('abort',abort);}})();this.#tasks.set(task,controller);const clear=()=>{this.#tasks.delete(task);};void task.then(clear,clear);return task;
 }
 async close(reason:unknown=new Error('Typing inventory stopped')):Promise<void>{this.#closed=true;for(const c of this.#tasks.values())c.abort(reason);await Promise.allSettled([...this.#tasks.keys()]);}
}
Object.freeze(NativeTypingInventoryReader.prototype);
