import {types} from 'node:util';
import {gatewayOwnField as own} from '../discord/gateway/values.ts';
import {requireDiscordText} from '../discord/text.ts';
import {formatRemoteUtcDateTime} from './datetime-format.ts';
import {RemoteReadOwner,listRemoteOwnedFiles,closeRemoteNativeRead,assertRemoteNativeReadHealthy,type RemoteNativeRead} from './files/read-owner.ts';
import {readRemoteFile} from './files/read-file.ts';
import {checkRemoteReadCancellation} from './files/read-signal.ts';
import {RemoteFilePolicyError} from './files/path-policy.ts';
import {RemoteRequestBudget,RemoteDeadlineError} from './request-budget.ts';
import type {RemoteProjectBackend,RemoteProjectBinding,RemoteSessionBackend,RemoteOperationContext} from './dispatcher-ports.ts';
import type {RemoteSessionIdentity} from './session-decisions.ts';
export interface RemoteNativeReadGrant {readonly threadId:string;readonly nativeRead:RemoteReadOwner;}
export interface RemoteNativeReadFactory {readonly openProject:(binding:RemoteProjectBinding)=>Promise<RemoteProjectBackend>;readonly dispose:()=>Promise<void>;}
function text(value:unknown):string{requireDiscordText(value);if(value.length===0||Buffer.byteLength(value)>4096)throw new TypeError('Invalid native read binding identity');return value;}
function uint(value:unknown,max:bigint):bigint{if(typeof value!=='bigint'||value<0n||value>max)throw new TypeError('Expected bounded unsigned native read input');return value;}
function binding(value:RemoteProjectBinding):RemoteProjectBinding{const expiresAt=own(value,'expiresAt') as RemoteProjectBinding['expiresAt'];formatRemoteUtcDateTime(expiresAt);return Object.freeze({threadId:text(own(value,'threadId')),root:text(own(value,'root')),expiresAt:Object.freeze({seconds:own(expiresAt,'seconds') as bigint,nanosecond:own(expiresAt,'nanosecond') as bigint})});}
/** Explicit local transfer of already-bound native owners. No path-based factory,
 * ambient discovery, root opening or native permission is derived from a command.
 * The caller must dispose the factory after its dispatcher has closed. Disposal
 * itself also aborts/joins all accepted backend work before closing native owners.
 * Not installed in CLI roots or a production remote profile. */
