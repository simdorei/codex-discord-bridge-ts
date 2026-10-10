import {join} from 'node:path';import {types} from 'node:util';
import {PortableResidentLifecycle} from '../app-server/portable-resident-lifecycle.ts';
import {gatewayOwnField as own} from '../discord/gateway/values.ts';
import {requireDiscordText} from '../discord/text.ts';
import {invokeSynchronousVoid} from '../core/synchronous-void.ts';
import {captureProPlugins} from './capture.ts';
import {expectedRemotePluginVersion} from './plugin-files.ts';
import {verifyProRuntime,ownedProDiagnostic,ProPreflightError,type ProRuntimeDiagnostic} from './preflight.ts';
import {recoverStalePro} from './preflight-recovery.ts';
import {rewriteProPrompt,formatLocalDevicePrompt} from './prompt.ts';
import {resolveProWorkingDirectory,PromptPreprocessError} from './project.ts';
export interface ProRemoteConnection{readonly deviceId:string;readonly isConnected:()=>boolean;}
export interface ProRuntimeOptions{readonly root:string;readonly stateDatabase:string;readonly executable:string;readonly server:PortableResidentLifecycle;readonly remote:ProRemoteConnection|null;readonly render:(error:unknown)=>string;readonly report:(diagnostic:ProRuntimeDiagnostic)=>void;}
const TOKEN=Symbol('captured Pro runtime');
function callback(value:unknown):asserts value is (...args:any[])=>unknown{if(typeof value!=='function'||types.isProxy(value)||types.isAsyncFunction(value)||types.isGeneratorFunction(value))throw new TypeError('Expected synchronous Pro runtime callback');}
/** Concrete owned-native preprocessor. Does not start an agent/browser or choose a
 * replacement project. Remote readiness is an explicit trusted gateway port; this
 * class does not implement/authenticate that gateway. Caller owns resident lifetime. */
export class ProPromptRuntime{
 readonly #state:string;readonly #executable:string;readonly #manifest:string;readonly #server:PortableResidentLifecycle;readonly #remote:ProRemoteConnection|null;readonly #render:(e:unknown)=>string;readonly #report:(d:ProRuntimeDiagnostic)=>void;
 #generation:bigint;#fingerprint:string|null;#captureError:string|null;
 private constructor(token:symbol,input:ProRuntimeOptions,generation:bigint,fingerprint:string|null,error:string|null){if(token!==TOKEN)throw new TypeError('Use ProPromptRuntime.capture');this.#state=input.stateDatabase;this.#executable=input.executable;this.#manifest=join(input.root,'plugins/codex-discord-remote/.codex-plugin/plugin.json');this.#server=input.server;this.#remote=input.remote;this.#render=input.render;this.#report=input.report;this.#generation=generation;this.#fingerprint=fingerprint;this.#captureError=error;}
 static async capture(input:ProRuntimeOptions,signal?:AbortSignal):Promise<ProPromptRuntime>{
  signal?.throwIfAborted();const root=own(input,'root'),state=own(input,'stateDatabase'),executable=own(input,'executable'),server=own(input,'server') as PortableResidentLifecycle,rawRemote=own(input,'remote'),render=own(input,'render'),report=own(input,'report');
  for(const value of [root,state,executable]){requireDiscordText(value);if(value.includes('\0'))throw new TypeError('NUL Pro runtime path');}callback(render);callback(report);
  const generation=PortableResidentLifecycle.prototype.generation.call(server);let remote:ProRemoteConnection|null=null;
  if(rawRemote!==null){const deviceId=own(rawRemote,'deviceId'),connected=own(rawRemote,'isConnected');requireDiscordText(deviceId);if(deviceId==='')throw new TypeError('Expected configured Pro device ID');callback(connected);remote=Object.freeze({deviceId,isConnected:()=>{const result=connected();if(typeof result!=='boolean'){if(types.isPromise(result))void Promise.prototype.then.call(result,undefined,()=>undefined);throw new TypeError('Remote readiness must be boolean');}return result;}});}
  const options={root:root as string,stateDatabase:state as string,executable:executable as string,server,remote,render:render as (e:unknown)=>string,report:report as (d:ProRuntimeDiagnostic)=>void};
  let fingerprint:string|null=null,error:string|null=null;
  try{fingerprint=(await captureProPlugins(options.executable,signal)).fingerprint;}catch(cause){signal?.throwIfAborted();const d=ownedProDiagnostic(cause);if(d===null)throw cause;error=d.internalDetail;}
  signal?.throwIfAborted();return new ProPromptRuntime(TOKEN,options,generation,fingerprint,error);
 }
 async #preflight(signal?:AbortSignal){
  const current=await captureProPlugins(this.#executable,signal);const expected=await expectedRemotePluginVersion(this.#manifest,signal);signal?.throwIfAborted();
  const state=PortableResidentLifecycle.prototype.lifecycleSnapshot.call(this.#server);
  // No await inside baseline reconciliation: single-event-loop equivalent of the
  // source's tiny mutex-protected snapshot update, never a native-process lock.
  if(this.#generation!==state.generation){this.#generation=state.generation;this.#fingerprint=current.fingerprint;this.#captureError=null;}
  return verifyProRuntime(current.inventory,expected,{generation:state.generation,healthy:state.healthy,accepting:state.healthy,pluginRuntimeFingerprint:this.#fingerprint,pluginRuntimeError:this.#captureError},current.fingerprint);
 }
 #public(error:unknown):never{
  const d=ownedProDiagnostic(error);if(d===null)throw error;
  invokeSynchronousVoid(this.#report,this,[Object.freeze({...d,internalDetail:[...d.internalDetail].slice(0,500).join('')})]);throw new PromptPreprocessError(d.publicMessage,d.recoveryAction,error);
 }
 async prepare(prompt:string,thread:string,signal?:AbortSignal):Promise<string>{
  signal?.throwIfAborted();requireDiscordText(thread);const rewritten=rewriteProPrompt(prompt);if(rewritten===null)return prompt;
  try{await recoverStalePro(s=>this.#preflight(s),s=>PortableResidentLifecycle.prototype.forceRestartIfQuiescent.call(this.#server,s),this.#render,signal);}catch(error){signal?.throwIfAborted();this.#public(error);}
  if(this.#remote===null)this.#public(new ProPreflightError('RemoteMcp','RemoteMcpNotConfigured','The local PC connection is not configured.','Configure remote MCP, restart the remote bot, then retry !pro.','remote MCP is not configured'));
  if(!this.#remote.isConnected())this.#public(new ProPreflightError('RemoteMcp','RemoteMcpConnectionFailed','The local PC connection did not become ready.','Restart the remote bot, verify remote MCP connectivity, then retry !pro.','remote MCP gateway hello has not been acknowledged'));
  const directory=await resolveProWorkingDirectory(this.#state,thread,signal);signal?.throwIfAborted();return formatLocalDevicePrompt(rewritten,thread,{deviceId:this.#remote.deviceId,workingDirectory:directory});
 }
}
