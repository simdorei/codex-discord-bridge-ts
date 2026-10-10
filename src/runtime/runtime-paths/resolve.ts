import {types} from 'node:util';
import {rustTrim} from '../../config/remote.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {joinRuntimePath as join,type PathPlatform} from './path-text.ts';
import {findRuntimeStateDatabase,nativeStateDatabaseProbe,type StateDatabaseProbe} from './state-database.ts';
import {selectRuntimeExecutable,type ExecutablePathSource} from './executable.ts';
export type RuntimeEnvironment=Readonly<Record<string,string>>;
export interface RuntimePathInputs{readonly root:string;readonly userHome:string;readonly localAppCandidates:readonly string[];readonly pathCandidates:readonly string[]}
export interface RuntimePaths{readonly root:string;readonly codexHome:string;readonly mirrorDb:string;readonly stateDb:string;readonly bridgeState:string;readonly logDb:string;readonly globalState:string;readonly sessionIndex:string;readonly archivedSessions:string;readonly maintenanceBackupRoot:string;readonly attachmentDir:string;readonly codexExe:string;readonly codexExeSource:ExecutablePathSource}
export class RuntimeUserHomeMissing extends Error{constructor(){super('could not expand configured database path: user home is missing');this.name='RuntimeUserHomeMissing';}}
/** Snapshot only own data properties; never import prototype values or invoke
 * accessors. Exact config key spelling differs deliberately from OS discovery. */
export function snapshotRuntimeEnvironment(value:RuntimeEnvironment):RuntimeEnvironment{
 if(value===null||typeof value!=='object'||types.isProxy(value))throw new TypeError('Expected runtime environment data');
 const result:Record<string,string>=Object.create(null) as Record<string,string>;
 for(const key of Object.getOwnPropertyNames(value)){requireDiscordText(key);const raw=own(value,key);requireDiscordText(raw as string);Object.defineProperty(result,key,{value:raw,enumerable:true});}return Object.freeze(result);
}
function envPath(env:RuntimeEnvironment,key:string):string|null{const raw=Object.getOwnPropertyDescriptor(env,key);if(raw===undefined)return null;const text=rustTrim(raw.value as string);return text===''?null:text;}
function expand(path:string,home:string|null,platform:PathPlatform):string{
 if(path==='~'||path.startsWith('~/')||path.startsWith('~\\')){if(home===null)throw new RuntimeUserHomeMissing();return path==='~'?home:join(home,path.slice(2),platform);}return path;
}
function checkPlatform(platform:PathPlatform):void{if(platform!=='win32'&&platform!=='posix')throw new TypeError('Expected path platform');}
function text(value:unknown):string{requireDiscordText(value as string);return value as string;}
function paths(value:unknown):readonly string[]{if(!Array.isArray(value)||types.isProxy(value))throw new TypeError('Expected runtime path list');const output:string[]=[];for(let i=0;i<value.length;i++)output.push(text(own(value,String(i))));return Object.freeze(output);}
async function state(env:RuntimeEnvironment,home:string|null,platform:PathPlatform,probe:StateDatabaseProbe){
 const rawHome=envPath(env,'CODEX_HOME'),codexHome=rawHome===null?(home===null?null:join(home,'.codex',platform)):expand(rawHome,home,platform);
 const rawState=envPath(env,'CODEX_STATE_DB'),stateDb=rawState===null?null:expand(rawState,home,platform);
 if(codexHome===null){if(stateDb===null)throw new RuntimeUserHomeMissing();return Object.freeze({codexHome:'',stateDb});}
 return Object.freeze({codexHome,stateDb:stateDb??await findRuntimeStateDatabase(codexHome,platform,probe)});
}
function store(env:RuntimeEnvironment,defaultRoot:string,home:string|null,platform:PathPlatform){const rawRoot=envPath(env,'CODEX_DISCORD_ROOT'),root=rawRoot===null?defaultRoot:expand(rawRoot,home,platform),rawDb=envPath(env,'CODEX_DISCORD_MIRROR_DB');return Object.freeze({root,mirrorDb:rawDb===null?join(root,'discord_mirror.sqlite',platform):expand(rawDb,home,platform)});}
export function resolveRuntimeStorePaths(environment:RuntimeEnvironment,defaultRoot:string,userHome:string|null,platform:PathPlatform=process.platform==='win32'?'win32':'posix'){
 checkPlatform(platform);text(defaultRoot);if(userHome!==null)text(userHome);return store(snapshotRuntimeEnvironment(environment),defaultRoot,userHome,platform);
}
export async function resolveRuntimeStatePaths(environment:RuntimeEnvironment,userHome:string|null,platform:PathPlatform=process.platform==='win32'?'win32':'posix',probe:StateDatabaseProbe=nativeStateDatabaseProbe){checkPlatform(platform);if(userHome!==null)text(userHome);return await state(snapshotRuntimeEnvironment(environment),userHome,platform,probe);}
/** Resolve online/offline paths from an explicit owned environment snapshot. No
 * process.env reads, DB opens, filesystem writes, authentication or process start. */
export async function resolveRuntimePaths(environment:RuntimeEnvironment,input:RuntimePathInputs,platform:PathPlatform=process.platform==='win32'?'win32':'posix',probe:StateDatabaseProbe=nativeStateDatabaseProbe):Promise<RuntimePaths>{
 checkPlatform(platform);const env=snapshotRuntimeEnvironment(environment),defaultRoot=text(own(input,'root')),home=text(own(input,'userHome')),local=paths(own(input,'localAppCandidates')),path=paths(own(input,'pathCandidates'));
 const resolvedState=await state(env,home,platform,probe),resolvedStore=store(env,defaultRoot,home,platform);
 const configured=(key:string,base:string,name:string)=>{const raw=envPath(env,key);return raw===null?join(base,name,platform):expand(raw,home,platform);};
 const codexHome=resolvedState.codexHome,root=resolvedStore.root;
 const other={bridgeState:configured('CODEX_BRIDGE_STATE',codexHome,'codex_desktop_bridge_state.json'),logDb:configured('CODEX_LOG_DB',codexHome,'logs_2.sqlite'),globalState:configured('CODEX_GLOBAL_STATE',codexHome,'.codex-global-state.json'),sessionIndex:configured('CODEX_SESSION_INDEX',codexHome,'session_index.jsonl'),archivedSessions:configured('CODEX_ARCHIVED_SESSIONS_DIR',codexHome,'archived_sessions'),maintenanceBackupRoot:configured('CODEX_MAINTENANCE_BACKUP_ROOT',codexHome,'maintenance_backups'),attachmentDir:configured('DISCORD_ATTACHMENT_DOWNLOAD_DIR',root,'.codex-discord-attachments')};
 const raw=envPath(env,'CODEX_EXE');let cleaned=raw===null?null:rustTrim(raw).replace(/^["']+|["']+$/g,'');if(cleaned?.endsWith(',0'))cleaned=cleaned.slice(0,-2);
 const exe=await selectRuntimeExecutable({configuredPath:cleaned===null||cleaned===''?null:expand(cleaned,home,platform),codexHome,localAppCandidates:local,pathCandidates:path},platform,probe);
 return Object.freeze({...resolvedStore,...resolvedState,...other,codexExe:exe.path,codexExeSource:exe.source});
}
