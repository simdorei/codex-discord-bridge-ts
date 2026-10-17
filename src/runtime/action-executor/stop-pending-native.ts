import {randomUUID} from 'node:crypto';
import {types} from 'node:util';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../owned-worker-slot.ts';
import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {parseStopControlJson,type StopControl} from '../../store/stop-control-dispatch.ts';
const MIN=-(1n<<63n),MAX=(1n<<63n)-1n,LIMIT=4*1024*1024;
export class NativeStopPendingUnavailable extends Error{constructor(){super('Original pending Stop page is unavailable; retain cursor and authority');this.name='NativeStopPendingUnavailable';}}
/** Periodic bounded read uses existing Maintenance1/FIFO2, never reserved Control.
 * No claim, interrupt, or cursor mutation. */
export class NativeStopPendingReader{
 readonly #path:string;readonly #slot=new OwnedWorkerSlot('Maintenance');
 constructor(path:string){requireDiscordText(path);if(path.includes('\0')||Buffer.byteLength(path)>32768)throw new TypeError('Invalid Stop path');this.#path=pinNativeRuntimePath(path);if(Buffer.byteLength(this.#path)>32768)throw new RangeError('Stop path exceeds native boundary');Object.freeze(this);}
 assertPath(path:string):void{requireDiscordText(path);if(pinNativeRuntimePath(path)!==this.#path)throw new TypeError('Stop reader belongs to another database');}
 async pending(after:bigint,signal?:AbortSignal,timeoutMs=6000){return this.#read('Pending',after,signal,timeoutMs);}
 async recovery(after:bigint,signal?:AbortSignal,timeoutMs=6000){return this.#read('Recovery',after,signal,timeoutMs);}
 async #read(operation:'Pending'|'Recovery',after:bigint,signal?:AbortSignal,timeoutMs=6000):Promise<readonly (readonly [bigint,StopControl])[]>{
  if(signal!==undefined&&(types.isProxy(signal)||!(signal instanceof AbortSignal)))throw new TypeError('Expected AbortSignal');signal?.throwIfAborted();
  if(typeof after!=='bigint'||after<MIN||after>MAX)throw new RangeError('Expected i64 Stop cursor');if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid Stop timeout');if(this.#slot.busy)throw new OwnedWorkerBusyError();
  const id=randomUUID(),request={id,path:this.#path,operation,after};let raw:unknown,admitted=false;
  try{const task=this.#slot.runMaintenanceRead(new URL('./stop-pending-native-worker.ts',import.meta.url),request,timeoutMs,signal);admitted=this.#slot.busy;try{raw=await task;}finally{await this.#slot.join();}}
  catch(e){if(signal?.aborted)throw signal.reason;if(!admitted)throw e;throw new NativeStopPendingUnavailable();}signal?.throwIfAborted();
  try{
   if(boundedSerdeByteCount(raw,LIMIT)===null||own(raw,'id')!==id||own(raw,'path')!==this.#path||own(raw,'operation')!==operation||own(raw,'after')!==after||own(raw,'ok')!==true)throw new NativeStopPendingUnavailable();
   const rows=own(raw,'rows');if(!Array.isArray(rows)||rows.length>16)throw new NativeStopPendingUnavailable();let previous=after;
   return Object.freeze(rows.map(row=>{if(!Array.isArray(row)||row.length!==2)throw new NativeStopPendingUnavailable();const [sequence,json]=row;if(typeof sequence!=='bigint'||sequence<=previous||sequence>MAX||typeof json!=='string')throw new NativeStopPendingUnavailable();previous=sequence;return Object.freeze([sequence,parseStopControlJson(json)] as const);}));
  }catch{throw new NativeStopPendingUnavailable();}
 }
}
Object.freeze(NativeStopPendingReader.prototype);
