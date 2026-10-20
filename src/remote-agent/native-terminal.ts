import {randomBytes,createHash} from 'node:crypto';
import {realpath,stat,access} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute,delimiter} from 'node:path';
import {runOwnedCommand,OwnedCommandCleanupError} from '../runtime/windows/owned-command.ts';
import {redactRemoteText} from './files/redaction.ts';
import type {TerminalRequest,TerminalShell} from './terminal-request.ts';
import type {RemoteTerminalOutput} from './terminal-output.ts';
import type {RemoteOperationContext} from './dispatcher-ports.ts';
const id=(prefix:string)=>prefix+randomBytes(8).toString('hex');
export function terminalEnvironment():Record<string,string>{const env:Record<string,string>={};for(const [key,value]of Object.entries(process.env))if(value!==undefined&&!/TOKEN|SECRET|PASSWORD|PASSWD|COOKIE|CREDENTIAL|OTP/i.test(key))env[key]=value;return env;}
export async function findNativeExecutable(names:readonly string[]):Promise<string>{
 const extensions=process.platform==='win32'?['','.exe','.com']:[''];
 for(const name of names)for(const directory of isAbsolute(name)?['']:(process.env.PATH??'').split(delimiter))for(const suffix of extensions){const path=isAbsolute(name)?name:join(directory,name+suffix);try{if((await stat(path)).isFile())return path;}catch{}}
 throw new Error('Required executable is unavailable');
}
export async function terminalArguments(requested:TerminalShell,command:string){
 const shell=requested==='auto'?(process.platform==='win32'?'powershell':'sh'):requested;
 if(shell==='powershell')return {shell,executable:await findNativeExecutable(['pwsh','powershell']),arguments:['-NoLogo','-NoProfile','-NonInteractive','-Command',command]};
 if(shell==='cmd')return {shell,executable:await findNativeExecutable([process.env.ComSpec??'cmd']),arguments:['/D','/S','/C',command]};
 return {shell,executable:await findNativeExecutable([shell]),arguments:['-c',command]};
}
type Entry={cwd:string;environment:Record<string,string>;active:{abort:AbortController;done:Promise<RemoteTerminalOutput>}|null;};
/** Per-session IDs retain cwd/env, never a foreign shell. cancel_previous joins
 * the exact previous Job before reserving its replacement. */
export class NativeTerminalEngine{
 readonly #root:string;readonly #entries=new Map<string,Entry>();#closed=false;#failure:unknown;#closing:Promise<void>|undefined;
 constructor(root:string){this.#root=root;}
 async execute(request:TerminalRequest,context:RemoteOperationContext):Promise<RemoteTerminalOutput>{
  if(request.kind!=='terminal_exec')throw new TypeError('Expected terminal execution');context.signal.throwIfAborted();
  if(this.#closed||this.#failure)throw new Error('Terminal session is closed or cleanup is unconfirmed');
  const terminalId=request.terminal_id??id('term_');let entry=this.#entries.get(terminalId);
  if(!entry){if(request.terminal_id!==null)throw new Error('Terminal belongs to another session');if(this.#entries.size>=32)throw new Error('Terminal session capacity reached');entry={cwd:this.#root,environment:terminalEnvironment(),active:null};this.#entries.set(terminalId,entry);}
  while(entry.active){if(!request.cancel_previous)throw new Error('Terminal already has an active command');entry.active.abort.abort(new Error('Previous terminal command cancelled'));await entry.active.done.catch(()=>{});context.signal.throwIfAborted();if(this.#closed||this.#failure)throw new Error('Terminal ownership is unavailable');}
  const abort=new AbortController(),owned=entry;
  const done=Promise.resolve().then(async()=>{
   const signal=AbortSignal.any([context.signal,abort.signal]);signal.throwIfAborted();
   const cwd=await realpath(request.cwd===null?owned.cwd:resolve(owned.cwd,request.cwd));if(!(await stat(cwd)).isDirectory())throw new Error('Terminal cwd is not a directory');
   const environment={...owned.environment,...request.environment},command=await terminalArguments(request.shell,request.command),started=performance.now();
   const remaining=Number((context.budget.remaining()+999999n)/1000000n),timeoutMs=Math.max(1,Math.min(Number(request.timeout_seconds)*1000,remaining));
   const outcome=await runOwnedCommand({...command,cwd,environment,inheritEnvironment:false},{timeoutMs,maxBytes:1048576,signal,captureStop:true,truncate:true});
   owned.cwd=cwd;owned.environment=environment;const duration_ms=BigInt(Math.round(performance.now()-started)),part=relative(this.#root,cwd),cwd_scope=part===''?'project_root':isAbsolute(part)||part==='..'||part.startsWith('..\\')||part.startsWith('../')?'external_absolute':'project_relative';
   // Single redaction owner: serialize streams rather than racing for its slot.
   const stdout=await redactRemoteText(outcome.stdout.toString('utf8')),stderr=await redactRemoteText(outcome.stderr.toString('utf8'));
   const exit_code=outcome.exitCode===null?null:BigInt(outcome.exitCode),flags={duration_ms,timed_out:outcome.timedOut,cancelled:outcome.cancelled,truncated:outcome.truncated};
   return Object.freeze({kind:'terminal_exec',terminal_id:terminalId,process_id:BigInt(outcome.processId),exit_code,stdout,stderr,cwd,...flags,receipt:Object.freeze({receipt_id:id('tr_'),terminal_id:terminalId,command_digest:createHash('sha256').update(request.command).digest('hex'),shell:command.shell,cwd_scope,exit_code,stdout_bytes:outcome.stdoutBytes,stderr_bytes:outcome.stderrBytes,...flags})}) satisfies RemoteTerminalOutput;
  });entry.active={abort,done};
  try{return await done;}catch(error){if(error instanceof OwnedCommandCleanupError)this.#failure=error;throw error;}finally{if(!this.#failure&&entry.active?.done===done)entry.active=null;}
 }
 close():Promise<void>{if(this.#closing)return this.#closing;this.#closed=true;const active=[...this.#entries.values()].flatMap(e=>e.active?[e.active]:[]);for(const entry of active)entry.abort.abort(new Error('Terminal session closed'));
  return this.#closing=(async()=>{await Promise.allSettled(active.map(e=>e.done));if(this.#failure)throw this.#failure;this.#entries.clear();})();}
}
