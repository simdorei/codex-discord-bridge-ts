import {RemoteFileFailure} from './error.ts';
import {constants} from 'node:fs';
import {open,lstat,realpath,opendir,type FileHandle} from 'node:fs/promises';
import type {BigIntStats,Dir} from 'node:fs';
import {types} from 'node:util';
import {checkRemoteReadCancellation as cancellation} from './read-signal.ts';
import {joinRuntimePath,pinNativeRuntimePath} from '../../runtime/runtime-paths/path-text.ts';
import {validateRemoteRelativePath,validateRemoteGlob,remotePathIsSensitive,remoteGlobMatches,remoteRelativeText,RemoteFilePolicyError} from './path-policy.ts';
import {utf8Compare} from '../request-input.ts';
const MAX=1048576,MAX_SCAN=10000,MAX_PATH_BYTES=4194304;
const acquisition=Object.freeze({});
const skip=new Set(['.codex-remote-mcp','.git','.next','.venv','__pycache__','build','dist','node_modules','vendor']);
const same=(a:BigIntStats,b:BigIntStats)=>a.dev===b.dev&&a.ino===b.ino;
const unsafe=(path:string,reason:string)=>new RemoteFilePolicyError('UnsafePath',path,reason);
const order=(a:string,b:string)=>utf8Compare(a.toLowerCase(),b.toLowerCase())||utf8Compare(a,b);

export interface RemoteNativeRead {readonly kind:'RemoteNativeRead';readonly root:string;}
export interface RemoteListFilesOutput {readonly files:readonly Readonly<{path:string;size_bytes:bigint}>[];readonly truncated:boolean;}
type NativeRead={health:()=>void;read:(relative:string,maxBytes:number,signal?:AbortSignal)=>Promise<Buffer>;list:(pattern:string,limit:number,signal?:AbortSignal)=>Promise<RemoteListFilesOutput>;close:()=>Promise<void>};
const nativeReads=new WeakMap<object,NativeRead>();
function native(value:RemoteNativeRead):NativeRead{if(value===null||typeof value!=='object'||types.isProxy(value)||!nativeReads.has(value))throw new TypeError('Expected authentic native read custody');return nativeReads.get(value)!;}
export function readRemoteOwnedBytes(owner:RemoteReadOwner|RemoteNativeRead,relative:string,maxBytes=MAX,signal?:AbortSignal):Promise<Buffer>{
 if(owner!==null&&typeof owner==='object'&&!types.isProxy(owner)&&nativeReads.has(owner))return native(owner as RemoteNativeRead).read(relative,maxBytes,signal);
 return RemoteReadOwner.prototype.readBytes.call(owner,relative,maxBytes,signal);
}
export function listRemoteOwnedFiles(owner:RemoteNativeRead,pattern:string,limit:number,signal?:AbortSignal):Promise<RemoteListFilesOutput>{return native(owner).list(pattern,limit,signal);}
export function assertRemoteNativeReadHealthy(owner:RemoteNativeRead):void{native(owner).health();}
export function closeRemoteNativeRead(owner:RemoteNativeRead):Promise<void>{return native(owner).close();}
/** Read-only POSIX ownership profile. Retained descriptors and repeated identity
 * checks are not atomic hostile-rename confinement. Binding is trusted local
 * acquisition, never authorization from a remote path. */
