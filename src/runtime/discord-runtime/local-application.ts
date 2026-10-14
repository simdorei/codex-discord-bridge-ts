import {join} from 'node:path';
import {SecretString,type RuntimeConfig} from '../../config/runtime.ts';
import {SecretToken} from '../../config/remote.ts';
import {RecommendedGateway} from '../../discord/gateway/recommended.ts';
import {discoverRuntimePathInputs} from '../runtime-paths/discovery.ts';
import {resolveRuntimePaths,snapshotRuntimeEnvironment,type RuntimeEnvironment} from '../runtime-paths/resolve.ts';
import {PosixRuntimeInstance} from '../runtime-instance.ts';
import {PosixDrainMarkerStore} from '../restart-readiness/drain-marker.ts';
import {RuntimeDrainController,posixDrainMarkerPort} from '../restart-readiness/drain-controller.ts';
import {posixRuntimeHeartbeatPort,RUNTIME_HEARTBEAT_NAME} from '../runtime-heartbeat.ts';
import {AttachmentHttpClient} from '../attachment-client.ts';
import {NewThreadMirrorLink} from '../mirror-sync/new-mirror-link.ts';
import {DiscordNewMirrorTransport} from '../mirror-sync/new-mirror-http.ts';
import {RuntimeStopSignal} from './stop-signal.ts';
import {runtimeResidentConfig} from './resident-config.ts';
import {prepareRuntimeProContext} from './startup-context.ts';
import {RuntimeResidentStartupCleanupError} from './resident-startup.ts';
import {loadRuntimeAutocomplete} from './autocomplete-bootstrap.ts';
import {startPreparedRuntimeWorkers,type PreparedRuntimeWorkerOwner} from './prepared-workers.ts';
import {runPreparedRuntimeLifetime,closePreparedRuntimeOuter} from './prepared-lifetime.ts';
import {captureLocalSessionMirrorProfile,requireLocalSessionMirrorPaths,requireLocalSessionMirrorDatabase,prepareLocalSessionMirrorSchemas,type LocalSessionMirrorProfile} from './local-session-mirror-profile.ts';
import {createSessionMirrorHttpTransport} from './session-mirror-http.ts';
import {captureRuntimeMirrorInput} from './session-mirror-start.ts';

export class LocalRuntimeUnsupportedError extends Error{
 constructor(){super('Local runtime profile requires POSIX, remote and host commands disabled, and session mirror disabled or an explicit qualified programmatic profile');this.name='LocalRuntimeUnsupportedError';}
}
export class LocalRuntimeOwnershipRetainedError extends AggregateError{
 constructor(primary:unknown,cleanup:unknown,readonly owners:Readonly<object>){super([primary,cleanup],'Runtime ownership retained: cleanup is unconfirmed; do not restart');this.name='LocalRuntimeOwnershipRetainedError';}
}
function milliseconds(value:bigint):number{
 if(typeof value!=='bigint'||value<0n||value%1000000n!==0n||value/1000000n>2147483647n)throw new TypeError('Unsupported runtime duration');return Number(value/1000000n);
}
/** Candidate local-only composition. This is not Windows/remote parity or
 * production qualification. Session mirroring requires the explicit caller-owned
 * profile; the CLI intentionally never supplies one. Singleton acquisition must succeed before
 * any marker publication, store preparation, native launch or Discord connection.
 * Defaults below are finite safety budgets, not measured throughput guarantees.
 * Startup cleanup releases outer ownership only after confirmed native disposal;
 * a failed active lifetime retains its owners rather than guessing it has joined.
 */
