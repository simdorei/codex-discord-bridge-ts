import {randomUUID} from 'node:crypto';
import {mkdir,open,unlink} from 'node:fs/promises';
import {dirname,join,win32} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {createWindowsNativeBinding} from './windows-native.ts';
import {WindowsFilePin} from './windows-file-pin.ts';
/** Bounded caller-owned file publication. This does not grant runtime marker
 * authority; the singleton-specific marker API remains separate. */
export async function writeWindowsAtomicFile(path:string,text:string):Promise<void>{
 if(process.platform!=='win32'||!win32.isAbsolute(path)||path.includes('\0')||Buffer.byteLength(text)>4194304)throw new TypeError('Invalid Windows atomic file input');
 const parent=dirname(path);await mkdir(parent,{recursive:true});const pin=WindowsFilePin.acquire(parent,'directory');
 const temporary=join(parent,'.cdr-publish-'+randomUUID()+'.tmp');let owned=false;
 try{
  const file=await open(temporary,'wx',0o600);owned=true;
  try{await file.writeFile(text,'utf8');await file.sync();}finally{await file.close();}
  const native=createWindowsNativeBinding(),deadline=performance.now()+500;
  for(;;){
   const submission=native.moveReplaceWriteThrough(win32.toNamespacedPath(temporary),win32.toNamespacedPath(path)),result=await submission.completion;
   if(result.kind==='win32'&&result.value!==0){owned=false;break;}
   // A reader or antivirus can briefly deny replacement. Retry only a confirmed
   // failed rename of this same owned temporary file, never the caller's action
   // or an unknown native outcome. Persistent access failures remain failures.
   if(submission.launchError===null&&result.kind==='win32'&&[5,32,33].includes(result.lastError)&&performance.now()<deadline){await sleep(20);continue;}
   throw new Error(`Windows atomic file publication failed${result.kind==='win32'?` (${result.lastError})`:''}`);
  }
 }finally{try{if(owned)await unlink(temporary);}finally{pin.close();}}
}
