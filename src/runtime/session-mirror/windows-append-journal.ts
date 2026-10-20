import {createRequire} from 'node:module';
import {win32} from 'node:path';
import type {MirrorFileStamp} from './file-window.ts';

type Native=((...args:any[])=>any)&{async:(...args:any[])=>void};
type Api={open:Native;io:Native;info:Native;close:Native};
let api:Api|undefined,disabled=false;
function binding():Api {
 if(api)return api;
 const koffi=createRequire(import.meta.url)('koffi');
 if(koffi.version!=='3.3.3')throw new Error('Unsupported Windows binding');
 const lib=koffi.load('kernel32.dll');
 api={
  open:lib.func('void * __stdcall CreateFileW(str16, uint32_t, uint32_t, void *, uint32_t, uint32_t, void *)'),
  io:lib.func('int32_t __stdcall DeviceIoControl(void *, uint32_t, void *, uint32_t, _Out_ void *, uint32_t, _Out_ void *, void *)'),
  info:lib.func('int32_t __stdcall GetFileInformationByHandle(void *, _Out_ void *)'),
  close:lib.func('int32_t __stdcall CloseHandle(void *)'),
 };return api;
}
const valid=(h:unknown):h is bigint=>typeof h==='bigint'&&h!==0n&&h!==-1n&&h!==0xffffffffffffffffn;
async function ioctl(native:Api,handle:bigint,code:number,input:Buffer|null,size:number):Promise<Buffer|null>{
 const out=Buffer.alloc(size),length=Buffer.alloc(4);
 const ok=await new Promise<number>((resolve,reject)=>native.io.async(handle,code,input,input?.length??0,out,size,length,null,(error:unknown,value:number)=>error?reject(error):resolve(value)));
 const n=length.readUInt32LE();return ok&&n<=size?out.subarray(0,n):null;
}
type Point=Readonly<{journal:bigint;usn:bigint;file:bigint;volume:bigint}>;
const owned=new WeakSet<object>();
/** Process-local NTFS checkpoint. Never persisted or accepted from callers. */
export type WindowsAppendCheckpoint=Point;
function identity(native:Api,h:bigint):{file:bigint;volume:bigint}|null{
 const b=Buffer.alloc(52);if(!native.info(h,b))return null;
 return {file:BigInt(b.readUInt32LE(44))<<32n|BigInt(b.readUInt32LE(48)),volume:BigInt(b.readUInt32LE(28))};
}
/** Read-only handles share writes and deletion. Unsupported volumes, access
 * denial, journal rollover and bounded-scan exhaustion all use full hashing.
 * No admin request, journal mutation, writer lock or persistent handle. */
export async function observeWindowsAppendJournal(path:string,stamp:MirrorFileStamp,prior?:WindowsAppendCheckpoint,signal?:AbortSignal):Promise<{checkpoint:WindowsAppendCheckpoint;appendOnly:boolean}|null>{
 signal?.throwIfAborted();
 if(disabled||process.platform!=='win32'||!['x64','arm64'].includes(process.arch))return null;
 let plain=path;if(/^\\\\\?\\[a-z]:\\/i.test(plain))plain=plain.slice(4);
 if(!/^[a-z]:\\/i.test(plain)||plain.includes('\0'))return null;
 let native:Api,file:bigint|undefined,root:bigint|undefined;
 try{
  native=binding();
  const opened=native.open(path,0x80000000,7,null,3,0,null);if(!valid(opened))return null;file=opened;
  const directory=native.open(win32.parse(plain).root,0,7,null,3,0x02000000,null);if(!valid(directory))return null;root=directory;
  const id=identity(native,file),volume=identity(native,root);
  if(id===null||volume===null||id.file!==stamp.ino||id.volume!==stamp.dev||volume.volume!==id.volume)return null;
  const journal=await ioctl(native,root,0x900f4,null,80);
  const current=await ioctl(native,file,0x900eb,Buffer.from([2,0,2,0]),4096);
  signal?.throwIfAborted();
  if(journal===null||journal.length<56||current===null||current.length<60||current.readUInt16LE(4)!==2||current.readBigUInt64LE(8)!==id.file)return null;
  const point:Point=Object.freeze({journal:journal.readBigUInt64LE(),usn:current.readBigInt64LE(24),...id});owned.add(point);
  let appendOnly=false;
  if(prior!==undefined&&owned.has(prior)&&prior.journal===point.journal&&prior.file===point.file&&prior.volume===point.volume&&prior.usn>=journal.readBigInt64LE(8)&&prior.usn>=journal.readBigInt64LE(24)&&prior.usn<=point.usn){
   // Include the baseline record: reasons coalesce while a writer stays open.
   // A baseline containing OVERWRITE cannot prove later overwrites absent.
   let cursor=prior.usn,baseline=false,latest=false,safe=true;const deadline=performance.now()+250;
   for(let page=0;page<32&&!latest&&safe;page++){
    signal?.throwIfAborted();if(performance.now()>deadline)break;
    const q=Buffer.alloc(48);q.writeBigInt64LE(cursor);q.writeUInt32LE(0xffffffff,8);q.writeBigUInt64LE(point.journal,32);q.writeUInt16LE(2,40);q.writeUInt16LE(2,42);
    const bytes=await ioctl(native,root,0x903ab,q,65536);
    if(bytes===null||bytes.length<8)break;
    let at=8;
    while(at<bytes.length){
     if(at+60>bytes.length){safe=false;break;}
     const size=bytes.readUInt32LE(at),version=bytes.readUInt16LE(at+4);
     if(size<60||size%8!==0||at+size>bytes.length||version!==2){safe=false;break;}
     const usn=bytes.readBigInt64LE(at+24);
     if(bytes.readBigUInt64LE(at+8)===id.file&&usn>=prior.usn){
      const reason=bytes.readUInt32LE(at+40),closed=Boolean(reason&0x80000000);
      if(usn===prior.usn){baseline=true;if(!closed&&(reason&~0x80008002)!==0)safe=false;if(closed&&usn===point.usn)safe=false;}
      else if((reason&~0x80008002)!==0)safe=false;
      if(usn===point.usn)latest=true;
      if(usn>point.usn)safe=false;
     }
     at+=size;
    }
    const next=bytes.readBigInt64LE();if(next<=cursor)break;cursor=next;
   }
   appendOnly=baseline&&latest&&safe;
  }
  // A new reason during the scan invalidates its observation. The caller also
  // verifies the file's native metadata before/after hashing and by pathname.
  const after=await ioctl(native,file,0x900eb,Buffer.from([2,0,2,0]),4096);
  if(after===null||after.length<60||after.readUInt16LE(4)!==2||after.readBigUInt64LE(8)!==id.file||after.readBigInt64LE(24)!==point.usn)return null;
  return {checkpoint:point,appendOnly};
 }catch(error){if(signal?.aborted)throw signal.reason;return null;}
 finally{
  if(api){for(const h of [root,file])if(h!==undefined)try{if(!api.close(h))disabled=true;}catch{disabled=true;}}
 }
}
export function sameWindowsAppendCheckpoint(a:WindowsAppendCheckpoint|undefined,b:WindowsAppendCheckpoint|undefined):boolean{
 return a!==undefined&&b!==undefined&&owned.has(a)&&owned.has(b)&&a.journal===b.journal&&a.usn===b.usn&&a.file===b.file&&a.volume===b.volume;
}
