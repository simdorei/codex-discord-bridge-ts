import {types} from 'node:util';
import {validateHeaderValue} from 'node:http';
import {gatewayOwnField as own} from '../discord/gateway/values.ts';
import {requireDiscordText} from '../discord/text.ts';
import {SecretToken} from '../config/remote.ts';
import {RemoteAgentStatus,RemoteAgentControl,claimManagedRemoteState} from './agent-state.ts';
import {RemoteProjectDispatcher,type RemoteDispatcherConfiguration} from './project-dispatcher.ts';
import {ownedPort,ownedPromise,type RemoteProjectBinding} from './dispatcher-ports.ts';
import {createRemoteDispatcherConnection} from './dispatcher-connection.ts';
import {connectAndServeRemote,type RemoteSocketConfiguration} from './native-connection.ts';
import {runRemoteAgentLoop,type RemoteAgentLoopPorts} from './runner.ts';
import {requireImmutableRemoteDto} from './native-decode.ts';
import {formatRemoteUtcDateTime} from './datetime-format.ts';
import type {RemoteUtcDateTime} from './datetime.ts';

/** Explicit synthetic fixture ports, NOT a native protected persistence backend.
 * restore owns claim/decrypt/validate/removal and settles its actual work before
 * returning. protect owns protection-before-write and actual persistence joins.
 * Neither receives tokens, sessions, cache entries, or arbitrary execute power.
 * Production must supply a separately qualified native implementation; this
 * profile cannot dial outside literal loopback or use a non-synthetic token. */
export interface SyntheticRemoteHandoffPorts{
 readonly kind:'SyntheticProtectedBindingPorts';
 readonly restore:(signal:AbortSignal)=>Promise<readonly RemoteProjectBinding[]>;
 /** Legacy fixtures may return void. A concrete adapter returns its actual
  * writer boolean; now is the owner's exact post-cleanup expiry sample. */
 readonly protect:(bindings:readonly RemoteProjectBinding[],now:RemoteUtcDateTime)=>Promise<void|boolean>;
}
export interface SyntheticManagedRemoteConfiguration{
 readonly kind:'SyntheticManagedRemote';
 readonly socket:RemoteSocketConfiguration;
 readonly reconnectDelaySeconds:bigint;
 readonly dispatcher:RemoteDispatcherConfiguration;
 readonly status:RemoteAgentStatus;
 readonly control:RemoteAgentControl;
 readonly handoff:SyntheticRemoteHandoffPorts;
 readonly disconnected:RemoteAgentLoopPorts['disconnected'];
}
/** Opaque, authentic, single-use receipt. Copies/proxies cannot run or release it. */
export interface PreparedManagedRemoteAgent{readonly kind:'PreparedManagedRemoteAgent';readonly status:RemoteAgentStatus;readonly control:RemoteAgentControl;}
type State={dispatcher:RemoteProjectDispatcher;nowUtc:RemoteDispatcherConfiguration['nowUtc'];socket:RemoteSocketConfiguration;delay:bigint;status:RemoteAgentStatus;control:RemoteAgentControl;protect:SyntheticRemoteHandoffPorts['protect'];disconnected:RemoteAgentLoopPorts['disconnected'];stop:AbortController;phase:'restoring'|'prepared'|'running'|'closing'|'protecting'|'closed'|'retained';completion:Promise<void>|null;handoffRequested:boolean;handoffPrepared:boolean};
const owners=new WeakMap<object,State>();
function state(owner:PreparedManagedRemoteAgent):State{
 if(owner===null||typeof owner!=='object'||types.isProxy(owner)||!owners.has(owner))throw new TypeError('Expected authentic prepared managed remote owner');return owners.get(owner)!;
}
function call<T extends (...args:never[])=>unknown>(fn:T,...args:Parameters<T>):ReturnType<T>{return Reflect.apply(fn,undefined,args) as ReturnType<T>;}
function signal(value:AbortSignal):void{if(types.isProxy(value)||!(value instanceof AbortSignal))throw new TypeError('Expected managed remote shutdown signal');}
function text(value:unknown):string{requireDiscordText(value);if(value.length===0||value.length>4096)throw new RangeError('Invalid managed remote text budget');return value;}
function date(value:unknown):RemoteUtcDateTime{const captured=Object.freeze({seconds:own(value,'seconds') as bigint,nanosecond:own(value,'nanosecond') as bigint});formatRemoteUtcDateTime(captured);return captured;}
function bindings(value:readonly RemoteProjectBinding[]):readonly RemoteProjectBinding[]{
 requireImmutableRemoteDto(value,1048576);
 if(!Array.isArray(value)||value.length>16)throw new RangeError('Managed restore exceeds dispatcher project budget');
 const ids=new Set<string>();return Object.freeze(value.map(raw=>{
  const threadId=text(own(raw,'threadId'));if(ids.has(threadId))throw new TypeError('Duplicate restored project binding');ids.add(threadId);
  return Object.freeze({threadId,root:text(own(raw,'root')),expiresAt:date(own(raw,'expiresAt'))});
 }));
}
export class ManagedRemoteOwnershipRetainedError extends AggregateError{
 constructor(primary:unknown,cleanup:unknown,readonly owner:PreparedManagedRemoteAgent){super([primary,cleanup],'Managed remote cleanup failed; ownership is retained');this.name='ManagedRemoteOwnershipRetainedError';}
}
/** Capture before the first await; restore once before any socket can open.
 * Returned resources are owned even on later initialization failure. Failed
 * cleanup is retained through an authentic receipt, never retried or hidden. */
