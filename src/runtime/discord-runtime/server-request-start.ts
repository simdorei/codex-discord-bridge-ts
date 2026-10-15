import {createNativePromptAuthorityReads} from '../server-prompt-authority-reads.ts';
import {types} from 'node:util';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {DiscordChannelClient} from '../../discord/channel-client.ts';
import {PortableResidentLifecycle} from '../../app-server/portable-resident-lifecycle.ts';
import type {BroadcastReceiver} from '../../app-server/broadcast.ts';
import type {ResidentServerRequestEvent} from '../../app-server/resident-forwarders.ts';
import {ServerRequestDelivery} from '../server-request-delivery.ts';
import {runServerRequestWorker,type ServerRequestWorkerReport} from '../server-request-worker.ts';
import {RuntimeMonitoredWorker,RuntimeWorkerExitChannel} from './monitored-worker.ts';
export interface RuntimeServerRequestStartup{readonly owner:PortableResidentLifecycle;readonly serverRequestReceiver:BroadcastReceiver<ResidentServerRequestEvent>;}
const requests=Object.getOwnPropertyDescriptor(DiscordChannelClient.prototype,'activeRequests')!.get!;
const send=DiscordChannelClient.prototype.sendValidated;
/** Transfers the startup subscription to the actual serial prompt worker and
 * binds the shared owned HTTP client. Factory announces callback entry before
 * returning its task handle: a caller can never abort an unentered worker and
 * strand this transferred receiver. Shared resident/HTTP owners are borrowed;
 * common-deadline runtime shutdown must join this worker before closing them.
 * No subscription replacement, default channel or service startup occurs here. */
export async function startServerRequestRuntimeWorker(startup:RuntimeServerRequestStartup,database:string,http:DiscordChannelClient,shutdown:AbortSignal,notifier:RuntimeWorkerExitChannel,report:(event:ServerRequestWorkerReport)=>void):Promise<RuntimeMonitoredWorker>{
 if(types.isProxy(shutdown)||!(shutdown instanceof AbortSignal))throw new TypeError('Expected server request shutdown signal');
 if(typeof report!=='function'||types.isProxy(report)||types.isAsyncFunction(report)||types.isGeneratorFunction(report))throw new TypeError('Expected synchronous server request diagnostic');
 const owner=own(startup,'owner') as PortableResidentLifecycle,receiver=own(startup,'serverRequestReceiver') as BroadcastReceiver<ResidentServerRequestEvent>;
 PortableResidentLifecycle.prototype.lifecycleSnapshot.call(owner);Reflect.apply(requests,http,[]);
 const delivery=new ServerRequestDelivery(database,owner,Object.freeze({sendValidated:(request:Parameters<typeof send>[0])=>Reflect.apply(send,http,[request]) as Promise<bigint>}),true,createNativePromptAuthorityReads(database));
 let announce!:()=>void;const entered=new Promise<void>(resolve=>announce=resolve);
 const worker=new RuntimeMonitoredWorker('server-request',notifier,async force=>{
  announce();try{await runServerRequestWorker(receiver,owner,delivery,AbortSignal.any([shutdown,force]),report);return {ok:true};}catch(error){if(force.aborted&&error===force.reason)throw error;return {ok:false,error};}
 });
 await entered;return worker;
}
