import {randomUUID} from 'node:crypto';
import {types} from 'node:util';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../owned-worker-slot.ts';
import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {InvalidActionRequestError,ActionIntegerRangeError} from './errors.ts';
export const RUNNER_INSPECTION_OUTPUT_BYTES=1024*1024;
const INPUT_BYTES=128*1024,ACK_BYTES=6*RUNNER_INSPECTION_OUTPUT_BYTES+INPUT_BYTES+1024;
function text(value:unknown):asserts value is string{requireDiscordText(value);if(Buffer.byteLength(value)>16384)throw new RangeError('Runner inspection identity exceeds native boundary');}
function actor(value:bigint):void{if(typeof value!=='bigint'||value<0n||value>=1n<<63n)throw new ActionIntegerRangeError();}
type Operation='Detail'|'Summary'|'TargetCounts'|'Global';
type Scope={channel:bigint|null;user:bigint|null;requestId:string|null;target:string|null;source:string|null;owned:string|null};
const EMPTY:Scope=Object.freeze({channel:null,user:null,requestId:null,target:null,source:null,owned:null});
export class NativeRunnerInspectionUnavailable extends Error{
 constructor(invalidQueue=false){super(invalidQueue?'Runner inspection unavailable: invalid durable queue state':'Runner inspection unavailable; no partial display, retry, or state change');this.name='NativeRunnerInspectionUnavailable';}
}
/** Display only. One pinned owner shares Background3 with a zero-entry queue.
 * Deadlines stop caller interest, not SQLite; every submitted read joins actual
 * native exit before returning. There is no synchronous fallback or retry. */
export class NativeRunnerInspectionReader{
 readonly #path:string;readonly #slot=new OwnedWorkerSlot('Background');
 constructor(path:string){requireDiscordText(path);if(path.includes('\0')||Buffer.byteLength(path)>32768)throw new TypeError('Invalid runner inspection path');this.#path=pinNativeRuntimePath(path);if(Buffer.byteLength(this.#path)>32768)throw new RangeError('Runner path exceeds native boundary');Object.freeze(this);}
 assertPath(path:string):void{requireDiscordText(path);if(pinNativeRuntimePath(path)!==this.#path)throw new TypeError('Runner inspection reader belongs to another database');}
 detail(channel:bigint,user:bigint,requestId:string,signal?:AbortSignal,timeoutMs=6000):Promise<string>{return this.#read('Detail',{...EMPTY,channel,user,requestId},signal,timeoutMs);}
 summary(channel:bigint,user:bigint,signal?:AbortSignal,timeoutMs=6000):Promise<string>{return this.#read('Summary',{...EMPTY,channel,user},signal,timeoutMs);}
 targetCounts(target:string,source:string,owned:string,signal?:AbortSignal,timeoutMs=6000):Promise<string>{return this.#read('TargetCounts',{...EMPTY,target,source,owned},signal,timeoutMs);}
 global(signal?:AbortSignal,timeoutMs=6000):Promise<string>{return this.#read('Global',EMPTY,signal,timeoutMs);}
 async #read(operation:Operation,scope:Scope,signal?:AbortSignal,timeoutMs=6000):Promise<string>{
  if(signal!==undefined&&(types.isProxy(signal)||!(signal instanceof AbortSignal)))throw new TypeError('Expected AbortSignal');signal?.throwIfAborted();
  if(operation==='Detail'||operation==='Summary'){actor(scope.channel!);actor(scope.user!);}for(const value of [scope.requestId,scope.target,scope.source,scope.owned])if(value!==null)text(value);
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid runner inspection timeout');if(process.platform==='win32')throw new Error('Windows runner inspection is not qualified');if(this.#slot.busy)throw new OwnedWorkerBusyError();
  const request={id:randomUUID(),path:this.#path,operation,...scope};if(boundedSerdeByteCount(request,INPUT_BYTES)===null)throw new RangeError('Runner inspection request exceeds native boundary');let raw:unknown,admitted=false;
  try{const task=this.#slot.run(new URL('./runner-inspection-native-worker.ts',import.meta.url),request,timeoutMs,signal);admitted=this.#slot.busy;try{raw=await task;}finally{await this.#slot.join();}}
  catch(error){if(signal?.aborted)throw signal.reason;if(!admitted)throw error;throw new NativeRunnerInspectionUnavailable();}signal?.throwIfAborted();
  if(boundedSerdeByteCount(raw,ACK_BYTES)===null)throw new NativeRunnerInspectionUnavailable();for(const [key,value] of Object.entries(request))if(own(raw,key)!==value)throw new NativeRunnerInspectionUnavailable();
  if(Object.keys(raw as object).length!==Object.keys(request).length+2)throw new NativeRunnerInspectionUnavailable();
  if(own(raw,'ok')!==true){if(own(raw,'ok')===false&&own(raw,'error')==='Missing'&&operation==='Detail')throw new InvalidActionRequestError('saved request is unavailable for this user and channel');throw new NativeRunnerInspectionUnavailable(own(raw,'error')==='InvalidQueueState');}
  const result=own(raw,'text');if(typeof result!=='string'||Buffer.byteLength(result)>RUNNER_INSPECTION_OUTPUT_BYTES)throw new NativeRunnerInspectionUnavailable();requireDiscordText(result);return result;
 }
}
Object.freeze(NativeRunnerInspectionReader.prototype);
