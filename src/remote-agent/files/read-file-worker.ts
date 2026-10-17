import {parentPort,workerData} from 'node:worker_threads';import {createHash} from 'node:crypto';import {types} from 'node:util';
import {selectRemoteTextLines} from './line-selection.ts';import {redactRemoteTextCpu} from './redaction-cpu.ts';
if(parentPort===null)throw new Error('Remote file output requires an owned CPU worker');
try{
 if(!types.isUint8Array(workerData.bytes)||workerData.bytes.byteLength>1048576)throw new RangeError('Invalid file byte snapshot');
 let text:string;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(workerData.bytes);}catch{throw new TypeError('Invalid UTF8 snapshot');}
 const selected=selectRemoteTextLines(text,workerData.start,workerData.maxLines),content=redactRemoteTextCpu(selected.selectedText);
 parentPort.postMessage({ok:true,output:{path:workerData.path,content,sha256:createHash('sha256').update(workerData.bytes).digest('hex'),start_line:selected.startLine,end_line:selected.endLine,total_lines:selected.totalLines,truncated:selected.truncated,redacted:content!==selected.selectedText}});
}catch(error){parentPort.postMessage({ok:false,kind:error instanceof TypeError&&error.message==='Invalid UTF8 snapshot'?'Encoding':'Processing'});}finally{parentPort.close();}
