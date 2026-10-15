import {createNativeInteractionJournal} from '../interaction-worker/journal.ts';
import {types} from 'node:util';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {AdmissionGate} from '../../admission/drain-gate.ts';
import {DiscordChannelClient} from '../../discord/channel-client.ts';
import {InteractionAccessPolicy} from '../../discord/interaction-access.ts';
import {PortableResidentLifecycle} from '../../app-server/portable-resident-lifecycle.ts';
import {QueueStartCoordinator} from '../queue-runner/start-coordinator.ts';
import {RuntimeCommandExecutor} from '../action-executor/command-executor.ts';
import {AutocompleteCatalog} from '../discord-dispatch/autocomplete.ts';
import {isInteractionWorkQueue,type InteractionWorkQueue} from '../discord-dispatch/interaction-work.ts';
import type {InteractionDispatchReport} from '../discord-dispatch/ordinary-dispatcher.ts';
import {createOrdinaryInteractionHandler} from './ordinary-interaction-handler.ts';
import type {RuntimeMessageStartup} from './message-bootstrap.ts';
/** One shared Normal/Reserved ingress handler for the same prepared executor,
 * policy, gate and interaction receiver. Autocomplete is an explicit previously
 * loaded model/list snapshot; no silent empty fallback or extra RPC here. Keeps
 * existing fresh policy, original custody, ACK deadline and queue reservation order.
 * Policy/store offload and complete gateway startup remain separate work. */
export function createPreparedInteractionIngress(input:RuntimeMessageStartup,gate:AdmissionGate,work:InteractionWorkQueue,http:DiscordChannelClient,autocomplete:AutocompleteCatalog,qaEnabled:boolean,report:(value:InteractionDispatchReport)=>void){
 if(!isInteractionWorkQueue(work)||typeof qaEnabled!=='boolean'||types.isProxy(autocomplete)||!(autocomplete instanceof AutocompleteCatalog))throw new TypeError('Invalid interaction ingress owners');
 if(typeof report!=='function'||types.isProxy(report)||types.isAsyncFunction(report)||types.isGeneratorFunction(report))throw new TypeError('Expected synchronous interaction ingress report');
 const owner=own(input,'owner') as PortableResidentLifecycle,queue=own(input,'queue') as QueueStartCoordinator,executor=own(input,'executor') as RuntimeCommandExecutor,policy=own(input,'policy') as InteractionAccessPolicy;
 RuntimeCommandExecutor.prototype.requireRuntimeQueue.call(executor,queue);RuntimeCommandExecutor.prototype.requireRuntimeResident.call(executor,owner);QueueStartCoordinator.prototype.requireAdmissionGate.call(queue,gate);PortableResidentLifecycle.prototype.lifecycleSnapshot.call(owner);InteractionAccessPolicy.prototype.withMirroredChannelIds.call(policy,[]);Object.getOwnPropertyDescriptor(DiscordChannelClient.prototype,'activeRequests')!.get!.call(http);
 const database=Object.getOwnPropertyDescriptor(QueueStartCoordinator.prototype,'dbPath')!.get!.call(queue) as string,binding=RuntimeCommandExecutor.prototype.messageRuntimeBinding.call(executor);
 return createOrdinaryInteractionHandler({interactionJournal:createNativeInteractionJournal(database),client:http,policy,qaEnabled,queue:work,database,autocomplete,admission:gate,settingsResolver:binding.resolver,report});
}
