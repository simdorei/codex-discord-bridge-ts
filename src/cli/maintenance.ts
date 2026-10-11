import {prepareStartup,type PreparedStartup} from './preflight.ts';
import {discoverRuntimePathInputs} from '../runtime/runtime-paths/discovery.ts';
import {resolveRuntimePaths} from '../runtime/runtime-paths/resolve.ts';
import {runtimeResidentConfig} from '../runtime/discord-runtime/resident-config.ts';
import {runOwnedRestartReadiness} from '../runtime/restart-readiness/owned-readiness.ts';
export type PreparedMaintenanceStartup=Exclude<PreparedStartup,{kind:'restartReadiness'}>;
/** Source CLI branch composition. Readiness owns a temporary actual native client
 * and returns its success text only after disposal. Other branches remain plans.
 * Caller supplies application entry path, current root and actual build version.
 * No executable main/singleton/gateway/backup/admin effects are implemented here.
 * Native directory discovery and Windows ownership retain their existing limits. */
export async function prepareMaintenanceStartup(argv:readonly string[],environment:ReadonlyMap<string,string>,applicationPath:string,root:string,version:string,signal?:AbortSignal):Promise<PreparedMaintenanceStartup>{
 const prepared=await prepareStartup(argv,environment,applicationPath,signal);
 if(prepared.kind!=='restartReadiness')return prepared;
 signal?.throwIfAborted();
 const env:Record<string,string>=Object.create(null);
 Map.prototype.forEach.call(prepared.environment,(value:string,key:string)=>{Object.defineProperty(env,key,{value,enumerable:true});});Object.freeze(env);
 const inputs=await discoverRuntimePathInputs(env,root);signal?.throwIfAborted();
 const paths=await resolveRuntimePaths(env,inputs);signal?.throwIfAborted();
 await runOwnedRestartReadiness(paths.mirrorDb,runtimeResidentConfig(paths,version),{quietSeconds:prepared.args.restartQuietSeconds,waitSeconds:prepared.args.restartWaitTimeoutSeconds,requestTimeoutMs:8000,startupTimeoutMs:45000,closeTimeoutMs:8000},signal);
 return Object.freeze({kind:'output',text:'restart_readiness_ok'});
}
