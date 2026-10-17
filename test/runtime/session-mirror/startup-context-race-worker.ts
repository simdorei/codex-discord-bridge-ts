import {parentPort,workerData} from 'node:worker_threads';
import {appendFileSync,writeFileSync} from 'node:fs';
import {readMirrorStartupContextNative} from '../../../src/runtime/session-mirror/startup-context-scan.ts';
import {MirrorFileChangedError} from '../../../src/runtime/session-mirror/file-window.ts';
if(parentPort===null)throw new Error('Expected test worker owner');
try{
 let checks=0,changed=false;
 const value=await readMirrorStartupContextNative(workerData.cutoff,workerData.limits,()=>{
  // Check 5 is inside the first captured byte window, before its first record.
  if(++checks===5){changed=true;if(workerData.replace)writeFileSync(workerData.cutoff.path,'x\n');else appendFileSync(workerData.cutoff.path,'{"type":"turn_context","payload":{"turn_id":"too-late"}}\n');}
 });
 parentPort.postMessage({ok:true,value,changed});
}catch(error){parentPort.postMessage({ok:false,changed:error instanceof MirrorFileChangedError});}
finally{parentPort.close();}
