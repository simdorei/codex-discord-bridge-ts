import {dirname,join,resolve} from 'node:path';import {types} from 'node:util';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../runtime/owned-worker-slot.ts';
import {requireDiscordText} from '../discord/text.ts';
const slot=new OwnedWorkerSlot('Control');
export class StartupEnvironmentError extends Error {readonly path:string;readonly code:string;constructor(path:string,code:string){super(`could not read environment file ${path}: ${code}`);this.name='StartupEnvironmentError';this.path=path;this.code=code;}}
function path(value:string):string{requireDiscordText(value);if(value.includes('\0')||value.length>32768)throw new TypeError('Invalid startup environment path');return value;}
/** Native-host path semantics. Caller supplies its actual application entry or
 * packaged executable path, not implicitly the Node binary path. */
export function defaultStartupEnvironmentPath(executablePath:string):string{return join(dirname(path(executablePath)),'.env');}
/** Source environment precedence and missing-file tolerance with bounded native
 * file reading/UTF8 decoding/merge. The caller supplies a process environment
 * snapshot; this module never implicitly reads/logs secrets from process.env.
 * All entries/path are captured before await, no global environment is mutated.
 * 4096 entries/1MiB input code units/1MiB regular file/4MiB output are explicit
 * bounded profiles. Timeout/abort joins actual worker exit, not fake completion. */
export async function loadStartupEnvironmentOffThread(environment:ReadonlyMap<string,string>,explicitPath:string|null,executablePath:string,signal?:AbortSignal,timeoutMs=10000):Promise<Map<string,string>>{
 if(signal!==undefined&&(types.isProxy(signal)||!(signal instanceof AbortSignal)))throw new TypeError('Expected startup environment abort signal');signal?.throwIfAborted();
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw new RangeError('Invalid startup environment timeout');
 if(types.isProxy(environment))throw new TypeError('Expected native environment map');const entries:Array<[string,string]>=[];let units=0,inspected=0;
 Map.prototype.forEach.call(environment,(value:unknown,key:unknown)=>{if(++inspected>4096)throw new RangeError('Startup environment snapshot exceeds entry budget');if(typeof key!=='string'||typeof value!=='string')throw new TypeError('Expected environment strings');units+=key.length+value.length;if(entries.length>=4096||units>1048576)throw new RangeError('Startup environment snapshot exceeds budget');try{requireDiscordText(key);requireDiscordText(value);}catch{return;}entries.push([key,value]);});
 const selectedPath=explicitPath===null?defaultStartupEnvironmentPath(executablePath):path(explicitPath);
 // Empty explicit path is ENOENT in source, not the current directory.
 const filePath=selectedPath===''?'':resolve(selectedPath);if(filePath.length>32768)throw new RangeError('Startup environment path exceeds budget');
 if(slot.busy)throw new OwnedWorkerBusyError();const pending=slot.run(new URL('./environment-worker.ts',import.meta.url),{entries,filePath},timeoutMs,signal),joined=slot.join();let response:unknown;
 try{response=await pending;}finally{await joined;}signal?.throwIfAborted();
 if(response===null||typeof response!=='object')throw new TypeError('Invalid environment worker response');const r=response as {ok?:unknown;code?:unknown;entries?:unknown};if(r.ok===false){if(typeof r.code!=='string'||r.code.length>100)throw new TypeError('Invalid environment failure');throw new StartupEnvironmentError(filePath,r.code);}
 if(r.ok!==true||!Array.isArray(r.entries)||r.entries.length>4096)throw new TypeError('Invalid environment entries');let total=0;const result=new Map<string,string>();
 for(const entry of r.entries){if(!Array.isArray(entry)||entry.length!==2||typeof entry[0]!=='string'||typeof entry[1]!=='string')throw new TypeError('Invalid environment entry');total+=entry[0].length+entry[1].length;if(total>4194304||result.has(entry[0]))throw new TypeError('Invalid environment output bound');result.set(entry[0],entry[1]);}
 return result;
}
