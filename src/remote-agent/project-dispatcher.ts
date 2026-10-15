import {types} from 'node:util';
import {gatewayOwnField as own} from '../discord/gateway/values.ts';
import {requireDiscordText} from '../discord/text.ts';
import type {GatewayCommand} from './gateway-command.ts';
import type {BridgeResult} from './bridge-inbound.ts';
import type {ComputerRequest} from './computer-request.ts';
import type {TerminalRequest} from './terminal-request.ts';
import type {CoreRequest} from './core-request.ts';
import type {RemoteUtcDateTime} from './datetime.ts';
import {formatRemoteUtcDateTime} from './datetime-format.ts';
import {remoteCommandMeta,remoteSessionActivation,remoteCommandIsMutation,remoteBindingError,remoteExpiredResult,remoteCancelledResult,remoteSessionError} from './dispatch-contract.ts';
import {decideRemoteSessionActivation,requireRemoteSessionIdentity,type RemoteSessionIdentity} from './session-decisions.ts';
import {RemoteSessionCleanupOwner} from './session-cleanup.ts';
import {RemoteMutationCache} from './mutation-cache.ts';
import {RemoteRequestBudget} from './request-budget.ts';
import {remoteFileErrorResult} from './file-error-result.ts';
import {requireImmutableRemoteDto,serializeBridgeMessageOffThread} from './native-decode.ts';
import {RemoteWorkerCapacityError} from './bounded-workers.ts';
import {utf8Compare} from './request-input.ts';
import {DispatcherLock} from './dispatcher-lock.ts';
import {captureProjectBackend,captureSessionBackend,ownedPort,ownedPromise,type RemoteProjectBackend,type RemoteSessionBackend,type RemoteProjectBinding,type RemoteOperationContext} from './dispatcher-ports.ts';

export interface RemoteDispatcherConfiguration {
 readonly openProject:(binding:RemoteProjectBinding)=>Promise<RemoteProjectBackend>;
 readonly nowUtc:()=>RemoteUtcDateTime;
 readonly nowMonotonic:()=>bigint;
}
/** An identity receipt, not a user-supplied generation number. Only the issuing
 * dispatcher accepts it; spreading, proxying or copying it loses ownership. */
export interface RemoteDispatcherConnection {readonly generation:bigint;}
type Session={identity:RemoteSessionIdentity;cleanup:RemoteSessionCleanupOwner;ports:Pick<RemoteSessionBackend,'computer'|'terminal'|'terminalWindow'>;stop:AbortController;active:number;idle:(()=>void)|null;closing:Promise<void>|null};
type Project={binding:RemoteProjectBinding;backend:RemoteProjectBackend;session:Session|null;sessionLock:DispatcherLock;mutations:DispatcherLock;cache:RemoteMutationCache;uncertain:boolean;closing:Promise<void>|null;active:number;idle:(()=>void)|null;retiring:Set<Session>};
type Accepted={stop:AbortController;done:Promise<void>};
const MAX_PROJECTS=16,MAX_BYTES=4194304,MAX_COMMANDS=4;
const stale='The command belongs to a stale local bridge connection.';
const cleanupFailure='Previous project session cleanup failed.';
function text(value:unknown):string{requireDiscordText(value);if(value.length>4096)throw new RangeError('Dispatcher identity exceeds budget');return value;}
function generation(value:unknown):bigint{if(typeof value!=='bigint'||value<0n||value>18446744073709551615n)throw new TypeError('Expected u64 connection generation');return value;}
function date(value:RemoteUtcDateTime):RemoteUtcDateTime{formatRemoteUtcDateTime(value);return Object.freeze({seconds:own(value,'seconds') as bigint,nanosecond:own(value,'nanosecond') as bigint});}
function expired(value:RemoteUtcDateTime,now:RemoteUtcDateTime):boolean{return value.seconds<now.seconds||value.seconds===now.seconds&&value.nanosecond<=now.nanosecond;}
function signal(value:unknown):asserts value is AbortSignal{if(types.isProxy(value)||!(value instanceof AbortSignal))throw new TypeError('Expected owned abort signal');}
function call<T extends (...args:never[])=>unknown>(fn:T,...args:Parameters<T>):ReturnType<T>{return Reflect.apply(fn,undefined,args) as ReturnType<T>;}
function capability(requestId:string):BridgeResult{return Object.freeze({type:'operation_error',request_id:requestId,error_code:'projectcapability',message:'This project capability has no qualified local backend.'});}
function charge(command:GatewayCommand):number{
 requireImmutableRemoteDto(command,Math.floor(MAX_BYTES/3));let size=128;
 const visit=(v:unknown):void=>{if(typeof v==='string')size+=v.length*3;else if(v!==null&&typeof v==='object')for(const k of Object.keys(v)){size+=k.length*3;visit(own(v,k));}else size+=16;};visit(command);return size;
}

