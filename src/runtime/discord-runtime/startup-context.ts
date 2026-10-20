import {claimSyntheticRuntimeRemoteForPro,type RuntimeRemoteProfile} from './remote-start.ts';
import {AdmittedRecoverExecutor} from '../action-executor/recover-action.ts';
import {RuntimeDeliveryWake} from './delivery-wake.ts';
import {invokeSynchronousVoid} from '../../core/synchronous-void.ts';
import {types} from 'node:util';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import type {RuntimeConfig} from '../../config/runtime.ts';
import type {PortableSessionConfig} from '../../app-server/portable-session.ts';
import type {RuntimePaths} from '../runtime-paths/resolve.ts';
import {AdmissionGate} from '../../admission/drain-gate.ts';
import type {ReserveRetirementLimits} from '../../store/reserve-retirement.ts';
import {refreshMirrorPolicyOffThread,type NativeMirrorPolicyLimits} from './native-mirror-policy.ts';
import {captureRuntimeAccessPolicy} from './access-policy-bootstrap.ts';
import {captureRuntimeExecutorOptions,buildRuntimeCommandExecutor,type RuntimeExecutorBootstrapOptions,captureRuntimeProExecutorOptions,buildRuntimeProCommandExecutor,type RuntimeProExecutorBootstrapOptions} from './executor-bootstrap.ts';
import {startRuntimeFoundation} from './startup-foundation.ts';
import {RuntimeResidentStartupCleanupError} from './resident-startup.ts';
export interface RuntimeStartupContextOptions{
 readonly paths:Pick<RuntimePaths,'root'|'stateDb'|'mirrorDb'|'bridgeState'>;
 readonly process:PortableSessionConfig;readonly runtimeId:string;readonly startupChannel:bigint|null;
 readonly admission:AdmissionGate;readonly executor:RuntimeExecutorBootstrapOptions;
 readonly access:Pick<RuntimeConfig,'allowedChannelIds'|'allowedUserIds'|'allowAllChannels'>;
 readonly reserveLimits:ReserveRetirementLimits;readonly policyLimits:NativeMirrorPolicyLimits;readonly storageTimeoutMs:number;
}
export interface RuntimeProStartupContextOptions extends Omit<RuntimeStartupContextOptions,'executor'>{readonly executor:RuntimeProExecutorBootstrapOptions;}
/** Actual pre-gateway startup chain. Caller must already own the runtime guard
 * and drain controller. No guard is fabricated and no gateway starts here.
 * All caller inputs are captured before effects. Once returned, preserve the
 * exact subscriptions for completion/server-request workers. On later startup
 * failure call disposeBeforeWorkers; after workers start use joined shutdown.
 * DB recovery writes may already be committed on failure/cancellation. */
