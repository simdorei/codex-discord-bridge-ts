import {parentPort,workerData} from 'node:worker_threads';
import {performance} from 'node:perf_hooks';
import {MirrorFileChangedError} from './file-window.ts';
import {MirrorStartupContextHeldError,snapshotMirrorStartupCutoffData,snapshotMirrorStartupContextLimits} from './startup-context-limits.ts';
import {captureMirrorStartupCutoffNative,readMirrorStartupContextNative} from './startup-context-scan.ts';
if(parentPort===null)throw new Error('Mirror startup context requires an owned parent');
try{
 const started=performance.now(),cancel=new Int32Array(workerData.cancel);
 const check=()=>{if(Atomics.load(cancel,0)!==0)throw new MirrorStartupContextHeldError('Cancelled');if(performance.now()-started>=workerData.timeoutMs)throw new MirrorStartupContextHeldError('Deadline');};
 const value=workerData.kind==='Capture'?await captureMirrorStartupCutoffNative(workerData.path,check):await readMirrorStartupContextNative(snapshotMirrorStartupCutoffData(workerData.cutoff),snapshotMirrorStartupContextLimits(workerData.limits),check);
 check();parentPort.postMessage({ok:true,value});
}catch(error){
 const reason=error instanceof MirrorStartupContextHeldError?error.reason:error instanceof MirrorFileChangedError?'ChangedFile':'NativeRead';
 parentPort.postMessage({ok:false,reason});
}finally{parentPort.close();}
