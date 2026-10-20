import {parentPort,workerData as q} from 'node:worker_threads';
import {claimComponentExisting,isComponentClaimLiveExisting,releaseComponentClaimExisting} from '../../store/component-claims.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {captureStandardClaimIdentity,standardClaimBinding,STANDARD_CLAIM_REQUEST_BYTES,STANDARD_CLAIM_REPLY_BYTES} from './standard-claim-snapshot.ts';
const port=parentPort;if(port===null)throw new Error('Standard claim requires owned native worker');
try{

 if(boundedSerdeByteCount(q,STANDARD_CLAIM_REQUEST_BYTES)===null)throw new RangeError('Standard claim request exceeds native budget');
 const identity=captureStandardClaimIdentity(q),binding=standardClaimBinding(q.id,q.path,q.operation,identity,q.now);
 if(Object.keys(q).length!==Object.keys(binding).length)throw new TypeError('Invalid standard claim request');
 for(const [key,value]of Object.entries(binding))if(!Object.is(q[key],value))throw new TypeError('Crossed standard claim request');
 let value:boolean|string;
 switch(q.operation){
  // Preserve each separate source read and IMMEDIATE cleanup/claim commit.
  case 'Claim':value=isComponentClaimLiveExisting(q.path,identity.readyMarker,q.now)?'DeliverConfirmation'
   :claimComponentExisting(q.path,identity.actionClaim,q.now,1800)?'ExecuteAction'
   :isComponentClaimLiveExisting(q.path,identity.readyMarker,q.now)?'DeliverConfirmation':'ActionUnconfirmed';break;
  case 'RecoverReady':value=isComponentClaimLiveExisting(q.path,identity.readyMarker,q.now)?'DeliverConfirmation':'ActionUnconfirmed';break;
  case 'Ready':value=claimComponentExisting(q.path,identity.readyMarker,q.now,1800);break;
  case 'Release':value=releaseComponentClaimExisting(q.path,identity.actionClaim);break;
  default:throw new TypeError('Unknown standard claim operation');
 }
 const reply={...binding,ok:true,value};if(boundedSerdeByteCount(reply,STANDARD_CLAIM_REPLY_BYTES)===null)throw new RangeError('Standard claim reply exceeds native budget');port.postMessage(reply);
}catch{port.postMessage({ok:false});}finally{port.close();}
