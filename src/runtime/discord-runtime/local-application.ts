import {createConfiguredRuntimeRemoteProfile,assertSyntheticRuntimeRemoteProfileAvailable,prepareSyntheticRuntimeRemote,closePreparedRuntimeRemote,assertPreparedRuntimeRemoteReleased,type RuntimeRemoteProfile,type PreparedRuntimeRemote} from './remote-start.ts';
import {ManagedRemoteOwnershipRetainedError} from '../../remote-agent/managed-agent.ts';
import {StoreAuthorityDomain} from '../../store/store-authority-domain.ts';
import {captureLocalStoreAuthorityProfile,requireLocalStoreAuthorityPaths,enrollLocalStoreAuthority,type LocalStoreAuthorityProfile} from './store-authority-profile.ts';
import {SecretString,type RuntimeConfig} from '../../config/runtime.ts';
import {SecretToken} from '../../config/remote.ts';
import {RecommendedGateway} from '../../discord/gateway/recommended.ts';
import {discoverRuntimePathInputs} from '../runtime-paths/discovery.ts';
import {resolveRuntimePaths,snapshotRuntimeEnvironment,type RuntimeEnvironment} from '../runtime-paths/resolve.ts';
import {acquireRuntimePlatform,type RuntimeInstance} from '../runtime-platform.ts';
import {RuntimeDrainController} from '../restart-readiness/drain-controller.ts';
import {AttachmentHttpClient} from '../attachment-client.ts';
import {NewThreadMirrorLink} from '../mirror-sync/new-mirror-link.ts';
import {DiscordNewMirrorTransport} from '../mirror-sync/new-mirror-http.ts';
import {RuntimeStopSignal} from './stop-signal.ts';
import {runtimeResidentConfig} from './resident-config.ts';
import {prepareRuntimeProContext} from './startup-context.ts';
import {RuntimeResidentStartupCleanupError} from './resident-startup.ts';
import {requiresPortableSessionCleanupRetention} from '../../app-server/portable-session.ts';
import {loadRuntimeAutocomplete} from './autocomplete-bootstrap.ts';
import {startPreparedRuntimeWorkers,type PreparedRuntimeWorkerOwner} from './prepared-workers.ts';
import {runPreparedRuntimeLifetime,closePreparedRuntimeOuter} from './prepared-lifetime.ts';
import {createVerifiedLocalSessionMirrorProfile,captureLocalSessionMirrorProfile,requireLocalSessionMirrorPaths,requireLocalSessionMirrorDatabase,prepareLocalSessionMirrorSchemas,type LocalSessionMirrorProfile} from './local-session-mirror-profile.ts';
import {createSessionMirrorHttpTransport} from './session-mirror-http.ts';
import {captureRuntimeMirrorInput} from './session-mirror-start.ts';
import {AdmittedRecoverExecutor} from '../action-executor/recover-action.ts';
import {createWindowsRecoveryController} from '../writer-recovery/windows-controller.ts';
import {createWindowsHostControl} from '../windows/host-control.ts';
import {createArchiveDeletionController} from '../archive-delete/controller.ts';
import {withOwnedWorkerBackpressure,withOwnedWorkerReuse,closeOwnedWorkerPool} from '../owned-worker-slot.ts';
import {createRuntimeDiagnostics} from './diagnostics.ts';

