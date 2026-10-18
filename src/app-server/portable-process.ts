import {spawn,type ChildProcessWithoutNullStreams} from "node:child_process";
import {randomUUID} from "node:crypto";
import {fileURLToPath} from "node:url";
import {WindowsProcessJob} from "./windows-process-job.ts";
import {cloneOwnedSerdeValue} from "../core/owned-serde-value.ts";
import {serdeField,serdeObject} from "./value.ts";
import {NodeAppServerInput,NodeAppServerByteSource} from "./node-streams.ts";
export interface PortableProcessConfig{readonly cwd?:string;readonly inheritEnvironment?:boolean;readonly executable:string;readonly arguments:readonly string[];readonly environment:Readonly<Record<string,string>>}
const ownedSpawnFailures = new WeakSet<object>();
export function isOwnedAppServerSpawnError(value: unknown): boolean {return value !== null && (typeof value === "object" || typeof value === "function") && ownedSpawnFailures.has(value);}
export class AppServerSpawnError extends Error{readonly executable:string;constructor(executable:string,cause:unknown){super(`could not start Codex app-server at ${executable}`,{cause});this.name="AppServerSpawnError";this.executable=executable;ownedSpawnFailures.add(this);}}
export class AppServerProcessExitTimeout extends Error{constructor(){super("owned app-server process exit was not confirmed before cleanup timeout");this.name="AppServerProcessExitTimeout";}}
interface ProcessRecord{child:ChildProcessWithoutNullStreams;job:WindowsProcessJob|undefined;exited:boolean;pipesClosed:boolean;exit:Promise<void>;closed:Promise<void>}
const owned=new Set<ProcessRecord>();
const parentExit=()=>{for(const record of owned){try{if(record.job!==undefined)record.job.terminate();else if(!record.exited&&record.child.exitCode===null&&record.child.signalCode===null)record.child.kill("SIGKILL");}catch{/* Exit hook is best effort, never a reaping proof. */}}};
function track(record:ProcessRecord):void{if(record.exited)return;if(owned.size===0)process.on("exit",parentExit);owned.add(record);}
function untrack(record:ProcessRecord):void{owned.delete(record);if(owned.size===0)process.off("exit",parentExit);}
function text(value:unknown):asserts value is string{if(typeof value!=="string"||/[\u0000\uD800-\uDFFF]/u.test(value))throw new TypeError("Expected NUL-free Unicode process text");}
function configSnapshot(config:PortableProcessConfig){
  const value=cloneOwnedSerdeValue(config),executable=serdeField(value,"executable"),args=serdeField(value,"arguments"),environment=serdeField(value,"environment");text(executable);if(!Array.isArray(args)||!serdeObject(environment))throw new TypeError("Expected process arguments and environment");
  const arguments_:string[]=[];for(const arg of args){text(arg);arguments_.push(arg);}
  const cwd=serdeField(value,'cwd'),inherit=serdeField(value,'inheritEnvironment');if(cwd!==undefined)text(cwd);if(inherit!==undefined&&typeof inherit!=='boolean')throw new TypeError('Invalid environment inheritance');
  const env:NodeJS.ProcessEnv=Object.assign(Object.create(null),inherit===false?{}:process.env);
  if(process.platform==='win32')for(const key of Object.keys(env))if(['CODEX_APP_TOOLS_PIPE_PATH','BROWSER_USE_ACCESS_VERIFYING_IDENTITY','CODEX_TASK_WORKSPACE_VERIFYING_IDENTITY','SKY_CUA_NATIVE_PIPE_DIRECTORY','CODEX_INTERNAL_ORIGINATOR_OVERRIDE','CODEX_SESSION_ID','CODEX_THREAD_ID'].includes(key.toUpperCase()))delete env[key];
  for(const key of Object.keys(environment)){text(key);if(key===""||key.includes("="))throw new TypeError("Invalid environment variable name");const value=serdeField(environment,key);text(value);if(process.platform==='win32')for(const inherited of Object.keys(env))if(inherited.toLowerCase()===key.toLowerCase())delete env[inherited];env[key]=value;}
  return {executable,arguments:arguments_,environment:env,...(cwd===undefined?{}:{cwd:cwd as string})};
}
function waitWithSignal<T>(result:Promise<T>,signal?:AbortSignal):Promise<T>{
  if(signal===undefined)return result;if(signal.aborted)return Promise.reject(signal.reason);
  return new Promise((resolve,reject)=>{const abort=()=>{signal.removeEventListener("abort",abort);reject(signal.reason);};signal.addEventListener("abort",abort,{once:true});void result.then(value=>{signal.removeEventListener("abort",abort);resolve(value);},error=>{signal.removeEventListener("abort",abort);reject(error);});});
}
/** POSIX direct child; Windows uses a bootstrap enrolled in a kill-on-close Job
 * before Codex starts. Reported processId is Codex's PID, not the bootstrap PID.
 * Explicit forceDispose must be awaited; POSIX parent-exit killing is best effort. */
