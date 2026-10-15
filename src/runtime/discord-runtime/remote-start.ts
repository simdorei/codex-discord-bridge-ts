import {RuntimeDeliveryWake} from './delivery-wake.ts';
import {PortableResidentLifecycle} from '../../app-server/portable-resident-lifecycle.ts';
import {types} from 'node:util';
import {validateHeaderValue} from 'node:http';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {SecretToken} from '../../config/remote.ts';
import {RemoteAgentStatus,RemoteAgentControl} from '../../remote-agent/agent-state.ts';
import {ownedPort,type RemoteProjectBinding} from '../../remote-agent/dispatcher-ports.ts';
import {prepareManagedRemoteAgent,runManagedRemoteAgent,requestManagedRemoteStop,closePreparedManagedRemoteAgent,managedRemoteSnapshot,ManagedRemoteOwnershipRetainedError,type PreparedManagedRemoteAgent,type SyntheticManagedRemoteConfiguration} from '../../remote-agent/managed-agent.ts';
import {PosixDrainMarkerStore} from '../restart-readiness/drain-marker.ts';
import {preparedRuntimeRemoteContextBinding} from './startup-context.ts';
import {RuntimeMonitoredWorker,RuntimeWorkerExitChannel} from './monitored-worker.ts';
import type {ProRemoteConnection} from '../../pro/runtime.ts';
import type {RuntimeCoreStartup} from './core-workers-start.ts';
import type {AdmissionGate} from '../../admission/drain-gate.ts';

/** Explicit loopback fixture profile. Its ports are not native project authority,
 * encryption, durable persistence or permission to enable remote configuration. */
export interface SyntheticRuntimeRemoteConfiguration extends Omit<SyntheticManagedRemoteConfiguration,'kind'|'status'|'control'>{readonly kind:'SyntheticRuntimeRemote';}
export interface SyntheticRuntimeRemoteProfile{readonly kind:'SyntheticRuntimeRemoteProfile';}
export interface PreparedRuntimeRemote{readonly kind:'PreparedSyntheticRuntimeRemote';}
export type RuntimeRemoteBranch={readonly kind:'DisabledRemote'}|PreparedRuntimeRemote;
type ProfileState={config:SyntheticManagedRemoteConfiguration;connection:ProRemoteConnection;phase:'new'|'context'|'preparing'|'prepared'|'failed'};
type RemoteState={managed:PreparedManagedRemoteAgent;context:RuntimeCoreStartup;gate:AdmissionGate;markers:PosixDrainMarkerStore;phase:'prepared'|'claimed'|'starting'|'started'|'closed'|'retained';worker:RuntimeMonitoredWorker|null;closing:Promise<void>|null};
const profiles=new WeakMap<object,ProfileState>(),owners=new WeakMap<object,RemoteState>(),workerOwners=new WeakMap<RuntimeMonitoredWorker,PreparedRuntimeRemote>();
function profile(input:SyntheticRuntimeRemoteProfile):ProfileState{if(input===null||typeof input!=='object'||types.isProxy(input)||!profiles.has(input))throw new TypeError('Expected authentic synthetic runtime remote profile');return profiles.get(input)!;}
function state(input:PreparedRuntimeRemote):RemoteState{if(input===null||typeof input!=='object'||types.isProxy(input)||!owners.has(input))throw new TypeError('Expected authentic prepared runtime remote owner');return owners.get(input)!;}
function signal(input:AbortSignal){if(types.isProxy(input)||!(input instanceof AbortSignal))throw new TypeError('Expected remote startup signal');input.throwIfAborted();}
function text(input:unknown):string{requireDiscordText(input);if(input.length===0||input.length>4096)throw new TypeError('Invalid synthetic remote text');return input;}
/** Pure passive capture; no restore, project, socket or credential lookup. Fresh
 * status/control are private and never supplied independently by a caller. */
