import {parentPort,workerData as q} from 'node:worker_threads';
import {StateAccessFacade} from '../../store/state-access-facade.ts';
const port=parentPort;if(port===null)throw new Error('New reply store requires owned native worker');
try{
 let value:unknown;
 if(q.kind==='Pending')value=await StateAccessFacade.pendingNewReplies(q.path,q.limit);
 else if(q.kind==='Read')value=await StateAccessFacade.getNewReplyBounded(q.path,q.job);
 else if(q.kind==='Checkpoint')value=await StateAccessFacade.checkpointNewReply(q.path,q.original,q.update);
 else throw new TypeError('Unsupported new reply store operation');
 port.postMessage({ok:true,value});
}catch(error){let detail='',n=0;for(const ch of error instanceof Error?error.message:'New reply store failed'){if(n++===2048)break;detail+=ch;}port.postMessage({ok:false,detail});}
finally{port.close();}
