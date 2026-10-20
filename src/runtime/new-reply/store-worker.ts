import {serveReusableWorker} from '../reusable-worker-entry.ts';
import type {ReusableNativeOperation} from '../reusable-worker-operations.ts';
import * as stateNewReplyPending from '../../store/new-reply-pending.ts';
import * as stateNewReplyCheckpoint from '../../store/new-reply-checkpoint.ts';
export const runNativeOperation:ReusableNativeOperation=async (q,port)=>{
try{
 let value:unknown;
 if(q.kind==='Pending')value=await stateNewReplyPending.pendingNewReplies(q.path,q.limit);
 else if(q.kind==='Read')value=await stateNewReplyPending.getNewReplyBounded(q.path,q.job);
 else if(q.kind==='Checkpoint')value=await stateNewReplyCheckpoint.checkpointNewReply(q.path,q.original,q.update);
 else throw new TypeError('Unsupported new reply store operation');
 port.postMessage({ok:true,value});
}catch(error){let detail='',n=0;for(const ch of error instanceof Error?error.message:'New reply store failed'){if(n++===2048)break;detail+=ch;}port.postMessage({ok:false,detail});}
finally{port.close();}
};
await serveReusableWorker(runNativeOperation);
