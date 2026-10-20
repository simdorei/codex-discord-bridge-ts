import {createHash,randomUUID} from 'node:crypto';
import {open,lstat,realpath,mkdir,link,rename,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,dirname,relative,isAbsolute} from 'node:path';
import {WindowsFilePin} from '../../runtime/windows/windows-file-pin.ts';
import {validateRemoteRelativePath} from './path-policy.ts';
import {RemoteFileFailure} from './error.ts';
export const fileDigest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const platform=process.platform==='win32'?'win32':'posix';
const conflict=(path:string)=>new RemoteFileFailure('Conflict',path,'file changed since it was read');
const identity=(a:{dev:bigint;ino:bigint},b:{dev:bigint;ino:bigint})=>a.dev===b.dev&&a.ino===b.ino;
const missing=(e:unknown)=>(e as NodeJS.ErrnoException)?.code==='ENOENT';
async function boundedRead(file:Awaited<ReturnType<typeof open>>,max:number):Promise<Buffer>{const parts:Buffer[]=[];let size=0;for(;;){const b=Buffer.alloc(Math.min(65536,max+1-size)),n=(await file.read(b,0,b.length,null)).bytesRead;if(!n)return Buffer.concat(parts,size);size+=n;if(size>max)throw new RangeError('File grew past mutation budget');parts.push(b.subarray(0,n));}}
/** Root-scoped file mutation. Parent handles survive all checks/publication;
 * Windows update handles deny writers while permitting our backup rename.
 * Existing data is never overwritten without its exact expected SHA-256. */
