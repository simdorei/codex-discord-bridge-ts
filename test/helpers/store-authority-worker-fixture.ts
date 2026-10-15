import workerThreads,{Worker,type WorkerOptions} from 'node:worker_threads';
import {syncBuiltinESMExports} from 'node:module';
import {fileURLToPath} from 'node:url';
/** Test-only instrumentation of the real central constructor. The original
 * module still executes with its unchanged business input and inherited side
 * channel. Native ACK and actual exit can be independently held or corrupted. */
export function instrumentStoreWorker(options:{match:string;trace:SharedArrayBuffer;before?:string;after?:string;ack?:'drop'|'duplicate'}){
 const Original=Worker,key='stage893-test-trace';
 class Instrumented extends Original{
  constructor(filename:string|URL,workerOptions?:WorkerOptions){
   if(!(filename instanceof URL)||!filename.pathname.endsWith(options.match)){super(filename,workerOptions);return;}
   const prior=workerThreads.getEnvironmentData(key);workerThreads.setEnvironmentData(key,options.trace);
   const script=`import {parentPort,getEnvironmentData} from 'node:worker_threads';const trace=new Int32Array(getEnvironmentData(${JSON.stringify(key)}));process.argv[1]=${JSON.stringify(fileURLToPath(filename))};
    const post=parentPort.postMessage.bind(parentPort);${options.ack==='drop'?'parentPort.postMessage=()=>{};':options.ack==='duplicate'?'parentPort.postMessage=(value)=>{post(value);post(value);};':''}
    ${options.before??''}
    await import(${JSON.stringify(filename.href)});
    Atomics.store(trace,0,1);${options.after??'Atomics.wait(trace,1,0,15000);'}
   `;
   try{super(new URL('data:text/javascript,'+encodeURIComponent(script)),workerOptions);}finally{workerThreads.setEnvironmentData(key,prior);}
  }
 }
 workerThreads.Worker=Instrumented as typeof Worker;syncBuiltinESMExports();
 return()=>{workerThreads.Worker=Original;syncBuiltinESMExports();};
}
export async function waitTrace(shared:SharedArrayBuffer,index=0):Promise<void>{const trace=new Int32Array(shared),deadline=Date.now()+10000;while(Atomics.load(trace,index)!==1){if(Date.now()>deadline)throw new Error('Fixture worker did not reach barrier');await new Promise(r=>setTimeout(r,5));}}
export function releaseTrace(shared:SharedArrayBuffer):void{const trace=new Int32Array(shared);Atomics.store(trace,1,1);Atomics.notify(trace,1);}