export function createSyntheticRuntimeRemoteProfile(input:SyntheticRuntimeRemoteConfiguration):SyntheticRuntimeRemoteProfile{
 if(own(input,'kind')!=='SyntheticRuntimeRemote')throw new TypeError('Expected explicit synthetic runtime remote profile');
 const raw=own(input,'socket'),bridgeUrl=text(own(raw,'bridgeUrl')),deviceId=text(own(raw,'deviceId')),token=own(raw,'deviceToken'),url=new URL(bridgeUrl);
 if(url.protocol!=='ws:'||url.hostname!=='127.0.0.1'||url.port===''||url.port==='0'||url.username!==''||url.password!==''||bridgeUrl.includes('#'))throw new TypeError('Synthetic runtime remote requires literal IPv4 loopback');
 if(types.isProxy(token))throw new TypeError('Expected synthetic token');const secret=SecretToken.prototype.expose.call(token);if(typeof secret!=='string'||!secret.startsWith('synthetic-')||secret.length>4096)throw new TypeError('Expected synthetic token');validateHeaderValue('Authorization','Bearer '+secret);
 const delay=own(input,'reconnectDelaySeconds');if(typeof delay!=='bigint'||delay<0n||delay>18446744073709551615n)throw new TypeError('Invalid synthetic reconnect delay');
 const d=own(input,'dispatcher'),dispatcher=Object.freeze({openProject:ownedPort<SyntheticManagedRemoteConfiguration['dispatcher']['openProject']>(d,'openProject'),nowUtc:ownedPort<SyntheticManagedRemoteConfiguration['dispatcher']['nowUtc']>(d,'nowUtc'),nowMonotonic:ownedPort<SyntheticManagedRemoteConfiguration['dispatcher']['nowMonotonic']>(d,'nowMonotonic')});
 const h=own(input,'handoff');if(own(h,'kind')!=='SyntheticProtectedBindingPorts')throw new TypeError('Expected synthetic protected binding ports');
 const handoff=Object.freeze({kind:'SyntheticProtectedBindingPorts' as const,restore:ownedPort<(signal:AbortSignal)=>Promise<readonly RemoteProjectBinding[]>>(h,'restore'),protect:ownedPort<(bindings:readonly RemoteProjectBinding[])=>Promise<void>>(h,'protect')}),disconnected=ownedPort<SyntheticManagedRemoteConfiguration['disconnected']>(input,'disconnected');
 const status=new RemoteAgentStatus(),control=new RemoteAgentControl(),deviceToken=new SecretToken(secret);Object.freeze(deviceToken);
 const config:SyntheticManagedRemoteConfiguration=Object.freeze({kind:'SyntheticManagedRemote',socket:Object.freeze({bridgeUrl,deviceId,deviceToken}),reconnectDelaySeconds:delay,dispatcher,status,control,handoff,disconnected});
 const result:SyntheticRuntimeRemoteProfile=Object.freeze({kind:'SyntheticRuntimeRemoteProfile'});profiles.set(result,{config,connection:Object.freeze({deviceId,isConnected:()=>RemoteAgentStatus.prototype.isConnected.call(status)}),phase:'new'});return result;
}
/** Internal startup transfer: single-use, before any resident/store effects. The
 * exact closure is installed by prepareRuntimeProContext, never caller readiness. */
export function assertSyntheticRuntimeRemoteProfileAvailable(input:SyntheticRuntimeRemoteProfile):void{if(profile(input).phase!=='new')throw new TypeError('Synthetic runtime remote profile already consumed');}
export function claimSyntheticRuntimeRemoteForPro(input:SyntheticRuntimeRemoteProfile):ProRemoteConnection{const s=profile(input);if(s.phase!=='new')throw new TypeError('Synthetic runtime remote profile already consumed');s.phase='context';return s.connection;}
export function syntheticRuntimeRemoteSnapshot(input:SyntheticRuntimeRemoteProfile){const s=profile(input);return Object.freeze({phase:s.phase,deviceId:s.connection.deviceId,status:RemoteAgentStatus.prototype.snapshot.call(s.config.status),handoffRequested:RemoteAgentControl.prototype.restartHandoffRequested.call(s.config.control)});}
export class RuntimeRemoteOwnershipRetainedError extends AggregateError{
 constructor(primary:unknown,readonly owner:PreparedRuntimeRemote){super([primary],'Remote cleanup is unconfirmed; runtime ownership retained');this.name='RuntimeRemoteOwnershipRetainedError';}
}
/** Restores once after the exact Pro context, before the caller opens a gateway.
 * Context records are minted only by the actual startup chain. Root/marker and
 * queue/resident/gate identity cannot be supplied as unrelated callback ports. */
