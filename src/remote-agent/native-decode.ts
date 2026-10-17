import {types} from 'node:util';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../runtime/owned-worker-slot.ts';
import {RemoteProtocolError} from './handshake.ts';
import type {ProjectOperation} from './project-request.ts';
import type {GatewayInboundMessage} from './gateway-inbound.ts';
import type {GatewayCommand} from './gateway-command.ts';
import type {BridgeInboundMessage} from './bridge-inbound.ts';
export interface DecodedRemoteOperation{readonly operation:ProjectOperation;readonly lifetimeSeconds:bigint;}
/** A trusted module's structured-cloned output is already privately owned. Bound
 * graph traversal and freeze it without JSON reparse/stringify or scanning its
 * large string contents on the main thread. Wire validation occurs in worker. */
function freezeResult(value:unknown,maxStringUnits:number):void{
 let nodes=0,units=0;const seen=new Set<object>();
 const visit=(item:unknown,depth:number):void=>{
  if(++nodes>4096||depth>16)throw new RangeError('Native remote result graph exceeds budget');
  if(typeof item==='string'){units+=item.length;if(units>maxStringUnits)throw new RangeError('Native remote result text exceeds budget');return;}
  if(item===null||typeof item==='boolean'||typeof item==='bigint')return;
  if(typeof item!=='object'||seen.has(item))throw new TypeError('Invalid native remote result value');
  seen.add(item);
  for(const key of Object.keys(item)){
   units+=key.length;if(units>maxStringUnits)throw new RangeError('Native remote result keys exceed budget');
   const d=Object.getOwnPropertyDescriptor(item,key)!;if(!Object.hasOwn(d,'value'))throw new TypeError('Unexpected native result accessor');visit(d.value,depth+1);
  }
  Object.freeze(item);
 };visit(value,0);
}
/** Validate passive immutable native DTO shape without walking large string
 * contents. Only decoded immutable trees enter structured clone; no caller
 * getters or toJSON hooks can execute. Graph/key enumeration overhead remains. */
export function requireImmutableRemoteDto(value:unknown,maxUnits:number):void{
 if(!Number.isSafeInteger(maxUnits)||maxUnits<1||maxUnits>12032768)throw new RangeError('Invalid immutable remote DTO budget');
 let nodes=0,units=0;const seen=new Set<object>();
 const visit=(item:unknown,depth:number):void=>{
  if(++nodes>4096||depth>16)throw new RangeError('Native remote input graph exceeds budget');
  if(typeof item==='string'){units+=item.length;if(units>maxUnits)throw new RangeError('Native remote input text exceeds budget');return;}
  if(item===null||typeof item==='boolean'||typeof item==='bigint')return;
  if(typeof item!=='object'||types.isProxy(item)||seen.has(item)||!Object.isFrozen(item))throw new TypeError('Expected immutable decoded bridge data');
  const proto=Object.getPrototypeOf(item);if(proto!==Object.prototype&&proto!==Array.prototype&&proto!==null)throw new TypeError('Opaque bridge DTO');
  if(Object.getOwnPropertySymbols(item).length!==0)throw new TypeError('Symbol bridge DTO field');
  seen.add(item);const names=Object.getOwnPropertyNames(item);
  if(Array.isArray(item)&&names.length!==item.length+1)throw new TypeError('Sparse or extended bridge DTO array');
  for(const key of names){
   if(Array.isArray(item)&&key==='length')continue;
   if(Array.isArray(item)&&(!Number.isSafeInteger(Number(key))||Number(key)<0||Number(key)>=item.length||String(Number(key))!==key))throw new TypeError('Extended bridge DTO array');
   units+=key.length;if(units>maxUnits)throw new RangeError('Native remote input keys exceed budget');
   const desc=Object.getOwnPropertyDescriptor(item,key)!;
   if(!Object.hasOwn(desc,'value')||!desc.enumerable)throw new TypeError('Active bridge DTO field');
   visit(desc.value,depth+1);
  }
 };visit(value,0);
}
/** One sequential codec domain with one native slot and no waiting queue.
 * Wire I/O and dispatcher cache/validation each own one instance. These two
 * domains may overlap but still share the unchanged global Background budget.
 * Reentry refuses; abort/timeout retains custody through actual native exit. */
