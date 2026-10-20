import {randomUUID} from 'node:crypto';
import {types} from 'node:util';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../owned-worker-slot.ts';
import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {rustTrim} from '../../app-server/value.ts';
export type ArchiveWrite={kind:'Reserve';scope:readonly string[];own:string|null}|{kind:'Verified'|'ReleaseRejected';operation:string};
function text(value:unknown):asserts value is string{requireDiscordText(value);if(Buffer.byteLength(value)>16384)throw new RangeError('Archive write text exceeds budget');}
function capture(input:ArchiveWrite):ArchiveWrite{
 if(boundedSerdeByteCount(input,262144)===null)throw new RangeError('Archive write exceeds budget');const q=cloneOwnedSerdeValue(input) as ArchiveWrite;
 if(q.kind==='Reserve'){
  if(!Array.isArray(q.scope)||q.scope.length<1||q.scope.length>101)throw new RangeError('Invalid archive scope');for(const id of q.scope){text(id);if(id===''||rustTrim(id)!==id)throw new TypeError('Invalid archive target');}if(new Set(q.scope).size!==q.scope.length)throw new TypeError('Duplicate archive targets');if(q.own!==null)text(q.own);
 }else if(q.kind==='Verified'||q.kind==='ReleaseRejected')text(q.operation);else throw new TypeError('Unknown archive write');return q;
}
export class NativeArchiveWriteUnknownError extends Error{
 readonly operation:ArchiveWrite['kind'];readonly requestId:string;
 constructor(operation:ArchiveWrite['kind'],requestId:string,cause:unknown){super('Archive write has no confirmed acknowledgement after native exit; retain fences and do not automatically retry',{cause});this.name='NativeArchiveWriteUnknownError';this.operation=operation;this.requestId=requestId;}
}
/** One fixed database and existing global Control1 budget, zero waiting queue.
 * Admitted cancellation/timeout cannot prove rollback. Never terminate a SQLite
 * worker or release target leases before joined native exit. No automatic retry. */
export class NativeArchiveWriter{
 readonly #path:string;readonly #slot=new OwnedWorkerSlot('Control');
 constructor(path:string){requireDiscordText(path);if(path.includes('\0')||Buffer.byteLength(path)>32768)throw new TypeError('Invalid archive database path');this.#path=pinNativeRuntimePath(path);if(Buffer.byteLength(this.#path)>32768)throw new RangeError('Archive database path exceeds budget');Object.freeze(this);}
 assertPath(path:string):void{requireDiscordText(path);if(pinNativeRuntimePath(path)!==this.#path)throw new TypeError('Archive writer belongs to another database');}
 async execute(input:ArchiveWrite,signal?:AbortSignal,timeoutMs=6000):Promise<string|null>{
  if(signal!==undefined&&(types.isProxy(signal)||!(signal instanceof AbortSignal)))throw new TypeError('Expected AbortSignal');signal?.throwIfAborted();if(process.platform==='win32')throw new Error('Windows archive writer is unqualified');if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid archive write timeout');const operation=capture(input);if(this.#slot.busy)throw new OwnedWorkerBusyError();
  const id=randomUUID(),request={id,path:this.#path,operation};let admitted=false,raw:unknown;
  try{const task=this.#slot.run(new URL('./archive-write-native-worker.ts',import.meta.url),request,timeoutMs,signal);admitted=this.#slot.busy;try{raw=await task;}finally{await this.#slot.join();}}
  catch(error){if(admitted)throw new NativeArchiveWriteUnknownError(operation.kind,id,error);throw error;}
  try{
   signal?.throwIfAborted();if(boundedSerdeByteCount(raw,65536)===null||own(raw,'id')!==id||own(raw,'path')!==this.#path||own(raw,'kind')!==operation.kind||own(raw,'ok')!==true)throw new TypeError('Missing bound archive acknowledgement');
   const value=own(raw,'value');if(operation.kind==='Reserve'){if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value))throw new TypeError('Invalid archive reservation ID');return value;}if(value!==null)throw new TypeError('Invalid archive completion acknowledgement');return null;
  }catch(error){throw new NativeArchiveWriteUnknownError(operation.kind,id,error);}
 }
}
Object.freeze(NativeArchiveWriter.prototype);
