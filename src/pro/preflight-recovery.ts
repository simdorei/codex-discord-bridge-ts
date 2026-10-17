import {types} from 'node:util';
import {ProPreflightError,ownedProDiagnostic,type ProRuntimeStatus} from './preflight.ts';
import {requireDiscordText} from '../discord/text.ts';
/** Source check -> at most one quiescent refresh -> at most one recheck. Ports are
 * owned native operations and must settle only after cleanup. No timeout race or
 * implicit restart is introduced; caller supplies the actual resident operation. */
export async function recoverStalePro(check:(signal?:AbortSignal)=>Promise<ProRuntimeStatus>,refresh:(signal?:AbortSignal)=>Promise<boolean>,render:(error:unknown)=>string,signal?:AbortSignal):Promise<ProRuntimeStatus>{
 for(const fn of [check,refresh,render])if(typeof fn!=='function'||types.isProxy(fn)||types.isGeneratorFunction(fn))throw new TypeError('Expected owned Pro recovery callback');
 if(types.isAsyncFunction(render))throw new TypeError('Expected synchronous Pro diagnostic renderer');
 signal?.throwIfAborted();
 const checkOnce=async()=>{const pending=check(signal);if(!types.isPromise(pending))throw new TypeError('Pro check must return a native Promise');const status=await pending;signal?.throwIfAborted();return status;};
 let original:unknown;
 try{return await checkOnce();}catch(error){signal?.throwIfAborted();original=error;}
 const diagnostic=ownedProDiagnostic(original);if(diagnostic?.code!=='ResidentStale')throw original;
 let refreshed:boolean;
 try{const pending=refresh(signal);if(!types.isPromise(pending))throw new TypeError('Pro refresh must return a native Promise');refreshed=await pending;signal?.throwIfAborted();}
 catch(error){signal?.throwIfAborted();const detail=render(error);if(types.isPromise(detail)){void Promise.prototype.then.call(detail,undefined,()=>undefined);throw new TypeError('Pro renderer must return text synchronously');}requireDiscordText(detail);throw new ProPreflightError(diagnostic.stage,diagnostic.code,diagnostic.publicMessage,diagnostic.recoveryAction,diagnostic.internalDetail+`; automatic resident refresh failed error=${detail}`,error);}
 if(refreshed===false)throw original;if(refreshed!==true)throw new TypeError('Pro refresh must return a boolean');
 return await checkOnce();
}
