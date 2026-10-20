import {types} from 'node:util';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {joinRuntimePath,type PathPlatform} from '../runtime-paths/path-text.ts';
import {NativeRecoveryOwner,type NativeRecoveryClaim} from './native-owner.ts';
import type {RecoveryCancellation} from '../../store/queue-cancel-recovery.ts';

/** Trusted startup-owned OS adapter, never transport/RPC input. Each method must
 * honor abort, retain exact process identity and join every owned invocation.
 * No production Windows adapter is supplied by this module. */
export interface RecoveryController {
 readonly inspect:(thread:string,signal:AbortSignal)=>Promise<unknown>;
 readonly start:(thread:string,identity:string,signal:AbortSignal)=>Promise<unknown>;
 readonly join:()=>Promise<void>;
}
export interface RecoveryHandoffReport{
 readonly phase:'dispatched_tools';readonly thread:string;readonly cancelled:readonly string[];
 readonly startedOrUncertain:number;readonly receipt:string;
}
export class RecoveryHandoffError extends Error{
 constructor(readonly cancellation:RecoveryCancellation|null,cause:unknown){
  super(cancellation===null?'Recovery outcome is unconfirmed; cancellation may already be committed; do not automatically replay':'Requests were cancelled and will not replay; restart dispatch or receipt is unconfirmed',{cause});this.name='RecoveryHandoffError';
 }
}
function checkedText(value:unknown,max:number):string{requireDiscordText(value);if(value.includes('\0')||Buffer.byteLength(value)>max)throw new TypeError('Recovery response exceeds text bound');return value;}
function response(value:unknown):unknown{if(boundedSerdeByteCount(value,1048576)===null)throw new TypeError('Recovery response exceeds byte budget');return value;}
function promise<T>(value:Promise<T>):Promise<T>{if(!types.isPromise(value))throw new TypeError('Expected native controller Promise');return value;}
function capture(controller:RecoveryController):RecoveryController{
 const get=(key:keyof RecoveryController)=>{const fn=own(controller,key);if(typeof fn!=='function'||types.isProxy(fn)||types.isGeneratorFunction(fn))throw new TypeError('Expected owned controller function');return fn;};
 return Object.freeze({inspect:get('inspect'),start:get('start'),join:get('join')}) as RecoveryController;
}
/** Strict spelling intentionally refuses aliases; it is not filesystem identity
 * or native Windows path qualification. Receipt evidence never proves completion. */
export function recoveryReceiptPath(root:string,value:unknown,platform:PathPlatform):string{
 checkedText(root,32768);response(value);const operation=own(value,'Operation');
 if(typeof operation!=='string'||!/^[a-f0-9]{32}$/.test(operation))throw new TypeError('Invalid recovery operation identity');
 const expected=joinRuntimePath(joinRuntimePath(joinRuntimePath(root,'maintenance_backups/desktop-recovery',platform),operation,platform),'receipt.json',platform);
 if(checkedText(own(value,'ReceiptPath'),32768)!==expected)throw new TypeError('Recovery receipt escaped its exact operation directory');return expected;
}
async function interrupted<T>(work:Promise<T>,signal:AbortSignal):Promise<T>{
 let abort:()=>void=()=>{};const stopped=new Promise<never>((_,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
 try{return await Promise.race([work,stopped]);}finally{signal.removeEventListener('abort',abort);}
}
/** Rust run_tools_checked ordering. No target mutex wait behind a stuck turn.
 * Only returns dispatched; process exit/replacement/tool readiness remain unproven. */
export async function handoffRecovery(owner:NativeRecoveryOwner,claim:NativeRecoveryClaim,input:RecoveryController,root:string,platform:PathPlatform,signal?:AbortSignal,totalMs=20000):Promise<RecoveryHandoffReport>{
 const controller=capture(input);checkedText(root,32768);if(platform!=='win32'&&platform!=='posix')throw new TypeError('Expected path platform');
 if(!Number.isSafeInteger(totalMs)||totalMs<=0||totalMs>20000)throw new TypeError('Invalid recovery deadline');
 signal?.throwIfAborted();const target=NativeRecoveryOwner.prototype.target.call(owner,claim),deadline=new AbortController(),combined=signal===undefined?deadline.signal:AbortSignal.any([signal,deadline.signal]);
 const timer=setTimeout(()=>deadline.abort(new Error('Recovery handoff deadline; inspect durable receipt before retrying')),totalMs);let cancelled:RecoveryCancellation|null=null,failure:unknown;
 try{
  await NativeRecoveryOwner.prototype.check.call(owner,claim,combined);combined.throwIfAborted();
  const inspection=response(await interrupted(promise(controller.inspect(target,combined)),combined));combined.throwIfAborted();
  if(own(inspection,'ThreadId')!==target||own(inspection,'State')!=='tools_recovery')throw new TypeError('Recovery inspection target or scope differs');
  const identity=checkedText(own(inspection,'RecoveryIdentity'),32768);
  cancelled=await NativeRecoveryOwner.prototype.cancel.call(owner,claim,combined);combined.throwIfAborted();
  await NativeRecoveryOwner.prototype.check.call(owner,claim,combined);combined.throwIfAborted();
  const dispatched=response(await interrupted(promise(controller.start(target,identity,combined)),combined));combined.throwIfAborted();
  const receipt=recoveryReceiptPath(root,dispatched,platform);
  return Object.freeze({phase:'dispatched_tools',thread:target,cancelled:Object.freeze([...cancelled.jobs]),startedOrUncertain:cancelled.startedOrUncertain,receipt});
 }catch(error){failure=error;throw new RecoveryHandoffError(cancelled,error);}
 finally{
  try{await promise(controller.join());combined.throwIfAborted();}catch(error){throw new RecoveryHandoffError(cancelled,new AggregateError(failure===undefined?[error]:[failure,error],'Recovery invocation join failed'));}finally{clearTimeout(timer);}
 }
}
