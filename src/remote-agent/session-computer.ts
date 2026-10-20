import {requireDiscordText} from '../discord/text.ts';
import {types} from 'node:util';
import {gatewayOwnField as own} from '../discord/gateway/values.ts';
import {boundedSerdeByteCount} from '../core/serde-byte-count.ts';
import {serializeSerdeValue} from '../core/serde-json.ts';
import {parseComputerRequest,type ComputerRequest} from './computer-request.ts';
import type {RemoteComputerOutput} from './computer-output.ts';
export type RemoteComputerMode='project'|'device';
export class RemoteComputerStoppedError extends Error{constructor(){super('computer control is stopped until the project is bound again');this.name='RemoteComputerStoppedError';}}
export class RemoteComputerPlatformError extends Error{constructor(reason:string){requireDiscordText(reason);super('computer platform operation failed: '+reason);this.name='RemoteComputerPlatformError';}}
export class RemoteComputerBusyError extends Error{constructor(){super('One computer operation is already owned; no request queued');this.name='RemoteComputerBusyError';}}
export interface OwnedRemoteComputerPorts{
 /** Ports own and join native work. No synchronous native UI call on the main
  * loop, and no unresolved native operation may be reported as completed. */
 readonly execute:(request:Exclude<ComputerRequest,{kind:'computer_stop'}>)=>Promise<RemoteComputerOutput>;
 readonly stop:()=>Promise<void>;
}
export type RemoteComputerFactory=(mode:RemoteComputerMode)=>Promise<OwnedRemoteComputerPorts>;
const stoppedOutput=()=>Object.freeze({kind:'computer_stop' as const,stopped:true,message:'Computer control stopped until this project is bound again.'});
function fn(value:unknown):(...args:never[])=>unknown{if(typeof value!=='function'||types.isProxy(value)||types.isGeneratorFunction(value))throw new TypeError('Expected owned computer port');return value as (...args:never[])=>unknown;}
function promise<T>(value:unknown):Promise<T>{if(!types.isPromise(value))throw new TypeError('Computer port must return an owned Promise');return value as Promise<T>;}
const unsupported:RemoteComputerFactory=async()=>{throw new RemoteComputerPlatformError(process.platform==='win32'?'Windows computer ownership is not qualified.':'Computer control is currently available only on Windows.');};
/** Lazy session custody, not a UI backend or authorization. One admitted action,
 * no queue. Factory failures are cached without fallback. Stop is permanent and
 * owns initialization/accepted work through native settlement before cleanup.
 * This async join extends source synchronous initialization conservatively.
 * A trusted factory must clean its own partial resources before rejecting. */
export class RemoteSessionComputerOwner{
 readonly #mode:RemoteComputerMode;readonly #factory:RemoteComputerFactory;
 #initializing:Promise<OwnedRemoteComputerPorts>|null=null;#controller:OwnedRemoteComputerPorts|null=null;
 #active:Promise<RemoteComputerOutput>|null=null;#stopped=false;#stopping:Promise<ReturnType<typeof stoppedOutput>>|null=null;
 constructor(mode:RemoteComputerMode,factory:RemoteComputerFactory=unsupported){if(mode!=='project'&&mode!=='device')throw new TypeError('Expected computer access mode');fn(factory);this.#mode=mode;this.#factory=factory;}
 #ensureRunning(){if(this.#stopped)throw new RemoteComputerStoppedError();}
 #initialize():Promise<OwnedRemoteComputerPorts>{
  if(this.#initializing!==null)return this.#initializing;
  this.#initializing=Promise.resolve().then(async()=>{const raw=await promise<OwnedRemoteComputerPorts>(this.#factory(this.#mode));const execute=fn(own(raw,'execute')) as OwnedRemoteComputerPorts['execute'],stop=fn(own(raw,'stop')) as OwnedRemoteComputerPorts['stop'];const controller=Object.freeze({execute,stop});this.#controller=controller;return controller;});return this.#initializing;
 }
 async execute(request:ComputerRequest):Promise<RemoteComputerOutput>{
  if(boundedSerdeByteCount(request,524288)===null)throw new TypeError('Invalid or over-budget computer request');const captured=parseComputerRequest(serializeSerdeValue(request),524288);
  if(captured.kind==='computer_stop')return this.stop();this.#ensureRunning();if(this.#active!==null)throw new RemoteComputerBusyError();
  const action=Promise.resolve().then(async()=>{this.#ensureRunning();const controller=await this.#initialize();this.#ensureRunning();const result=await promise<RemoteComputerOutput>(controller.execute(captured));this.#ensureRunning();return result;});this.#active=action;
  const clear=()=>{if(this.#active===action)this.#active=null;};void action.then(clear,clear);return action;
 }
 stop():Promise<ReturnType<typeof stoppedOutput>>{
  this.#stopped=true;if(this.#stopping!==null)return this.#stopping;const active=this.#active;
  this.#stopping=Promise.resolve().then(async()=>{if(active!==null)try{await active;}catch{/* Execution failure stays with its original caller. */}const controller=this.#controller;if(controller!==null)await promise<void>(controller.stop());return stoppedOutput();});return this.#stopping;
 }
 snapshot(){return Object.freeze({stopped:this.#stopped,initializationStarted:this.#initializing!==null,controllerReady:this.#controller!==null,operationPending:this.#active!==null,stopStarted:this.#stopping!==null});}
}
Object.freeze(RemoteSessionComputerOwner.prototype);
