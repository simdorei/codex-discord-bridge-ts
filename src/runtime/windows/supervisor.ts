import {randomUUID} from 'node:crypto';
import {mkdir,open,readdir,readFile,rename,unlink,realpath} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {OwnedPortableAppServerProcess,type PortableProcessConfig} from '../../app-server/portable-process.ts';
import {acquireWindowsSingletonOwner,releaseWindowsSingletonOwner} from './windows-singleton-owner.ts';
import {WindowsFilePin} from './windows-file-pin.ts';
import {writeWindowsAtomicFile} from './windows-atomic-file.ts';
import {DRAIN_MARKER_NAMES,parseRuntimeIdentityMarker,parseRuntimeFenceMarker,encodeRuntimeAckMarker,type RuntimeMarker} from '../restart-readiness/drain-marker.ts';
import {DrainFenceKey} from '../../admission/owned-key.ts';

export const SUPERVISOR_MANIFEST='.cdr-ts-supervisor.json';
const controls='.cdr-ts-controls';
export type SupervisorAction='restart'|'force_restart'|'stop';
interface Manifest{version:1;nonce:string;processId:number;root:string;node:string;entry:string;childPid:number|null;updatedAt:number;}
export interface RestartTiming{delaySeconds?:number;quietSeconds?:number;waitSeconds?:number;}
interface Request{version:1;operation:string;nonce:string;action:SupervisorAction;runtimeId:string;childPid:number;expiresAt:number;notBefore?:number;quietMs?:number;waitMs?:number;}
async function bounded(path:string):Promise<string>{const h=await open(path,'r');try{const b=Buffer.alloc(65537);const{bytesRead}=await h.read(b,0,b.length,0);if(bytesRead>65536)throw new Error('Supervisor record exceeds bound');return new TextDecoder('utf-8',{fatal:true}).decode(b.subarray(0,bytesRead));}finally{await h.close();}}
async function optional(path:string):Promise<string|null>{try{return await bounded(path);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}}
async function identity(root:string):Promise<RuntimeMarker|null>{const path=join(root,DRAIN_MARKER_NAMES.identity),text=await optional(path);return text===null?null:parseRuntimeIdentityMarker(text,path);}
async function remove(path:string){try{await unlink(path);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
function request(value:unknown):Request{const v=value as Request;if(v?.version!==1||!/^[a-f0-9]{32}$/.test(v.operation)||typeof v.nonce!=='string'||typeof v.runtimeId!=='string'||!['restart','force_restart','stop'].includes(v.action)||!Number.isSafeInteger(v.childPid)||!Number.isSafeInteger(v.expiresAt))throw new Error('Invalid supervisor request');for(const key of ['notBefore','quietMs','waitMs'] as const)if(v[key]!==undefined&&(!Number.isSafeInteger(v[key])||v[key]!<0||key!=='notBefore'&&v[key]!>86400000))throw new Error('Invalid supervisor timing');return v;}
export async function supervisorStatus(root:string):Promise<Manifest>{const v=JSON.parse(await bounded(join(root,SUPERVISOR_MANIFEST))) as Manifest;if(v.version!==1||v.root!==root||!Number.isSafeInteger(v.processId)||typeof v.nonce!=='string'||!isAbsolute(v.node)||!isAbsolute(v.entry))throw new Error('Supervisor binding differs');return v;}
/** Durable request, bound to one supervisor generation and one runtime identity.
 * Dispatch is not completion. The unique receipt remains available after restart. */
export async function requestSupervisor(root:string,action:SupervisorAction,signal?:AbortSignal,expectedRuntime?:string,timing:RestartTiming={}):Promise<{operation:string;receipt:string}>{
 for(const value of Object.values(timing))if(!Number.isSafeInteger(value)||value<0||value>86400)throw new Error('Restart timing must be an integer from 0 to 86400 seconds');
 if(action!=='restart'&&Object.keys(timing).length)throw new Error('Restart timing applies only to a graceful restart');
 signal?.throwIfAborted();const manifest=await supervisorStatus(root),runtime=await identity(root);if(runtime===null||manifest.childPid!==runtime.processId||(expectedRuntime!==undefined&&runtime.runtimeId!==expectedRuntime))throw new Error('No matching supervised runtime');
 const operation=randomUUID().replaceAll('-',''),directory=join(root,controls);await mkdir(directory,{recursive:true});const pin=WindowsFilePin.acquire(directory,'directory');
 try{const now=Date.now(),value:Request={version:1,operation,nonce:manifest.nonce,action,runtimeId:runtime.runtimeId,childPid:runtime.processId,expiresAt:now+(timing.delaySeconds??0)*1000+120000,notBefore:now+(timing.delaySeconds??0)*1000,quietMs:(timing.quietSeconds??0)*1000,waitMs:(timing.waitSeconds??120)*1000};signal?.throwIfAborted();await writeWindowsAtomicFile(join(directory,operation+'.json'),JSON.stringify(value));return{operation,receipt:join(directory,operation+'.receipt.json')};}finally{pin.close();}
}
/** Acquiring the original mutex proves there is no live conforming runtime.
 * This clears only transport markers; queue attempts and uncertain work survive. */
async function clearJoinedMarkers(root:string,includeStop:boolean){const guard=acquireWindowsSingletonOwner(root);try{for(const kind of ['identity','prepare','ack','restart'] as const)await remove(join(root,DRAIN_MARKER_NAMES[kind]));if(includeStop)await remove(join(root,DRAIN_MARKER_NAMES.stop));}finally{const result=await releaseWindowsSingletonOwner(guard);if(result.closure!=='closed')throw new Error('Runtime exclusion release is unconfirmed');}}
export interface SupervisorOptions{root:string;entry:string;arguments:readonly string[];environment:Readonly<Record<string,string>>;signal?:AbortSignal;clearStop?:boolean;restartDelayMs?:number;onRuntimeStarted?:()=>void;}
export async function runWindowsSupervisor(options:SupervisorOptions):Promise<void>{
 if(process.platform!=='win32')throw new Error('Windows supervisor requires Windows');
 const root=await realpath(options.root);if(root!==options.root)throw new Error('Supervisor root must be canonical');const pin=WindowsFilePin.acquire(root,'directory'),guard=acquireWindowsSingletonOwner(join(root,'.cdr-ts-watchdog'));
 const manifest:Manifest={version:1,nonce:randomUUID(),processId:process.pid,root,node:process.execPath,entry:options.entry,childPid:null,updatedAt:Date.now()};
 const directory=join(root,controls);let child:OwnedPortableAppServerProcess|undefined,pipes:Promise<unknown>|undefined;let retain=false,resumeBindings=false;const crashes:number[]=[];
 const publish=async()=>{manifest.updatedAt=Date.now();await writeWindowsAtomicFile(join(root,SUPERVISOR_MANIFEST),JSON.stringify(manifest));};
 const receipt=async(r:Request,phase:string,extra:Record<string,unknown>={})=>writeWindowsAtomicFile(join(directory,r.operation+'.receipt.json'),JSON.stringify({version:1,operation:r.operation,phase,action:r.action,runtimeId:r.runtimeId,oldPid:r.childPid,at:Date.now(),...extra}));
 try{
  await mkdir(directory,{recursive:true});if(!options.clearStop&&await optional(join(root,DRAIN_MARKER_NAMES.stop))!==null)return;await clearJoinedMarkers(root,options.clearStop===true);
  for(;;){
   options.signal?.throwIfAborted();const config:PortableProcessConfig={executable:process.execPath,arguments:[options.entry,...options.arguments],cwd:root,environment:{...options.environment,CODEX_DISCORD_ROOT:root,CDR_SUPERVISOR_NONCE:manifest.nonce,CODEX_REMOTE_MCP_RESUME_BINDINGS:resumeBindings?'1':'0'},inheritEnvironment:false};
   child=await OwnedPortableAppServerProcess.spawn(config);manifest.childPid=child.processId;await publish();await child.input.shutdown();options.onRuntimeStarted?.();
   const pump=async(source:OwnedPortableAppServerProcess['stdout'],channel:string)=>{const path=join(root,'cdr-'+channel+'.log');let file=await open(path,'a',0o600),size=(await file.stat()).size;try{for(;;){const b=await source.readChunk();if(b===null)return;if(size+b.length>5242880){await file.close();await remove(path+'.1');await rename(path,path+'.1');file=await open(path,'w',0o600);size=0;}await file.writeFile(b);size+=b.length;}}finally{await file.close();}};
   pipes=Promise.all([pump(child.stdout,'stdout'),pump(child.stderr,'stderr')]);void pipes.catch(()=>{try{child?.startKill();}catch{}});
   let selected:Request|undefined,stop=false,forced=false;
   let draining:{key:DrainFenceKey;encoded:string;deadline:number;quietSince:number|null;timedOut:boolean;committed:boolean}|undefined;
   while(!child.exitConfirmed){
    if(options.signal?.aborted){stop=true;await writeWindowsAtomicFile(join(root,DRAIN_MARKER_NAMES.stop),'supervisor_stop\n');break;}
    if(await optional(join(root,DRAIN_MARKER_NAMES.stop))!==null){stop=true;break;}
    const files=(await readdir(directory)).filter(x=>/^[a-f0-9]{32}\.json$/.test(x));if(files.length>64)throw new Error('Supervisor request capacity exceeded');
    for(const leaf of files){const path=join(directory,leaf);let r:Request;try{r=request(JSON.parse(await bounded(path)));}catch{await rename(path,path+'.invalid');continue;}
     await rename(path,path+'.claimed');const current=await identity(root);
     if(r.nonce!==manifest.nonce||r.childPid!==child.processId||current?.runtimeId!==r.runtimeId||r.expiresAt<Date.now()){await receipt(r,'rejected');continue;}
     if(selected&&r.action==='restart'){await receipt(r,'restart_pending');continue;}
     if(selected)await receipt(selected,'superseded',{by:r.operation});
     selected=r;draining=undefined;await receipt(r,'accepted');break;
    }
    if(selected&&Date.now()>=(selected.notBefore??0)){
     if(selected.action==='force_restart'){forced=true;child.startKill();break;}if(selected.action==='stop'){stop=true;await writeWindowsAtomicFile(join(root,DRAIN_MARKER_NAMES.stop),'supervisor_stop\n');break;}
     if(!draining){const key=DrainFenceKey.create(selected.runtimeId,`${child.processId}|0`,selected.operation),encoded=encodeRuntimeAckMarker(key);await writeWindowsAtomicFile(join(root,DRAIN_MARKER_NAMES.prepare),encoded);draining={key,encoded,deadline:Date.now()+(selected.waitMs??120000),quietSince:null,timedOut:false,committed:false};}
     // Waiting for a seal or quiet period must not block subsequent stop/force
     // controls. A timeout preserves the seal and never escalates to a kill.
     if(!draining.timedOut&&!draining.committed){const ack=await optional(join(root,DRAIN_MARKER_NAMES.ack));if(ack!==null&&draining.key.equals(parseRuntimeFenceMarker(ack,'supervisor-ack','sealed'))){draining.quietSince??=Date.now();if(Date.now()-draining.quietSince>=(selected.quietMs??0)){await writeWindowsAtomicFile(join(root,DRAIN_MARKER_NAMES.restart),draining.encoded);draining.committed=true;await receipt(selected,'restart_requested');}}else draining.quietSince=null;
      if(!draining.committed&&Date.now()>=draining.deadline){draining.timedOut=true;await receipt(selected,'drain_pending');}
     }
    }
    await sleep(100);
   }
   if(stop&&!child.exitConfirmed){const until=Date.now()+15000;while(!child.exitConfirmed&&Date.now()<until)await sleep(100);if(!child.exitConfirmed)child.startKill();}
   await child.wait();await pipes;await child.forceDispose();child=undefined;pipes=undefined;manifest.childPid=null;await publish();
   resumeBindings=selected?.action==='restart'&&!forced;
   if(selected)await receipt(selected,'exited',{forced});
   await clearJoinedMarkers(root,!stop);if(stop)return;
   if(!selected){const now=Date.now();crashes.push(now);while(crashes[0]!==undefined&&crashes[0]<now-600000)crashes.shift();if(crashes.length>5)throw new Error('Watchdog crash limit reached; inspect cdr-stderr.log');}
   await sleep(options.restartDelayMs??1000);
  }
 }catch(error){if(child)try{await child.forceDispose();}catch(cleanup){retain=true;throw new AggregateError([error,cleanup],'Supervisor child ownership retained');}if(pipes)await pipes.catch(()=>{});throw error;}
 finally{if(!retain){const current=await optional(join(root,SUPERVISOR_MANIFEST));if(current!==null&&JSON.parse(current).nonce===manifest.nonce)await remove(join(root,SUPERVISOR_MANIFEST));const released=await releaseWindowsSingletonOwner(guard);if(released.closure!=='closed')throw new Error('Watchdog exclusion retained');pin.close();}}
}
