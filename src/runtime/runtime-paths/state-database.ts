import {readdir} from 'node:fs/promises';
import {types} from 'node:util';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {nativeExecutableProbe,type ExecutableProbe} from './executable.ts';

export interface StateDatabaseProbe extends ExecutableProbe {
  /** Immediate entry names only; failed native directory reads become an empty list. */
  entryNames(directory:string):Promise<readonly string[]>;
}
export const nativeStateDatabaseProbe:StateDatabaseProbe=Object.freeze({
  ...nativeExecutableProbe,
  async entryNames(directory:string):Promise<readonly string[]> {
    let entries:Buffer[];try { entries=await readdir(directory,{encoding:'buffer'}); } catch { return []; }
    const names:string[]=[];const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
    // Rust file_name().to_str() refuses invalid UTF-8 instead of replacing bytes.
    for(const entry of entries){try{names.push(decoder.decode(entry));}catch{continue;}}
    return names;
  },
});
function appendName(base:string,name:string,platform:'win32'|'posix'):string {
  if(base===''||base.endsWith('/')||(platform==='win32'&&(/^[A-Za-z]:$/.test(base)||base.endsWith('\\'))))return base+name;
  return base+(platform==='win32'?'\\':'/')+name;
}
/** Read-only selection shared by future online/offline path resolvers. Does not
 * open SQLite, initialize a database, or create the fallback file. Directory
 * enumeration and metadata use asynchronous native fs calls. */
export async function findRuntimeStateDatabase(
  codexHome:string,
  platform:'win32'|'posix'=process.platform==='win32'?'win32':'posix',
  probe:StateDatabaseProbe=nativeStateDatabaseProbe,
):Promise<string>{
  requireDiscordText(codexHome);if(platform!=='win32'&&platform!=='posix')throw new TypeError('Expected path platform');
  const entriesFn=own(probe,'entryNames'),fileFn=own(probe,'isFile'),modifiedFn=own(probe,'modifiedNs');
  for(const fn of [entriesFn,fileFn,modifiedFn])if(typeof fn!=='function'||types.isProxy(fn)||types.isGeneratorFunction(fn))throw new TypeError('Expected owned state database probe');
  const call=async(fn:unknown,path:string):Promise<unknown>=>{const task=Reflect.apply(fn as Function,probe,[path]);if(!types.isPromise(task))throw new TypeError('Expected native probe Promise');return await task;};
  const raw=await call(entriesFn,codexHome);if(!Array.isArray(raw)||types.isProxy(raw))throw new TypeError('Expected state directory entries');
  const names:string[]=[];
  for(let i=0;i<raw.length;i++){
    const name=own(raw,String(i));requireDiscordText(name as string);
    if(name===''||name==='.'||name==='..'||(name as string).includes('/')||(platform==='win32'&&(/[\\:]/.test(name as string))))throw new TypeError('Expected immediate directory entry name');
    names.push(name as string);
  }
  const candidates:{name:string;path:string;mtime:bigint}[]=[];
  for(const name of names){
    if(!name.startsWith('state_')||!name.endsWith('.sqlite'))continue;
    const path=appendName(codexHome,name,platform),file=await call(fileFn,path);
    if(typeof file!=='boolean')throw new TypeError('Invalid state database file probe');if(!file)continue;
    const mtime=await call(modifiedFn,path);if(typeof mtime!=='bigint')throw new TypeError('Invalid state database modification time');
    candidates.push({name,path,mtime});
  }
  candidates.sort((a,b)=>a.mtime<b.mtime?-1:a.mtime>b.mtime?1:Buffer.compare(Buffer.from(a.name),Buffer.from(b.name)));
  return candidates.at(-1)?.path??appendName(codexHome,'state_5.sqlite',platform);
}
