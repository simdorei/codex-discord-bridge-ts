import {createRequire} from 'node:module';
import {WindowsProcessJob} from '../../app-server/windows-process-job.ts';
import {setTimeout as sleep} from 'node:timers/promises';
type Native=(...args:any[])=>any;
let api:{create:Native;resume:Native;close:Native;wait:Native;kill:Native}|undefined;
const retained=new Set<WindowsWindowProcess>();
function binding(){if(process.platform!=='win32'||!['x64','arm64'].includes(process.arch))throw new Error('Window process requires Windows');if(api)return api;
 const k=createRequire(import.meta.url)('koffi'),l=k.load('kernel32.dll');if(k.version!=='3.3.3')throw new Error('Unsupported native dependency');
 return api={create:l.func('int32_t __stdcall CreateProcessW(str16 app, void *command, void *processAttributes, void *threadAttributes, int32_t inherit, uint32_t flags, void *environment, str16 cwd, void *startup, _Out_ void *processInfo)'),resume:l.func('uint32_t __stdcall ResumeThread(void *thread)'),close:l.func('int32_t __stdcall CloseHandle(void *handle)'),wait:l.func('uint32_t __stdcall WaitForSingleObject(void *handle, uint32_t milliseconds)'),kill:l.func('int32_t __stdcall TerminateProcess(void *process,uint32_t code)')};
}
export function quoteWindowsArgument(value:string):string{if(value.includes('\0'))throw new TypeError('NUL argument');if(value!==''&&!/[\s"]/.test(value))return value;return '"'+value.replace(/(\\*)"/g,'$1$1\\"').replace(/(\\+)$/,'$1$1')+'"';}
/** CREATE_SUSPENDED -> exact process handle into kill-on-close job -> resume.
 * Interactive windows are created only for an explicit remote launch request. */
export class WindowsWindowProcess{
 readonly processId:number;readonly #handle:bigint;readonly #job:WindowsProcessJob;#closed=false;#closing:Promise<void>|undefined;
 private constructor(pid:number,handle:bigint,job:WindowsProcessJob){this.processId=pid;this.#handle=handle;this.#job=job;retained.add(this);}
 static async launch(executable:string,args:readonly string[],cwd:string,environment:Readonly<Record<string,string>>,consoleWindow=false):Promise<WindowsWindowProcess>{
  const native=binding(),startup=Buffer.alloc(104),info=Buffer.alloc(24);startup.writeUInt32LE(104);const command=Buffer.from([executable,...args].map(quoteWindowsArgument).join(' ')+'\0','utf16le');
  const entries=Object.entries(environment).sort(([a],[b])=>a.toUpperCase().localeCompare(b.toUpperCase()));for(const[k,v]of entries)if(k.includes('=')||k.includes('\0')||v.includes('\0'))throw new TypeError('Invalid process environment');const block=Buffer.from(entries.map(([k,v])=>k+'='+v).join('\0')+'\0\0','utf16le');
  const job=WindowsProcessJob.create();let owner:WindowsWindowProcess|undefined,thread:bigint|undefined;
  try{if(native.create(executable,command,null,null,0,0x4|0x400|(consoleWindow?0x10:0),block,cwd,startup,info)===0)throw new Error('Window process launch failed');const handle=info.readBigUInt64LE(0);thread=info.readBigUInt64LE(8);owner=new WindowsWindowProcess(info.readUInt32LE(16),handle,job);
   try{job.assignProcess(handle);}catch(error){native.kill(handle,1);throw error;}
   if(native.resume(thread)===0xffffffff)throw new Error('Window process resume failed');const closingThread=thread;thread=undefined;if(native.close(closingThread)===0)throw new Error('Window thread handle release failed');return owner;
  }catch(error){if(thread!==undefined)native.close(thread);if(owner)await owner.close();else await job.finish();throw error;}
 }
 running():boolean{if(this.#closed)return false;const result=binding().wait(this.#handle,0);if(result!==0&&result!==258)throw new Error('Window process state is unconfirmed');return result===258;}
 close():Promise<void>{return this.#closing??=(async()=>{await this.#job.finish();const deadline=performance.now()+5000;while(binding().wait(this.#handle,0)!==0){if(performance.now()>=deadline)throw new Error('Window process exit is unconfirmed');await sleep(10);}if(binding().close(this.#handle)===0)throw new Error('Window process release is unconfirmed');this.#closed=true;retained.delete(this);})();}
}
