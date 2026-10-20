import {types} from 'node:util';
import {gatewayOwnField as own} from '../discord/gateway/values.ts';
import {RemoteConnectionWorkers} from './connection-workers.ts';
import {RemoteWorkerCapacityError} from './bounded-workers.ts';
import {RemoteNativeCodecOwner,requireRemoteNativeCodecOwner} from './native-decode.ts';
import type {GatewayCommand} from './gateway-command.ts';
import type {BridgeResult} from './bridge-inbound.ts';

export interface RemoteCommandLoopPorts {
 readonly receive:(signal:AbortSignal)=>Promise<string|null>;
 readonly send:(wire:string,signal:AbortSignal)=>Promise<void>;
 readonly execute:(command:GatewayCommand,generation:bigint,cancelled:AbortSignal)=>Promise<BridgeResult>;
}
export class RemoteCommandLoopError extends Error {
 readonly kind:'DuplicateHello'|'Worker';
 constructor(kind:RemoteCommandLoopError['kind'],cause?:unknown){super(kind==='DuplicateHello'?'the gateway sent a duplicate hello':'local bridge worker failed',{cause});this.name='RemoteCommandLoopError';this.kind=kind;}
}
type ReadEvent={kind:'read';ok:true;raw:string|null}|{kind:'read';ok:false;error:unknown};
type ReadyEvent={kind:'ready';ok:true;ready:boolean}|{kind:'ready';ok:false;error:unknown};
function promise<T>(value:unknown):Promise<T>{if(!types.isPromise(value))throw new TypeError('Owned remote port must return a Promise');return value as Promise<T>;}
function port<T>(input:unknown,key:string):T{const value=own(input,key);if(typeof value!=='function'||types.isProxy(value)||types.isGeneratorFunction(value))throw new TypeError('Expected owned remote command port');return value as T;}

/** Post-hello command owner. Caller must have accepted a protocol10 hello ack
 * and owns connection/session authorization and later retire_sessions. This
 * function connects actual native codecs to bounded workers and borrowed I/O,
 * but creates no socket, binding, credential or concrete project dispatcher.
 * Shutdown is a one-way AbortSignal adapter, not full Tokio watch semantics. */
export async function runRemoteCommandLoop(generation:bigint,ports:RemoteCommandLoopPorts,shutdown:AbortSignal,maxBytes=12000000,codec=new RemoteNativeCodecOwner()):Promise<void>{
 requireRemoteNativeCodecOwner(codec);
 if(typeof generation!=='bigint'||generation<0n||generation>18446744073709551615n)throw new RangeError('Invalid connection generation');
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>12000000)throw new RangeError('Invalid remote frame byte budget');
 if(types.isProxy(shutdown)||!(shutdown instanceof AbortSignal))throw new TypeError('Expected owned shutdown signal');
 const receive=port<RemoteCommandLoopPorts['receive']>(ports,'receive'),send=port<RemoteCommandLoopPorts['send']>(ports,'send'),execute=port<RemoteCommandLoopPorts['execute']>(ports,'execute');
 if(shutdown.aborted)return;
 const io=new AbortController(),workers=new RemoteConnectionWorkers<BridgeResult>(generation);
 let resolveStop!:()=>void;
 const stopped=new Promise<{kind:'stop'}>(resolve=>{resolveStop=()=>resolve({kind:'stop'});});
 shutdown.addEventListener('abort',resolveStop,{once:true});
 let reading:Promise<ReadEvent>|null=null,ready:Promise<ReadyEvent>|null=null,failed=false,failure:unknown;
 const write=async(result:BridgeResult)=>{const wire=await codec.serializeBridgeMessageOffThread(result,maxBytes,io.signal);await promise<void>(send(wire,io.signal));};
 try{
  for(;;){
   if(shutdown.aborted)break;
   if(reading===null)reading=Promise.resolve().then(()=>promise<string|null>(receive(io.signal))).then(raw=>({kind:'read',ok:true,raw}) as ReadEvent,error=>({kind:'read',ok:false,error}) as ReadEvent);
   if(ready===null&&workers.snapshot().pending>0)ready=workers.waitReady().then(value=>({kind:'ready',ok:true,ready:value}) as ReadyEvent,error=>({kind:'ready',ok:false,error}) as ReadyEvent);
   const selected=await Promise.race(ready===null?[stopped,reading]:[stopped,reading,ready]);
   if(shutdown.aborted||selected.kind==='stop')break;
   if(selected.kind==='ready'){
    ready=null;if(!selected.ok)throw new RemoteCommandLoopError('Worker',selected.error);
    if(!selected.ready)continue;const result=workers.takeReady();if(result===null)throw new Error('Ready remote result was not retained');
    if(!result.ok)throw new RemoteCommandLoopError('Worker',result.error);await write(result.value);continue;
   }
   reading=null;if(!selected.ok)throw selected.error;if(selected.raw===null)break;
   if(typeof selected.raw!=='string')throw new TypeError('Expected owned raw gateway text');
   // Decode only the selected input, never in the background receive Promise.
   const message=await codec.decodeGatewayMessageOffThread(selected.raw,maxBytes,io.signal);
   if(message.type==='hello_ack')throw new RemoteCommandLoopError('DuplicateHello');
   if(message.type==='project_ack')continue;
   const bytes=Buffer.byteLength(selected.raw);
   try{
    workers.submit(async(original,cancelled)=>{
     try{return await promise<BridgeResult>(execute(message,original,cancelled));}
     catch(error){if(!(error instanceof RemoteWorkerCapacityError))throw error;return Object.freeze({type:'operation_error',request_id:message.request_id,error_code:'bridge_busy',message:'The local bridge is busy. Retry this request shortly.'});}
    },bytes);
   }catch(error){
    if(!(error instanceof RemoteWorkerCapacityError))throw error;
    await write(Object.freeze({type:'operation_error',request_id:message.request_id,error_code:'bridge_busy',message:'The local bridge is busy. Retry this request shortly.'}));
   }
  }
 }catch(error){failed=true;failure=error;}
 finally{
  shutdown.removeEventListener('abort',resolveStop);
  // Request worker cancellation before waiting on either receive or result I/O.
  const drained=failed?workers.close(failure):workers.close();io.abort(new Error('Remote command loop ended'));
  if(reading!==null)await reading;
  if(ready!==null)await ready;
  const outcome=await drained;await codec.join();
  if(!failed&&!outcome.ok){failed=true;failure=new RemoteCommandLoopError('Worker',outcome.error);}
 }
 if(failed)throw failure;
}
