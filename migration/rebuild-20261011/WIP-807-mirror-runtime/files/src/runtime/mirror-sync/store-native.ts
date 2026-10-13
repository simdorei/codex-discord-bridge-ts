import {randomUUID} from 'node:crypto';
import {types} from 'node:util';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../owned-worker-slot.ts';
import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {captureMirrorStoreRequest,captureMirrorStoreResult,type MirrorStoreRequest,type MirrorStoreResult} from './store-native-protocol.ts';
import {MirrorCleanupProtectedError} from '../cleanup-refusal.ts';
export class NativeMirrorStoreUnknownError extends Error {
 readonly requestId:string;readonly operation:MirrorStoreRequest['kind'];
 constructor(id:string,kind:MirrorStoreRequest['kind'],cause:unknown){super('Mirror store operation has no confirmed acknowledgement; retain custody and do not automatically retry',{cause});this.name='NativeMirrorStoreUnknownError';this.requestId=id;this.operation=kind;}
}
/** One initialized store path, existing shared Control budget, zero local queue.
 * Includes schema/open work off the event loop. Cancellation joins SQLite native
 * exit; no forced termination or automatic write retry. Full BridgeSync wiring
 * and Windows behavior remain outside this storage transport. */
export class NativeMirrorStore {
 readonly #path:string;readonly #slot=new OwnedWorkerSlot('Control');
 constructor(path:string){requireDiscordText(path);if(path.includes('\0')||Buffer.byteLength(path)>32768)throw new TypeError('Invalid mirror database path');this.#path=pinNativeRuntimePath(path);if(Buffer.byteLength(this.#path)>32768)throw new RangeError('Mirror database path exceeds budget');Object.freeze(this);}
 assertPath(path:string):void{if(pinNativeRuntimePath(path)!==this.#path)throw new TypeError('Mirror store belongs to another database');}
 async execute(input:MirrorStoreRequest,signal?:AbortSignal,timeoutMs=6000):Promise<MirrorStoreResult>{
  if(signal!==undefined&&(types.isProxy(signal)||!(signal instanceof AbortSignal)))throw new TypeError('Expected AbortSignal');signal?.throwIfAborted();if(process.platform==='win32')throw new Error('Windows native mirror store unqualified');if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid mirror store timeout');
  const operation=captureMirrorStoreRequest(input);if(this.#slot.busy)throw new OwnedWorkerBusyError();const id=randomUUID();let admitted=false,raw:unknown;
  try{const task=this.#slot.run(new URL('./store-native-worker.ts',import.meta.url),{id,path:this.#path,operation},timeoutMs,signal);admitted=this.#slot.busy;try{raw=await task;}finally{await this.#slot.join();}}catch(error){if(admitted)throw new NativeMirrorStoreUnknownError(id,operation.kind,error);throw error;}
  let protectedError:MirrorCleanupProtectedError|undefined;
  try{
   signal?.throwIfAborted();if(boundedSerdeByteCount(raw,2097152)===null||own(raw,'id')!==id||own(raw,'path')!==this.#path||own(raw,'kind')!==operation.kind)throw new TypeError('Missing bound mirror acknowledgement');
   if(own(raw,'ok')===true)return captureMirrorStoreResult(operation.kind,own(raw,'value'));
   const p=own(raw,'protected');if(operation.kind==='BeginCleanup'&&own(raw,'ok')===false&&own(p,'channel')===operation.args[0]&&operation.args[0]>0n){const reason=own(p,'reason');requireDiscordText(reason);protectedError=new MirrorCleanupProtectedError(operation.args[0],reason);}else throw new TypeError('Unconfirmed mirror operation');
  }catch(error){throw new NativeMirrorStoreUnknownError(id,operation.kind,error);}
  throw protectedError;
 }
}
Object.freeze(NativeMirrorStore.prototype);