const remoteContexts=new WeakMap<object,{binding:Readonly<{profile:RuntimeRemoteProfile;root:string;gate:AdmissionGate}>;open:boolean}>();
export function preparedRuntimeRemoteContextBinding(context:object){const entry=remoteContexts.get(context);if(entry===undefined)throw new TypeError('Expected exact remote Pro startup context');if(!entry.open)throw new TypeError('Remote Pro startup context is closed');return entry.binding;}
async function prepareContext(input:RuntimeStartupContextOptions|RuntimeProStartupContextOptions,proMode:boolean,signal?:AbortSignal,remoteProfile?:RuntimeRemoteProfile){
 if(signal!==undefined&&(types.isProxy(signal)||!(signal instanceof AbortSignal)))throw new TypeError('Expected startup context abort signal');signal?.throwIfAborted();
 const get=<K extends keyof RuntimeStartupContextOptions>(key:K)=>own(input,key) as RuntimeStartupContextOptions[K];
 const paths=cloneOwnedSerdeValue(get('paths')) as RuntimeStartupContextOptions['paths'],process=cloneOwnedSerdeValue(get('process')) as PortableSessionConfig;
 const runtimeId=get('runtimeId'),startupChannel=get('startupChannel'),admission=get('admission'),executorOptions=proMode?captureRuntimeProExecutorOptions(own(input,'executor') as RuntimeProExecutorBootstrapOptions):captureRuntimeExecutorOptions(get('executor'));
 if(remoteProfile!==undefined){if(!proMode||(executorOptions as RuntimeProExecutorBootstrapOptions).pro.remote!==null)throw new TypeError('Synthetic remote profile requires an unbound Pro context');}
 const remote=remoteProfile===undefined?null:claimSyntheticRuntimeRemoteForPro(remoteProfile);
 const initialPolicy=captureRuntimeAccessPolicy(get('access')),reserveLimits=cloneOwnedSerdeValue(get('reserveLimits')) as ReserveRetirementLimits,policyLimits=cloneOwnedSerdeValue(get('policyLimits')) as NativeMirrorPolicyLimits,timeout=get('storageTimeoutMs');
 if(proMode&&(executorOptions as RuntimeProExecutorBootstrapOptions).pro.executable!==own(own(process,'process'),'executable'))throw new TypeError('Pro inventory and resident must use the same executable');
 AdmissionGate.prototype.isSealed.call(admission);
 if(executorOptions.recovery!==undefined)AdmittedRecoverExecutor.prototype.requireDatabase.call(executorOptions.recovery,paths.mirrorDb);
 const deliveryWake=new RuntimeDeliveryWake(),originalNotify=executorOptions.notifyDeliveryReady;
 const wiredOptions={...executorOptions,...(remote===null?{}:{pro:Object.freeze({...((executorOptions as RuntimeProExecutorBootstrapOptions).pro),remote})}),notifyDeliveryReady:function(this:object){deliveryWake.notify();invokeSynchronousVoid(originalNotify,this,[]);}};
 const foundation=await startRuntimeFoundation(paths,process,runtimeId,startupChannel,executorOptions.render,reserveLimits,timeout,signal);
 let built:Awaited<ReturnType<typeof buildRuntimeCommandExecutor>>|undefined;
 try{
  signal?.throwIfAborted();built=proMode?await buildRuntimeProCommandExecutor(paths,foundation.owner,admission,wiredOptions as RuntimeProExecutorBootstrapOptions):await buildRuntimeCommandExecutor(paths,foundation.owner,admission,wiredOptions as RuntimeExecutorBootstrapOptions);signal?.throwIfAborted();
  const policy=await refreshMirrorPolicyOffThread(initialPolicy,paths.mirrorDb,policyLimits,signal);signal?.throwIfAborted();
  const executor=built,remoteEntry=remoteProfile===undefined?null:{binding:Object.freeze({profile:remoteProfile,root:paths.root,gate:admission}),open:true};
  const disposeBeforeWorkers=async()=>{if(remoteEntry!==null)remoteEntry.open=false;try{await foundation.owner.dispose();}finally{deliveryWake.close();executor.disposeReceivers();}};
  const result=Object.freeze({...foundation,...executor,policy,deliveryWake,disposeBeforeWorkers});
  if(remoteEntry!==null)remoteContexts.set(result,remoteEntry);return result;
 }catch(primary){
  deliveryWake.close();built?.disposeReceivers();
  try{await foundation.owner.dispose();}catch(cleanup){throw new RuntimeResidentStartupCleanupError(primary,cleanup,foundation.owner);}throw primary;
 }
}

export function prepareRuntimeContext(input:RuntimeStartupContextOptions,signal?:AbortSignal){return prepareContext(input,false,signal);}
/** Same owned startup chain with source-ordered actual Pro capture. */
export function prepareRuntimeProContext(input:RuntimeProStartupContextOptions,signal?:AbortSignal,remoteProfile?:RuntimeRemoteProfile){return prepareContext(input,true,signal,remoteProfile);}
