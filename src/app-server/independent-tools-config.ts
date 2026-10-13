import {cloneOwnedSerdeValue} from '../core/owned-serde-value.ts';
const desktopNames=new Set(['CODEX_APP_TOOLS_PIPE_PATH','BROWSER_USE_ACCESS_VERIFYING_IDENTITY','CODEX_TASK_WORKSPACE_VERIFYING_IDENTITY','SKY_CUA_NATIVE_PIPE_DIRECTORY','CODEX_INTERNAL_ORIGINATOR_OVERRIDE','CODEX_SESSION_ID','CODEX_THREAD_ID']);
export function defaultAppServerArguments(platform:NodeJS.Platform):readonly string[]{
 return Object.freeze(platform==='win32'?['app-server','--stdio','-c','mcp_servers.node_repl.env.SKY_CUA_NATIVE_PIPE="0"']:['app-server','--stdio']);
}
/** Remove inherited Windows desktop-session identities before explicit overrides.
 * Pure assembly only; does not qualify a Windows process owner or native tools. */
export function independentInheritedEnvironment(input:Readonly<Record<string,string>>,platform:NodeJS.Platform):Record<string,string>{
 const snapshot=cloneOwnedSerdeValue(input);
 if(snapshot===null||typeof snapshot!=='object'||Array.isArray(snapshot))throw new TypeError('Expected environment record');
 const result:Record<string,string>=Object.create(null);
 for(const key of Object.keys(snapshot)){
  if(platform==='win32'&&desktopNames.has(key.toUpperCase()))continue;
  const value=(snapshot as Record<string,unknown>)[key];
  if(typeof value!=='string')throw new TypeError('Expected environment text');
  Object.defineProperty(result,key,{value,enumerable:true,writable:true,configurable:true});
 }
 return result;
}
