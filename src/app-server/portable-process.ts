import {spawn,type ChildProcessWithoutNullStreams} from "node:child_process";
import {cloneOwnedSerdeValue} from "../core/owned-serde-value.ts";
import {serdeField,serdeObject} from "./value.ts";
import {NodeAppServerInput,NodeAppServerByteSource} from "./node-streams.ts";
export interface PortableProcessConfig{readonly executable:string;readonly arguments:readonly string[];readonly environment:Readonly<Record<string,string>>}
const ownedSpawnFailures = new WeakSet<object>();
export function isOwnedAppServerSpawnError(value: unknown): boolean {return value !== null && (typeof value === "object" || typeof value === "function") && ownedSpawnFailures.has(value);}
export class AppServerSpawnError extends Error{readonly executable:string;constructor(executable:string,cause:unknown){super(`could not start Codex app-server at ${executable}`,{cause});this.name="AppServerSpawnError";this.executable=executable;ownedSpawnFailures.add(this);}}
export class AppServerProcessExitTimeout extends Error{constructor(){super("owned app-server process exit was not confirmed before cleanup timeout");this.name="AppServerProcessExitTimeout";}}
interface ProcessRecord{child:ChildProcessWithoutNullStreams;exited:boolean;pipesClosed:boolean;exit:Promise<void>;closed:Promise<void>}
const owned=new Set<ProcessRecord>();
const parentExit=()=>{for(const record of owned){if(!record.exited&&record.child.exitCode===null&&record.child.signalCode===null){try{record.child.kill("SIGKILL");}catch{/* Exit hook is best effort, never a reaping proof. */}}}};
function track(record:ProcessRecord):void{if(record.exited)return;if(owned.size===0)process.on("exit",parentExit);owned.add(record);}
function untrack(record:ProcessRecord):void{owned.delete(record);if(owned.size===0)process.off("exit",parentExit);}
function text(value:unknown):asserts value is string{if(typeof value!=="string"||/[\u0000\uD800-\uDFFF]/u.test(value))throw new TypeError("Expected NUL-free Unicode process text");}
function configSnapshot(config:PortableProcessConfig){
  const value=cloneOwnedSerdeValue(config),executable=serdeField(value,"executable"),args=serdeField(value,"arguments"),environment=serdeField(value,"environment");text(executable);if(!Array.isArray(args)||!serdeObject(environment))throw new TypeError("Expected process arguments and environment");
  const arguments_:string[]=[];for(const arg of args){text(arg);arguments_.push(arg);}
  const env:NodeJS.ProcessEnv=Object.assign(Object.create(null),process.env);
  for(const key of Object.keys(environment)){text(key);if(key===""||key.includes("="))throw new TypeError("Invalid environment variable name");const value=serdeField(environment,key);text(value);env[key]=value;}
  return {executable,arguments:arguments_,environment:env};
}
function waitWithSignal<T>(result:Promise<T>,signal?:AbortSignal):Promise<T>{
  if(signal===undefined)return result;if(signal.aborted)return Promise.reject(signal.reason);
  return new Promise((resolve,reject)=>{const abort=()=>{signal.removeEventListener("abort",abort);reject(signal.reason);};signal.addEventListener("abort",abort,{once:true});void result.then(value=>{signal.removeEventListener("abort",abort);resolve(value);},error=>{signal.removeEventListener("abort",abort);reject(error);});});
}
/** Non-Windows Node profile for the frozen portable direct-child path. No shell,
 * process-group/descendant kill, Windows Job Object, or automatic Rust Drop claim.
 * Explicit forceDispose must be awaited; parent-exit killing is only best effort. */
export class OwnedPortableAppServerProcess{
  readonly #record:ProcessRecord;readonly processId:number;readonly input:NodeAppServerInput;readonly stdout:NodeAppServerByteSource;readonly stderr:NodeAppServerByteSource;#dispose:Promise<void>|undefined;
  private constructor(record:ProcessRecord,pid:number){this.#record=record;this.processId=pid;this.input=new NodeAppServerInput(record.child.stdin);this.stdout=new NodeAppServerByteSource(record.child.stdout);this.stderr=new NodeAppServerByteSource(record.child.stderr);}
  static async spawn(config:PortableProcessConfig):Promise<OwnedPortableAppServerProcess>{
    if(process.platform==="win32")throw new TypeError("Windows native process ownership is not implemented by the portable profile");
    const copied=configSnapshot(config);let child:ChildProcessWithoutNullStreams;
    try{child=spawn(copied.executable,copied.arguments,{stdio:["pipe","pipe","pipe"],shell:false,env:copied.environment});}catch(error){throw new AppServerSpawnError(copied.executable,error);}
    let resolveExit!:()=>void,resolveClose!:()=>void;
    const record:ProcessRecord={child,exited:false,pipesClosed:false,exit:new Promise(resolve=>{resolveExit=resolve;}),closed:new Promise(resolve=>{resolveClose=resolve;})};
    child.once("exit",()=>{record.exited=true;untrack(record);resolveExit();});child.once("close",()=>{record.pipesClosed=true;resolveClose();});
    // Native error emissions are always observed, including before port construction.
    const streamError=()=>{};for(const stream of [child.stdin,child.stdout,child.stderr])stream?.on("error",streamError);child.on("error",()=>{});
    try{
      await new Promise<void>((resolve,reject)=>{const error=(error:Error)=>{child.off("spawn",ready);reject(error);};const ready=()=>{child.off("error",error);resolve();};child.once("error",error);child.once("spawn",ready);});
    }catch(error){for(const stream of [child.stdin,child.stdout,child.stderr])stream?.destroy();await record.closed;throw new AppServerSpawnError(copied.executable,error);}
    track(record);
    if(child.pid===undefined||!Number.isInteger(child.pid)||child.pid<=0||child.pid>0xffffffff||child.stdin===null||child.stdout===null||child.stderr===null){
      if(!record.exited&&child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");for(const stream of [child.stdin,child.stdout,child.stderr])stream?.destroy();await record.closed;throw new AppServerSpawnError(copied.executable,new Error("spawned child did not expose its required identity/pipes"));
    }
    const result=new OwnedPortableAppServerProcess(record,child.pid);for(const stream of [child.stdin,child.stdout,child.stderr])stream.off("error",streamError);return result;
  }
  get exitConfirmed():boolean{return this.#record.exited;}
  get stdioClosed():boolean{return this.#record.pipesClosed;}
  wait(signal?:AbortSignal):Promise<void>{return waitWithSignal(this.#record.exit,signal);}
  tryWait():boolean{return this.#record.exited;}
  startKill():void{
    const record=this.#record;if(record.exited||record.child.exitCode!==null||record.child.signalCode!==null)return;
    if(!record.child.kill("SIGKILL"))throw new Error("signal to owned app-server child was not accepted");
  }
  /** Force-cleanup this exact spawned child. Success requires exit AND owned pipe close,
   * not merely child.killed. Does not kill descendants or certify other native platforms. */
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
