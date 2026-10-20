import {types} from 'node:util';
import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../owned-worker-slot.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {snapshotStoredQueueJob,type StoredQueueJob} from '../../store/queue-read.ts';
export class NativeCompletionOwnerUnavailable extends Error{constructor(){super('Completion original owner read unavailable');this.name='NativeCompletionOwnerUnavailable';}}
/** Existing-only snapshots under caller-owned target leases. Four already-owned
 * state operations maximum; native Background3 remains a separate global limit.
 * No retries or waiting worker queue. Read failure never becomes a Missing owner. */
export class NativeCompletionOwnerReader{
 readonly #path:string;readonly #timeout:number;readonly #tasks=new Map<Promise<StoredQueueJob|null>,AbortController>();#closed=false;
 constructor(path:string,timeoutMs=5000){requireDiscordText(path);if(path.includes('\0')||Buffer.byteLength(path)>32768)throw new TypeError('Invalid completion path');this.#path=pinNativeRuntimePath(path);if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid completion owner deadline');this.#timeout=timeoutMs;}
 get active():number{return this.#tasks.size;}
 read(target:string,turn:string,signal?:AbortSignal):Promise<StoredQueueJob|null>{return this.#readSnapshot(target,turn,'Admission',signal);}
 /** Finalization preserves the original whole-queue decode before exact find. */
 readForFinalization(target:string,turn:string,signal?:AbortSignal):Promise<StoredQueueJob|null>{return this.#readSnapshot(target,turn,'Finalization',signal);}
 readUniqueRunning(target:string,signal?:AbortSignal):Promise<StoredQueueJob|null>{return this.#readSnapshot(target,null,'History',signal);}
 readFirstWaiting(target:string,signal?:AbortSignal):Promise<StoredQueueJob|null>{return this.#readSnapshot(target,null,'Waiting',signal);}
 #readSnapshot(target:string,turn:string|null,scope:'Admission'|'Finalization'|'History'|'Waiting',signal?:AbortSignal):Promise<StoredQueueJob|null>{
  for(const v of turn===null?[target]:[target,turn]){requireDiscordText(v);if(Buffer.byteLength(v)>32768)throw new RangeError('Completion owner identity exceeds boundary');}
  if(signal!==undefined&&(types.isProxy(signal)||!(signal instanceof AbortSignal)))throw new TypeError('Expected AbortSignal');signal?.throwIfAborted();
  if(this.#closed)throw new NativeCompletionOwnerUnavailable();if(this.#tasks.size>=4)throw new OwnedWorkerBusyError();
  const slot=new OwnedWorkerSlot('Background'),controller=new AbortController(),abort=()=>controller.abort(signal!.reason);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const task=(async()=>{try{
   const pending=slot.run(new URL('./native-owner-read-worker.ts',import.meta.url),{path:this.#path,target,turn,scope},this.#timeout,controller.signal);let raw:unknown;try{raw=await pending;}finally{await slot.join();}controller.signal.throwIfAborted();
   if(boundedSerdeByteCount(raw,4*1024*1024)===null||own(raw,'ok')!==true)throw new NativeCompletionOwnerUnavailable();
   const owner=own(raw,'owner');if(owner===null)return null;const job=snapshotStoredQueueJob(owner as StoredQueueJob);
   if(job.targetThreadId!==target||((scope==='Admission'||scope==='Finalization')&&job.turnId!==turn)||(scope==='Waiting'&&!job.goalWaiting)||job.state!=='Running')throw new NativeCompletionOwnerUnavailable();Object.freeze(job.baselineTurnIds);return Object.freeze(job);
  }finally{signal?.removeEventListener('abort',abort);}})();this.#tasks.set(task,controller);const clear=()=>{this.#tasks.delete(task);};void task.then(clear,clear);return task;
 }
 async close(reason:unknown=new Error('Completion owner reader stopped')):Promise<void>{this.#closed=true;for(const c of this.#tasks.values())c.abort(reason);await Promise.allSettled([...this.#tasks.keys()]);}
}
Object.freeze(NativeCompletionOwnerReader.prototype);
