import assert from 'node:assert/strict';
import workerThreads,{Worker,type WorkerOptions} from 'node:worker_threads';
import {syncBuiltinESMExports} from 'node:module';
import {fileURLToPath} from 'node:url';
import {ownedWorkerModuleUrl} from '../../src/runtime/owned-worker-slot.ts';
export async function responseUntil(check:()=>boolean,label:string):Promise<void>{const end=performance.now()+10000;while(!check()){assert.ok(performance.now()<end,label);await new Promise(r=>setTimeout(r,5));}}
/** Disposable exact-module test observer. It never changes original operation
 * data/SQL. A shared post-module barrier distinguishes ACK from actual exit. */
export function responseWorkerFixture(path:string,mode:'ack'|'drop'|'foreign'|'duplicate'='ack'){
 const Original=Worker,url=ownedWorkerModuleUrl(new URL('../../src/runtime/native-response-completion-worker.ts',import.meta.url),import.meta.url),buffer=new SharedArrayBuffer(24),trace=new Int32Array(buffer);
 const handles:Promise<void>[]=[],errors:unknown[]=[];let count=0,exited=0,submitted:unknown;
 class Observed extends Original{
  constructor(filename:string|URL,options?:WorkerOptions){
   const selected=filename instanceof URL&&filename.href===url.href&&options?.workerData.path===path;
   if(selected){
    count++;assert.equal(count,1,'one original completion submission');submitted=options!.workerData;
    const key='checkpoint931-response-fixture',prior=workerThreads.getEnvironmentData(key);workerThreads.setEnvironmentData(key,{buffer,mode});
    const script=`import {parentPort,getEnvironmentData} from 'node:worker_threads';
const {buffer,mode}=getEnvironmentData(${JSON.stringify(key)}),t=new Int32Array(buffer),post=parentPort.postMessage.bind(parentPort);
process.argv[1]=${JSON.stringify(fileURLToPath(url))};
parentPort.postMessage=value=>{Atomics.add(t,1,1);Atomics.store(t,2,value.ok===true?1:2);if(mode==='drop')return;post(mode==='foreign'?{...value,requestId:'foreign'}:value);if(mode==='duplicate')post(value);};
Atomics.store(t,0,1);try{await import(${JSON.stringify(url.href)});}finally{Atomics.store(t,3,1);while(Atomics.load(t,4)===0)Atomics.wait(t,4,0,10000);Atomics.store(t,5,1);}`;
    try{super(new URL('data:text/javascript,'+encodeURIComponent(script)),options);}finally{workerThreads.setEnvironmentData(key,prior);}
   }else super(filename,options);
   if(selected){handles.push(new Promise<void>(resolve=>{this.once('exit',code=>{exited++;if(code!==0)errors.push(Error('completion worker exit '+code));resolve();});}));this.on('error',error=>errors.push(error));}
  }
 }
 workerThreads.Worker=Observed as typeof Worker;syncBuiltinESMExports();
 return {trace,get count(){return count;},get exited(){return exited;},get submitted(){return submitted;},release(){Atomics.store(trace,4,1);Atomics.notify(trace,4);},async join(){await Promise.all(handles);assert.deepEqual(errors,[]);},restore(){assert.equal(exited,count,'cannot restore before actual exit');workerThreads.Worker=Original;syncBuiltinESMExports();}};
}
