import {parentPort,workerData as q} from 'node:worker_threads';import * as stateNewReplyClaims from '../../store/new-reply-claims.ts';
import * as stateDeliveryPreflight from '../../store/delivery-preflight.ts';
import * as stateCommentaryOutbox from '../../store/commentary-outbox.ts';
import * as stateGoalProgress from '../../store/goal-progress.ts';
import * as stateStartNoticeOutbox from '../../store/start-notice-outbox.ts';import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
const port=parentPort;if(port===null)throw new Error('Progress state requires owned worker');
try{
 const b=q.binding;if(!['Goal','Commentary','StartFailure'].includes(b.kind))throw new TypeError('Unknown progress kind');let value:unknown;
 if(q.operation==='Preflight'){
  if(b.kind==='StartFailure')throw new TypeError('No start preflight');
  // Every adapter opens and closes its own original connection, never one combined snapshot.
  const hold=stateNewReplyClaims.newReplyOutputHoldExisting(q.path,b.job);
  if(hold!==null)value={kind:'Held',detail:hold};else{const request=stateDeliveryPreflight.pendingFirstReplyExisting(q.path,b.job);if(request!==null)value={kind:'FirstReply',detail:request};else if(b.kind==='Commentary'&&stateCommentaryOutbox.hasPendingCommentaryExisting(q.path,b.job,b.sequence))value={kind:'Commentary'};else value={kind:'Ready'};}
 }else if(q.operation==='Failure'){
  if(b.kind!=='Goal')throw new TypeError('Only Goal failure recording');stateGoalProgress.recordGoalProgressErrorExisting(q.path,{thread:b.thread,turn:b.turn},q.display);value=true;
 }else if(q.operation==='Complete'){
  if(b.kind==='Goal')stateGoalProgress.completeGoalProgressExisting(q.path,{thread:b.thread,turn:b.turn});else if(b.kind==='Commentary')stateCommentaryOutbox.completeCommentaryExisting(q.path,b.sequence);else stateStartNoticeOutbox.completeStartNoticeExisting(q.path,b.job);value=true;
 }else throw new TypeError('Unknown progress state operation');
 const result={ok:true,value};if(boundedSerdeByteCount(result,16*1024*1024)===null)throw new Error('Progress result exceeds native wire budget');port.postMessage(result);
}catch{port.postMessage({ok:false});}finally{port.close();}
