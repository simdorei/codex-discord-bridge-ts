import {RemoteReadOwner,listRemoteOwnedFiles,closeRemoteNativeRead,assertRemoteNativeReadHealthy,type RemoteNativeRead} from './files/read-owner.ts';
import {readRemoteFile} from './files/read-file.ts';
import {RemoteFileMutations,fileDigest} from './files/mutations.ts';
import {RemoteFileFailure} from './files/error.ts';
import {RemoteOperationFailure} from './operation-failure.ts';
import {settledRemoteOperationFailure} from './operation-error-result.ts';
import {NativeRemoteCore,RemoteCoreInputConflict} from './native-core.ts';
import {RemoteImageInputError} from './native-images.ts';
import {NativeTerminalEngine} from './native-terminal.ts';
import {WindowsTerminalWindows} from './windows-terminal.ts';
import {RemoteSessionComputerOwner} from './session-computer.ts';
import {createWindowsComputer} from './windows-computer.ts';
import {OwnedCommandCleanupError} from '../runtime/windows/owned-command.ts';
import {freezeRemoteBackendResult} from './native-decode.ts';
import type {RemoteProjectBackend,RemoteProjectBinding,RemoteOperationContext,RemoteSessionBackend} from './dispatcher-ports.ts';
import type {RemoteSessionIdentity} from './session-decisions.ts';
/** Configured gateway project bindings are the local authority grant. This
 * factory pins the actual root and transfers resources only after acquisition;
 * partial startup and final release both join every accepted native operation. */
export async function openNativeRemoteProject(binding:RemoteProjectBinding,codexExe:string):Promise<RemoteProjectBackend>{
 let reader:RemoteNativeRead|undefined,files:RemoteFileMutations|undefined;
 try{reader=(await RemoteReadOwner.bind(binding.root)).transfer();files=await RemoteFileMutations.bind(reader.root);}catch(error){if(reader)await closeRemoteNativeRead(reader);files?.close();throw error;}
 const native=reader,mutations=files,core=new NativeRemoteCore(mutations,native,codexExe),stop=new AbortController(),active=new Set<Promise<unknown>>(),debts:unknown[]=[],sessions=new Map<RemoteSessionIdentity,{backend:RemoteSessionBackend;stop:AbortController}>();let closed=false,closing:Promise<void>|undefined;
 const run=<T>(context:RemoteOperationContext,work:(context:RemoteOperationContext)=>Promise<T>):Promise<T>=>{
  if(closed||context.binding!==binding||!sessions.has(context.session))throw new Error('Remote project/session ownership differs');context.signal.throwIfAborted();const remaining=context.budget.remaining();
  const deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(new Error('Remote operation deadline expired')),Math.max(1,Math.min(2147483647,Number(remaining/1000000n))));
  const captured={...context,signal:AbortSignal.any([context.signal,stop.signal,sessions.get(context.session)!.stop.signal,deadline.signal])};
  const task=Promise.resolve().then(()=>{captured.signal.throwIfAborted();return work(captured);}).then(freezeRemoteBackendResult).catch(error=>{if(error instanceof OwnedCommandCleanupError){debts.push(error);stop.abort(error);}throw error;}).finally(()=>{clearTimeout(timer);active.delete(task);});active.add(task);return task;
 };
 const createSession=async(identity:RemoteSessionIdentity):Promise<RemoteSessionBackend>=>{
  if(closed)throw new Error('Remote project is closed');assertRemoteNativeReadHealthy(native);const terminal=new NativeTerminalEngine(mutations.root),windows=new WindowsTerminalWindows(mutations.root),computer=new RemoteSessionComputerOwner(identity.computerMode,createWindowsComputer),abort=new AbortController();
  const backend:RemoteSessionBackend=Object.freeze({stopComputer:async()=>{abort.abort(new Error('Remote session retired'));await computer.stop();},closeTerminalWindows:()=>windows.close(),closeTerminals:async()=>{await terminal.close();sessions.delete(identity);},computer:(request,context)=>run(context,()=>computer.execute(request)),terminal:(request,context)=>run(context,c=>terminal.execute(request,c)),terminalWindow:(request,context)=>run(context,c=>windows.execute(request,c))} satisfies RemoteSessionBackend);sessions.set(identity,{backend,stop:abort});return backend;
 };
 return Object.freeze({createSession,
  listFiles:(command,context)=>run(context,c=>listRemoteOwnedFiles(native,command.pattern,Number(command.limit),c.signal)),
  readFile:(command,context)=>run(context,c=>readRemoteFile(native,command.path,command.start_line,Number(command.max_lines),c.signal)),
  writeFile:(command,context)=>run(context,async c=>{
   const before=await mutations.read(command.path,1048576);
   if(before===null?command.expected_sha256!==null:command.expected_sha256===null||fileDigest(before)!==command.expected_sha256)return settledRemoteOperationFailure(command,new RemoteOperationFailure({family:'checkpoint',failure:{kind:'File',error:new RemoteFileFailure('Conflict',command.path,'file changed since it was read')}}));
   const r=await core.write(command.path,command.content,command.expected_sha256,c.signal);return {path:r.path,sha256:r.sha256,bytes_written:r.bytes_written,created:r.created};
  }),
  core:(request,context)=>run(context,async c=>{try{return await core.execute(request,c);}catch(error){
   if(error instanceof RemoteCoreInputConflict){
    const family=request.kind==='save_image'||request.kind==='save_image_from_url'?'image':request.kind==='file_create'||request.kind==='file_apply_patch'?'checkpoint':null;
    if(family!==null)return settledRemoteOperationFailure(request,new RemoteOperationFailure({family,failure:{kind:'File',error}}));
   }
   if(error instanceof RemoteImageInputError&&(request.kind==='save_image'||request.kind==='save_image_from_url'))return settledRemoteOperationFailure(request,new RemoteOperationFailure({family:'image',failure:{kind:'Invalid',path:request.path,reason:error.message}}));throw error;
  }}),
  close:()=>{closed=true;stop.abort(new Error('Remote project closed'));return closing??=(async()=>{const results=await Promise.allSettled([...sessions.values()].map(async({backend})=>{const joined=await Promise.allSettled([backend.stopComputer(),backend.closeTerminalWindows(),backend.closeTerminals()]);const failures=joined.filter((r):r is PromiseRejectedResult=>r.status==='rejected');if(failures.length)throw new AggregateError(failures.map(r=>r.reason),'Remote session cleanup unconfirmed');}));await Promise.allSettled([...active]);const failures=results.filter((r):r is PromiseRejectedResult=>r.status==='rejected');if(failures.length||debts.length)throw new AggregateError([...failures.map(r=>r.reason),...debts],'Remote project cleanup is unconfirmed');await closeRemoteNativeRead(native);mutations.close();})();},
 } satisfies RemoteProjectBackend);
}
