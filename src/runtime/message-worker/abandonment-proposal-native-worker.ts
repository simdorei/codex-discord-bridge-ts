import {usingExistingReadOnlyStore,withStoreTransaction,commitStore} from '../../store/owned-scope.ts';
import {readAbandonmentProposalIn} from '../../store/abandonment-proposal-read.ts';
import {receiptRow,receiptText,receiptTextColumns,receiptHash} from '../../store/delivery-receipt-key.ts';
import {serializeSerdeValue} from '../../core/serde-json.ts';
import {abandonmentDecisionRows,serializeDiscordComponent} from '../../discord/components.ts';
import {parentPort,workerData as q} from 'node:worker_threads';
import {abandonmentCommandTarget} from '../../store/abandonment-routing.ts';
import {getIngressExisting} from '../../store/ingress-read.ts';
import {proposeAbandonment,bindAbandonmentDelivery} from '../../store/abandonment-proposal.ts';
import {serdeField} from '../../app-server/value.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {captureProposalOriginal,proposalBinding,proposalFields,ABANDONMENT_PROPOSAL_REQUEST_BYTES,ABANDONMENT_PROPOSAL_REPLY_BYTES} from './abandonment-proposal-protocol.ts';
const port=parentPort;if(port===null)throw new TypeError('Proposal requires owned worker');
try{
 if(process.platform==='win32'||boundedSerdeByteCount(q,ABANDONMENT_PROPOSAL_REQUEST_BYTES)===null)throw new TypeError('Unsupported proposal request');
 const original=captureProposalOriginal(Object.fromEntries(['path','ingress','event','channel','actor','application','job','content','proposal'].map(key=>[key,q[key]]))),binding=proposalBinding(q.requestId,original,q.operation,q.target,q.at,q.message,q.revision,q.hash);
 proposalFields(q,Object.keys(binding));for(const [key,value]of Object.entries(binding))if(!Object.is(q[key],value))throw new TypeError('Crossed proposal request');
 let value:unknown;
 if(q.operation==='Route')value=abandonmentCommandTarget(q.path,q.job,q.channel,q.actor);
 else if(q.operation==='Prepare'){
  // Preserve the original separate observations before the unchanged IMMEDIATE proposal transaction.
  if(abandonmentCommandTarget(q.path,q.job,q.channel,q.actor)!==q.target)throw new TypeError('Proposal target changed while waiting for the lock');
  const saved=getIngressExisting(q.path,q.ingress);
  if(saved===null||saved.kind!=='message'||saved.eventId!==q.event||saved.sourceMessageId!==q.event||saved.applicationId!==null||saved.channelId!==q.channel||saved.ownerUserId!==q.actor||saved.targetThreadId!==q.target||serdeField(saved.payload,'content')!==q.content||serdeField(saved.payload,'processing_mode')!=='normal')throw new TypeError('Proposal differs from its frozen authenticated ingress');
  value=proposeAbandonment(q.path,{proposal_id:q.proposal,job_id:q.job,ingress_id:q.ingress,application_id:q.application,now:q.at,expires_at:q.at+120});
 }else if(q.operation==='Bind'){
  // Exact native retained-row readback replaces the compatibility receipt re-read.
  // A transport ID or UPDATE changes count alone is never delivery evidence.
  usingExistingReadOnlyStore(q.path,db=>withStoreTransaction(db,'DEFERRED',()=>{
   const stored=readAbandonmentProposalIn(db,q.proposal),p=stored.proposal;
   if(stored.source_ingress!==q.ingress||p.revision!==q.revision||p.job_id!==q.job||p.thread_id!==q.target||p.channel_id!==q.channel||p.owner_user_id!==q.actor||p.application_id!==q.application||p.review_sha256!==q.hash)throw new TypeError('Original delivered proposal changed');
   const components=abandonmentDecisionRows(p.id,p.revision),key=serializeSerdeValue([q.channel,'recovery-abandonment-proposal-v1',`${p.id}:${p.revision}`,0n]),hash=receiptHash(`[${JSON.stringify(p.review_text)},[${components.map(serializeDiscordComponent).join(',')}]]`);
   const row=receiptRow(db,`SELECT content_hash,message_id,${receiptTextColumns('content_hash','message_id')} FROM codex_delivery_receipts WHERE receipt_key=? AND length(CAST(content_hash AS BLOB))=64 AND length(CAST(message_id AS BLOB)) BETWEEN 1 AND 19`,key);
   if(row===undefined||receiptText(row,'content_hash')!==hash||receiptText(row,'message_id')!==String(q.message))throw new TypeError('Proposal has no confirmed exact native receipt');
   return commitStore(undefined);
  }));
  bindAbandonmentDelivery(q.path,q.proposal,q.message,q.hash,q.at);value=true;
 }
 else throw new TypeError('Unknown proposal operation');
 const reply={...binding,ok:true,value};if(boundedSerdeByteCount(reply,ABANDONMENT_PROPOSAL_REPLY_BYTES)===null)throw new RangeError('Proposal reply exceeds boundary');port.postMessage(reply);
}catch{port.postMessage({ok:false});}finally{port.close();}
