import {RemoteFileFailure} from './error.ts';
import {constants} from 'node:fs';
import {open,lstat,realpath,type FileHandle} from 'node:fs/promises';
import type {BigIntStats} from 'node:fs';
import {joinRuntimePath,pinNativeRuntimePath} from '../../runtime/runtime-paths/path-text.ts';
import {validateRemoteRelativePath,RemoteFilePolicyError} from './path-policy.ts';
const MAX=1048576;
const same=(a:BigIntStats,b:BigIntStats)=>a.dev===b.dev&&a.ino===b.ino;
const unsafe=(path:string,reason:string)=>new RemoteFilePolicyError('UnsafePath',path,reason);
/** Read-only POSIX ownership profile. No atomic hostile-rename confinement claim.
 * Not a project authorization token; not wired into the remote dispatcher. */
export class RemoteReadOwner{
 #root:string;#file:FileHandle;#identity:BigIntStats;#closing=false;#closed:Promise<void>|undefined;#active=0;#idle:(()=>void)|undefined;
 private constructor(root:string,file:FileHandle,identity:BigIntStats){this.#root=root;this.#file=file;this.#identity=identity;}
 static async bind(input:string):Promise<RemoteReadOwner>{
  if(process.platform==='win32')throw new Error('Native Windows remote file ownership is unqualified');
  const path=pinNativeRuntimePath(input);if(input===''||input.includes('\0')||Buffer.byteLength(input)>32768)throw new TypeError('Invalid project path');
  const root=await realpath(path);let file:FileHandle|undefined;
  try{file=await open(root,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);const identity=await file.stat({bigint:true});const observed=await lstat(root,{bigint:true});
   if(!identity.isDirectory()||!same(identity,observed)||observed.isSymbolicLink()||await realpath(root)!==root)throw unsafe(root,'the bound project root moved or changed identity');
   return new RemoteReadOwner(root,file,identity);
  }catch(error){if(file)await file.close();throw error;}
 }
 get root():string{return this.#root;}
 async #verify():Promise<void>{let observed:BigIntStats;try{observed=await lstat(this.#root,{bigint:true});}catch{throw unsafe(this.#root,'the bound project root moved or changed identity');}if(!observed.isDirectory()||observed.isSymbolicLink()||!same(observed,this.#identity)||await realpath(this.#root)!==this.#root)throw unsafe(this.#root,'the bound project root moved or changed identity');}
 async readBytes(relative:string,maxBytes=MAX):Promise<Buffer>{
  if(this.#closing)throw new Error('Remote project owner is closed');
  validateRemoteRelativePath(relative,'posix');if(!Number.isSafeInteger(maxBytes)||maxBytes<0||maxBytes>MAX)throw new RangeError('Invalid bounded file size');
  const parts=relative.split('/').filter(p=>p!==''&&p!=='.');
  if(parts.length>256)throw new RemoteFilePolicyError('Limit',relative,'path exceeds256components');
  if(this.#active>=4)throw new RemoteFilePolicyError('Limit',relative,'four reads already active');
  this.#active++;const retained:FileHandle[]=[];
  try{
   await this.#verify();let current=this.#root;
   for(const part of parts.slice(0,-1)){current=joinRuntimePath(current,part,'posix');const handle=await open(current,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);retained.push(handle);const st=await handle.stat({bigint:true}),path=await lstat(current,{bigint:true});if(!st.isDirectory()||path.isSymbolicLink()||!same(st,path))throw unsafe(relative,'project parent changed identity');}
   const target=joinRuntimePath(this.#root,relative,'posix');const file=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);retained.push(file);
   const before=await file.stat({bigint:true});if(!before.isFile()||before.nlink!==1n)throw unsafe(relative,'path is not a single-link regular file');
   if(before.size>BigInt(maxBytes))throw new RemoteFileFailure('Size',relative,`file exceeds ${maxBytes} bytes`);
   const bytes=Buffer.alloc(maxBytes+1);let used=0;while(used<bytes.length){const result=await file.read(bytes,used,bytes.length-used,used);if(result.bytesRead===0)break;used+=result.bytesRead;}
   if(used>maxBytes)throw new RemoteFileFailure('Size',relative,`file exceeds ${maxBytes} bytes`);
   const after=await file.stat({bigint:true}),observed=await lstat(target,{bigint:true});const canonical=await realpath(target);
   if(!same(before,after)||!same(after,observed)||observed.isSymbolicLink()||after.nlink!==1n||after.size!==before.size||after.mtimeNs!==before.mtimeNs||after.ctimeNs!==before.ctimeNs||!(canonical.startsWith(this.#root.endsWith('/')?this.#root:this.#root+'/')))throw unsafe(relative,'file changed during bounded read');
   await this.#verify();return Buffer.from(bytes.subarray(0,used));
  }finally{
   let failure:unknown;for(const handle of retained.reverse())try{await handle.close();}catch(error){failure??=error;}
   this.#active--;if(this.#active===0)this.#idle?.();if(failure!==undefined)throw failure;
  }
 }
 close():Promise<void>{if(this.#closed)return this.#closed;this.#closing=true;this.#closed=(async()=>{if(this.#active)await new Promise<void>(resolve=>{this.#idle=resolve;});await this.#file.close();})();return this.#closed;}
}
