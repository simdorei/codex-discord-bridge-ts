import {parentPort,workerData} from 'node:worker_threads';
import {spawnSync} from 'node:child_process';
import {rustTrim} from '../app-server/value.ts';
if(parentPort===null)throw new Error('Inventory worker requires owned parent');
const MAX=1048576;
try{
 const result=spawnSync(workerData.executable,['plugin','list','--json'],{shell:false,timeout:10000,maxBuffer:MAX*2,killSignal:'SIGKILL',windowsHide:true,encoding:'buffer'});
 const output=result.stdout??Buffer.alloc(0),errorOutput=result.stderr??Buffer.alloc(0),code=(result.error as NodeJS.ErrnoException|undefined)?.code;
 if(code==='ETIMEDOUT')parentPort.postMessage({ok:false,kind:'Timeout',detail:'Codex plugin inventory query timed out after 10 seconds'});
 else if(code==='ENOBUFS'||output.length>MAX||errorOutput.length>MAX)parentPort.postMessage({ok:false,kind:'TooLarge',detail:'Codex plugin inventory output exceeded 1 MiB'});
 else if(result.error!==undefined)parentPort.postMessage({ok:false,kind:'Spawn',detail:`Codex plugin inventory process could not start: ${result.error.message}`});
 else if(result.status!==0){const detail=[...rustTrim(new TextDecoder('utf-8',{ignoreBOM:true}).decode(errorOutput.length===0?output:errorOutput))].slice(0,1000).join('');parentPort.postMessage({ok:false,kind:'Exit',exitCode:result.status??-1,detail:`Codex plugin inventory query failed with exit code ${result.status??-1}: ${detail}`});}
 else{
  let text:string|undefined;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(output);}catch(error){parentPort.postMessage({ok:false,kind:'Utf8',detail:`Codex plugin inventory output was not UTF-8: ${error instanceof Error?error.message:'invalid bytes'}`});}
  if(text!==undefined)parentPort.postMessage({ok:true,text});
 }
}catch(error){parentPort.postMessage({ok:false,kind:'Spawn',detail:`Codex plugin inventory process could not start: ${error instanceof Error?error.message:'native query failed'}`});}
finally{parentPort.close();}
