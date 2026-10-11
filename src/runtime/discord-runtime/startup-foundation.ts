import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import {types} from 'node:util';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import type {PortableSessionConfig} from '../../app-server/portable-session.ts';
import type {RuntimePaths} from '../runtime-paths/resolve.ts';
import type {ReserveRetirementLimits} from '../../store/reserve-retirement.ts';
import {prepareRuntimeStorageOffThread} from './storage-preparation.ts';
import {retireRuntimeReserveOffThread} from './reserve-retirement.ts';
import {recoverRuntimeIngressOffThread} from './native-ingress-recovery.ts';
import {startRuntimeResident,RuntimeResidentStartupCleanupError} from './resident-startup.ts';
/** Source linear foundation after the caller has acquired the exclusive runtime
 * guard and initialized its drain controller. No guard is synthesized here and
 * this is not a standalone entrypoint. No gateway or dispatcher starts here.
 * Paths/configuration are pinned before any await. Store tasks join native exit;
 * failed post-spawn recovery disposes the exact child or retains its retry owner.
 * Existing custody/idle-journal hooks remain synchronous; not full DB offload. */
export async function startRuntimeFoundation(paths:Pick<RuntimePaths,'stateDb'|'mirrorDb'>,config:PortableSessionConfig,runtimeId:string,startupChannel:bigint|null,render:(error:unknown)=>string,limits:ReserveRetirementLimits,timeoutMs=10000,signal?:AbortSignal){
 if(signal!==undefined&&(types.isProxy(signal)||!(signal instanceof AbortSignal)))throw new TypeError('Expected startup abort signal');signal?.throwIfAborted();
 const state=own(paths,'stateDb'),mirror=own(paths,'mirrorDb');for(const v of [state,mirror,runtimeId])requireDiscordText(v as string);
 if(runtimeId.includes('\0')||Buffer.byteLength(runtimeId)>4096)throw new RangeError('Invalid startup runtime identity');
 if(startupChannel!==null&&(typeof startupChannel!=='bigint'||startupChannel<0n||startupChannel>=(1n<<63n)))throw new TypeError('Invalid startup channel');
 if(typeof render!=='function'||types.isProxy(render)||types.isAsyncFunction(render)||types.isGeneratorFunction(render))throw new TypeError('Expected synchronous startup diagnostic renderer');
 const maxRows=own(limits,'maxRows'),maxBytes=own(limits,'maxBytes');if(typeof maxRows!=='number'||!Number.isSafeInteger(maxRows)||maxRows<1||maxRows>4096||typeof maxBytes!=='number'||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>4194304)throw new RangeError('Invalid startup resource limits');
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw new RangeError('Invalid startup store deadline');
 const pinnedPaths=Object.freeze({stateDb:pinNativeRuntimePath(state as string),mirrorDb:pinNativeRuntimePath(mirror as string)}),pinnedConfig=cloneOwnedSerdeValue(config) as PortableSessionConfig,pinnedLimits=Object.freeze({maxRows,maxBytes});
 await prepareRuntimeStorageOffThread(pinnedPaths,timeoutMs,signal);signal?.throwIfAborted();
 const retirement=await retireRuntimeReserveOffThread(pinnedPaths.mirrorDb,pinnedLimits,timeoutMs,signal);signal?.throwIfAborted();
 const owner=await startRuntimeResident(pinnedConfig,pinnedPaths.mirrorDb,runtimeId,startupChannel,render,signal);
 try{
  signal?.throwIfAborted();const heldIngress=await recoverRuntimeIngressOffThread(pinnedPaths.mirrorDb,runtimeId,Date.now()/1000,pinnedLimits,timeoutMs,signal);signal?.throwIfAborted();
  return Object.freeze({owner,retirement,heldIngress});
 }catch(primary){
  try{await owner.dispose();}catch(cleanup){throw new RuntimeResidentStartupCleanupError(primary,cleanup,owner);}throw primary;
 }
}
