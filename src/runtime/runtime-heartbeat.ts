import {open,unlink} from 'node:fs/promises';
import {types} from 'node:util';
import {DelayedTicks} from './delayed-ticks.ts';
import {writePosixAtomicMarker} from './atomic-marker.ts';
import {gatewayOwnField as own} from '../discord/gateway/values.ts';
import {invokeSynchronousVoid} from '../core/synchronous-void.ts';
import {requireDiscordText} from '../discord/text.ts';
export const RUNTIME_HEARTBEAT_NAME='.codex_discord_rust.heartbeat';
export interface RuntimeHeartbeatPort {readonly publish:(text:string)=>Promise<void>;readonly removeIfOwned:(lastPublished:string)=>Promise<void>}
export interface RuntimeHeartbeatOptions {readonly pid?:number;readonly seconds?:()=>bigint;readonly periodMs?:number;readonly report:(event:string,error:unknown)=>void}
export function unixHeartbeatSeconds():bigint{const milliseconds=Date.now();return Number.isFinite(milliseconds)&&milliseconds>=0?BigInt(Math.floor(milliseconds/1000)):0n;}
/** Exact marker wire fields. Clock failure uses zero as in Rust unwrap_or_default. */
export function encodeRuntimeHeartbeat(pid:number,seconds:bigint):string{if(!Number.isInteger(pid)||pid<0||pid>0xffffffff||typeof seconds!=='bigint'||seconds<0n||seconds>=(1n<<64n))throw new TypeError('Invalid runtime heartbeat identity/time');return `pid=${pid}\nupdated_at=${seconds}\n`;}
export function posixRuntimeHeartbeatPort(path:string):RuntimeHeartbeatPort{
 requireDiscordText(path);if(process.platform==='win32')throw new Error('Windows heartbeat marker adapter is not implemented');
 return Object.freeze({publish:(text:string)=>writePosixAtomicMarker(path,text),removeIfOwned:async(expected:string)=>{
  let handle;try{handle=await open(path,'r');}catch(error){if(error!==null&&typeof error==='object'&&Object.getOwnPropertyDescriptor(error,'code')?.value==='ENOENT')return;throw error;}
  let actual:string|null=null;try{const bytes=Buffer.alloc(129);let used=0;while(used<bytes.length){const read=await handle.read(bytes,used,bytes.length-used,null);if(read.bytesRead===0)break;used+=read.bytesRead;}if(used<=128)actual=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes.subarray(0,used));}finally{await handle.close();}
  if(actual===expected)try{await unlink(path);}catch(error){if(error===null||typeof error!=='object'||Object.getOwnPropertyDescriptor(error,'code')?.value!=='ENOENT')throw error;}
 }});
}
/** Caller must own the runtime-instance guard. Writes are serial, first tick is
 * immediate, stop joins current IO, cleanup removes only the last owned bytes.
 * Content comparison is not cross-process atomic CAS; foreign writers are outside
 * the required exclusive guard. Windows/native single-instance QA remains pending. */
export async function runRuntimeHeartbeat(input:RuntimeHeartbeatPort,stop:AbortSignal,options:RuntimeHeartbeatOptions):Promise<void>{
 const publish=own(input,'publish'),remove=own(input,'removeIfOwned'),report=own(options,'report');for(const fn of [publish,remove,report])if(typeof fn!=='function'||types.isProxy(fn)||types.isGeneratorFunction(fn))throw new TypeError('Expected owned heartbeat operation');if(types.isAsyncFunction(report))throw new TypeError('Expected synchronous heartbeat reporter');
 const optional=(name:string)=>{const d=Object.getOwnPropertyDescriptor(options,name);if(d===undefined)return undefined;if(!Object.hasOwn(d,'value'))throw new TypeError('Active heartbeat option');return d.value;};
 const pid=optional('pid')??process.pid,seconds=optional('seconds')??unixHeartbeatSeconds,period=optional('periodMs')??10000;encodeRuntimeHeartbeat(pid,0n);if(!Number.isInteger(period)||period<=0||period>2147483647||typeof seconds!=='function'||types.isProxy(seconds)||types.isAsyncFunction(seconds)||types.isGeneratorFunction(seconds))throw new TypeError('Invalid heartbeat timing');
 const call=async(fn:Function,text:string)=>{const p=Reflect.apply(fn,input,[text]);if(!types.isPromise(p))throw new TypeError('Expected native heartbeat Promise');if(await p!==undefined)throw new TypeError('Expected void heartbeat IO');};
 const ticks=new DelayedTicks(period),wake=()=>ticks.close();stop.addEventListener('abort',wake,{once:true});let last:string|null=null,failed=false,primary:unknown;
 try{while(!stop.aborted){let now:bigint;try{const value:unknown=seconds();if(types.isPromise(value))void Promise.prototype.then.call(value,undefined,()=>undefined);now=value as bigint;encodeRuntimeHeartbeat(pid,now);}catch{now=0n;}const text=encodeRuntimeHeartbeat(pid,now);try{await call(publish as Function,text);last=text;}catch(error){invokeSynchronousVoid(report as Function,options,['runtime_heartbeat_write_failed',error]);}if(stop.aborted)break;await ticks.wait();}}
 catch(error){failed=true;primary=error;}
 finally{ticks.close();stop.removeEventListener('abort',wake);if(last!==null)try{await call(remove as Function,last);}catch(error){try{invokeSynchronousVoid(report as Function,options,['runtime_heartbeat_cleanup_failed',error]);}catch(reportError){if(failed)primary=new AggregateError([primary,reportError],'Heartbeat operation and cleanup diagnostic failed');else{failed=true;primary=reportError;}}}}
 if(failed)throw primary;
}
