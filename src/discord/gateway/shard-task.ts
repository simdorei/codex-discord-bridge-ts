import {setImmediate as yieldToRuntime} from 'node:timers/promises';
import {invokeSynchronousVoid} from '../../core/synchronous-void.ts';
import {GatewayTypedActivation} from './activation.ts';
import {GatewayPublication} from './publication.ts';
import {GatewayIngressLane} from './lane.ts';
import {gatewayOwnField} from './values.ts';
import type {DecodedGatewayEvent} from './ingress.ts';
export type GatewayShardItem<I extends object>={readonly kind:'Event';readonly event:DecodedGatewayEvent<I>}|{readonly kind:'ReceiveError';readonly message:string};
/** Required owned adapter. nextEvent must respect abort and permit exactly one
 * pending read. Normal close requests protocol close/drain, not immediate disposal.
 * dispose cancels/joins all adapter-owned IO. This file does not supply WebSocket,
 * discovery, reconnect/identify or a complete Gateway/Interaction wire decoder. */
export interface GatewayShardPort<I extends object>{readonly shardId:number;nextEvent(signal:AbortSignal):Promise<GatewayShardItem<I>|null>;requestNormalClose():void;dispose():Promise<void>}
interface ReadResult<I extends object>{readonly kind:'Read';readonly item:GatewayShardItem<I>|null}
interface ReadFailure{readonly kind:'ReadFailure';readonly error:unknown}
/** Source run_shard contract with explicit Promise custody. Shutdown retains the
 * losing read, requests NORMAL once and drains until close/EOF. Force abort cancels
 * and joins the read and adapter, never claims a Promise.race loser was cancelled.
 * Caller owns this task and any hard deadline/process-abort policy. */
export async function runGatewayShard<I extends object,R extends object>(options:{port:GatewayShardPort<I>;activation:GatewayTypedActivation<R>;publication:GatewayPublication<I>;shutdown:AbortSignal;force?:AbortSignal;exits:GatewayIngressLane<number>;now?:()=>number}):Promise<void>{
 const port=options.port,shard=port.shardId;if(!Number.isInteger(shard)||shard<0||shard>4294967295)throw new TypeError('Expected u32 gateway shard');
 const cancel=new AbortController(),signal=options.force===undefined?cancel.signal:AbortSignal.any([cancel.signal,options.force]),now=options.now??(()=>performance.now());
 let pending:Promise<ReadResult<I>|ReadFailure>|undefined,failed=false,primary:unknown,cleanupFailure:unknown,cleanupFailed=false;
 let notifyStop!:()=>void;const stopping=new Promise<{kind:'Shutdown'}>(resolve=>{notifyStop=()=>resolve({kind:'Shutdown'});});options.shutdown.addEventListener('abort',notifyStop,{once:true});if(options.shutdown.aborted)notifyStop();
 let notifyForced!:()=>void;const forced=new Promise<{kind:'Forced'}>(resolve=>{notifyForced=()=>resolve({kind:'Forced'});});signal.addEventListener('abort',notifyForced,{once:true});if(signal.aborted)notifyForced();
 const read=():Promise<ReadResult<I>|ReadFailure>=>Promise.resolve().then(()=>{signal.throwIfAborted();return port.nextEvent(signal);}).then(item=>({kind:'Read' as const,item}),error=>({kind:'ReadFailure' as const,error}));
 try{
  await options.activation.runAfterActivation(async()=>{
   let closing=false,batch=0;
   const close=()=>{closing=true;invokeSynchronousVoid(port.requestNormalClose,port);};
   for(;;){
    signal.throwIfAborted();if(!closing&&options.shutdown.aborted)close();pending??=read();
    const selected=await Promise.race(closing?[pending,forced]:[pending,stopping,forced]);signal.throwIfAborted();if(selected.kind==='Forced')throw signal.reason;
    if(selected.kind==='Shutdown'){close();continue;}
    pending=undefined;if(selected.kind==='ReadFailure')throw selected.error;const item=selected.item;if(item===null)break;
    const kind=gatewayOwnField(item,'kind');
    if(kind==='ReceiveError')options.publication.publishReceiveError(shard,gatewayOwnField(item,'message') as string);
    else if(kind==='Event'){
     const event=gatewayOwnField(item,'event') as DecodedGatewayEvent<I>,terminal=gatewayOwnField(event,'kind')==='GatewayClose';
     options.publication.publish(event,now());if(terminal&&(closing||options.shutdown.aborted))break;
    }else throw new TypeError('Unknown gateway shard item');
    if(++batch===64){batch=0;await yieldToRuntime();}
   }
  },signal);
 }catch(error){failed=true;primary=error;}
 finally{
  options.shutdown.removeEventListener('abort',notifyStop);signal.removeEventListener('abort',notifyForced);cancel.abort(new Error('Gateway shard task finished'));
  // Start actual disposal before waiting for a pending read that may need socket
  // destruction to settle. Both still remain owned and joined.
  const cleanup=Promise.resolve().then(()=>port.dispose());const results=await Promise.allSettled([...(pending===undefined?[]:[pending]),cleanup]);const last=results[results.length-1]!;if(last.status==='rejected'){cleanupFailed=true;cleanupFailure=last.reason;}
  options.exits.trySend(shard); // Bounded best effort, including failed/stopped entry.
 }
 if(failed&&cleanupFailed)throw new AggregateError([primary,cleanupFailure],'Gateway shard and cleanup failed');if(failed)throw primary;if(cleanupFailed)throw cleanupFailure;
}