/** Owned dispatcher foundation, connected only by an explicit managed adapter
 * and still uninstalled from CLI roots. Callers provide already decoded commands and qualified resource
 * factories, never an arbitrary execute callback. The outer command loop remains
 * the sole 4-active/16-total worker queue; this owner only rejects excess direct
 * calls and bounds its lock waiters and retained command text to four/4 MiB.
 * One instance survives reconnect, preserving each still-bound project's cache. */
export class RemoteProjectDispatcher {
 readonly #open:RemoteDispatcherConfiguration['openProject'];readonly #utc:RemoteDispatcherConfiguration['nowUtc'];readonly #mono:RemoteDispatcherConfiguration['nowMonotonic'];
 readonly #quarantine=new Set<Readonly<{resource:unknown;receipt:Promise<void>}>>();readonly #failedSessions=new Set<Session>();readonly #failedProjects=new Set<Project>();
 readonly #projects=new Map<string,Project>();readonly #connections=new WeakSet<object>();readonly #accepted=new Set<Accepted>();readonly #bindings=new DispatcherLock();readonly #codecs=new DispatcherLock();
 #connection:RemoteDispatcherConnection|null=null;#highest:bigint|null=null;#transition:Promise<void>|null=null;#closed=false;#faulted=false;#bytes=0;#closeReceipt:Promise<void>|null=null;
 constructor(config:RemoteDispatcherConfiguration){this.#open=ownedPort(config,'openProject');this.#utc=ownedPort(config,'nowUtc');this.#mono=ownedPort(config,'nowMonotonic');}
 #cleanupFailed():boolean{return this.#failedSessions.size>0||this.#failedProjects.size>0||this.#quarantine.size>0;}
 #now():RemoteUtcDateTime{return date(call(this.#utc));}
 #current(connection:RemoteDispatcherConnection):boolean{return this.#connection===connection&&!this.#closed&&!this.#faulted&&this.#transition===null;}
 #auth(connection:RemoteDispatcherConnection):void{if(connection===null||typeof connection!=='object'||types.isProxy(connection)||!this.#connections.has(connection))throw new TypeError('Foreign or forged dispatcher connection');}
 snapshot(){return Object.freeze({generation:this.#connection?.generation??null,projects:this.#projects.size,accepted:this.#accepted.size,retainedCommandBytes:this.#bytes,transitioning:this.#transition!==null,closed:this.#closed,faulted:this.#faulted||this.#cleanupFailed(),failedSessionCleanups:this.#failedSessions.size,failedProjectCleanups:this.#failedProjects.size,quarantinedResources:this.#quarantine.size});}
 /** Binding metadata only, after retirement has joined sessions and operations.
  * No session identity, cache, command or uncertain outcome is restart state. */
 snapshotRetiredBindings():readonly RemoteProjectBinding[]{
  if(this.#connection!==null||this.#transition!==null||this.#accepted.size!==0||this.#closed||this.#faulted||this.#cleanupFailed())throw new Error('Dispatcher bindings require successful retired ownership');
  const now=this.#now();return Object.freeze([...this.#projects.values()].map(project=>project.binding).filter(binding=>!expired(binding.expiresAt,now)).sort((a,b)=>utf8Compare(a.threadId,b.threadId)));
 }
 async #drain():Promise<void>{for(const op of this.#accepted)op.stop.abort(new Error('Dispatcher connection retired'));await Promise.all([...this.#accepted].map(op=>op.done));}
 async #closeSession(session:Session):Promise<void>{
  if(session.closing!==null)return session.closing;
  session.stop.abort(new Error('Project session retired'));
  session.closing=Promise.resolve().then(async()=>{if(session.active>0)await new Promise<void>(resolve=>{session.idle=resolve;});await session.cleanup.close();}).catch(error=>{this.#failedSessions.add(session);throw error;});return session.closing;
 }
 async #closeProject(project:Project):Promise<void>{
  if(project.closing!==null)return project.closing;
  project.closing=Promise.resolve().then(async()=>{const release=await project.sessionLock.acquire(new AbortController().signal);const previous=project.session;project.session=null;release();const failures:unknown[]=[];const sessions=new Set(project.retiring);if(previous)sessions.add(previous);const closing=[...sessions].map(session=>this.#closeSession(session));const settled=await Promise.allSettled(closing);for(const result of settled)if(result.status==='rejected')failures.push(result.reason);if(project.active>0)await new Promise<void>(resolve=>{project.idle=resolve;});project.cache.clear();try{await ownedPromise<void>(project.backend.close());}catch(error){failures.push(error);}if(failures.length)throw new AggregateError(failures,cleanupFailure);}).catch(error=>{this.#failedProjects.add(project);throw error;});return project.closing;
 }
 async #retireAll():Promise<void>{
  const sessions:Session[]=[];for(const project of this.#projects.values()){if(project.session)sessions.push(project.session);project.session=null;}
  const failures:unknown[]=[];for(const session of sessions)try{await this.#closeSession(session);}catch(error){failures.push(error);}if(failures.length||this.#cleanupFailed())throw new AggregateError(failures,cleanupFailure);
 }
 #control(run:()=>Promise<void>):Promise<void>{
  if(this.#transition!==null)return Promise.reject(new Error('Dispatcher control transition already owned'));
  const promise=Promise.resolve().then(run);this.#transition=promise;
  return promise.finally(()=>{this.#transition=null;});
 }
 async beginConnection(next:bigint):Promise<RemoteDispatcherConnection>{
  generation(next);if(this.#closed||this.#faulted||this.#cleanupFailed())throw new Error('Dispatcher is closed or cleanup failed');
  if(this.#highest!==null&&next<=this.#highest)throw new Error('The local bridge connection generation did not advance.');
  let result!:RemoteDispatcherConnection;
  await this.#control(async()=>{this.#highest=next;this.#connection=null;await this.#drain();try{await this.#retireAll();}catch(error){this.#faulted=true;throw error;}result=Object.freeze({generation:next});this.#connections.add(result);this.#connection=result;});return result;
 }
 async retireConnection(connection:RemoteDispatcherConnection):Promise<void>{
  this.#auth(connection);if(this.#connection!==connection)throw new Error(stale);
  await this.#control(async()=>{this.#connection=null;await this.#drain();try{await this.#retireAll();}catch(error){this.#faulted=true;throw error;}});
 }
 /** Trusted local binding ingestion. This is not a remote authorization check.
  * The managed binding/storage assembly must be qualified separately. */
 async upsert(binding:RemoteProjectBinding):Promise<void>{
  const captured=this.#binding(binding);if(this.#closed||this.#faulted||this.#cleanupFailed())throw new Error('Dispatcher is closed or cleanup failed');
  await this.#control(async()=>{await this.#drain();await this.#upsert(captured);});
 }
 #binding(value:RemoteProjectBinding):RemoteProjectBinding{return Object.freeze({threadId:text(own(value,'threadId')),root:text(own(value,'root')),expiresAt:date(own(value,'expiresAt') as RemoteUtcDateTime)});}
 async #rejectTransfer(resource:unknown,error:unknown,release:(()=>Promise<void>)|null):Promise<never>{
  // Quarantine before calling any release function. Keep an uncleanable resource
  // and its failed receipt reachable; no guessed release or automatic retry.
  const receipt=Promise.resolve().then(()=>{if(release===null)throw error;return ownedPromise<void>(release());});
  const entry=Object.freeze({resource,receipt});this.#quarantine.add(entry);
  try{await receipt;this.#quarantine.delete(entry);}catch(failure){throw new AggregateError([error,failure],cleanupFailure);}
  throw error;
 }
 #sessionRelease(raw:unknown):Readonly<{cleanup:RemoteSessionCleanupOwner;failures:readonly unknown[]}>{
  const failures:unknown[]=[];
  const release=(key:'stopComputer'|'closeTerminalWindows'|'closeTerminals'):()=>Promise<void>=>{
   try{return ownedPort<()=>Promise<void>>(raw,key);}catch(error){failures.push(error);return ()=>Promise.reject(error);}
  };
  const cleanup=new RemoteSessionCleanupOwner({stopComputer:release('stopComputer'),closeTerminalWindows:release('closeTerminalWindows'),closeTerminals:release('closeTerminals')});
  return {cleanup,failures};
 }
 async #captureSession(raw:RemoteSessionBackend):Promise<ReturnType<typeof captureSessionBackend>>{
  const {cleanup,failures}=this.#sessionRelease(raw);
  try{if(failures.length)throw new AggregateError(failures,'Malformed session release ports');return captureSessionBackend(raw);}
  catch(error){return this.#rejectTransfer(raw,error,()=>cleanup.close());}
 }
 async #upsert(binding:RemoteProjectBinding):Promise<Project>{
  if(this.#cleanupFailed())throw new DispatcherReplacementError(new Error(cleanupFailure));
  if(!this.#projects.has(binding.threadId)&&this.#projects.size>=MAX_PROJECTS)throw new RemoteWorkerCapacityError();
  const pending:unknown=call(this.#open,binding);
  if(!types.isPromise(pending)){let close:(()=>Promise<void>)|null=null;try{close=ownedPort<()=>Promise<void>>(pending,'close');}catch{}return this.#rejectTransfer(pending,new TypeError('Project factory must return a native Promise'),close);}
  const raw=await (pending as Promise<RemoteProjectBackend>);let backend:RemoteProjectBackend;
  // Capture the release path first; a malformed returned backend cannot leak it.
  let close:()=>Promise<void>;try{close=ownedPort<()=>Promise<void>>(raw,'close');}catch(error){return this.#rejectTransfer(raw,error,null);}
  try{backend=captureProjectBackend(raw);}catch(error){return this.#rejectTransfer(raw,error,close);}
  if(this.#cleanupFailed())return this.#rejectTransfer(raw,new Error(cleanupFailure),close);
  const project:Project={binding,backend,session:null,sessionLock:new DispatcherLock(),mutations:new DispatcherLock(),cache:new RemoteMutationCache(Math.floor(MAX_BYTES/(MAX_PROJECTS+MAX_COMMANDS))),uncertain:false,closing:null,active:0,idle:null,retiring:new Set()};
  const previous=this.#projects.get(binding.threadId);this.#projects.set(binding.threadId,project);
  if(previous)try{await this.#closeProject(previous);}catch(error){throw new DispatcherReplacementError(error);}
  return project;
 }
 close():Promise<void>{
  if(this.#closeReceipt!==null)return this.#closeReceipt;
  if(this.#transition!==null)return Promise.reject(new Error('Dispatcher control transition already owned'));
  this.#closeReceipt=this.#control(async()=>{this.#closed=true;this.#connection=null;await this.#drain();const failures:unknown[]=[];for(const project of this.#projects.values())try{await this.#closeProject(project);}catch(error){failures.push(error);}if(failures.length||this.#cleanupFailed()){this.#faulted=true;throw new AggregateError(failures,cleanupFailure);}this.#projects.clear();});return this.#closeReceipt;
 }
 execute(command:GatewayCommand,connection:RemoteDispatcherConnection,cancelled:AbortSignal):Promise<BridgeResult>{
  signal(cancelled);const bytes=charge(command),meta=remoteCommandMeta(command);text(meta.request_id);text(meta.thread_id);if(meta.computer_session_id!==null)text(meta.computer_session_id);date(meta.deadline_at);
  if(cancelled.aborted)return Promise.resolve(remoteCancelledResult(meta.request_id));this.#auth(connection);
  if(!this.#current(connection))return Promise.resolve(remoteSessionError(meta.request_id,stale));
  if(this.#accepted.size>=MAX_COMMANDS||this.#bytes+bytes>MAX_BYTES)return Promise.reject(new RemoteWorkerCapacityError());
  const stop=new AbortController(),abort=()=>stop.abort(cancelled.reason);cancelled.addEventListener('abort',abort,{once:true});
  let settled!:()=>void;const op:Accepted={stop,done:new Promise<void>(resolve=>{settled=resolve;})};this.#accepted.add(op);this.#bytes+=bytes;
  return Promise.resolve().then(()=>this.#execute(command,connection,stop.signal)).finally(()=>{cancelled.removeEventListener('abort',abort);this.#accepted.delete(op);this.#bytes-=bytes;settled();});
 }
 async #execute(command:GatewayCommand,connection:RemoteDispatcherConnection,cancelled:AbortSignal):Promise<BridgeResult>{
  const meta=remoteCommandMeta(command);if(cancelled.aborted)return remoteCancelledResult(meta.request_id);
  if(command.type==='device_session'){
   let unlock:(()=>void)|undefined;
   try{unlock=await this.#bindings.acquire(cancelled);if(cancelled.aborted)return remoteCancelledResult(meta.request_id);await this.#upsert(this.#binding({threadId:meta.thread_id,root:command.working_directory,expiresAt:command.expires_at}));}
   catch(error){if(cancelled.aborted)return remoteCancelledResult(meta.request_id);if(error instanceof DispatcherReplacementError)return remoteSessionError(meta.request_id,cleanupFailure);return remoteFileErrorResult(meta.request_id,error,cancelled);}
   finally{unlock?.();}
  }
  const project=this.#projects.get(meta.thread_id);if(!project)return remoteBindingError(meta.request_id,'binding_missing');
  if(expired(meta.deadline_at,this.#now()))return remoteExpiredResult(meta.request_id);
  if(expired(project.binding.expiresAt,this.#now()))return remoteBindingError(meta.request_id,'binding_expired');
  const activation=remoteSessionActivation(command);
  if(activation!==null)return this.#activate(project,meta.request_id,Object.freeze({connectionGeneration:connection.generation,sessionGeneration:activation.session_generation,sessionId:activation.session_id,computerMode:activation.computer_mode}),connection,meta.deadline_at,cancelled);
  let session:Session;let release:(()=>void)|undefined;
  try{
   release=await project.sessionLock.acquire(cancelled);
   const required=requireRemoteSessionIdentity(this.#connection?.generation??null,project.session?.identity??null,meta.computer_session_id,connection.generation);
   if(required.kind==='Reject')return remoteSessionError(meta.request_id,required.message);
   session=project.session!;session.active++;project.active++;
  }catch(error){if(cancelled.aborted)return remoteCancelledResult(meta.request_id);throw error;}finally{release?.();}
  const signal=AbortSignal.any([cancelled,session.stop.signal]);
  try{
   if(remoteCommandIsMutation(command)){
    let unlock:(()=>void)|undefined;
    try{
     unlock=await project.mutations.acquire(signal);
     if(signal.aborted)return remoteCancelledResult(meta.request_id);
     if(expired(meta.deadline_at,this.#now()))return remoteExpiredResult(meta.request_id);
     // Async custody extension: expiry/replacement are rechecked after lock wait.
     if(expired(project.binding.expiresAt,this.#now()))return remoteBindingError(meta.request_id,'binding_expired');
     if(project.uncertain)return remoteSessionError(meta.request_id,'A previous mutation outcome is uncertain; this binding is blocked.');
     let cacheRelease=await this.#codecs.acquire(signal);let cached:BridgeResult|null;
     try{cached=await project.cache.lookup(command,signal);}finally{cacheRelease();}
     if(cached!==null)return cached;
     const result=await this.#run(command,project,session,signal);
     try{cacheRelease=await this.#codecs.acquire(signal);try{await project.cache.remember(command,result,signal);}finally{cacheRelease();}}
     catch(error){project.uncertain=true;throw error;}
     return result;
    }catch(error){if(signal.aborted)return remoteCancelledResult(meta.request_id);throw error;}finally{unlock?.();}
   }
   return await this.#run(command,project,session,signal);
  }catch(error){if(signal.aborted)return remoteCancelledResult(meta.request_id);throw error;}finally{session.active--;if(session.active===0)session.idle?.();project.active--;if(project.active===0)project.idle?.();}
 }
 async #activate(project:Project,requestId:string,identity:RemoteSessionIdentity,connection:RemoteDispatcherConnection,deadline:RemoteUtcDateTime,cancelled:AbortSignal):Promise<BridgeResult>{
  let release:(()=>void)|undefined;
  try{
   release=await project.sessionLock.acquire(cancelled);
   if(cancelled.aborted||project.closing!==null)return remoteCancelledResult(requestId);
   if(expired(deadline,this.#now()))return remoteExpiredResult(requestId);
   if(expired(project.binding.expiresAt,this.#now()))return remoteBindingError(requestId,'binding_expired');
   const decision=decideRemoteSessionActivation(this.#connection?.generation??null,project.session?.identity??null,identity);
   if(decision.kind==='Reject')return remoteSessionError(requestId,decision.message);
   if(decision.kind==='Reuse')return Object.freeze({type:'project_session_result',request_id:requestId});
   if(this.#cleanupFailed())return remoteSessionError(requestId,cleanupFailure);
   if(project.backend.createSession===null)return capability(requestId);
   const pending:unknown=project.backend.createSession(identity);
   if(!types.isPromise(pending))return await this.#rejectTransfer(pending,new TypeError('Session factory must return a native Promise'),()=>this.#sessionRelease(pending).cleanup.close());
   const raw=await (pending as Promise<RemoteSessionBackend>);
   const captured=await this.#captureSession(raw);
   const next:Session={identity,cleanup:captured.cleanup,ports:captured.ports,stop:new AbortController(),active:0,idle:null,closing:null};
   if(this.#cleanupFailed()){await this.#closeSession(next);return remoteSessionError(requestId,cleanupFailure);}
   if(cancelled.aborted||!this.#current(connection)||project.closing!==null){await this.#closeSession(next);return remoteCancelledResult(requestId);}
   if(expired(deadline,this.#now())){await this.#closeSession(next);return remoteExpiredResult(requestId);}
   if(expired(project.binding.expiresAt,this.#now())){await this.#closeSession(next);return remoteBindingError(requestId,'binding_expired');}
   const previous=project.session;project.session=next;
   release();release=undefined;
   if(previous){project.retiring.add(previous);try{await this.#closeSession(previous);project.retiring.delete(previous);}catch{return remoteSessionError(requestId,cleanupFailure);}}
   return Object.freeze({type:'project_session_result',request_id:requestId});
  }catch(error){if(cancelled.aborted)return remoteCancelledResult(requestId);return remoteSessionError(requestId,'Local project session creation failed.');}finally{release?.();}
 }
 async #run(command:GatewayCommand,project:Project,session:Session,cancelled:AbortSignal):Promise<BridgeResult>{
  const requestId=command.request_id;if(cancelled.aborted)return remoteCancelledResult(requestId);
  if(expired(command.deadline_at,this.#now()))return remoteExpiredResult(requestId);
  if(expired(project.binding.expiresAt,this.#now()))return remoteBindingError(requestId,'binding_expired');
  const context:RemoteOperationContext=Object.freeze({binding:project.binding,session:session.identity,signal:cancelled,budget:RemoteRequestBudget.fromDeadline(command.deadline_at,this.#now(),call(this.#mono))});
  let invoked=false;
  try{
   let result:BridgeResult;
   switch(command.type){
    case 'project_info':result=Object.freeze({type:'project_info_result',request_id:requestId,output:Object.freeze({root:project.binding.root,thread_id:project.binding.threadId})});break;
    case 'list_files':{if(project.backend.listFiles===null)return capability(requestId);invoked=true;let output;try{output=await ownedPromise(project.backend.listFiles(command,context));}catch(error){return remoteFileErrorResult(requestId,error,cancelled);}result=Object.freeze({type:'list_files_result',request_id:requestId,output});break;}
    case 'read_file':{if(project.backend.readFile===null)return capability(requestId);invoked=true;let output;try{output=await ownedPromise(project.backend.readFile(command,context));}catch(error){return remoteFileErrorResult(requestId,error,cancelled);}result=Object.freeze({type:'read_file_result',request_id:requestId,output});break;}
    case 'write_file':if(project.backend.writeFile===null)return capability(requestId);invoked=true;result=Object.freeze({type:'write_file_result',request_id:requestId,output:await ownedPromise(project.backend.writeFile(command,context))});break;
    case 'project_operation':{
     const operation=command.operation;let output;
     if(operation.kind.startsWith('computer_')){if(session.ports.computer===null)return capability(requestId);invoked=true;output=await ownedPromise(session.ports.computer(operation as ComputerRequest,context));}
     else if(operation.kind.startsWith('terminal_')){const port=operation.kind==='terminal_exec'?session.ports.terminal:session.ports.terminalWindow;if(port===null)return capability(requestId);invoked=true;output=await ownedPromise(port(operation as TerminalRequest,context));}
     else{if(project.backend.core===null)return capability(requestId);invoked=true;output=await ownedPromise(project.backend.core(operation as CoreRequest,context));}
     result=Object.freeze({type:'project_operation_result',request_id:requestId,output});break;
    }
    default:return capability(requestId);
   }
   requireImmutableRemoteDto(result,1048576+32768);
   if(!remoteCommandIsMutation(command)){const release=await this.#codecs.acquire(cancelled);try{await serializeBridgeMessageOffThread(result,1048576,cancelled);}finally{release();}}
   return result;
  }catch(error){if(invoked&&remoteCommandIsMutation(command))project.uncertain=true;throw error;}
 }
}
class DispatcherReplacementError extends Error{constructor(cause:unknown){super(cleanupFailure,{cause});}}
Object.freeze(RemoteProjectDispatcher.prototype);