export class OwnedPortableAppServerProcess{
  readonly #record:ProcessRecord;readonly processId:number;readonly input:NodeAppServerInput;readonly stdout:NodeAppServerByteSource;readonly stderr:NodeAppServerByteSource;#dispose:Promise<void>|undefined;
  private constructor(record:ProcessRecord,pid:number){this.#record=record;this.processId=pid;this.input=new NodeAppServerInput(record.child.stdin);this.stdout=new NodeAppServerByteSource(record.child.stdout);this.stderr=new NodeAppServerByteSource(record.child.stderr);}
  static async spawn(config:PortableProcessConfig):Promise<OwnedPortableAppServerProcess>{
    const copied=configSnapshot(config);let child:ChildProcessWithoutNullStreams,job:WindowsProcessJob|undefined;
    const nonce=randomUUID();
    try{
      if(process.platform==='win32'){
        job=WindowsProcessJob.create();
        const helper=fileURLToPath(new URL('./windows-process-bootstrap.js',import.meta.url));
        const helperEnv={...copied.environment};for(const key of Object.keys(helperEnv))if(key.toUpperCase()==='NODE_OPTIONS')delete helperEnv[key];
        child=spawn(process.execPath,['--no-strip-types',helper,job.name,nonce],{stdio:['pipe','pipe','pipe','ipc'],shell:false,windowsHide:true,env:helperEnv}) as ChildProcessWithoutNullStreams;
      }else child=spawn(copied.executable,copied.arguments,{stdio:["pipe","pipe","pipe"],shell:false,env:copied.environment,...(copied.cwd===undefined?{}:{cwd:copied.cwd})});
    }catch(error){if(job!==undefined)await job.finish();throw new AppServerSpawnError(copied.executable,error);}
    let resolveExit!:()=>void,rejectExit!:(error:unknown)=>void,resolveClose!:()=>void;
    const record:ProcessRecord={child,job,exited:false,pipesClosed:false,exit:new Promise((resolve,reject)=>{resolveExit=resolve;rejectExit=reject;}),closed:new Promise(resolve=>{resolveClose=resolve;})};
    void record.exit.catch(()=>undefined);
    child.once("exit",()=>{const joined=()=>{record.exited=true;untrack(record);resolveExit();};if(job===undefined)joined();else void job.finish().then(joined,rejectExit);});child.once("close",()=>{record.pipesClosed=true;resolveClose();});
    // Native error emissions are always observed, including before port construction.
    const streamError=()=>{};for(const stream of [child.stdin,child.stdout,child.stderr])stream?.on("error",streamError);child.on("error",()=>{});
    let processId:number|undefined;
    track(record);
    try{
      await new Promise<void>((resolve,reject)=>{const error=(error:Error)=>{child.off("spawn",ready);reject(error);};const ready=()=>{child.off("error",error);resolve();};child.once("error",error);child.once("spawn",ready);});
      processId=job===undefined?child.pid:await startWindowsProvider(child,nonce,copied);
    }catch(error){
      // Bootstrap may fail before joining the job. The original ChildProcess
      // handle still owns it; an empty job alone is not proof that it exited.
      if(job!==undefined&&child.pid!==undefined&&child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
      if(job!==undefined)await job.finish();for(const stream of [child.stdin,child.stdout,child.stderr])stream?.destroy();await record.closed;untrack(record);throw new AppServerSpawnError(copied.executable,error);
    }
    if(processId===undefined||!Number.isInteger(processId)||processId<=0||processId>0xffffffff||child.stdin===null||child.stdout===null||child.stderr===null){
      if(job!==undefined)await job.finish();else if(!record.exited&&child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");for(const stream of [child.stdin,child.stdout,child.stderr])stream?.destroy();await record.closed;throw new AppServerSpawnError(copied.executable,new Error("spawned child did not expose its required identity/pipes"));
    }
    const result=new OwnedPortableAppServerProcess(record,processId);for(const stream of [child.stdin,child.stdout,child.stderr])stream.off("error",streamError);return result;
  }
  get exitConfirmed():boolean{return this.#record.exited;}
  get exitCode():number|null{return this.#record.child.exitCode;}
  get stdioClosed():boolean{return this.#record.pipesClosed;}
  wait(signal?:AbortSignal):Promise<void>{return waitWithSignal(this.#record.exit,signal);}
  tryWait():boolean{return this.#record.exited;}
  startKill():void{
    const record=this.#record;if(record.exited)return;if(record.job!==undefined){record.job.terminate();return;}if(record.child.exitCode!==null||record.child.signalCode!==null)return;
    if(!record.child.kill("SIGKILL"))throw new Error("signal to owned app-server child was not accepted");
  }
  /** Force-cleanup this exact spawned child. Success requires exit AND owned pipe close,
   * not merely child.killed. Windows also joins every member of its original job. */
  forceDispose(timeoutMs=5000):Promise<void>{
    if(this.#dispose!==undefined)return this.#dispose;
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<=0||timeoutMs>2147483647)return Promise.reject(new TypeError("Expected bounded cleanup timeout"));
    this.#dispose=this.#forceDispose(timeoutMs);void this.#dispose.catch(()=>undefined);return this.#dispose;
  }
  async #forceDispose(timeoutMs:number):Promise<void>{
    let failed=false,first:unknown;try{this.startKill();}catch(error){failed=true;first=error;}
    const abort=new AbortController(),timer=setTimeout(()=>abort.abort(new AppServerProcessExitTimeout()),timeoutMs);
    try{
      try{await this.wait(abort.signal);}catch(error){if(!failed){failed=true;first=error;}}
      if(!this.#record.exited){if(failed)throw first;throw new AppServerProcessExitTimeout();}
      try{
        for(const result of await waitWithSignal(Promise.allSettled([this.input.destroyAndJoin(),this.stdout.destroyAndJoin(),this.stderr.destroyAndJoin()]),abort.signal))if(result.status==="rejected"&&!failed){failed=true;first=result.reason;}
        await waitWithSignal(this.#record.closed,abort.signal);
      }catch(error){if(!failed){failed=true;first=error;}}
      if(failed)throw first;
    }finally{clearTimeout(timer);}
  }
}

function startWindowsProvider(child:ChildProcessWithoutNullStreams,nonce:string,config:ReturnType<typeof configSnapshot>):Promise<number>{
  return new Promise((resolve,reject)=>{
    let ready=false,settled=false;
    const finish=(error:unknown,pid?:number)=>{if(settled)return;settled=true;clearTimeout(timer);child.off('message',message);child.off('exit',exited);child.off('error',failed);if(error!==undefined)reject(error);else resolve(pid!);};
    const failed=(error:Error)=>finish(error),exited=()=>finish(new Error('Windows process bootstrap exited before launch acknowledgement'));
    const message=(value:unknown)=>{
      const packet=value as {kind?:unknown;nonce?:unknown;pid?:unknown};
      if(packet?.nonce!==nonce)return finish(new Error('Windows process bootstrap identity differs'));
      if(packet.kind==='ready'&&!ready){ready=true;child.send({kind:'launch',nonce,...config},error=>{if(error)finish(error);});}
      else if(packet.kind==='started'&&ready&&typeof packet.pid==='number'&&Number.isInteger(packet.pid)&&packet.pid>0&&packet.pid<=0xffffffff)finish(undefined,packet.pid);
      else finish(new Error('Windows process bootstrap did not confirm launch'));
    };
    const timer=setTimeout(()=>finish(new Error('Windows process bootstrap timed out')),10000);
    child.on('message',message);child.once('exit',exited);child.once('error',failed);
    if(child.exitCode!==null||child.signalCode!==null)exited();
  });
}