const codecOwners=new WeakSet<object>();
export class RemoteNativeCodecOwner {
 readonly #slot=new OwnedWorkerSlot();
 constructor(){codecOwners.add(this);Object.freeze(this);}
 get busy():boolean{return this.#slot.busy;}
 join():Promise<void>{return this.#slot.join();}
/** One decode operation, no waiting queue, sharing the global Background budget.
 * Timeout/abort waits for actual worker exit before returning; there is no forced
 * termination, automatic retry, session authority, or operation execution. */
async #decodeOwned(raw:string,maxBytes:number,mode:'operation'|'gateway'|'bridge',signal:AbortSignal|undefined,timeoutMs:number):Promise<Record<string,unknown>>{
 signal?.throwIfAborted();
 if(typeof raw!=='string')throw new TypeError('Expected remote JSON text');
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>12000000)throw new RangeError('Invalid remote frame byte budget');
 if(raw.length>maxBytes||Buffer.byteLength(raw)>maxBytes)throw new RangeError('Remote protocol frame exceeds byte budget');
 return this.#runOwned({raw,maxBytes,mode},maxBytes,signal,timeoutMs);
}
async #runOwned(data:unknown,maxBytes:number,signal:AbortSignal|undefined,timeoutMs:number):Promise<Record<string,unknown>>{
 signal?.throwIfAborted();
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid remote decode timeout');
 if(this.#slot.busy)throw new OwnedWorkerBusyError();
 const pending=this.#slot.run(new URL('./decode-worker.ts',import.meta.url),data,timeoutMs,signal),joined=this.#slot.join();let result:unknown;
 try{result=await pending;}finally{await joined;}signal?.throwIfAborted();
 freezeResult(result,maxBytes+32768);
 if(result===null||typeof result!=='object'||!Object.hasOwn(result,'ok'))throw new TypeError('Invalid native remote decode envelope');
 const v=result as Record<string,unknown>;
 if(v.ok===false){
  if(typeof v.detail!=='string'||typeof v.kind!=='string')throw new TypeError('Invalid native remote error');
  if(v.kind==='UnsupportedVersion'){if(typeof v.received!=='bigint'||v.received<0n||v.received>18446744073709551615n)throw new TypeError('Invalid native unsupported version');throw new RemoteProtocolError('UnsupportedVersion','',v.received);}
  if(v.kind==='Json'||v.kind==='Validation'){const error=new RemoteProtocolError(v.kind,'');error.message=v.detail;throw error;}
  if(v.kind==='Range')throw new RangeError(v.detail);if(v.kind==='Type')throw new TypeError(v.detail);throw new Error(v.detail);
 }
 if(v.ok!==true)throw new TypeError('Invalid native remote decode status');
 return v;
}
async decodeProjectOperationOffThread(raw:string,maxBytes:number,signal?:AbortSignal,timeoutMs=6000):Promise<DecodedRemoteOperation>{
 const v=await this.#decodeOwned(raw,maxBytes,'operation',signal,timeoutMs);
 if(typeof v.lifetimeSeconds!=='bigint'||v.lifetimeSeconds<1n||v.lifetimeSeconds>3615n||v.operation===null||typeof v.operation!=='object')throw new TypeError('Invalid native remote operation');
 return Object.freeze({operation:v.operation as ProjectOperation,lifetimeSeconds:v.lifetimeSeconds});
}

/** Full gateway inbound envelope (two acknowledgements and seven commands),
 * decoded by this owner in the bounded Background native class. Session and
 * deadline data are not authorization or permission to execute an operation. */
async decodeGatewayMessageOffThread(raw:string,maxBytes:number,signal?:AbortSignal,timeoutMs=6000):Promise<GatewayInboundMessage>{
 const v=await this.#decodeOwned(raw,maxBytes,'gateway',signal,timeoutMs),message=v.message;
 if(message===null||typeof message!=='object'||!Object.hasOwn(message,'type'))throw new TypeError('Invalid native gateway message');
 const type=(message as Record<string,unknown>).type;
 if(typeof type!=='string'||!['hello_ack','project_ack','project_info','list_files','read_file','write_file','project_operation','project_session','device_session'].includes(type))throw new TypeError('Invalid native gateway message type');
 return message as GatewayInboundMessage;
}

/** Bridge hello, project upsert and all seven result envelopes use the same
 * native owner. Full output contracts run there, but neither provenance nor
 * authorization of returned data follows from a structurally valid envelope. */
async decodeBridgeMessageOffThread(raw:string,maxBytes:number,signal?:AbortSignal,timeoutMs=6000):Promise<BridgeInboundMessage>{
 const v=await this.#decodeOwned(raw,maxBytes,'bridge',signal,timeoutMs),message=v.message;
 if(message===null||typeof message!=='object'||!Object.hasOwn(message,'type'))throw new TypeError('Invalid native bridge message');
 const type=(message as Record<string,unknown>).type;
 if(typeof type!=='string'||!['hello','project_upsert','project_info_result','list_files_result','read_file_result','write_file_result','project_operation_result','project_session_result','operation_error'].includes(type))throw new TypeError('Invalid native bridge message type');
 return message as BridgeInboundMessage;
}

/** Heavy serialization, date formatting, byte counting and full wire validation
 * run in this owner's native slot. This returns wire text but never sends it. */
async serializeBridgeMessageOffThread(value:BridgeInboundMessage,maxBytes:number,signal?:AbortSignal,timeoutMs=6000):Promise<string>{
 signal?.throwIfAborted();
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>12000000)throw new RangeError('Invalid bridge output byte budget');
 requireImmutableRemoteDto(value,maxBytes+32768);
 const result=await this.#runOwned({mode:'serialize_bridge',value,maxBytes},maxBytes,signal,timeoutMs);
 if(typeof result.wire!=='string'||result.wire.length>maxBytes)throw new TypeError('Invalid native bridge wire output');
 return result.wire;
}