export function createRemoteNativeReadFactory(input:readonly RemoteNativeReadGrant[]):RemoteNativeReadFactory{
 if(types.isProxy(input)||!Array.isArray(input))throw new TypeError('Expected passive native read allowlist');const length=own(input,'length');if(typeof length!=='number'||length<1||length>16)throw new RangeError('Native read allowlist requires 1..16 projects');
 const captured:{threadId:string;owner:RemoteReadOwner;root:string}[]=[],threads=new Set<string>(),owners=new Set<RemoteReadOwner>();
 for(let i=0;i<length;i++){const entry=own(input,String(i)),threadId=text(own(entry,'threadId')),owner=own(entry,'nativeRead') as RemoteReadOwner;
  if(owner===null||typeof owner!=='object'||types.isProxy(owner))throw new TypeError('Expected actual owned native reader');RemoteReadOwner.prototype.assertTransferable.call(owner);
  const root=text(Reflect.getOwnPropertyDescriptor(RemoteReadOwner.prototype,'root')!.get!.call(owner));if(threads.has(threadId)||owners.has(owner))throw new TypeError('Duplicate native read grant');threads.add(threadId);owners.add(owner);captured.push({threadId,owner,root});
 }
 const grants=new Map<string,RemoteNativeRead>();for(const entry of captured)grants.set(entry.threadId,RemoteReadOwner.prototype.transfer.call(entry.owner));
 const backends=new Set<()=>Promise<void>>();let closed=false,disposed:Promise<void>|null=null,active=0;
 const openProject=async(input:RemoteProjectBinding):Promise<RemoteProjectBackend>=>{
  const bound=binding(input);if(closed)throw new TypeError('Native read factory is disposed');const nativeRead=grants.get(bound.threadId);
  if(nativeRead===undefined||nativeRead.root!==bound.root)throw new RemoteFilePolicyError('UnsafePath',bound.root,'project binding has no captured native read grant');
  assertRemoteNativeReadHealthy(nativeRead);
  if(backends.size>=20)throw new RemoteFilePolicyError('Limit','project','native read backend ownership capacity reached');
  const sessions=new WeakSet<object>(),accepted=new Set<Promise<unknown>>(),stop=new AbortController();let closing:Promise<void>|null=null;
  const close=():Promise<void>=>{if(closing!==null)return closing;stop.abort(new RemoteDeadlineError('Cancelled'));closing=(async()=>{await Promise.allSettled([...accepted]);assertRemoteNativeReadHealthy(nativeRead);backends.delete(close);})();return closing;};backends.add(close);
  const run=<T>(context:RemoteOperationContext,work:(signal:AbortSignal)=>Promise<T>):Promise<T>=>{
   const actual=own(context,'binding') as RemoteProjectBinding,session=own(context,'session') as RemoteSessionIdentity,signal=own(context,'signal') as AbortSignal,budget=own(context,'budget') as RemoteRequestBudget;
   if(types.isProxy(signal)||!(signal instanceof AbortSignal))throw new TypeError('Expected owned operation signal');checkRemoteReadCancellation(signal);
   if(actual!==input||types.isProxy(session)||!sessions.has(session))throw new TypeError('Native read operation belongs to another binding or session');
   if(closed||closing!==null)throw new TypeError('Native read backend is closed');if(active>=4)throw new RemoteFilePolicyError('Limit','project','four native read operations already active');
   const remaining=()=>RemoteRequestBudget.prototype.remaining.call(budget);remaining();const deadline=new AbortController();const combined=AbortSignal.any([signal,stop.signal,deadline.signal]);let timer:ReturnType<typeof setTimeout>|undefined;
   const arm=()=>{try{const ns=remaining(),ms=Number((ns+999999n)/1000000n);timer=setTimeout(arm,Math.min(ms,2147483647));}catch(error){deadline.abort(error);}};arm();
   active++;
   const task=Promise.resolve().then(async()=>{combined.throwIfAborted();try{const result=await work(combined);combined.throwIfAborted();remaining();return result;}catch(error){combined.throwIfAborted();remaining();throw error;}}).finally(()=>{clearTimeout(timer);active--;accepted.delete(task);});accepted.add(task);return task;
  };
  const createSession=async(identity:RemoteSessionIdentity):Promise<RemoteSessionBackend>=>{
   if(closed||closing!==null)throw new TypeError('Native read backend is closed');assertRemoteNativeReadHealthy(nativeRead);if(identity===null||typeof identity!=='object'||types.isProxy(identity))throw new TypeError('Expected owned read session');sessions.add(identity);
   let retirement:Promise<void>|null=null;const retire=():Promise<void>=>{if(retirement===null)retirement=Promise.resolve().then(()=>{sessions.delete(identity);assertRemoteNativeReadHealthy(nativeRead);});return retirement;};
   // A read-only session owns no UI or terminal resource. These release ports
   // retire its read identity; the corresponding operation ports remain absent.
   return Object.freeze({stopComputer:retire,closeTerminalWindows:retire,closeTerminals:retire,computer:null,terminal:null,terminalWindow:null});
  };
  return Object.freeze({close,createSession,
   listFiles:async(command,context)=>{if(own(command,'type')!=='list_files'||own(command,'thread_id')!==bound.threadId)throw new TypeError('Native list command binding mismatch');const pattern=own(command,'pattern');requireDiscordText(pattern);const limit=uint(own(command,'limit'),65535n);return run(context,signal=>listRemoteOwnedFiles(nativeRead,pattern,Number(limit),signal));},
   readFile:async(command,context)=>{if(own(command,'type')!=='read_file'||own(command,'thread_id')!==bound.threadId)throw new TypeError('Native read command binding mismatch');const path=own(command,'path');requireDiscordText(path);const start=uint(own(command,'start_line'),18446744073709551615n),lines=uint(own(command,'max_lines'),65535n);return run(context,signal=>readRemoteFile(nativeRead,path,start,Number(lines),signal));},
   writeFile:null,core:null} satisfies RemoteProjectBackend);
 };
 const dispose=():Promise<void>=>{if(disposed!==null)return disposed;closed=true;disposed=(async()=>{const backendsClosed=await Promise.allSettled([...backends].map(close=>close()));const results=await Promise.allSettled([...grants.values()].map(closeRemoteNativeRead)),failed=[...backendsClosed,...results].filter((r):r is PromiseRejectedResult=>r.status==='rejected');if(failed.length)throw new AggregateError(failed.map(r=>r.reason),'Native project read disposal failed');})();return disposed;};
 return Object.freeze({openProject,dispose});
}