export class RemoteReadOwner{
 #root:string;#file:FileHandle;#identity:BigIntStats;#closing=false;#transferred=false;#closed:Promise<void>|undefined;#active=0;#idle:(()=>void)|undefined;#failedCloses:Readonly<{handle:FileHandle|Dir;error:unknown}>[]=[];
 private constructor(root:string,file:FileHandle,identity:BigIntStats,receipt:object){if(receipt!==acquisition)throw new TypeError('Native reader requires actual root acquisition');this.#root=root;this.#file=file;this.#identity=identity;}
 static async bind(input:string):Promise<RemoteReadOwner>{
  if(process.platform==='win32')throw new Error('Native Windows remote file ownership is unqualified');
  const path=pinNativeRuntimePath(input);if(input===''||input.includes('\0')||Buffer.byteLength(input)>32768)throw new TypeError('Invalid project path');
  const root=await realpath(path);let file:FileHandle|undefined;
  try{file=await open(root,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);const identity=await file.stat({bigint:true});const observed=await lstat(root,{bigint:true});
   if(!identity.isDirectory()||!same(identity,observed)||observed.isSymbolicLink()||await realpath(root)!==root)throw unsafe(root,'the bound project root moved or changed identity');
   return new RemoteReadOwner(root,file,identity,acquisition);
  }catch(error){if(file)await file.close();throw error;}
 }
 get root():string{return this.#root;}
 /** Validate all allowlist entries first. Transfer consumes an idle actual owner;
  * direct reads/close and repeat transfer then reject, without acquiring by path. */
 assertTransferable():void{if(this.#closing||this.#transferred||this.#active!==0||this.#failedCloses.length!==0)throw new TypeError('Native reader is closed, active, faulted or already transferred');}
 transfer():RemoteNativeRead{RemoteReadOwner.prototype.assertTransferable.call(this);this.#transferred=true;const value:RemoteNativeRead=Object.freeze({kind:'RemoteNativeRead',root:this.#root});nativeReads.set(value,{health:()=>this.#health(),read:(relative,maxBytes,signal)=>this.#read(relative,maxBytes,signal),list:(pattern,limit,signal)=>this.#list(pattern,limit,signal),close:()=>this.#close()});return value;}
 #health():void{if(this.#failedCloses.length!==0)throw new AggregateError(this.#failedCloses.map(x=>x.error),'Native read handles remain unconfirmed');}
 async #verify():Promise<void>{let observed:BigIntStats;try{observed=await lstat(this.#root,{bigint:true});}catch{throw unsafe(this.#root,'the bound project root moved or changed identity');}if(!observed.isDirectory()||observed.isSymbolicLink()||!same(observed,this.#identity)||await realpath(this.#root)!==this.#root)throw unsafe(this.#root,'the bound project root moved or changed identity');}
 #admit(signal?:AbortSignal):void{cancellation(signal);if(this.#closing||this.#failedCloses.length!==0)throw new Error('Remote project owner is closed or cleanup failed');if(this.#active>=4)throw new RemoteFilePolicyError('Limit','project','four reads already active');this.#active++;}
 #release():void{this.#active--;if(this.#active===0)this.#idle?.();}
 async #closeHandles(handles:FileHandle[]):Promise<void>{let failure:unknown;for(const handle of handles.reverse())try{await handle.close();}catch(error){this.#failedCloses.push({handle,error});failure??=error;}if(failure!==undefined)throw failure;}
 async #parents(relative:string,retained:FileHandle[],includeLeaf=false,signal?:AbortSignal):Promise<void>{
  const parts=relative.split('/').filter(p=>p!==''&&p!=='.');if(parts.length>256)throw new RemoteFilePolicyError('Limit',relative,'path exceeds256components');
  await this.#verify();let current=this.#root;
  for(const part of includeLeaf?parts:parts.slice(0,-1)){cancellation(signal);current=joinRuntimePath(current,part,'posix');const handle=await open(current,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);retained.push(handle);const st=await handle.stat({bigint:true}),observed=await lstat(current,{bigint:true}),canonical=await realpath(current);if(!st.isDirectory()||observed.isSymbolicLink()||!same(st,observed)||!this.#confined(canonical))throw unsafe(relative,'project parent changed identity');}
 }
 #confined(path:string):boolean{return path===this.#root||path.startsWith(this.#root.endsWith('/')?this.#root:this.#root+'/');}
 async #regular(relative:string,retained:FileHandle[],signal?:AbortSignal):Promise<Readonly<{file:FileHandle;before:BigIntStats;target:string}>>{
  await this.#parents(relative,retained,false,signal);const target=joinRuntimePath(this.#root,relative,'posix'),file=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);retained.push(file);
  const before=await file.stat({bigint:true});if(!before.isFile()||before.nlink!==1n)throw unsafe(relative,'path is not a single-link regular file');
  const observed=await lstat(target,{bigint:true});if(observed.isSymbolicLink()||!same(before,observed)||!this.#confined(await realpath(target)))throw unsafe(relative,'file changed during bounded read');return {file,before,target};
 }
 async readBytes(relative:string,maxBytes=MAX,signal?:AbortSignal):Promise<Buffer>{if(this.#transferred)throw new TypeError('Native reader custody was transferred');return this.#read(relative,maxBytes,signal);}
 async #read(relative:string,maxBytes:number,signal?:AbortSignal):Promise<Buffer>{
  validateRemoteRelativePath(relative,'posix');if(!Number.isSafeInteger(maxBytes)||maxBytes<0||maxBytes>MAX)throw new RangeError('Invalid bounded file size');this.#admit(signal);const retained:FileHandle[]=[];
  try{
   const {file,before,target}=await this.#regular(relative,retained,signal);cancellation(signal);if(before.size>BigInt(maxBytes))throw new RemoteFileFailure('Size',relative,`file exceeds ${maxBytes} bytes`);
   const bytes=Buffer.alloc(maxBytes+1);let used=0;while(used<bytes.length){cancellation(signal);const result=await file.read(bytes,used,bytes.length-used,used);cancellation(signal);if(result.bytesRead===0)break;used+=result.bytesRead;}
   if(used>maxBytes)throw new RemoteFileFailure('Size',relative,`file exceeds ${maxBytes} bytes`);
   const after=await file.stat({bigint:true}),observed=await lstat(target,{bigint:true});const canonical=await realpath(target);
   if(!same(before,after)||!same(after,observed)||observed.isSymbolicLink()||after.nlink!==1n||after.size!==before.size||after.mtimeNs!==before.mtimeNs||after.ctimeNs!==before.ctimeNs||!this.#confined(canonical))throw unsafe(relative,'file changed during bounded read');
   await this.#verify();cancellation(signal);return Buffer.from(bytes.subarray(0,used));
  }finally{try{await this.#closeHandles(retained);}finally{this.#release();}}
 }
 async #list(pattern:string,limit:number,signal?:AbortSignal):Promise<RemoteListFilesOutput>{
  validateRemoteGlob(pattern);if(!Number.isInteger(limit)||limit<0||limit>65535)throw new RangeError('Expected u16 list limit');this.#admit(signal);
  let scanned=0,bytes=0,work=0;const candidates:string[]=[];const boundedLimit=Math.max(1,Math.min(limit,500));
  const charge=(n:number)=>{bytes+=n;if(bytes>MAX_PATH_BYTES)throw new RemoteFilePolicyError('Limit','**/*','listing path memory exceeds4194304bytes');};
  const visit=async(relative:string):Promise<void>=>{
   cancellation(signal);const retained:FileHandle[]=[];
   try{
    await this.#parents(relative,retained,true,signal);const target=relative===''?this.#root:joinRuntimePath(this.#root,relative,'posix');
    const handle=await open(target,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);retained.push(handle);const before=await handle.stat({bigint:true}),observed=await lstat(target,{bigint:true});if(!before.isDirectory()||observed.isSymbolicLink()||!same(before,observed)||!this.#confined(await realpath(target)))throw unsafe(relative,'project directory changed identity');
    cancellation(signal);const directory=await opendir(target,{encoding:'latin1',bufferSize:32});const names:string[]=[];
    try{while(true){cancellation(signal);const entry=await directory.read();if(entry===null)break;if(++scanned>MAX_SCAN)throw new RemoteFilePolicyError('Limit','**/*','glob scanned too many candidates; limit is 10000');
      // Latin1 preserves each native byte. Never let lossy UTF8 replacement select
      // another filename or create a display-path alias.
      let name:string;try{name=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.from(entry.name,'latin1'));}catch{throw unsafe(relative,'directory contains a non-UTF-8 filename');}charge(Buffer.byteLength(name));names.push(name);}
    }finally{try{await directory.close();}catch(error){this.#failedCloses.push({handle:directory,error});throw error;}}
    await this.#closeHandles(retained.splice(0,retained.length-1));
    names.sort(order);const seen=new Set<string>();
    for(const name of names){cancellation(signal);if(seen.has(name))continue;seen.add(name);const child=relative===''?name:relative+'/'+name;charge(Buffer.byteLength(child));if(remotePathIsSensitive(child,'posix'))continue;
     // Native directory entries are already single POSIX components. Do not
     // reinterpret literal colon/backslash names as user-supplied path syntax.
     if(name===''||name==='.'||name==='..'||name.includes('/')||name.includes('\0'))throw unsafe(relative,'invalid native directory entry');
     let st:BigIntStats;try{st=await lstat(joinRuntimePath(this.#root,child,'posix'),{bigint:true});}catch{continue;}if(st.isSymbolicLink())continue;
     if(st.isDirectory()){if(!skip.has(name.toLowerCase()))await visit(child);}else if(st.isFile())candidates.push(child);
    }
    const after=await lstat(target,{bigint:true});if(after.isSymbolicLink()||!same(before,after)||!this.#confined(await realpath(target)))throw unsafe(relative,'project directory changed identity');
   }finally{await this.#closeHandles(retained);}
  };
  try{
   await visit('');candidates.sort((a,b)=>order(remoteRelativeText(a),remoteRelativeText(b)));const files:Readonly<{path:string;size_bytes:bigint}>[]=[];let count=0;
   for(const relative of candidates){cancellation(signal);const path=remoteRelativeText(relative);work+=(Buffer.byteLength(pattern)+1)*(Buffer.byteLength(path)+1)+pattern.length*(path.split('/').length+1);if(work>8000000)throw new RemoteFilePolicyError('Limit',pattern,'listing glob exceeds8000000work cells');if(!remoteGlobMatches(pattern,path,'posix'))continue;
    const retained:FileHandle[]=[];try{let opened;try{opened=await this.#regular(relative,retained,signal);}catch{cancellation(signal);continue;}cancellation(signal);count++;if(files.length<boundedLimit)files.push(Object.freeze({path,size_bytes:opened.before.size}));}finally{await this.#closeHandles(retained);}
   }
   await this.#verify();cancellation(signal);return Object.freeze({files:Object.freeze(files),truncated:count>boundedLimit});
  }finally{this.#release();}
 }
 close():Promise<void>{if(this.#transferred)return Promise.reject(new TypeError('Native reader custody was transferred'));return this.#close();}
 #close():Promise<void>{if(this.#closed)return this.#closed;this.#closing=true;this.#closed=(async()=>{if(this.#active)await new Promise<void>(resolve=>{this.#idle=resolve;});await this.#closeHandles([this.#file]);if(this.#failedCloses.length)throw new AggregateError(this.#failedCloses.map(x=>x.error),'Native read handles remain unconfirmed');})();return this.#closed;}
}
Object.freeze(RemoteReadOwner.prototype);