export async function prepareManagedRemoteAgent(input:SyntheticManagedRemoteConfiguration,shutdown:AbortSignal):Promise<PreparedManagedRemoteAgent>{
 signal(shutdown);shutdown.throwIfAborted();
 if(own(input,'kind')!=='SyntheticManagedRemote')throw new TypeError('Expected explicit synthetic managed remote profile');
 const raw=own(input,'socket'),bridgeUrl=text(own(raw,'bridgeUrl')),deviceId=text(own(raw,'deviceId')),token=own(raw,'deviceToken');
 const url=new URL(bridgeUrl);
 if(url.protocol!=='ws:'||url.hostname!=='127.0.0.1'||url.port===''||url.port==='0'||url.username!==''||url.password!==''||bridgeUrl.includes('#'))throw new TypeError('Synthetic managed remote requires literal IPv4 loopback');
 if(types.isProxy(token))throw new TypeError('Expected owned synthetic token');const secret=SecretToken.prototype.expose.call(token);
 if(typeof secret!=='string'||!secret.startsWith('synthetic-')||secret.length>4096)throw new TypeError('Expected synthetic remote token');validateHeaderValue('Authorization','Bearer '+secret);
 const capturedToken=new SecretToken(secret);Object.freeze(capturedToken);const socket=Object.freeze({bridgeUrl,deviceId,deviceToken:capturedToken});
 const delay=own(input,'reconnectDelaySeconds');if(typeof delay!=='bigint'||delay<0n||delay>18446744073709551615n)throw new RangeError('Invalid remote reconnect delay');
 const rawStatus=own(input,'status') as RemoteAgentStatus,rawControl=own(input,'control') as RemoteAgentControl;
 if(types.isProxy(rawStatus)||types.isProxy(rawControl))throw new TypeError('Expected owned remote state');
 const status=RemoteAgentStatus.prototype.clone.call(rawStatus),control=RemoteAgentControl.prototype.clone.call(rawControl);
 const current=RemoteAgentStatus.prototype.snapshot.call(status);if(current.connected||current.generation!==0n)throw new TypeError('Managed remote requires fresh disconnected status');
 const handoff=own(input,'handoff');if(own(handoff,'kind')!=='SyntheticProtectedBindingPorts')throw new TypeError('Expected explicit synthetic protected binding ports');
 const restore=ownedPort<SyntheticRemoteHandoffPorts['restore']>(handoff,'restore'),protect=ownedPort<SyntheticRemoteHandoffPorts['protect']>(handoff,'protect');
 const disconnected=ownedPort<RemoteAgentLoopPorts['disconnected']>(input,'disconnected');
 const dispatcherInput=own(input,'dispatcher') as RemoteDispatcherConfiguration,nowUtc=ownedPort<RemoteDispatcherConfiguration['nowUtc']>(dispatcherInput,'nowUtc');
 const dispatcher=new RemoteProjectDispatcher(dispatcherInput);
 claimManagedRemoteState(status,control);
 const owner:PreparedManagedRemoteAgent=Object.freeze({kind:'PreparedManagedRemoteAgent',status,control});
 const owned:State={dispatcher,nowUtc,socket,delay,status,control,protect,disconnected,stop:new AbortController(),phase:'restoring',completion:null,handoffRequested:false,handoffPrepared:false};owners.set(owner,owned);
 try{
  const restored=bindings(await ownedPromise(call(restore,shutdown)));shutdown.throwIfAborted();
  for(const binding of restored){await RemoteProjectDispatcher.prototype.upsert.call(dispatcher,binding);shutdown.throwIfAborted();}
  owned.phase='prepared';return owner;
 }catch(primary){
  owned.phase='closing';
  try{await RemoteProjectDispatcher.prototype.close.call(dispatcher);owned.phase='closed';}
  catch(cleanup){owned.phase='retained';throw new ManagedRemoteOwnershipRetainedError(primary,cleanup,owner);}
  throw primary;
 }
}
export function managedRemoteSnapshot(owner:PreparedManagedRemoteAgent){
 const s=state(owner);return Object.freeze({phase:s.phase,status:RemoteAgentStatus.prototype.snapshot.call(s.status),dispatcher:RemoteProjectDispatcher.prototype.snapshot.call(s.dispatcher),handoffRequested:s.handoffRequested,handoffPrepared:s.handoffPrepared});
}
/** Callers must request the sticky control BEFORE stopping for restart. A late
 * request after the post-loop decision never retroactively prepares a handoff. */