export async function runLocalRuntimeApplication(config:RuntimeConfig,environment:RuntimeEnvironment,root:string,version:string,mirrorProfile?:LocalSessionMirrorProfile):Promise<void>{
 if(process.platform==='win32'||config.remoteMcp!==null||config.hostCommands||(config.sessionMirror&&mirrorProfile===undefined))throw new LocalRuntimeUnsupportedError();
 if(typeof config.sessionMirror!=='boolean'||(!config.sessionMirror&&mirrorProfile!==undefined))throw new TypeError('Local mirror profile and sessionMirror configuration differ');
 const capturedMirror=mirrorProfile===undefined?null:captureLocalSessionMirrorProfile(mirrorProfile);
 const env=snapshotRuntimeEnvironment(environment),resumeMs=milliseconds(config.appServerResumeTimeoutNs),historyMs=milliseconds(config.appServerHistoryReadTimeoutNs),historyPeriodMs=config.historyPollIntervalNs===null?null:milliseconds(config.historyPollIntervalNs);
 const access={allowedChannelIds:new Set(config.allowedChannelIds),allowedUserIds:new Set(config.allowedUserIds),allowAllChannels:config.allowAllChannels},mentions=new Set(config.plainAskMentionUserIds);
 const startupChannel=config.startupChannelId,guild=config.guildId,messageContent=config.enableMessageContent,qa=config.qaCommands,notify=config.startupNotify,commentary=config.streamCommentary;
 const attachmentConfig={attachmentsEnabled:config.attachmentsEnabled,attachmentMaxBytes:config.attachmentMaxBytes,attachmentTextInlineMaxBytes:config.attachmentTextInlineMaxBytes};
 const token=new SecretToken(SecretString.prototype.expose.call(config.botToken));
 const stop=RuntimeStopSignal.install();
 let instance:PosixRuntimeInstance|undefined,controller:RuntimeDrainController|undefined,context:Awaited<ReturnType<typeof prepareRuntimeProContext>>|undefined,gateway:RecommendedGateway|undefined,attachment:AttachmentHttpClient|undefined,workers:PreparedRuntimeWorkerOwner|undefined,outerClosed=false,retained=false;
 // Never echo arbitrary payloads, credentials or raw diagnostic causes.
 const report=()=>{process.stderr.write('runtime_diagnostic: inspect protected local evidence\n');},render=()=> 'runtime operation failed';
 try{
  const inputs=await discoverRuntimePathInputs(env,root);stop.signal.throwIfAborted();const paths=await resolveRuntimePaths(env,inputs);stop.signal.throwIfAborted();
  if(capturedMirror!==null)requireLocalSessionMirrorPaths(capturedMirror,paths);
  instance=await PosixRuntimeInstance.acquire(paths.root);stop.signal.throwIfAborted();
  if(capturedMirror!==null)await requireLocalSessionMirrorDatabase(paths,stop.signal);
  const markers=new PosixDrainMarkerStore(paths.root);controller=await RuntimeDrainController.initialize(posixDrainMarkerPort(markers));stop.signal.throwIfAborted();
  let linker:NewThreadMirrorLink|undefined;
  const mirror={linkNewThread:async(channel:bigint,thread:string,prompt:string,cwd:string|null,signal?:AbortSignal)=>{if(linker===undefined)throw new Error('Runtime mirror transport is not connected');return linker.linkNewThread(channel,thread,prompt,cwd,signal);}};
  context=await prepareRuntimeProContext({paths,process:runtimeResidentConfig(paths,version),runtimeId:controller.runtimeId,startupChannel,admission:controller.admissionGate,access,reserveLimits:{maxRows:4096,maxBytes:4194304},policyLimits:{maxRows:4096n,maxValueBytes:4194304n,maxOutputIds:8192,timeoutMs:10000},storageTimeoutMs:10000,executor:{render,mirror,reportNewAttempt:report,reportPolicyFailure:report,notifyDeliveryReady:()=>{},resumeTimeoutMs:resumeMs,historyTimeoutMs:historyMs,pro:{executable:paths.codexExe,remote:null,report}}},stop.signal);
  if(capturedMirror!==null)await prepareLocalSessionMirrorSchemas(capturedMirror,paths,stop.signal);
  gateway=await RecommendedGateway.startPaused({token,messageContent,reportReceiveErrorDrop:report,reportTriggerFailure:report,reportHttpError:report,signal:stop.signal});
  const sessionMirror=capturedMirror===null?null:captureRuntimeMirrorInput(capturedMirror.worker,createSessionMirrorHttpTransport(gateway.http,stop.signal),render,report,context.queue);
  linker=new NewThreadMirrorLink(paths.mirrorDb,new DiscordNewMirrorTransport(gateway.http),context.queue.locks,guild);
  const catalog=await loadRuntimeAutocomplete(context.owner,stop.signal);attachment=new AttachmentHttpClient();
  workers=await startPreparedRuntimeWorkers(context,gateway.runtime,controller.admissionGate,gateway.http,catalog,stop.signal,{remoteEnabled:false,ingress:{config:attachmentConfig,attachmentRoot:paths.attachmentDir,attachmentTransport:attachment,attachmentReport:report,classification:{enableMessageContent:messageContent,plainAskMentionUserIds:mentions},report,allowedChannelIds:access.allowedChannelIds,startupChannelId:startupChannel,historyTargetLimits:{maxRows:4096,timeoutMs:10000},guildId:guild,qaCommands:qa,startupNotify:notify,historyPeriodMs,reportReady:report,reportDispatch:report,reportInteraction:report,reportReceiveError:report},completion:{commentaryEnabled:commentary,historyReadTimeoutMs:historyMs,render,report},interleaving:{heartbeat:{port:posixRuntimeHeartbeatPort(join(paths.root,RUNTIME_HEARTBEAT_NAME)),options:{report}},mirror:sessionMirror},reportInteraction:report});
  const result=await runPreparedRuntimeLifetime(workers,controller,stop.signal,{stopRequested:()=>markers.stopRequested(),reportControl:report,reportTransition:report,shutdown:{report}});
  await closePreparedRuntimeOuter(result,gateway,controller);await instance.release();outerClosed=true;
  if(!result.finalized.decision.result.ok)throw result.finalized.decision.result.error;
 }catch(primary){
  if(outerClosed)throw primary;
  const owners=Object.freeze({instance,controller,context,gateway,attachment,workers,stop});
  // This error already retains a native child whose disposal failed before a
  // prepared context could be returned. Do not remove its exclusion identity.
  if(primary instanceof RuntimeResidentStartupCleanupError||workers!==undefined){retained=true;throw new LocalRuntimeOwnershipRetainedError(primary,new Error('Active ownership requires explicit reconciliation'),owners);}
  try{await context?.disposeBeforeWorkers();await gateway?.close();await attachment?.close();await controller?.dispose();await instance?.release();}
  catch(cleanup){retained=true;throw new LocalRuntimeOwnershipRetainedError(primary,cleanup,owners);}
  throw primary;
 }finally{if(!retained)stop.dispose();}
}
