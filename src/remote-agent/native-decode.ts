import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../runtime/owned-worker-slot.ts';
import {RemoteProtocolError} from './handshake.ts';
import type {ProjectOperation} from './project-request.ts';
const slot=new OwnedWorkerSlot();
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
/** One decode owner, no waiting queue, sharing the global Background budget.
 * Timeout/abort waits for actual worker exit before returning; there is no forced
 * termination, automatic retry, session authority, or operation execution. */
export async function decodeProjectOperationOffThread(raw:string,maxBytes:number,signal?:AbortSignal,timeoutMs=6000):Promise<DecodedRemoteOperation>{
 signal?.throwIfAborted();
 if(typeof raw!=='string')throw new TypeError('Expected remote JSON text');
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>12000000)throw new RangeError('Invalid remote frame byte budget');
 if(raw.length>maxBytes||Buffer.byteLength(raw)>maxBytes)throw new RangeError('Remote protocol frame exceeds byte budget');
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid remote decode timeout');
 if(slot.busy)throw new OwnedWorkerBusyError();
 const pending=slot.run(new URL('./decode-worker.ts',import.meta.url),{raw,maxBytes},timeoutMs,signal),joined=slot.join();let result:unknown;
 try{result=await pending;}finally{await joined;}signal?.throwIfAborted();
 freezeResult(result,maxBytes+32768);
 if(result===null||typeof result!=='object'||!Object.hasOwn(result,'ok'))throw new TypeError('Invalid native remote decode envelope');
 const v=result as Record<string,unknown>;
 if(v.ok===false){
  if(typeof v.detail!=='string'||typeof v.kind!=='string')throw new TypeError('Invalid native remote error');
  if(v.kind==='Json'||v.kind==='Validation'){const error=new RemoteProtocolError(v.kind,'');error.message=v.detail;throw error;}
  if(v.kind==='Range')throw new RangeError(v.detail);if(v.kind==='Type')throw new TypeError(v.detail);throw new Error(v.detail);
 }
 if(v.ok!==true||typeof v.lifetimeSeconds!=='bigint'||v.lifetimeSeconds<1n||v.lifetimeSeconds>3615n||v.operation===null||typeof v.operation!=='object')throw new TypeError('Invalid native remote operation');
 return Object.freeze({operation:v.operation as ProjectOperation,lifetimeSeconds:v.lifetimeSeconds});
}
