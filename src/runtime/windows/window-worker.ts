import {parentPort,workerData} from 'node:worker_threads';
import {nativeWindows,nativeWindow,nativeCapture,nativeAction} from './window-native.ts';
if(parentPort===null)throw new Error('Window worker requires owned parent');
try{const {kind,id,request,identity}=workerData;const result=kind==='list'?nativeWindows():kind==='inspect'?nativeWindow(id):kind==='capture'?nativeCapture(id,identity,workerData.allowInactive===true):nativeAction(request,identity);parentPort.postMessage({ok:true,result});}
catch(error){parentPort.postMessage({ok:false,error:error instanceof Error?error.message:'Native window operation failed'});}
finally{parentPort.close();}
