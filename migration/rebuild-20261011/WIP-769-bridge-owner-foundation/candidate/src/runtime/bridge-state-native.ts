import {randomUUID} from 'node:crypto';
import {cloneOwnedSerdeValue} from '../core/owned-serde-value.ts';
import {boundedSerdeByteCount} from '../core/serde-byte-count.ts';
import {gatewayOwnField as own} from '../discord/gateway/values.ts';
import {requireDiscordText} from '../discord/text.ts';
import {pinNativeRuntimePath} from './runtime-paths/path-text.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from './owned-worker-slot.ts';
import type {SavedThreadSettings} from './bridge-state.ts';
export type BridgeOperation={kind:'Selected'}|{kind:'Tracked'}|{kind:'Settings';id:string}|{kind:'Select';id:string|null}|{kind:'Remember';id:string;model:string|null;reasoning:string|null;speed:string|null}|{kind:'Fork';source:string;target:string}|{kind:'ClearScope';scope:readonly string[]};
function text(v:unknown):asserts v is string{requireDiscordText(v);if(Buffer.byteLength(v)>16384)throw new RangeError('Bridge operation text exceeds budget');}
function capture(input:BridgeOperation):BridgeOperation{
 if(boundedSerdeByteCount(input,262144)===null)throw new RangeError('Bridge operation exceeds input budget');const q=cloneOwnedSerdeValue(input) as BridgeOperation;
 switch(q.kind){case 'Selected':case 'Tracked':break;case 'Settings':text(q.id);break;case 'Select':if(q.id!==null)text(q.id);break;case 'Remember':text(q.id);for(const v of [q.model,q.reasoning,q.speed])if(v!==null)text(v);break;case 'Fork':text(q.source);text(q.target);break;case 'ClearScope':if(!Array.isArray(q.scope)||q.scope.length>101)throw new RangeError('Invalid Bridge clear scope');for(const id of q.scope)text(id);if(new Set(q.scope).size!==q.scope.length)throw new TypeError('Duplicate Bridge scope');break;default:throw new TypeError('Unknown Bridge operation');}return q;
}
export class NativeBridgeStateUnavailableError extends Error{
 readonly operation:BridgeOperation['kind'];readonly outcome:'Unknown'|'ReadUnavailable';
 constructor(operation:BridgeOperation['kind'],cause:unknown){super('Bridge operation has no confirmed result after native join; do not retry a possible write',{cause});this.name='NativeBridgeStateUnavailableError';this.operation=operation;this.outcome=['Select','Remember','Fork','ClearScope'].includes(operation)?'Unknown':'ReadUnavailable';}
}
/** Standalone foundation only. Production must inject one owner into every Bridge
 * user before enabling native writes; mixed synchronous writers are unsafe.
 * Existing global Control lane serializes accepted operations even across owners.
 * Zero waiting queue; no new worker pool. Timeout/abort always joins native exit. */
export class NativeBridgeStateOwner{
 readonly #path:string;readonly #slot=new OwnedWorkerSlot('Control');
 constructor(path:string){requireDiscordText(path);if(path.includes('\0')||Buffer.byteLength(path)>32768)throw new TypeError('Invalid Bridge path');this.#path=pinNativeRuntimePath(path);if(Buffer.byteLength(this.#path)>32768)throw new RangeError('Bridge path exceeds budget');Object.freeze(this);}
 async execute(input:BridgeOperation,signal?:AbortSignal,timeoutMs=6000):Promise<string|null|readonly string[]|SavedThreadSettings|boolean|undefined>{
  signal?.throwIfAborted();if(process.platform==='win32')throw new Error('Windows Bridge owner is not yet qualified');if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid Bridge owner timeout');const operation=capture(input);if(this.#slot.busy)throw new OwnedWorkerBusyError();
  const id=randomUUID(),request={id,path:this.#path,operation};let admitted=false,raw:unknown;
  try{const pending=this.#slot.run(new URL('./bridge-state-native-worker.ts',import.meta.url),request,timeoutMs,signal);admitted=this.#slot.busy;try{raw=await pending;}finally{await this.#slot.join();}}
  catch(error){if(admitted)throw new NativeBridgeStateUnavailableError(operation.kind,error);throw error;}
  try{
   if(boundedSerdeByteCount(raw,1048576)===null)throw new RangeError('Bridge response exceeds budget');const reply=cloneOwnedSerdeValue(raw);
   if(own(reply,'id')!==id||own(reply,'path')!==this.#path||own(reply,'kind')!==operation.kind||own(reply,'ok')!==true)throw new TypeError('No complete bound Bridge acknowledgement');const value=own(reply,'value');
   switch(operation.kind){case 'Selected':if(value!==null)text(value);return value as string|null;
    case 'Tracked':if(!Array.isArray(value)||value.length>4096)throw new TypeError('Invalid tracked Bridge IDs');for(const id of value)text(id);if(new Set(value).size!==value.length)throw new TypeError('Duplicate tracked Bridge IDs');return value as string[];
    case 'Settings':for(const k of ['model','reasoning','speed']){const v=own(value,k);if(v!==null)text(v);}return value as SavedThreadSettings;
    case 'ClearScope':if(typeof value!=='boolean')throw new TypeError('Invalid Bridge clear result');return value;
    default:if(value!==null)throw new TypeError('Invalid Bridge write receipt');return undefined;
   }
  }catch(error){throw new NativeBridgeStateUnavailableError(operation.kind,error);}
 }
}
Object.freeze(NativeBridgeStateOwner.prototype);
