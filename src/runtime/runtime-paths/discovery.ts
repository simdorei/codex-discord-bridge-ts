import {types} from 'node:util';
import {asciiLower,rustTrim} from '../../config/remote.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {joinRuntimePath as join,type PathPlatform} from './path-text.ts';
import {snapshotRuntimeEnvironment,type RuntimeEnvironment,type RuntimePathInputs} from './resolve.ts';
import {nativeStateDatabaseProbe,type StateDatabaseProbe} from './state-database.ts';
export type DiscoveryPlatform='win32'|'darwin'|'posix';
export class RuntimePathDiscoveryError extends Error{
 readonly kind:'UserHomeMissing'|'ConflictingEnvironmentValues';readonly key:string|null;
 constructor(kind:RuntimePathDiscoveryError['kind'],key:string|null=null){super(kind==='UserHomeMissing'?'could not determine the current user home from USERPROFILE or HOME':`conflicting Windows environment values for ${key}`);this.name='RuntimePathDiscoveryError';this.kind=kind;this.key=key;Object.freeze(this);}
}
function value(env:RuntimeEnvironment,key:string,platform:PathPlatform):string|null{
 const exact=Object.getOwnPropertyDescriptor(env,key);if(exact!==undefined)return exact.value as string;if(platform!=='win32')return null;
 let result:string|null=null;for(const name of Object.keys(env))if(asciiLower(name)===asciiLower(key)){const next=env[name]!;if(result!==null&&next!==result)throw new RuntimePathDiscoveryError('ConflictingEnvironmentValues',key);result=next;}return result;
}
function first(env:RuntimeEnvironment,keys:readonly string[],platform:PathPlatform):string|null{for(const key of keys){const raw=value(env,key,platform);if(raw!==null){const result=rustTrim(raw);if(result!=='')return result;}}return null;}
/** Native Windows PATH quote handling, including quoted semicolons inside a
 * component, empty entries and an unmatched closing region. POSIX has no quoting. */
export function splitRuntimeSearchPath(raw:string,platform:PathPlatform):readonly string[]{
 requireDiscordText(raw);if(platform==='posix')return Object.freeze(raw.split(':'));if(platform!=='win32')throw new TypeError('Expected path platform');
 const output:string[]=[];let current='',quoted=false;for(const char of raw){if(char==='"')quoted=!quoted;else if(char===';'&&!quoted){output.push(current);current='';}else current+=char;}output.push(current);return Object.freeze(output);
}
/** Environment is explicit and snapshotted. Discovery reads metadata only and
 * never executes discovered binaries or opens their databases. Native Windows
 * discovery and admin CLI end-to-end remain separate qualification. */
export async function discoverRuntimePathInputs(environment:RuntimeEnvironment,root:string,platform:DiscoveryPlatform=process.platform==='win32'?'win32':process.platform==='darwin'?'darwin':'posix',probe:StateDatabaseProbe=nativeStateDatabaseProbe):Promise<RuntimePathInputs>{
 requireDiscordText(root);if(platform!=='win32'&&platform!=='darwin'&&platform!=='posix')throw new TypeError('Expected discovery platform');const os:PathPlatform=platform==='win32'?'win32':'posix',env=snapshotRuntimeEnvironment(environment);
 const home=first(env,['USERPROFILE','HOME'],os);if(home===null)throw new RuntimePathDiscoveryError('UserHomeMissing');
 const files=own(probe,'isFile'),entries=own(probe,'entryNames');for(const fn of [files,entries])if(typeof fn!=='function'||types.isProxy(fn)||types.isGeneratorFunction(fn))throw new TypeError('Expected owned discovery probe');
 const call=async(fn:unknown,path:string):Promise<unknown>=>{const task=Reflect.apply(fn as Function,probe,[path]);if(!types.isPromise(task))throw new TypeError('Expected native discovery Promise');return await task;};
 const isFile=async(path:string)=>{const result=await call(files,path);if(typeof result!=='boolean')throw new TypeError('Invalid discovery file metadata');return result;};
 const names=async(path:string)=>{const raw=await call(entries,path);if(!Array.isArray(raw)||types.isProxy(raw))throw new TypeError('Expected immediate discovery entries');const output:string[]=[];for(let i=0;i<raw.length;i++){const name=own(raw,String(i));requireDiscordText(name as string);if(name===''||name==='.'||name==='..'||(name as string).includes('/')||(os==='win32'&&/[\\:]/.test(name as string)))throw new TypeError('Expected immediate discovery name');output.push(name as string);}return output;};
 const roots:string[]=[],local=first(env,['LOCALAPPDATA'],os);if(local!==null)roots.push(join(local,'OpenAI/Codex/bin',os));roots.push(join(home,'AppData/Local/OpenAI/Codex/bin',os),join(home,'Library/Application Support/OpenAI/Codex/bin',os));if(platform==='darwin')roots.push('/Applications/Codex.app/Contents/Resources/bin');
 const executable=os==='win32'?'codex.exe':'codex',localAppCandidates:string[]=[],pathCandidates:string[]=[];
 for(const localRoot of roots){const direct=join(localRoot,executable,os);if(await isFile(direct))localAppCandidates.push(direct);for(const child of await names(localRoot)){const candidate=join(join(localRoot,child,os),executable,os);if(await isFile(candidate))localAppCandidates.push(candidate);}}
 const search=value(env,'PATH',os);if(search!==null)for(const directory of splitRuntimeSearchPath(search,os)){const candidate=join(directory,executable,os);if(await isFile(candidate))pathCandidates.push(candidate);}
 return Object.freeze({root,userHome:home,localAppCandidates:Object.freeze(localAppCandidates),pathCandidates:Object.freeze(pathCandidates)});
}