export class LocalRuntimeUnsupportedError extends Error{
 constructor(){super('Host commands require the Windows controller');this.name='LocalRuntimeUnsupportedError';}
}
export class LocalRuntimeOwnershipRetainedError extends AggregateError{
 constructor(primary:unknown,cleanup:unknown,readonly owners:Readonly<object>){super([primary,cleanup],'Runtime ownership retained: cleanup is unconfirmed; do not restart');this.name='LocalRuntimeOwnershipRetainedError';}
}
function milliseconds(value:bigint):number{
 if(typeof value!=='bigint'||value<0n||value%1000000n!==0n||value/1000000n>2147483647n)throw new TypeError('Unsupported runtime duration');return Number(value/1000000n);
}
/** Installed runtime composition, including configured remote MCP and verified
 * full-prefix session mirroring. Synthetic profiles remain test-only adapters.
 * Singleton acquisition must succeed before
 * any marker publication, store preparation, native launch or Discord connection.
 * Defaults below are finite safety budgets, not measured throughput guarantees.
 * Startup cleanup releases outer ownership only after confirmed native disposal;
 * a failed active lifetime retains its owners rather than guessing it has joined.
 */
export function runLocalRuntimeApplication(config:RuntimeConfig,environment:RuntimeEnvironment,root:string,version:string,mirrorProfile?:LocalSessionMirrorProfile,authorityProfile?:LocalStoreAuthorityProfile,remoteProfile?:RuntimeRemoteProfile):Promise<void>{
 return withOwnedWorkerReuse(()=>withOwnedWorkerBackpressure(()=>runApplication(config,environment,root,version,mirrorProfile,authorityProfile,remoteProfile)));
}
async function runApplication(config:RuntimeConfig,environment:RuntimeEnvironment,root:string,version:string,mirrorProfile?:LocalSessionMirrorProfile,authorityProfile?:LocalStoreAuthorityProfile,remoteProfile?:RuntimeRemoteProfile):Promise<void>{
 if(config.hostCommands&&process.platform!=='win32')throw new LocalRuntimeUnsupportedError();
 if(remoteProfile!==undefined)assertSyntheticRuntimeRemoteProfileAvailable(remoteProfile);
 if(typeof config.sessionMirror!=='boolean'||(!config.sessionMirror&&mirrorProfile!==undefined))throw new TypeError('Local mirror profile and sessionMirror configuration differ');
 const capturedAuthority=authorityProfile===undefined?null:captureLocalStoreAuthorityProfile(authorityProfile);
 let capturedMirror=mirrorProfile===undefined?null:captureLocalSessionMirrorProfile(mirrorProfile);
 const env=snapshotRuntimeEnvironment(environment),resumeMs=milliseconds(config.appServerResumeTimeoutNs),historyMs=milliseconds(config.appServerHistoryReadTimeoutNs),historyPeriodMs=config.historyPollIntervalNs===null?null:milliseconds(config.historyPollIntervalNs);
 const access={allowedChannelIds:new Set(config.allowedChannelIds),allowedUserIds:new Set(config.allowedUserIds),allowAllChannels:config.allowAllChannels},mentions=new Set(config.plainAskMentionUserIds);
 const startupChannel=config.startupChannelId,guild=config.guildId,messageContent=config.enableMessageContent,qa=config.qaCommands,notify=config.startupNotify,commentary=config.streamCommentary,localToolApprovalPolicy=config.localToolApprovalPolicy,approvalPolicy=config.approvalPolicy;
 const attachmentConfig={attachmentsEnabled:config.attachmentsEnabled,attachmentMaxBytes:config.attachmentMaxBytes,attachmentTextInlineMaxBytes:config.attachmentTextInlineMaxBytes};
 const token=new SecretToken(SecretString.prototype.expose.call(config.botToken));
 const stop=RuntimeStopSignal.install();
 let remote:PreparedRuntimeRemote|undefined,authority:StoreAuthorityDomain|undefined,instance:RuntimeInstance|undefined,controller:RuntimeDrainController|undefined,context:Awaited<ReturnType<typeof prepareRuntimeProContext>>|undefined,gateway:RecommendedGateway|undefined,attachment:AttachmentHttpClient|undefined,workers:PreparedRuntimeWorkerOwner|undefined,outerClosed=false,retained=false;
 const diagnostics=createRuntimeDiagnostics(line=>process.stderr.write(line),[SecretToken.prototype.expose.call(token),...(config.remoteMcp===null?[]:[SecretToken.prototype.expose.call(config.remoteMcp.device_token)])]);
 const {report,render,forScope}=diagnostics;
 try{
  const inputs=await discoverRuntimePathInputs(env,root);stop.signal.throwIfAborted();const paths=await resolveRuntimePaths(env,inputs);stop.signal.throwIfAborted();
  if(config.remoteMcp!==null){if(remoteProfile!==undefined)throw new TypeError('Remote profile already supplied');remoteProfile=createConfiguredRuntimeRemoteProfile(config.remoteMcp,paths.root,paths.codexExe,env.CODEX_REMOTE_MCP_RESUME_BINDINGS==='1');}
  if(config.sessionMirror&&capturedMirror===null)capturedMirror=createVerifiedLocalSessionMirrorProfile(paths);
  if(capturedMirror!==null)requireLocalSessionMirrorPaths(capturedMirror,paths);
  if(capturedAuthority!==null)requireLocalStoreAuthorityPaths(paths);
  const platform=await acquireRuntimePlatform(paths.root);instance=platform.instance;
  if(capturedAuthority!==null)authority=enrollLocalStoreAuthority(instance,paths,capturedAuthority);
  stop.signal.throwIfAborted();
  if(capturedMirror!==null)await requireLocalSessionMirrorDatabase(paths,stop.signal);
  const markers=platform.markers;controller=await RuntimeDrainController.initialize(markers);stop.signal.throwIfAborted();
  let linker:NewThreadMirrorLink|undefined;
  const mirror={linkNewThread:async(channel:bigint,thread:string,prompt:string,cwd:string|null,signal?:AbortSignal)=>{if(linker===undefined)throw new Error('Runtime mirror transport is not connected');return linker.linkNewThread(channel,thread,prompt,cwd,signal);}};
  context=await prepareRuntimeProContext({paths,process:runtimeResidentConfig(paths,version),runtimeId:controller.runtimeId,startupChannel,admission:controller.admissionGate,access,reserveLimits:{maxRows:4096,maxBytes:4194304},policyLimits:{maxRows:4096n,maxValueBytes:4194304n,maxOutputIds:8192,timeoutMs:10000},storageTimeoutMs:10000,executor:{render,mirror,reportNewAttempt:forScope('action.new'),reportPolicyFailure:forScope('action.policy'),notifyDeliveryReady:()=>{},resumeTimeoutMs:resumeMs,historyTimeoutMs:historyMs,pro:{executable:paths.codexExe,remote:null,report:forScope('pro')}}},stop.signal,remoteProfile);
  if(process.platform==='win32'){
   context.executor.configureRecovery(new AdmittedRecoverExecutor(paths.mirrorDb,paths.root,'win32',createWindowsRecoveryController(paths.root,paths.codexHome)));
   context.executor.configureHostControl(createWindowsHostControl(paths.root,controller.runtimeId,config.hostCommands));
   context.executor.configureArchiveDeletion(createArchiveDeletionController(paths.mirrorDb,{state:paths.stateDb,logs:paths.logDb,global:paths.globalState,bridge:paths.bridgeState,index:paths.sessionIndex,archivedSessions:paths.archivedSessions,root:paths.maintenanceBackupRoot}));
  }
  if(capturedMirror!==null)await prepareLocalSessionMirrorSchemas(capturedMirror,paths,stop.signal);
  if(remoteProfile!==undefined)remote=await prepareSyntheticRuntimeRemote(remoteProfile,context,stop.signal);
  gateway=await RecommendedGateway.startPaused({token,messageContent,reportReceiveErrorDrop:forScope('gateway.receive'),reportTriggerFailure:forScope('gateway.trigger'),reportHttpError:forScope('gateway.http'),signal:stop.signal});
  const sessionMirror=capturedMirror===null?null:captureRuntimeMirrorInput(capturedMirror.worker,createSessionMirrorHttpTransport(gateway.http,stop.signal),render,forScope('mirror'),context.queue);
  linker=new NewThreadMirrorLink(paths.mirrorDb,new DiscordNewMirrorTransport(gateway.http),context.queue.locks,guild);
  const catalog=await loadRuntimeAutocomplete(context.owner,stop.signal);attachment=new AttachmentHttpClient();
  workers=await startPreparedRuntimeWorkers(context,gateway.runtime,controller.admissionGate,gateway.http,catalog,stop.signal,{localToolApprovalPolicy,approvalPolicy,remote:remote??{kind:'DisabledRemote'},ingress:{config:attachmentConfig,attachmentRoot:paths.attachmentDir,attachmentTransport:attachment,attachmentReport:forScope('attachment'),classification:{enableMessageContent:messageContent,plainAskMentionUserIds:mentions},report:forScope('ingress'),allowedChannelIds:access.allowedChannelIds,startupChannelId:startupChannel,historyTargetLimits:{maxRows:4096,timeoutMs:10000},historyPolicyLimits:{maxRows:4096n,maxValueBytes:4194304n,maxOutputIds:8192,timeoutMs:10000},interactionPolicyLimits:{maxRows:4096n,maxValueBytes:4194304n,maxOutputIds:8192,timeoutMs:10000},messageClassificationLimits:{maxRows:4096n,maxValueBytes:4194304n,maxOutputBytes:4194304,timeoutMs:10000},historyClassificationLimits:{maxRows:4096n,maxValueBytes:4194304n,maxOutputBytes:4194304,timeoutMs:10000},messagePolicyLimits:{maxRows:4096n,maxValueBytes:4194304n,maxOutputIds:8192,timeoutMs:10000},guildId:guild,qaCommands:qa,startupNotify:notify,historyPeriodMs,reportReady:forScope('gateway.ready'),reportDispatch:forScope('gateway.dispatch'),reportInteraction:forScope('interaction'),reportReceiveError:forScope('gateway.receive')},completion:{commentaryEnabled:commentary,historyReadTimeoutMs:historyMs,render,report:forScope('completion')},interleaving:{heartbeat:{port:platform.heartbeat,options:{report:forScope('heartbeat')}},mirror:sessionMirror},reportInteraction:report});
  const result=await runPreparedRuntimeLifetime(workers,controller,stop.signal,{stopRequested:()=>markers.stopRequested(),reportControl:forScope('control'),reportTransition:forScope('transition'),shutdown:{report:forScope('shutdown')}});
  await closePreparedRuntimeOuter(result,gateway,controller);authority?.closeAfterOwnersJoined();await instance.release();outerClosed=true;
  if(!result.finalized.decision.result.ok)throw result.finalized.decision.result.error;
 }catch(primary){
  if(outerClosed)throw primary;
  authority?.seal();
  const owners=Object.freeze({instance,controller,context,gateway,attachment,workers,stop,authority,remote});
  // Startup may retain an exact pending session inside its original aggregate
  // before a prepared context exists. Do not remove that exclusion identity.
  if(requiresPortableSessionCleanupRetention(primary)||primary instanceof RuntimeResidentStartupCleanupError||primary instanceof ManagedRemoteOwnershipRetainedError||workers!==undefined){retained=true;throw new LocalRuntimeOwnershipRetainedError(primary,new Error('Active ownership requires explicit reconciliation'),owners);}
  try{if(remote!==undefined){await closePreparedRuntimeRemote(remote);assertPreparedRuntimeRemoteReleased(remote);}await context?.disposeBeforeWorkers();await gateway?.close();await attachment?.close();await controller?.dispose();await closeOwnedWorkerPool();authority?.closeAfterOwnersJoined();await instance?.release();}
  catch(cleanup){retained=true;throw new LocalRuntimeOwnershipRetainedError(primary,cleanup,owners);}
  throw primary;
 }finally{if(!retained)stop.dispose();}
}
