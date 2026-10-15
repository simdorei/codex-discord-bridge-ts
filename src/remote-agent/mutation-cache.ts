import {types} from 'node:util';
import {gatewayOwnField as own} from '../discord/gateway/values.ts';
import {requireDiscordText} from '../discord/text.ts';
import {remoteCommandMeta,remoteRequestConflict} from './dispatch-contract.ts';
import {RemoteNativeCodecOwner,requireRemoteNativeCodecOwner,requireImmutableRemoteDto,fingerprintGatewayCommandOffThread,serializeBridgeMessageOffThread,decodeBridgeMessageOffThread} from './native-decode.ts';
import type {GatewayCommand} from './gateway-command.ts';
import type {BridgeResult} from './bridge-inbound.ts';

export class RemoteMutationCacheBusyError extends Error {
 constructor(){super('Remote mutation cache operation is already owned');this.name='RemoteMutationCacheBusyError';}
}
export type RemoteCacheRemember = 'Retained'|'SkippedError'|'NotRetainedBudget';
type Entry=Readonly<{fingerprint:string;wire:string;charge:number}>;
const RESULT_TYPES=new Set(['project_info_result','list_files_result','read_file_result','write_file_result','project_operation_result','project_session_result','operation_error']);
function immutable(value:unknown):void{
 if(value===null||typeof value!=='object'||types.isProxy(value)||!Object.isFrozen(value))throw new TypeError('Expected immutable decoded remote DTO');
}
function resultType(value:BridgeResult):string{
 immutable(value);const type=own(value,'type');if(typeof type!=='string'||!RESULT_TYPES.has(type))throw new TypeError('Expected bridge result');return type;
}
function key(command:GatewayCommand):Readonly<{key:string;requestId:string}>{
 immutable(command);const meta=remoteCommandMeta(command);
 for(const value of [meta.thread_id,meta.request_id,...(meta.computer_session_id===null?[]:[meta.computer_session_id])]){
  if(typeof value!=='string'||value.length>4096)throw new RangeError('Remote cache identity exceeds key budget');requireDiscordText(value);
 }
 return Object.freeze({key:JSON.stringify([meta.thread_id,meta.computer_session_id,meta.request_id]),requestId:meta.request_id});
}
/** Volatile replay optimization for an already authorized project owner. It is
 * NOT durable execution evidence or an execution permit. The dispatcher must
 * serialize the whole lookup/execute/remember span separately. Evicted/missing
 * or over-budget results never authorize an automatic mutation retry.
 *
 * Matching hits refresh LRU; conflicts do not. Operation errors are not stored.
 * Native canonicalization/serialization/decoding share actual-exit accounting.
 * The text budget charges 3 bytes per UTF-16 unit plus 128 bytes per entry, an
 * upper bound for retained UTF-8/UTF-16 text, not a JavaScript heap/RSS limit.
 * Count/key/frame limits are explicit bounded TS profiles. */
const compatibilityCodecs=Object.freeze({fingerprintGatewayCommandOffThread,serializeBridgeMessageOffThread,decodeBridgeMessageOffThread});
export class RemoteMutationCache {
 readonly #codec:Pick<RemoteNativeCodecOwner,keyof typeof compatibilityCodecs>;
 #entries=new Map<string,Entry>();#retained=0;#busy=false;
 readonly #maxBytes:number;readonly #maxEntries:number;readonly #frameBytes:number;
 constructor(maxRetainedBytes=4_194_304,maxEntries=256,maxFrameBytes=1_048_576,codec?:RemoteNativeCodecOwner){
  if(codec!==undefined)requireRemoteNativeCodecOwner(codec);this.#codec=codec??compatibilityCodecs;
  if(!Number.isSafeInteger(maxRetainedBytes)||maxRetainedBytes<1||maxRetainedBytes>67_108_864)throw new RangeError('Invalid remote cache byte limit');
  if(!Number.isSafeInteger(maxEntries)||maxEntries<1||maxEntries>256)throw new RangeError('Invalid remote cache entry limit');
  if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||maxFrameBytes>12_000_000)throw new RangeError('Invalid remote cache frame limit');
  this.#maxBytes=maxRetainedBytes;this.#maxEntries=maxEntries;this.#frameBytes=maxFrameBytes;
 }
 get size():number{return this.#entries.size;}
 get retainedTextCharge():number{return this.#retained;}
 get busy():boolean{return this.#busy;}
 #enter():void{if(this.#busy)throw new RemoteMutationCacheBusyError();this.#busy=true;}
 clear():void{if(this.#busy)throw new RemoteMutationCacheBusyError();this.#entries.clear();this.#retained=0;}
 async lookup(command:GatewayCommand,signal?:AbortSignal):Promise<BridgeResult|null>{
  signal?.throwIfAborted();this.#enter();
  try{
   requireImmutableRemoteDto(command,this.#frameBytes+32768);const identity=key(command),entry=this.#entries.get(identity.key);if(entry===undefined)return null;
   const fingerprint=await this.#codec.fingerprintGatewayCommandOffThread(command,this.#frameBytes,signal);
   if(fingerprint!==entry.fingerprint)return remoteRequestConflict(identity.requestId);
   const decoded=await this.#codec.decodeBridgeMessageOffThread(entry.wire,this.#frameBytes,signal);
   if(decoded.type==='hello'||decoded.type==='project_upsert'||decoded.request_id!==identity.requestId)throw new TypeError('Invalid retained remote result');
   // No recency mutation until validation and actual native completion succeed.
   this.#entries.delete(identity.key);this.#entries.set(identity.key,entry);return decoded;
  }finally{this.#busy=false;}
 }
 async remember(command:GatewayCommand,result:BridgeResult,signal?:AbortSignal):Promise<RemoteCacheRemember>{
  signal?.throwIfAborted();this.#enter();
  try{
   requireImmutableRemoteDto(result,this.#frameBytes+32768);
   if(resultType(result)==='operation_error')return 'SkippedError';
   requireImmutableRemoteDto(command,this.#frameBytes+32768);
   const identity=key(command);if(own(result,'request_id')!==identity.requestId)throw new TypeError('Remote cache result request differs');
   const fingerprint=await this.#codec.fingerprintGatewayCommandOffThread(command,this.#frameBytes,signal);
   const wire=await this.#codec.serializeBridgeMessageOffThread(result,this.#frameBytes,signal);
   const charge=3*(identity.key.length+wire.length+fingerprint.length)+128;
   if(charge>this.#maxBytes)return 'NotRetainedBudget';
   const previous=this.#entries.get(identity.key);if(previous!==undefined){this.#retained-=previous.charge;this.#entries.delete(identity.key);}
   this.#entries.set(identity.key,Object.freeze({fingerprint,wire,charge}));this.#retained+=charge;
   while(this.#entries.size>this.#maxEntries||this.#retained>this.#maxBytes){
    const first=this.#entries.entries().next().value!;this.#entries.delete(first[0]);this.#retained-=first[1].charge;
   }
   return 'Retained';
  }finally{this.#busy=false;}
 }
}
