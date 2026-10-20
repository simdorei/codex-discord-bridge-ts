import {parentPort,workerData} from 'node:worker_threads';
import {storeWorkerReuseEnabled,storeWorkerDispatchEnabled} from './store-worker-authority.ts';
import {workerStoreConnectionsOpen} from '../store/authority-connection.ts';

export const REUSABLE_WORKER_ENV='codex-discord-bridge:reusable-worker:v1';
export interface WorkerReplyPort{postMessage(value:unknown):void;close():void;}

/** A reviewed operation must finish all of its scoped I/O before returning.
 * Capture its existing single reply and publish only after that cleanup. The
 * ordinary one-shot entry retains the original wire reply and native exit. */
export async function serveReusableWorker(operation:(input:any,reply:WorkerReplyPort)=>void|Promise<void>,dispatcher=false):Promise<void>{
 // Importing an allowed operation into the dispatcher registers its export;
 // only the outer dispatcher owns the MessagePort and request loop.
 if(storeWorkerDispatchEnabled()&&!dispatcher)return;
 const port=parentPort;if(port===null)throw new Error('Owned native worker required');
 const reusable=storeWorkerReuseEnabled();
 let running=false,closing=false,sequence=0;
 const execute=async(input:unknown,id:number)=>{
  if(running||closing)throw new Error('Reusable worker received overlapping work');
  running=true;let count=0,value:unknown,returned=false;
  const reply=Object.freeze({postMessage(result:unknown){if(returned)throw new Error('Native reply outlived its operation');count++;value=result;},close(){}});
  try{
   await operation(input,reply);returned=true;
   if(count!==1)throw new Error('Native operation must return exactly one reply');
   if(reusable&&workerStoreConnectionsOpen()!==0)throw new Error('Reusable native operation retained an open store connection');
   port.postMessage(reusable?{sequence:id,value}:value);
  }finally{returned=true;running=false;if(!reusable||closing)port.close();}
 };
 if(reusable)port.on('message',(request:unknown)=>{
  if(request!==null&&typeof request==='object'&&Object.keys(request).length===1&&Reflect.get(request,'close')===true){closing=true;if(!running)port.close();return;}
  if(request===null||typeof request!=='object'||Object.keys(request).length!==2||Reflect.get(request,'sequence')!==sequence+1||!Object.hasOwn(request,'input'))throw new Error('Invalid reusable worker request');
  sequence++;
  // An unexpected handler failure must exit the worker. Never report it as an
  // empty successful read or replay a possibly submitted operation.
  void execute(Reflect.get(request,'input'),sequence).catch(error=>{setImmediate(()=>{throw error;});});
 });
 await execute(workerData,0);
}