export class RemoteFileMutations {
 readonly root:string;readonly #rootPin:WindowsFilePin|undefined;#closed=false;#closeFailure:unknown;
 private constructor(root:string,pin:WindowsFilePin|undefined){this.root=root;this.#rootPin=pin;}
 static async bind(input:string):Promise<RemoteFileMutations>{const root=await realpath(input);if(!(await lstat(root)).isDirectory())throw new TypeError('Project root must be a directory');return new RemoteFileMutations(root,platform==='win32'?WindowsFilePin.acquire(root,'directory'):undefined);}
 path(value:string,internal=false):string {
  if(this.#closed)throw new Error('Project files are closed');
  if(internal){if(!/^\.codex-remote-mcp\/checkpoints\/cp_[a-f0-9]{16}\.json$/.test(value))throw new TypeError('Invalid private checkpoint path');}
  else validateRemoteRelativePath(value,platform);
  const target=join(this.root,value),part=relative(this.root,target);if(part===''||part==='..'||part.startsWith('..\\')||part.startsWith('../')||isAbsolute(part))throw new RemoteFileFailure('UnsafePath',value,'path escapes project');return target;
 }
 async #parents(target:string,create:boolean):Promise<()=>void>{
  let current=this.root;const pins:WindowsFilePin[]=[];
  try{for(const part of relative(this.root,dirname(target)).split(/[\\/]/).filter(Boolean)){current=join(current,part);if(create)try{await mkdir(current);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
   const stat=await lstat(current);if(stat.isSymbolicLink()||!stat.isDirectory()||await realpath(current)!==current)throw new RemoteFileFailure('UnsafePath',current,'parent is not a retained directory');if(platform==='win32')pins.push(WindowsFilePin.acquire(current,'directory'));}
   return ()=>{for(const pin of pins.reverse())pin.close();};
  }catch(error){for(const pin of pins.reverse())pin.close();throw error;}
 }
 async read(value:string,max=1048576,internal=false):Promise<Buffer|null>{
  const path=this.path(value,internal);let release:()=>void;
  try{release=await this.#parents(path,false);}catch(error){if(missing(error))return null;throw error;}
  let pin:WindowsFilePin|undefined;
  try{
   let observed;try{observed=await lstat(path,{bigint:true});}catch(error){if(missing(error))return null;throw error;}
   if(!observed.isFile()||observed.isSymbolicLink()||observed.nlink!==1n)throw new RemoteFileFailure('UnsafePath',value,'file must be regular and single-link');
   if(platform==='win32')pin=WindowsFilePin.acquire(path,'file',true);
   const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
   try{const before=await file.stat({bigint:true});if(!identity(before,observed)||before.size>BigInt(max))throw new RemoteFileFailure('Size',value,'file exceeds observation budget');const bytes=Buffer.alloc(Number(before.size)+1);let used=0;
    while(used<bytes.length){const {bytesRead}=await file.read(bytes,used,bytes.length-used,null);if(!bytesRead)break;used+=bytesRead;}
    const after=await file.stat({bigint:true});if(used!==Number(before.size)||after.mtimeNs!==before.mtimeNs||after.ctimeNs!==before.ctimeNs||!identity(after,await lstat(path,{bigint:true})))throw conflict(value);return bytes.subarray(0,used);
   }finally{await file.close();}
  }finally{try{pin?.close();}finally{release();}}
 }
 async write(value:string,content:Uint8Array,expected:string|null,internal=false):Promise<boolean>{
  if(content.byteLength>33554432)throw new RemoteFileFailure('Size',value,'content exceeds mutation budget');const bytes=Buffer.from(content),path=this.path(value,internal),release=await this.#parents(path,true);
  const temporary=join(dirname(path),'.cdr-'+randomUUID()+'.tmp');let createdTemp=false,published=false;let pin:WindowsFilePin|undefined,tempPin:WindowsFilePin|undefined;
  try{
   const current=await this.read(value,33554432,internal);if(current===null?expected!==null:expected===null||fileDigest(current)!==expected)throw conflict(value);
   const file=await open(temporary,'wx',0o600);createdTemp=true;try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}
   if(platform==='win32')tempPin=WindowsFilePin.acquire(temporary,'file',true,true);
   const tempIdentity=await lstat(temporary,{bigint:true});
   if(current===null){await link(temporary,path);published=true;}
   else{
    if(platform==='win32')pin=WindowsFilePin.acquire(path,'file',true,true);
    const held=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);const backup=join(dirname(path),'.cdr-'+randomUUID()+'.bak');let moved=false;
    try{const before=await held.stat({bigint:true});if(before.size>33554432n||before.nlink!==1n||!before.isFile())throw conflict(value);const raw=await boundedRead(held,33554432);if(fileDigest(raw)!==expected||!identity(before,await lstat(path,{bigint:true})))throw conflict(value);
     await rename(path,backup);moved=true;if(!identity(before,await lstat(backup,{bigint:true})))throw conflict(value);
     await link(temporary,path);published=true;await unlink(backup);moved=false;
    }finally{try{await held.close();}finally{pin?.close();pin=undefined;if(moved){try{await link(backup,path);await unlink(backup);}catch{/* Preserve exact backup if another writer owns the destination. */}}}}
   }
   if(!identity(tempIdentity,await lstat(path,{bigint:true})))throw conflict(value);await unlink(temporary);createdTemp=false;return current===null;
  }catch(error){if(published)throw new AggregateError([error],'File was published; inspect checkpoint before retrying');throw error;}
  finally{try{pin?.close();if(createdTemp)await unlink(temporary);}finally{try{tempPin?.close();}finally{release();}}}
 }
 async delete(value:string,expected:string,internal=false):Promise<void>{
  const path=this.path(value,internal),release=await this.#parents(path,false);let pin:WindowsFilePin|undefined;
  const backup=join(dirname(path),'.cdr-'+randomUUID()+'.delete');let moved=false;
  try{const raw=await this.read(value,33554432,internal);if(raw===null||fileDigest(raw)!==expected)throw conflict(value);if(platform==='win32')pin=WindowsFilePin.acquire(path,'file',true,true);
   const before=await lstat(path,{bigint:true});const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{if(fileDigest(await boundedRead(file,33554432))!==expected||!identity(before,await file.stat({bigint:true})))throw conflict(value);await rename(path,backup);moved=true;if(!identity(before,await lstat(backup,{bigint:true})))throw conflict(value);await unlink(backup);moved=false;}finally{await file.close();}
  }finally{try{pin?.close();if(moved)try{await link(backup,path);await unlink(backup);}catch{/* Preserve backup, never clobber a concurrently created file. */}}finally{release();}}
 }
 close():void{if(this.#closed){if(this.#closeFailure)throw this.#closeFailure;return;}this.#closed=true;try{this.#rootPin?.close();}catch(error){this.#closeFailure=error;throw error;}}
}
