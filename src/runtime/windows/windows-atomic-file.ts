import {randomUUID} from 'node:crypto';
import {mkdir,open,unlink} from 'node:fs/promises';
import {dirname,join,win32} from 'node:path';
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
  const native=createWindowsNativeBinding(),submission=native.moveReplaceWriteThrough(win32.toNamespacedPath(temporary),win32.toNamespacedPath(path)),result=await submission.completion;
  if(result.kind!=='win32'||result.value===0)throw new Error('Windows atomic file publication failed');owned=false;
 }finally{try{if(owned)await unlink(temporary);}finally{pin.close();}}
}
