import {createNativeMirrorPolicyRefresh,captureNativeMirrorPolicyLimits,type NativeMirrorPolicyLimits} from './native-mirror-policy.ts';
import {captureNativeHistoryTargetLimits,type NativeHistoryTargetLimits} from './native-history-targets.ts';
import {types} from 'node:util';
import {gatewayOwnField as own,gatewayId} from '../../discord/gateway/values.ts';
import type {GatewayRuntime} from '../../discord/gateway/runtime.ts';
import type {DecodedGatewayInteraction} from '../../discord/gateway/decoded-interaction.ts';
import type {DiscordChannelClient} from '../../discord/channel-client.ts';
import type {AdmissionGate} from '../../admission/drain-gate.ts';
import type {InteractionWorkQueue} from '../discord-dispatch/interaction-work.ts';
import type {AutocompleteCatalog} from '../discord-dispatch/autocomplete.ts';
import type {InteractionDispatchReport} from '../discord-dispatch/ordinary-dispatcher.ts';
import type {RuntimeWorkerExitChannel} from './monitored-worker.ts';
import {capturePreparedMessageOptions,type RuntimeMessageStartup} from './message-bootstrap.ts';
import type {RuntimeHistoryStartupOptions} from './history-bootstrap.ts';
import {createGatewayMessageHandler} from './message-handler.ts';
import {createDiscordHistoryOperations} from './history-operations.ts';
import {createPreparedInteractionIngress} from './interaction-ingress-bootstrap.ts';
import {readyHttpPort} from './ready-http-port.ts';
import type {ReadySetupOptions} from './ready-setup.ts';
import {startTypedIngressWorkers,type TypedIngressStartOptions} from './typed-ingress-start.ts';
export interface PreparedTypedIngressOptions extends RuntimeHistoryStartupOptions{
 readonly interactionPolicyLimits:NativeMirrorPolicyLimits;readonly messagePolicyLimits:NativeMirrorPolicyLimits;
 readonly guildId:bigint|null;readonly qaCommands:boolean;readonly startupNotify:boolean;readonly historyPeriodMs:number|null;
 readonly reportReady:ReadySetupOptions['report'];readonly reportDispatch:(value:InteractionDispatchReport)=>void;
 readonly reportInteraction:TypedIngressStartOptions['reportInteraction'];readonly reportReceiveError:TypedIngressStartOptions['reportReceiveError'];
}
/** Wire all seven real typed consumers before activating the supplied paused
 * gateway. Uses one prepared executor, HTTP owner, gate and settings resolver.
 * This borrows the interaction work queue; its business worker is separately
 * owned and must start/join under the common runtime lifecycle. */
export function capturePreparedTypedIngressOptions(input:RuntimeMessageStartup,gate:AdmissionGate,http:DiscordChannelClient,work:InteractionWorkQueue,catalog:AutocompleteCatalog,options:PreparedTypedIngressOptions):TypedIngressStartOptions{
 const captured=capturePreparedMessageOptions(input,gate,http,options),qa=own(options,'qaCommands') as boolean,startupNotify=own(options,'startupNotify') as boolean;
 if(typeof qa!=='boolean'||typeof startupNotify!=='boolean')throw new TypeError('Expected startup flags');
 const optionalId=(key:string)=>{const value=own(options,key);return value===null?null:gatewayId(value);},guildId=optionalId('guildId'),startupChannelId=optionalId('startupChannelId');
 const callback=<T>(key:string)=>{const fn=own(options,key);if(typeof fn!=='function'||types.isProxy(fn)||types.isAsyncFunction(fn)||types.isGeneratorFunction(fn))throw new TypeError('Expected synchronous startup reporter');return fn as T;};
 const reportReady=callback<ReadySetupOptions['report']>('reportReady'),reportDispatch=callback<PreparedTypedIngressOptions['reportDispatch']>('reportDispatch'),reportInteraction=callback<TypedIngressStartOptions['reportInteraction']>('reportInteraction'),reportReceiveError=callback<TypedIngressStartOptions['reportReceiveError']>('reportReceiveError');
 const raw=own(options,'allowedChannelIds');if(raw===null||typeof raw!=='object'||types.isProxy(raw))throw new TypeError('Expected native allowed channel set');const allowedChannelIds=new Set<bigint>();Set.prototype.forEach.call(raw,(id:unknown)=>allowedChannelIds.add(gatewayId(id)));
 const message=createGatewayMessageHandler({...captured,refreshPolicy:createNativeMirrorPolicyRefresh(captured.context.database,own(options,'messagePolicyLimits') as NativeMirrorPolicyLimits)}),interaction=createPreparedInteractionIngress(input,gate,work,http,catalog,qa,reportDispatch,captureNativeMirrorPolicyLimits(own(options,'interactionPolicyLimits') as NativeMirrorPolicyLimits)),historyOptions=Object.freeze({...captured,refreshPolicy:createNativeMirrorPolicyRefresh(captured.context.database,own(options,'historyPolicyLimits') as NativeMirrorPolicyLimits),allowedChannelIds,startupChannelId,nativeTargetLimits:captureNativeHistoryTargetLimits(own(options,'historyTargetLimits') as NativeHistoryTargetLimits)});
 return Object.freeze<TypedIngressStartOptions>({ready:Object.freeze({port:readyHttpPort(http),guildId,qaCommands:qa,startupNotify,startupChannelId,report:reportReady}),message,history:(gaps,acceptedMessages)=>createDiscordHistoryOperations(gaps,{...historyOptions,acceptedMessages}),historyPeriodMs:own(options,'historyPeriodMs') as number|null,interaction,reportInteraction,reportReceiveError});
}

export function startPreparedTypedIngress(input:RuntimeMessageStartup,gateway:GatewayRuntime<DecodedGatewayInteraction>,gate:AdmissionGate,http:DiscordChannelClient,work:InteractionWorkQueue,catalog:AutocompleteCatalog,shutdown:AbortSignal,notifier:RuntimeWorkerExitChannel,options:PreparedTypedIngressOptions){
 shutdown.throwIfAborted();
 return startTypedIngressWorkers(gateway,shutdown,notifier,capturePreparedTypedIngressOptions(input,gate,http,work,catalog,options));
}
