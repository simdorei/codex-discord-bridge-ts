import {open,stat,type FileHandle} from 'node:fs/promises';
import {resolve} from 'node:path';
import type {BigIntStats} from 'node:fs';
import {requireDiscordText} from '../../discord/text.ts';
const TOKEN=Symbol('owned mirror file observation');
const MAX_OPEN=8,MAX_BYTES=1048576;
let active=0;
export function activeMirrorFileReads():number{return active;}
export class MirrorFileBusyError extends Error{constructor(){super('mirror file IO capacity is occupied; no queued read created');this.name='MirrorFileBusyError';}}
export class MirrorFileChangedError extends Error{constructor(){super('mirror file identity or metadata changed; retain cursor and observe again');this.name='MirrorFileChangedError';}}
/** The capacity slot remains occupied until an explicit retry confirms close. */
export class MirrorFileClosePendingError extends Error {
 readonly primary:unknown;readonly cleanup:unknown;readonly #handle:FileHandle;#closed=false;#pending:Promise<void>|undefined;
 constructor(token:symbol,handle:FileHandle,primary:unknown,cleanup:unknown){if(token!==TOKEN)throw new TypeError('Expected owned close debt');super('Mirror file close is unresolved; IO capacity retained',{cause:cleanup});this.primary=primary;this.cleanup=cleanup;this.#handle=handle;}
 retryCleanup():Promise<void>{
  if(this.#closed)return Promise.resolve();
  if(this.#pending!==undefined)return this.#pending;
  this.#pending=(async()=>{await this.#handle.close();this.#closed=true;active--;})().finally(()=>{this.#pending=undefined;});return this.#pending;
 }
}
export interface MirrorFileStamp {readonly dev:bigint;readonly ino:bigint;readonly birthtimeNs:bigint;readonly mtimeNs:bigint;readonly ctimeNs:bigint;readonly size:bigint;}
const keys=['dev','ino','birthtimeNs','mtimeNs','ctimeNs','size'] as const;
function stamp(value:BigIntStats):MirrorFileStamp{if(!value.isFile())throw new TypeError('Expected regular mirror rollout file');return Object.freeze({dev:value.dev,ino:value.ino,birthtimeNs:value.birthtimeNs,mtimeNs:value.mtimeNs,ctimeNs:value.ctimeNs,size:value.size});}
function same(a:MirrorFileStamp,b:MirrorFileStamp):boolean{return keys.every(k=>a[k]===b[k]);}
async function owned<T>(path:string,signal:AbortSignal|undefined,read:(handle:FileHandle)=>Promise<T>):Promise<T>{
 signal?.throwIfAborted();if(active===MAX_OPEN)throw new MirrorFileBusyError();active++;
 let handle:FileHandle|undefined,value:T|undefined,failed=false,primary:unknown;
 try{handle=await open(path,'r');signal?.throwIfAborted();value=await read(handle);signal?.throwIfAborted();}catch(error){failed=true;primary=error;}
 finally{let closed=true;try{if(handle)await handle.close();}catch(cleanup){closed=false;primary=new MirrorFileClosePendingError(TOKEN,handle!,failed?primary:undefined,cleanup);failed=true;}if(closed)active--;}
 if(failed)throw primary;signal?.throwIfAborted();return value as T;
}
/** Bounded immutable bytes and a point-in-time native metadata witness.
 * No whole-file hash, cursor write, delivery permission or eternal generation proof.
 * Any observed concurrent append/rewrite is conservatively held for a fresh read.
 * Persistent cursor generation binding and atomic durable handoff remain caller work. */
export class MirrorFileWindow {
 readonly path:string;readonly offset:bigint;readonly generation:MirrorFileStamp;readonly #bytes:Uint8Array;
 constructor(token:symbol,path:string,offset:bigint,generation:MirrorFileStamp,bytes:Uint8Array){if(token!==TOKEN)throw new TypeError('Expected owned file observation');this.path=path;this.offset=offset;this.generation=generation;this.#bytes=bytes;Object.freeze(this);}
 get byteLength():number{return this.#bytes.length;}
 copyBytes():Uint8Array{return this.#bytes.slice();}
 async verifyCurrent(signal?:AbortSignal):Promise<void>{
  void this.#bytes; // Reject forged/proxied receivers before reading public fields.
  await owned(this.path,signal,async handle=>{
   const fd=stamp(await handle.stat({bigint:true})),named=stamp(await stat(this.path,{bigint:true}));
   if(!same(this.generation,fd)||!same(this.generation,named))throw new MirrorFileChangedError();
  });
 }
 static async read(path:string,offset:bigint,maximumBytes:number,signal?:AbortSignal):Promise<MirrorFileWindow>{
  requireDiscordText(path);if(path.includes('\0'))throw new TypeError('NUL mirror path');
  if(typeof offset!=='bigint'||offset<0n||offset>=(1n<<64n))throw new RangeError('Expected u64 file offset');
  if(!Number.isSafeInteger(maximumBytes)||maximumBytes<1||maximumBytes>MAX_BYTES)throw new RangeError('Expected mirror byte window from 1 to 1048576');
  const pinned=resolve(path);
  return owned(pinned,signal,async handle=>{
   const before=stamp(await handle.stat({bigint:true}));if(offset>before.size)throw new MirrorFileChangedError();
   const remaining=before.size-offset,length=Number(remaining<BigInt(maximumBytes)?remaining:BigInt(maximumBytes)),bytes=new Uint8Array(length);let used=0;
   while(used<length){signal?.throwIfAborted();const result=await handle.read(bytes,used,length-used,offset+BigInt(used));if(result.bytesRead===0)throw new MirrorFileChangedError();used+=result.bytesRead;}
   const after=stamp(await handle.stat({bigint:true})),named=stamp(await stat(pinned,{bigint:true}));
   if(!same(before,after)||!same(before,named))throw new MirrorFileChangedError();
   return new MirrorFileWindow(TOKEN,pinned,offset,before,bytes);
  });
 }
}
Object.freeze(MirrorFileWindow.prototype);
