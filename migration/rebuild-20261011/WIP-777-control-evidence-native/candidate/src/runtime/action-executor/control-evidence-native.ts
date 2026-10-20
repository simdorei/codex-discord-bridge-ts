import {randomUUID} from 'node:crypto';
import {types} from 'node:util';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../owned-worker-slot.ts';
import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
function identity(value:unknown):asserts value is string{requireDiscordText(value);if(Buffer.byteLength(value)>16384)throw new RangeError('Control identity exceeds native boundary');}
export class NativeControlEvidenceUnavailable extends Error{constructor(){super('Original control completion evidence is unavailable; no control is authorized');this.name='NativeControlEvidenceUnavailable';}}
/** Standalone existing-store predicate, not a dispatch authority or runtime installation.
 * Uses reserved Control1 with no queue. Always joins native work before returning. */
export class NativeControlEvidenceReader{
 readonly #path:string;readonly #slot=new OwnedWorkerSlot('Control');
 constructor(path:string){requireDiscordText(path);if(path.includes('\0')||Buffer.byteLength(path)>32768)throw new TypeError('Invalid control evidence path');this.#path=pinNativeRuntimePath(path);if(Buffer.byteLength(this.#path)>32768)throw new RangeError('Control path exceeds native boundary');Object.freeze(this);}
 async observed(thread:string,turn:string,signal?:AbortSignal,timeoutMs=6000):Promise<boolean>{
  if(signal!==undefined&&(types.isProxy(signal)||!(signal instanceof AbortSignal)))throw new TypeError('Expected AbortSignal');signal?.throwIfAborted();
  if(process.platform==='win32')throw new Error('Windows control evidence reader is not qualified');identity(thread);identity(turn);if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid control evidence timeout');if(this.#slot.busy)throw new OwnedWorkerBusyError();
  const id=randomUUID(),request={id,path:this.#path,operation:'Observed',thread,turn};if(boundedSerdeByteCount(request,262144)===null)throw new RangeError('Control request exceeds boundary');let raw:unknown,admitted=false;
  try{const pending=this.#slot.run(new URL('./control-evidence-native-worker.ts',import.meta.url),request,timeoutMs,signal);admitted=this.#slot.busy;try{raw=await pending;}finally{await this.#slot.join();}}
  catch(error){if(signal?.aborted)throw signal.reason;if(!admitted)throw error;throw new NativeControlEvidenceUnavailable();}
  signal?.throwIfAborted();
  try{if(boundedSerdeByteCount(raw,262144)===null||own(raw,'id')!==id||own(raw,'path')!==this.#path||own(raw,'operation')!=='Observed'||own(raw,'thread')!==thread||own(raw,'turn')!==turn||own(raw,'ok')!==true||typeof own(raw,'value')!=='boolean')throw new NativeControlEvidenceUnavailable();return own(raw,'value') as boolean;}catch{throw new NativeControlEvidenceUnavailable();}
 }
}
Object.freeze(NativeControlEvidenceReader.prototype);