/** Heavy canonicalization and hashing of decoded command contents share the
 * owner and actual-exit accounting with its other codec operations. No result cache or
 * executable mutation is created by computing this identity. */
async fingerprintGatewayCommandOffThread(value:GatewayCommand,maxBytes:number,signal?:AbortSignal,timeoutMs=6000):Promise<string>{
 signal?.throwIfAborted();
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>12000000)throw new RangeError('Invalid command fingerprint budget');
 requireImmutableRemoteDto(value,maxBytes+32768);
 const result=await this.#runOwned({mode:'fingerprint_command',value,maxBytes},maxBytes,signal,timeoutMs);
 if(typeof result.fingerprint!=='string'||!/[a-f0-9]{64}/u.test(result.fingerprint)||result.fingerprint.length!==64)throw new TypeError('Invalid native command fingerprint');
 return result.fingerprint;
}
}

Object.freeze(RemoteNativeCodecOwner.prototype);
/** Reject copied, proxied or overridden codec capabilities before calling them. */
export function requireRemoteNativeCodecOwner(value:unknown):asserts value is RemoteNativeCodecOwner{
 if(value===null||typeof value!=='object'||types.isProxy(value)||!codecOwners.has(value)||Object.getPrototypeOf(value)!==RemoteNativeCodecOwner.prototype)throw new TypeError('Expected owned remote native codec');
}

/** Compatibility helpers retain one default owner. Live connection/dispatcher
 * owners use explicit instances, never this module-global compatibility slot. */
const compatibilityOwner=new RemoteNativeCodecOwner();
export function decodeProjectOperationOffThread(raw:string,maxBytes:number,signal?:AbortSignal,timeoutMs=6000):Promise<DecodedRemoteOperation>{return compatibilityOwner.decodeProjectOperationOffThread(raw,maxBytes,signal,timeoutMs);}
export function decodeGatewayMessageOffThread(raw:string,maxBytes:number,signal?:AbortSignal,timeoutMs=6000):Promise<GatewayInboundMessage>{return compatibilityOwner.decodeGatewayMessageOffThread(raw,maxBytes,signal,timeoutMs);}
export function decodeBridgeMessageOffThread(raw:string,maxBytes:number,signal?:AbortSignal,timeoutMs=6000):Promise<BridgeInboundMessage>{return compatibilityOwner.decodeBridgeMessageOffThread(raw,maxBytes,signal,timeoutMs);}
export function serializeBridgeMessageOffThread(value:BridgeInboundMessage,maxBytes:number,signal?:AbortSignal,timeoutMs=6000):Promise<string>{return compatibilityOwner.serializeBridgeMessageOffThread(value,maxBytes,signal,timeoutMs);}
export function fingerprintGatewayCommandOffThread(value:GatewayCommand,maxBytes:number,signal?:AbortSignal,timeoutMs=6000):Promise<string>{return compatibilityOwner.fingerprintGatewayCommandOffThread(value,maxBytes,signal,timeoutMs);}
