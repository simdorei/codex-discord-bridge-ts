import {parentPort,workerData} from 'node:worker_threads';
import {statSync} from 'node:fs';import {isAbsolute} from 'node:path';
import {CodexThreadStore} from '../codex-state/store.ts';
import {rustTrim} from '../app-server/value.ts';
if(parentPort===null)throw new Error('Project observation requires owned worker');
try{
 const thread=CodexThreadStore.open(workerData.state).loadThread(workerData.thread,false);
 if(thread===null)throw new Error('the original active thread was not found');
 if(rustTrim(thread.cwd)===''||!isAbsolute(thread.cwd))throw new Error('the original thread has no absolute project directory');
 if(Buffer.byteLength(thread.cwd)>32768)throw new Error('the original project directory exceeds the supported path budget');
 if(!statSync(thread.cwd).isDirectory())throw new Error('the original project path is not a directory');
 parentPort.postMessage({ok:true,directory:thread.cwd});
}catch(error){parentPort.postMessage({ok:false,detail:error instanceof Error?error.message:'original project observation failed'});}
finally{parentPort.close();}
