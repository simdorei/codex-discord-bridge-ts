import {parentPort,workerData} from 'node:worker_threads';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {inspectLocalBlocking,inspectRolloutsBlocking} from './inspection-local.ts';
if(parentPort===null)throw new Error('Mirror inspection requires owned parent');
try{const value=workerData.operation==='inventory'?inspectLocalBlocking(workerData.codex,workerData.mirror):workerData.operation==='rollouts'?inspectRolloutsBlocking(workerData.rollouts):(()=>{throw new TypeError('Unknown inspection operation');})();if(boundedSerdeByteCount(value,4*1024*1024)===null)throw new Error('mirror inspection local snapshot exceeds 4 MiB transfer budget; inspection incomplete');parentPort.postMessage({ok:true,value});}
catch(error){parentPort.postMessage({ok:false,message:error instanceof Error?error.message:'Mirror inspection failed'});}
finally{parentPort.close();}
