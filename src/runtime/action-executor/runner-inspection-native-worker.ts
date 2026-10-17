import {parentPort,workerData as q} from 'node:worker_threads';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {InvalidQueueStateError} from '../../store/queue-read.ts';
import {formatSavedRequestMessage,formatSavedRequestSummary,formatRunnersMessage,formatRunnerTargetSummary} from './runner-inspection-format.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
const port=parentPort;if(port===null)throw new Error('Runner inspection requires owned worker');
// Only the trusted owner's passive fixed request is accepted. Replies echo every
// original scope field, never decoded payloads or credential-bearing diagnostics.
const binding={id:q.id,path:q.path,operation:q.operation,channel:q.channel,user:q.user,requestId:q.requestId,target:q.target,source:q.source,owned:q.owned};
try{
 if(process.platform==='win32'||boundedSerdeByteCount(q,128*1024)===null)throw new TypeError('Unsupported runner inspection request');let text:string;
 switch(q.operation){
  case 'Detail':{const record=state.runnerInspectionDetailExisting(q.path,q.requestId,q.channel,q.user);if(record===null){port.postMessage({...binding,ok:false,error:'Missing'});port.close();break;}text=formatSavedRequestMessage(record);port.postMessage({...binding,ok:true,text});break;}
  case 'Summary':text=formatSavedRequestSummary(state.runnerInspectionSummaryExisting(q.path,q.channel,q.user));port.postMessage({...binding,ok:true,text});break;
  case 'TargetCounts':text=formatRunnerTargetSummary(state.runnerInspectionTargetCountsExisting(q.path,q.target),{target:q.target,source:q.source,owned:q.owned});port.postMessage({...binding,ok:true,text});break;
  case 'Global':text=formatRunnersMessage(state.runnerInspectionGlobalExisting(q.path));port.postMessage({...binding,ok:true,text});break;
  default:throw new TypeError('Unsupported runner inspection operation');
 }
}catch(error){port.postMessage({...binding,ok:false,error:error instanceof InvalidQueueStateError?'InvalidQueueState':'Unavailable'});}finally{port.close();}
