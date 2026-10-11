import {parentPort,workerData} from 'node:worker_threads';import {openSync,fstatSync,readSync,closeSync,constants} from 'node:fs';
import {mergeEnvText} from '../config/runtime.ts';
const port=parentPort;if(port===null)throw new Error('Startup environment requires a native owner');
function fail(code:string):never{throw Object.assign(new Error('Startup environment read failed'),{code});}
function text(path:string):string|null{
 let fd:number;try{fd=openSync(path,constants.O_RDONLY|constants.O_NONBLOCK);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
 try{const stat=fstatSync(fd);if(!stat.isFile())fail('NotRegularFile');if(stat.size>1048576)fail('FileLimit');const buffer=Buffer.alloc(1048577);let used=0;
  while(used<buffer.length){const n=readSync(fd,buffer,used,buffer.length-used,null);if(n===0)break;used+=n;}
  if(used>1048576)fail('FileLimit');try{return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(buffer.subarray(0,used));}catch{fail('InvalidUtf8');}
 }finally{closeSync(fd);}
}
try{
 const env=new Map<string,string>(workerData.entries),raw=text(workerData.filePath);if(raw!==null)mergeEnvText(env,raw);if(env.size>4096)fail('EntryLimit');let bytes=0;
 const entries=[...env.entries()].sort(([a],[b])=>Buffer.compare(Buffer.from(a),Buffer.from(b)));for(const [key,value] of entries){bytes+=Buffer.byteLength(key)+Buffer.byteLength(value);if(bytes>4194304)fail('OutputLimit');}
 port.postMessage({ok:true,entries});
}catch(error){const code=(error as NodeJS.ErrnoException).code;port.postMessage({ok:false,code:typeof code==='string'?code:'ReadFailure'});}finally{port.close();}
