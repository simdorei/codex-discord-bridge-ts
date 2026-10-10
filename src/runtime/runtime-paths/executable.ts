import {joinRuntimePath as append} from './path-text.ts';
import {stat} from 'node:fs/promises';
import {types} from 'node:util';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
export type ExecutablePathSource='Environment'|'LocalAppBin'|'SandboxBin'|'Path';
export interface ExecutableInputs{readonly configuredPath:string|null;readonly codexHome:string;readonly localAppCandidates:readonly string[];readonly pathCandidates:readonly string[]}
export interface ExecutableProbe{isFile(path:string):Promise<boolean>;modifiedNs(path:string):Promise<bigint>}
export class RuntimeExecutableError extends Error{
 readonly kind:'ConfiguredExecutableMissing'|'CodeModeHostMissing'|'WindowsAppsAliasOnly'|'ExecutableNotFound';readonly path:string|null;
 constructor(kind:RuntimeExecutableError['kind'],path:string|null=null){super(kind==='ConfiguredExecutableMissing'?`configured CODEX_EXE does not exist or is not a file: ${path}`:kind==='CodeModeHostMissing'?`Codex installation is incomplete: missing ${path}; no usable fallback was found; set CODEX_EXE to codex.exe in a complete Codex installation containing its matching codex-code-mode-host.exe`:kind==='WindowsAppsAliasOnly'?'Codex resolves only to a WindowsApps alias; configure the real CODEX_EXE':'no usable Codex executable was found');this.name='RuntimeExecutableError';this.kind=kind;this.path=path;Object.freeze(this);}
}
export const nativeExecutableProbe:ExecutableProbe=Object.freeze({
 async isFile(path:string){try{return (await stat(path,{bigint:true})).isFile();}catch{return false;}},
 async modifiedNs(path:string){try{return (await stat(path,{bigint:true})).mtimeNs;}catch{return 0n;}},
});
function paths(value:unknown):string[]{if(!Array.isArray(value)||types.isProxy(value))throw new TypeError('Expected dense path array');const out:string[]=[];for(let i=0;i<value.length;i++){const v=own(value,String(i));requireDiscordText(v as string);out.push(v as string);}return out;}
function sibling(path:string,name:string,platform:'win32'|'posix'):string{const index=platform==='win32'?Math.max(path.lastIndexOf('/'),path.lastIndexOf('\\')):path.lastIndexOf('/');return index<0?(/^[a-z]:/i.test(path)&&platform==='win32'?path.slice(0,2)+name:name):path.slice(0,index+1)+name;}
/** Selection leaf over already-expanded paths. Latest Rust host validation is
 * preserved: incomplete explicit/local/sandbox installs may fall back; a missing
 * explicit executable may not. Does not discover paths, start or authenticate.
 * UTF-8 tie ordering is tested on Linux; native Windows path ordering remains QA. */
export async function selectRuntimeExecutable(input:ExecutableInputs,platform:'win32'|'posix'=process.platform==='win32'?'win32':'posix',probe:ExecutableProbe=nativeExecutableProbe):Promise<{readonly path:string;readonly source:ExecutablePathSource}>{
 if(platform!=='win32'&&platform!=='posix')throw new TypeError('Expected path platform');
 const configured=own(input,'configuredPath') as string|null,home=own(input,'codexHome') as string;if(configured!==null)requireDiscordText(configured);requireDiscordText(home);
 const local=paths(own(input,'localAppCandidates')),pathCandidates=paths(own(input,'pathCandidates'));
 const file=own(probe,'isFile'),modified=own(probe,'modifiedNs');for(const fn of [file,modified])if(typeof fn!=='function'||types.isProxy(fn)||types.isGeneratorFunction(fn))throw new TypeError('Expected owned file probe');
 const read=async<T>(fn:unknown,path:string,kind:'boolean'|'bigint'):Promise<T>=>{const task=Reflect.apply(fn as Function,probe,[path]);if(!types.isPromise(task))throw new TypeError('Expected native file probe Promise');const result=await task;if(typeof result!==kind)throw new TypeError('Invalid file probe result');return result as T;};
 const isFile=(path:string)=>read<boolean>(file,path,'boolean');let missingHost:RuntimeExecutableError|null=null;
 const usable=async(path:string,source:ExecutablePathSource)=>{const normalized=path.replaceAll('\\','/').toLowerCase();if(platform==='win32'&&(normalized.includes('/openai/codex/bin/')||normalized.includes('/.sandbox-bin/'))){const host=sibling(path,'codex-code-mode-host.exe',platform);if(!await isFile(host)){missingHost??=new RuntimeExecutableError('CodeModeHostMissing',host);return null;}}return Object.freeze({path,source});};
 if(configured!==null&&configured!==''){if(!await isFile(configured))throw new RuntimeExecutableError('ConfiguredExecutableMissing',configured);const resolved=await usable(configured,'Environment');if(resolved!==null)return resolved;}
 const existing:{path:string;modified:bigint}[]=[];for(const path of local)if(await isFile(path))existing.push({path,modified:await read<bigint>(modified,path,'bigint')});existing.sort((a,b)=>a.modified<b.modified?-1:a.modified>b.modified?1:Buffer.compare(Buffer.from(a.path),Buffer.from(b.path)));
 for(const candidate of existing.reverse()){const resolved=await usable(candidate.path,'LocalAppBin');if(resolved!==null)return resolved;}
 const sandbox=append(append(home,'.sandbox-bin',platform),platform==='win32'?'codex.exe':'codex',platform);if(await isFile(sandbox)){const resolved=await usable(sandbox,'SandboxBin');if(resolved!==null)return resolved;}
 let alias=false;for(const path of pathCandidates){if(!await isFile(path))continue;if(path.replaceAll('\\','/').toLowerCase().includes('/windowsapps/'))alias=true;else{const resolved=await usable(path,'Path');if(resolved!==null)return resolved;}}
 if(missingHost!==null)throw missingHost;throw new RuntimeExecutableError(alias?'WindowsAppsAliasOnly':'ExecutableNotFound');
}
