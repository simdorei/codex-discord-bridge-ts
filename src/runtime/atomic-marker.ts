import {randomUUID} from 'node:crypto';
import {open,mkdir,rename,unlink} from 'node:fs/promises';
import {dirname} from 'node:path';
import {joinRuntimePath} from './runtime-paths/path-text.ts';
import {requireDiscordText} from '../discord/text.ts';
/** POSIX temp-file + fsync + rename. Owns only a successfully created wx temp.
 * Windows write-through replacement requires its separately qualified adapter. */
export async function writePosixAtomicMarker(path:string,text:string):Promise<void>{
 requireDiscordText(path);requireDiscordText(text);if(process.platform==='win32')throw new Error('Windows write-through marker adapter is not implemented');
 const parent=dirname(path);let temporary:string|null=null,owned=false;
 try{await mkdir(parent,{recursive:true});temporary=joinRuntimePath(parent,`.cdr-runtime-${randomUUID()}.tmp`,'posix');const handle=await open(temporary,'wx',0o600);owned=true;let failed=false,primary:unknown;
  try{await handle.writeFile(text,'utf8');await handle.sync();}catch(error){failed=true;primary=error;}
  try{await handle.close();}catch(error){if(!failed){failed=true;primary=error;}}if(failed)throw primary;
  await rename(temporary,path);temporary=null;
 }catch(error){if(temporary!==null&&owned)try{await unlink(temporary);}catch{/* primary remains the actual publication failure */}throw error;}
}
