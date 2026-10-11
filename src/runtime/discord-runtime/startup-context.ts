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
import {captureRuntimeExecutorOptions,buildRuntimeCommandExecutor,type RuntimeExecutorBootstrapOptions} from './executor-bootstrap.ts';
import {startRuntimeFoundation} from './startup-foundation.ts';
import {RuntimeResidentStartupCleanupError} from './resident-startup.ts';
export interface RuntimeStartupContextOptions{
 readonly paths:Pick<RuntimePaths,'root'|'stateDb'|'mirrorDb'|'bridgeState'>;
 readonly process:PortableSessionConfig;readonly runtimeId:string;readonly startupChannel:bigint|null;
 readonly admission:AdmissionGate;readonly executor:RuntimeExecutorBootstrapOptions;
 readonly access:Pick<RuntimeConfig,'allowedChannelIds'|'allowedUserIds'|'allowAllChannels'>;
 readonly reserveLimits:ReserveRetirementLimits;readonly policyLimits:NativeMirrorPolicyLimits;readonly storageTimeoutMs:number;
}
/** Actual pre-gateway startup chain. Caller must already own the runtime guard
 * and drain controller. No guard is fabricated and no gateway starts here.
 * All caller inputs are captured before effects. Once returned, preserve the
 * exact subscriptions for completion/server-request workers. On later startup
 * failure call disposeBeforeWorkers; after workers start use joined shutdown.
 * DB recovery writes may already be committed on failure/cancellation. */
export async function prepareRuntimeContext(input:RuntimeStartupContextOptions,signal?:AbortSignal){
 if(signal!==undefined&&(types.isProxy(signal)||!(signal instanceof AbortSignal)))throw new TypeError('Expected startup context abort signal');signal?.throwIfAborted();
 const get=<K extends keyof RuntimeStartupContextOptions>(key:K)=>own(input,key) as RuntimeStartupContextOptions[K];
 const paths=cloneOwnedSerdeValue(get('paths')) as RuntimeStartupContextOptions['paths'],process=cloneOwnedSerdeValue(get('process')) as PortableSessionConfig;
 const runtimeId=get('runtimeId'),startupChannel=get('startupChannel'),admission=get('admission'),executorOptions=captureRuntimeExecutorOptions(get('executor'));
 const initialPolicy=captureRuntimeAccessPolicy(get('access')),reserveLimits=cloneOwnedSerdeValue(get('reserveLimits')) as ReserveRetirementLimits,policyLimits=cloneOwnedSerdeValue(get('policyLimits')) as NativeMirrorPolicyLimits,timeout=get('storageTimeoutMs');
 AdmissionGate.prototype.isSealed.call(admission);
 const foundation=await startRuntimeFoundation(paths,process,runtimeId,startupChannel,executorOptions.render,reserveLimits,timeout,signal);
 let built:Awaited<ReturnType<typeof buildRuntimeCommandExecutor>>|undefined;
 try{
  signal?.throwIfAborted();built=await buildRuntimeCommandExecutor(paths,foundation.owner,admission,executorOptions);signal?.throwIfAborted();
  const policy=await refreshMirrorPolicyOffThread(initialPolicy,paths.mirrorDb,policyLimits,signal);signal?.throwIfAborted();
  const executor=built;
  const disposeBeforeWorkers=async()=>{try{await foundation.owner.dispose();}finally{executor.disposeReceivers();}};
  return Object.freeze({...foundation,...executor,policy,disposeBeforeWorkers});
 }catch(primary){
  built?.disposeReceivers();
  try{await foundation.owner.dispose();}catch(cleanup){throw new RuntimeResidentStartupCleanupError(primary,cleanup,foundation.owner);}throw primary;
 }
}
