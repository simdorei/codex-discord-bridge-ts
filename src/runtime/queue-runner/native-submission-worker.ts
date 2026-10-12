import {parentPort,workerData as q} from 'node:worker_threads';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {MirrorMappingChangedError} from '../../store/queue-enqueue.ts';
import {ForkHandoffTargetMovedError} from '../../store/fork-handoff-admission.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
const port=parentPort;if(port===null)throw new Error('Queue submission requires owned worker');
try{
 let response:unknown;
 try{
  const value=q.mapping===null?state.enqueueExisting(q.path,q.job):state.enqueueIfMirrorMatchesExisting(q.path,q.job,q.mapping);
  response={kind:'Enqueued',value};
 }catch(error){
  // These exact local classes are thrown before queue INSERT. Their original
  // transaction has unwound. Parent waits for this process's actual exit too.
  if(error instanceof MirrorMappingChangedError&&Object.getPrototypeOf(error)===MirrorMappingChangedError.prototype){
   response={kind:'MirrorChanged',channel:error.discordChannelId,expected:error.expectedTargetThreadId,actual:error.actualTargetThreadId};
  }else if(error instanceof ForkHandoffTargetMovedError&&Object.getPrototypeOf(error)===ForkHandoffTargetMovedError.prototype){
   response={kind:'SourceMoved',source:error.sourceThreadId,target:error.targetThreadId};
  }else response={kind:'Unconfirmed'};
 }
 if(boundedSerdeByteCount(response,16*1024*1024)===null)throw new Error('Queue submission response exceeds wire budget');
 port.postMessage(response);
}catch{port.postMessage({kind:'Unconfirmed'});}finally{port.close();}
