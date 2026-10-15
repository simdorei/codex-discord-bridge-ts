import {parentPort,workerData as q} from 'node:worker_threads';
import {claimComponentExisting,isComponentClaimLiveExisting} from '../../store/component-claims.ts';
import {readBusyChoiceStateExisting,claimBusyChoiceExisting,releaseBusyChoiceClaimExisting} from '../../store/busy-choice-store.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {captureBusyClaimIdentity,busyClaimBinding,BUSY_CLAIM_REQUEST_BYTES,BUSY_CLAIM_REPLY_BYTES} from './busy-claim-snapshot.ts';
const port=parentPort;if(port===null)throw new Error('Busy claim requires owned native worker');
try{
 if(process.platform==='win32')throw new TypeError('Windows Busy claim worker unqualified');
 if(boundedSerdeByteCount(q,BUSY_CLAIM_REQUEST_BYTES)===null)throw new RangeError('Busy claim request exceeds native budget');
 const identity=captureBusyClaimIdentity(q),binding=busyClaimBinding(q.id,q.path,q.operation,identity,q.now);
 if(Object.keys(q).length!==Object.keys(binding).length)throw new TypeError('Invalid Busy claim request');
 for(const [key,value]of Object.entries(binding))if(!Object.is(q[key],value))throw new TypeError('Crossed Busy claim request');
 const ready=()=>isComponentClaimLiveExisting(q.path,identity.readyMarker,q.now)?'DeliverConfirmation':'ActionUnconfirmed';
 let value:boolean|string;
 switch(q.operation){
  case 'Claim':{
   // Separate source operations: no new encompassing transaction, row snapshot
   // substitution, route/allowSteer policy or cleanup is introduced here.
   value=ready();if(value==='DeliverConfirmation')break;
   const current=readBusyChoiceStateExisting(q.path,identity.choiceId,q.now);
   if(current?.claimed){value=ready();break;}
   if(current===null){value='Missing';break;}
   value=claimBusyChoiceExisting(q.path,identity.choiceId,q.now)?'ExecuteAction':ready();break;
  }
  case 'ReadReady':case 'RecoverReady':value=ready();break;
  case 'Ready':value=claimComponentExisting(q.path,identity.readyMarker,q.now,1800);break;
  case 'Release':value=releaseBusyChoiceClaimExisting(q.path,identity.choiceId);break;
  default:throw new TypeError('Unknown Busy claim operation');
 }
 const reply={...binding,ok:true,value};if(boundedSerdeByteCount(reply,BUSY_CLAIM_REPLY_BYTES)===null)throw new RangeError('Busy claim reply exceeds native budget');port.postMessage(reply);
}catch{port.postMessage({ok:false});}finally{port.close();}
