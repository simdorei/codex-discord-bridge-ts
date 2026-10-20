import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {runOwnedCommand,OwnedCommandCleanupError} from '../windows/owned-command.ts';
import type {RecoveryController} from './handoff.ts';
/** The independent recovery worker is intentionally outside the bot's job: it
 * must survive the exact bot restart. The dispatcher itself always joins. */
export function createWindowsRecoveryController(root:string,codexHome:string,scope:'tools'|'writer'='tools'):RecoveryController{
 const script=fileURLToPath(new URL('../../../../scripts/Invoke-CdrDesktopRecovery.ps1',import.meta.url));
 const shell=join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
 let active:Promise<unknown>|undefined,debt:unknown;
 const run=(mode:string,thread:string,signal:AbortSignal,identity?:string)=>{
  if(active||debt)return Promise.reject(new Error('Recovery invocation ownership is retained'));
  if(!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(thread))return Promise.reject(new TypeError('Recovery requires exact UUID'));
  const args=['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',script,'-Mode',mode,'-RepoRoot',root,'-CodexHome',codexHome,'-ThreadId',thread];if(identity!==undefined)args.push(scope==='tools'?'-ExpectedRecoveryIdentity':'-ExpectedWriterIdentity',identity);
  const task=runOwnedCommand({executable:shell,arguments:args,environment:{}},{timeoutMs:15000,maxBytes:1048576,signal}).then(result=>{if(result.exitCode!==0)throw new Error('Windows recovery controller failed; inspect local recovery receipt');return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(result.stdout));}).catch(error=>{if(error instanceof OwnedCommandCleanupError)debt=error;throw error;});active=task;
  void task.finally(()=>{if(active===task)active=undefined;}).catch(()=>{});return task;
 };
 return Object.freeze({inspect:(thread:string,signal:AbortSignal)=>run(scope==='tools'?'InspectTools':'Inspect',thread,signal),start:(thread:string,identity:string,signal:AbortSignal)=>run(scope==='tools'?'StartTools':'Start',thread,signal,identity),join:async()=>{await active;if(debt)throw debt;}});
}