export function requestManagedRemoteStop(owner:PreparedManagedRemoteAgent):void{state(owner).stop.abort(new Error('Managed remote stopping'));}
/** Abandoned startup releases prepared ownership without running or persisting.
 * Repeated close returns the identical actual completion/failure receipt. */
export function closePreparedManagedRemoteAgent(owner:PreparedManagedRemoteAgent):Promise<void>{
 const s=state(owner);
 if(s.phase==='running'||s.phase==='restoring')throw new TypeError('Managed remote is already active');
 if(s.completion!==null)return s.completion;
 if(s.phase!=='prepared')throw new TypeError('Managed remote cannot be released in this phase');
 s.phase='closing';s.completion=RemoteProjectDispatcher.prototype.close.call(s.dispatcher).then(()=>{s.phase='closed';},error=>{s.phase='retained';throw new ManagedRemoteOwnershipRetainedError(new Error('Prepared remote release failed'),error,owner);});return s.completion;
}
/** One dispatcher across sequential native socket attempts. Existing command
 * workers retain sole queue ownership (4 active/16 total); no replay/new pool.
 * A completion receipt includes actual connection drain/disposal, final project
 * cleanup, and any explicitly requested synthetic handoff preparation. */
export function runManagedRemoteAgent(owner:PreparedManagedRemoteAgent,shutdown:AbortSignal):Promise<void>{
 const s=state(owner);signal(shutdown);
 if(s.phase!=='prepared')throw new TypeError('Prepared managed remote owner already claimed');
 s.phase='running';const abort=()=>requestManagedRemoteStop(owner);shutdown.addEventListener('abort',abort,{once:true});if(shutdown.aborted)abort();
 s.completion=(async()=>{
  let failed=false,primary:unknown,restart:readonly RemoteProjectBinding[]|null=null;
  try{
   await runRemoteAgentLoop(s.delay,s.status,{connectAndServe:(generation,status,stop)=>connectAndServeRemote(s.socket,createRemoteDispatcherConnection(s.dispatcher,generation),generation,status,stop),disconnected:async event=>{
    // Cleanup failure is terminal. Do not repeatedly dial a faulted owner.
    if(RemoteProjectDispatcher.prototype.snapshot.call(s.dispatcher).faulted)throw event.ok?new Error('Remote dispatcher cleanup failed'):event.error;
    await ownedPromise(call(s.disconnected,event));
   }},s.stop.signal);
   s.handoffRequested=RemoteAgentControl.prototype.restartHandoffRequested.call(s.control);
   if(s.handoffRequested)restart=RemoteProjectDispatcher.prototype.snapshotRetiredBindings.call(s.dispatcher);
  }catch(error){failed=true;primary=error;}
  finally{shutdown.removeEventListener('abort',abort);RemoteAgentStatus.prototype.setDisconnected.call(s.status);}
  s.phase='closing';
  try{await RemoteProjectDispatcher.prototype.close.call(s.dispatcher);s.phase='closed';}
  catch(cleanup){s.phase='retained';throw new ManagedRemoteOwnershipRetainedError(failed?primary:new Error('Managed remote final cleanup failed'),cleanup,owner);}
  if(failed)throw primary;
  // Empty bindings never manufacture a persisted handoff. The existing fixture
  // port or explicit runtime persistence adapter owns the actual completion.
  if(restart!==null&&restart.length>0){
   // Explicit asynchronous project cleanup may outlive a binding. Re-filter at
   // the actual protection boundary; never persist a stale pre-cleanup view.
   const now=date(call(s.nowUtc));restart=Object.freeze(restart.filter(binding=>binding.expiresAt.seconds>now.seconds||binding.expiresAt.seconds===now.seconds&&binding.expiresAt.nanosecond>now.nanosecond));
   if(restart.length>0){s.phase='protecting';try{const written=await ownedPromise(call(s.protect,restart,now));if(written!==undefined&&typeof written!=='boolean')throw new TypeError('Invalid managed handoff completion');s.handoffPrepared=written!==false;}finally{s.phase='closed';}}
  }
 })();return s.completion;
}
