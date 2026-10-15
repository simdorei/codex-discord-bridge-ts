import {types} from 'node:util';
import {gatewayOwnField as own} from '../discord/gateway/values.ts';
import type {GatewayCommand} from './gateway-command.ts';
import type {BridgeResult,RemoteProjectOutput} from './bridge-inbound.ts';
import type {CoreRequest} from './core-request.ts';
import type {ComputerRequest} from './computer-request.ts';
import type {TerminalRequest} from './terminal-request.ts';
import type {RemoteRequestBudget} from './request-budget.ts';
import type {RemoteUtcDateTime} from './datetime.ts';
import type {RemoteSessionIdentity} from './session-decisions.ts';
import {RemoteSessionCleanupOwner} from './session-cleanup.ts';

export interface RemoteProjectBinding {readonly threadId:string;readonly root:string;readonly expiresAt:RemoteUtcDateTime;}
export interface RemoteOperationContext {readonly binding:RemoteProjectBinding;readonly session:RemoteSessionIdentity;readonly signal:AbortSignal;readonly budget:RemoteRequestBudget;}
type FileOutput<K extends BridgeResult['type']>=Extract<BridgeResult,{type:K}> extends {output:infer O}?O:never;
type FileCommand<K extends GatewayCommand['type']>=Extract<GatewayCommand,{type:K}>;
export interface RemoteSessionBackend {
 readonly stopComputer:()=>Promise<void>;
 readonly closeTerminalWindows:()=>Promise<void>;
 readonly closeTerminals:()=>Promise<void>;
 readonly computer:((request:ComputerRequest,context:RemoteOperationContext)=>Promise<RemoteProjectOutput>)|null;
 readonly terminal:((request:TerminalRequest,context:RemoteOperationContext)=>Promise<RemoteProjectOutput>)|null;
 readonly terminalWindow:((request:TerminalRequest,context:RemoteOperationContext)=>Promise<RemoteProjectOutput>)|null;
}
/** Factories own partial initialization on failure. Returned resources transfer
 * exclusive custody to the dispatcher. Every operation settles only after its
 * actual native work ends; signal delivery alone is never a completion receipt.
 * These typed leaf ports are NOT native filesystem/terminal/UI implementations. */
export interface RemoteProjectBackend {
 readonly close:()=>Promise<void>;
 readonly createSession:((identity:RemoteSessionIdentity)=>Promise<RemoteSessionBackend>)|null;
 readonly listFiles:((command:FileCommand<'list_files'>,context:RemoteOperationContext)=>Promise<FileOutput<'list_files_result'>>)|null;
 readonly readFile:((command:FileCommand<'read_file'>,context:RemoteOperationContext)=>Promise<FileOutput<'read_file_result'>>)|null;
 readonly writeFile:((command:FileCommand<'write_file'>,context:RemoteOperationContext)=>Promise<FileOutput<'write_file_result'>>)|null;
 readonly core:((request:CoreRequest,context:RemoteOperationContext)=>Promise<RemoteProjectOutput>)|null;
}
export function ownedPort<T>(value:unknown,key:string,nullable=false):T{
 const fn=own(value,key);if(nullable&&fn===null)return fn as T;
 if(typeof fn!=='function'||types.isProxy(fn)||types.isGeneratorFunction(fn))throw new TypeError('Expected passive owned dispatcher port');return fn as T;
}
export function ownedPromise<T>(value:Promise<T>):Promise<T>{if(!types.isPromise(value))throw new TypeError('Owned dispatcher port must return a Promise');return value as Promise<T>;}
export function captureProjectBackend(value:RemoteProjectBackend):RemoteProjectBackend{
 return Object.freeze({close:ownedPort<RemoteProjectBackend['close']>(value,'close'),createSession:ownedPort<RemoteProjectBackend['createSession']>(value,'createSession',true),listFiles:ownedPort<RemoteProjectBackend['listFiles']>(value,'listFiles',true),readFile:ownedPort<RemoteProjectBackend['readFile']>(value,'readFile',true),writeFile:ownedPort<RemoteProjectBackend['writeFile']>(value,'writeFile',true),core:ownedPort<RemoteProjectBackend['core']>(value,'core',true)});
}
export function captureSessionBackend(value:RemoteSessionBackend):Readonly<{cleanup:RemoteSessionCleanupOwner;ports:Pick<RemoteSessionBackend,'computer'|'terminal'|'terminalWindow'>}>{
 const cleanup=new RemoteSessionCleanupOwner(value);
 return Object.freeze({cleanup,ports:Object.freeze({computer:ownedPort<RemoteSessionBackend['computer']>(value,'computer',true),terminal:ownedPort<RemoteSessionBackend['terminal']>(value,'terminal',true),terminalWindow:ownedPort<RemoteSessionBackend['terminalWindow']>(value,'terminalWindow',true)})});
}
