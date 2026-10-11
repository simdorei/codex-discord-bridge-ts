import {runAdminStore} from './admin-store.ts';
import {snapshotCutoverStore} from '../store/cutover-backup.ts';
import {prepareStartup,type PreparedStartup} from './preflight.ts';
import {discoverRuntimePathInputs} from '../runtime/runtime-paths/discovery.ts';
import {resolveRuntimePaths} from '../runtime/runtime-paths/resolve.ts';
import {runtimeResidentConfig} from '../runtime/discord-runtime/resident-config.ts';
import {runOwnedRestartReadiness} from '../runtime/restart-readiness/owned-readiness.ts';
type ConfiguredStartup=Extract<PreparedStartup,{kind:'backupStore'|'gateway'}>;
export type PreparedMaintenanceStartup=Exclude<PreparedStartup,{kind:'restartReadiness'}|ConfiguredStartup>|Readonly<Omit<ConfiguredStartup,'kind'>&{kind:'gateway'}>;
/** Source CLI branch composition. Readiness owns a temporary actual native client
 * and returns its success text only after disposal. Backup uses an owned native
 * snapshot and returns only confirmed output; store admin commands execute,
 * other admin/gateway branches remain plans.
 * Caller supplies application entry path, current root and actual build version.
 * No executable main/singleton/gateway or other admin effects are implemented here.
 * Native directory discovery and Windows ownership retain their existing limits. */
export async function prepareMaintenanceStartup(argv:readonly string[],environment:ReadonlyMap<string,string>,applicationPath:string,root:string,version:string,signal?:AbortSignal):Promise<PreparedMaintenanceStartup>{
 // Invoke the owned admin store executor before yielding so caller argv/env
 // are captured before any asynchronous boundary. Other admin effects stay plans.
 if(argv[0]==='--admin'&&(argv[1]==='backup-store'||argv[1]==='active-queue-count'))return Object.freeze({kind:'output',text:await runAdminStore(argv.slice(1),environment,root,signal)});
 const prepared=await prepareStartup(argv,environment,applicationPath,signal);
 if(prepared.kind==='admin'||prepared.kind==='output')return prepared;
 if(prepared.kind==='gateway')return Object.freeze({...prepared,kind:'gateway' as const});
 signal?.throwIfAborted();
 const env:Record<string,string>=Object.create(null);
 Map.prototype.forEach.call(prepared.environment,(value:string,key:string)=>{Object.defineProperty(env,key,{value,enumerable:true});});Object.freeze(env);
 const inputs=await discoverRuntimePathInputs(env,root);signal?.throwIfAborted();
 const paths=await resolveRuntimePaths(env,inputs);signal?.throwIfAborted();
 if(prepared.kind==='backupStore')return Object.freeze({kind:'output',text:`backup_created path=${await snapshotCutoverStore(paths.mirrorDb,signal)}`});
 await runOwnedRestartReadiness(paths.mirrorDb,runtimeResidentConfig(paths,version),{quietSeconds:prepared.args.restartQuietSeconds,waitSeconds:prepared.args.restartWaitTimeoutSeconds,requestTimeoutMs:8000,startupTimeoutMs:45000,closeTimeoutMs:8000},signal);
 return Object.freeze({kind:'output',text:'restart_readiness_ok'});
}
