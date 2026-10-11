import {AdminArgs} from './admin-args.ts';
import {loadStartupEnvironmentOffThread} from './environment.ts';
import {resolveRuntimeStorePaths} from '../runtime/runtime-paths/resolve.ts';
import {joinRuntimePath} from '../runtime/runtime-paths/path-text.ts';
import {rustTrim} from '../config/remote.ts';
import {requireDiscordText} from '../discord/text.ts';
import {gatewayOwnField as own} from '../discord/gateway/values.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../runtime/owned-worker-slot.ts';
import {snapshotCutoverStore} from '../store/cutover-backup.ts';
const slot=new OwnedWorkerSlot('Control');
const platform=()=>process.platform==='win32'?'win32' as const:'posix' as const;
function path(value:string):string{requireDiscordText(value);if(value.includes('\0')||value.length>32768)throw new TypeError('Invalid admin store path');return value;}
/** Existing-store read only; no initialization or migration. A timed-out reader
 * retains native ownership until actual exit. No absolute SQLite CPU bound. */
export async function activeQueueCountOffThread(database:string,signal?:AbortSignal,timeoutMs=10000):Promise<bigint>{
 signal?.throwIfAborted();if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw new RangeError('Invalid queue count timeout');
 const file=path(joinRuntimePath(process.cwd(),path(database),platform()));if(slot.busy)throw new OwnedWorkerBusyError();
 const pending=slot.run(new URL('./admin-store-worker.ts',import.meta.url),{path:file},timeoutMs,signal),joined=slot.join();let reply:unknown;try{reply=await pending;}finally{await joined;}
 const ok=own(reply,'ok');if(ok===true){const count=own(reply,'count');if(typeof count!=='bigint'||count<0n||count>9223372036854775807n)throw new TypeError('Invalid active queue count result');return count;}
 const phase=own(reply,'phase'),message=own(reply,'message');if(ok!==false||typeof message!=='string'||message.length>4096)throw new TypeError('Invalid active queue failure');
 const prefix=phase==='Open'?`Cannot inspect active queue at ${file}: `:phase==='Timeout'?'Cannot configure queue inspection: ':phase==='Query'?'Cannot inspect active queue: ':phase==='Close'?'Cannot close queue inspection: ':null;
 if(prefix===null)throw new TypeError('Invalid active queue failure phase');throw new Error(prefix+message);
}
/** Only the two source store commands. Other parsed admin commands have no
 * executor here and fail before IO. No Discord/Codex credentials or process start. */
export async function runAdminStore(argv:readonly string[],environment:ReadonlyMap<string,string>,currentDirectory:string,signal?:AbortSignal):Promise<string>{
 const args=AdminArgs.parse(argv);if(args.command!=='backup-store'&&args.command!=='active-queue-count')throw new Error(`Admin store executor does not implement ${args.command}`);
 signal?.throwIfAborted();const current=path(currentDirectory),root=path(args.root(current,platform())),envPath=path(joinRuntimePath(root,'.env',platform()));
 const captured=await loadStartupEnvironmentOffThread(environment,envPath,'',signal);signal?.throwIfAborted();
 const env:Record<string,string>=Object.create(null);for(const [key,value] of captured)Object.defineProperty(env,key,{value,enumerable:true});Object.freeze(env);
 const home=[captured.get('USERPROFILE'),captured.get('HOME')].filter((s):s is string=>s!==undefined).map(rustTrim).find(s=>s!=='')??null;
 const database=path(joinRuntimePath(current,resolveRuntimeStorePaths(env,root,home,platform()).mirrorDb,platform()));
 return args.command==='backup-store'?`backup_created path=${await snapshotCutoverStore(database,signal)}`:(await activeQueueCountOffThread(database,signal)).toString();
}