export async function prepareSyntheticRuntimeRemote(input:SyntheticRuntimeRemoteProfile,context:RuntimeCoreStartup,shutdown:AbortSignal):Promise<PreparedRuntimeRemote>{
 signal(shutdown);const s=profile(input),binding=preparedRuntimeRemoteContextBinding(context);
 if(binding.profile!==input||s.phase!=='context')throw new TypeError('Synthetic remote profile and prepared context differ or already consumed');
 RuntimeDeliveryWake.prototype.assertAvailable.call(context.deliveryWake);if(!PortableResidentLifecycle.prototype.lifecycleSnapshot.call(context.owner).healthy)throw new TypeError('Remote requires a live prepared resident');
 const markers=new PosixDrainMarkerStore(binding.root);s.phase='preparing';
 try{const managed=await prepareManagedRemoteAgent(s.config,shutdown);
  try{preparedRuntimeRemoteContextBinding(context);RuntimeDeliveryWake.prototype.assertAvailable.call(context.deliveryWake);if(!PortableResidentLifecycle.prototype.lifecycleSnapshot.call(context.owner).healthy)throw new TypeError('Remote requires a live prepared resident');}
  catch(primary){try{await closePreparedManagedRemoteAgent(managed);}catch(cleanup){throw new ManagedRemoteOwnershipRetainedError(primary,cleanup,managed);}throw primary;}
  const result:PreparedRuntimeRemote=Object.freeze({kind:'PreparedSyntheticRuntimeRemote'});owners.set(result,{managed,context,gate:binding.gate,markers,phase:'prepared',worker:null,closing:null});s.phase='prepared';return result;}
 catch(error){s.phase='failed';throw error;}
}
/** Validate before typed workers, HTTP or gateway activation. */
export function claimPreparedRuntimeRemote(input:RuntimeRemoteBranch,context:RuntimeCoreStartup,gate:AdmissionGate):PreparedRuntimeRemote|null{
 if(own(input,'kind')==='DisabledRemote')return null;
 const s=state(input as PreparedRuntimeRemote);
 preparedRuntimeRemoteContextBinding(s.context);
 if(s.phase!=='prepared'||s.context!==context||s.gate!==gate)throw new TypeError('Prepared runtime remote context differs or already claimed');
 // The managed receipt cannot be replaced through the public discriminant.
 if(managedRemoteSnapshot(s.managed).phase!=='prepared')throw new TypeError('Managed runtime remote is not prepared');s.phase='claimed';return input as PreparedRuntimeRemote;
}
export function requestPreparedRuntimeRemoteStop(input:PreparedRuntimeRemote):void{const s=state(input);if(s.phase==='starting'&&s.worker!==null)s.worker.abort();else requestManagedRemoteStop(s.managed);}
/** Active remote stop is intentionally independent of the user/startup signal.
 * Root samples its owned restart marker first, then calls requestStop. Forced
 * cancellation still joins the actual managed operation, including pre-entry. */
export async function startPreparedRuntimeRemote(input:PreparedRuntimeRemote,notifier:RuntimeWorkerExitChannel):Promise<RuntimeMonitoredWorker>{
 const s=state(input);if(s.phase!=='claimed')throw new TypeError('Prepared runtime remote is not claimed');s.phase='starting';
 try{
  const worker=new RuntimeMonitoredWorker('remote-mcp',notifier,async force=>{s.phase='started';try{await runManagedRemoteAgent(s.managed,force);s.phase='closed';return {ok:true};}catch(error){s.phase=managedRemoteSnapshot(s.managed).phase==='retained'?'retained':'closed';return {ok:false,error};}},async()=>{await closeUnstartedRuntimeRemote(input,s);});
  s.worker=worker;workerOwners.set(worker,input);return worker;
 }catch(primary){try{await closePreparedRuntimeRemote(input);}catch(cleanup){throw new AggregateError([primary,cleanup],'Remote startup cleanup failed');}throw primary;}
}
/** Idempotent actual receipt. Never retries a rejected cleanup. */
export function closePreparedRuntimeRemote(input:PreparedRuntimeRemote):Promise<void>{
 const s=state(input);if(s.worker!==null&&s.worker.peek()===undefined)throw new TypeError('Join active remote worker before prepared close');return closeUnstartedRuntimeRemote(input,s);
}
function closeUnstartedRuntimeRemote(input:PreparedRuntimeRemote,s:RemoteState):Promise<void>{
 if(s.closing!==null)return s.closing;
 s.closing=closePreparedManagedRemoteAgent(s.managed).then(()=>{s.phase='closed';},error=>{s.phase='retained';throw new RuntimeRemoteOwnershipRetainedError(error,input);});return s.closing;
}
export function preparedRuntimeRemoteSnapshot(input:PreparedRuntimeRemote){const s=state(input);return Object.freeze({phase:s.phase,managed:managedRemoteSnapshot(s.managed)});}
/** Exact task joins can still report failed native cleanup. Withhold resident and
 * outer release authority until the managed dispatcher actually released all. */
export function assertPreparedRuntimeRemoteReleased(input:PreparedRuntimeRemote):void{const s=state(input),snapshot=managedRemoteSnapshot(s.managed);if(snapshot.phase!=='closed'||snapshot.dispatcher.faulted||!snapshot.dispatcher.closed)throw new RuntimeRemoteOwnershipRetainedError(new Error('Managed remote resources remain owned'),input);}
export function assertRuntimeRemoteWorkerReleased(worker:RuntimeMonitoredWorker):void{const owner=workerOwners.get(worker);if(owner!==undefined)assertPreparedRuntimeRemoteReleased(owner);}
/** Bound native marker read, with explicit-stop precedence. Caller observes this
 * Promise under the original shutdown deadline before the first remote stop. */
export async function requestPreparedRuntimeRemoteHandoff(input:PreparedRuntimeRemote):Promise<void>{const s=state(input);if(await PosixDrainMarkerStore.prototype.restartRequested.call(s.markers))RemoteAgentControl.prototype.requestRestartHandoff.call(s.managed.control);}
