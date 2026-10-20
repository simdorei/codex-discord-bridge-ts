import {parentPort,workerData as q} from 'node:worker_threads';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {captureRecoveryDecisionClick,recoverySnapshot,requireRecoveryIngress} from '../../store/recovery-decision-binding.ts';
import {readPublicationDecisionSnapshotExisting} from '../../store/publication-binding.ts';
import {readAbandonmentDecisionSnapshotExisting} from '../../store/abandonment-routing.ts';
import {recordPublicationConsentExisting,recoverPublicationConsentExisting} from '../../store/publication-consent.ts';
import {recordAbandonmentDecisionExisting,recoverAbandonmentDecisionExisting} from '../../store/abandonment-decision.ts';
import {getIngressExisting} from '../../store/ingress-read.ts';
import {recoveryDecisionBinding,encodeRecoverySnapshot,encodeRecoveryReceipt,RECOVERY_DECISION_REQUEST_BYTES,RECOVERY_DECISION_REPLY_BYTES} from './recovery-decision-native-snapshot.ts';
const port=parentPort;if(port===null)throw new Error('Recovery decision requires owned worker');
try {
 if(boundedSerdeByteCount(q,RECOVERY_DECISION_REQUEST_BYTES)===null)throw new TypeError('Unsupported recovery decision worker request');
 const click=captureRecoveryDecisionClick(q),binding=recoveryDecisionBinding(q.id,q.path,q.operation,click,q.sealJson,q.displayedJson,q.now);
 if(Object.keys(q).length!==Object.keys(binding).length)throw new TypeError('Invalid recovery decision request');for(const [key,value]of Object.entries(binding))if(!Object.is(q[key],value))throw new TypeError('Crossed recovery decision request');
 const original=q.sealJson===null?null:recoverySnapshot(click.flow,q.sealJson,q.displayedJson);let value:string|boolean|null;
 switch(q.operation){
  case 'Read':{const current=click.flow==='Publication'?readPublicationDecisionSnapshotExisting(q.path,click):readAbandonmentDecisionSnapshotExisting(q.path,click,q.now);if(original!==null&&(original.sealJson!==current.sealJson||original.displayedJson!==current.displayedJson))throw new TypeError('Original displayed recovery seal changed');value=encodeRecoverySnapshot(current);break;}
  case 'Ingress':requireRecoveryIngress(click,original!,getIngressExisting(q.path,click.interactionIngressId));value=true;break;
  case 'Decide':{const receipt=click.flow==='Publication'?recordPublicationConsentExisting(q.path,click,original!,q.now):recordAbandonmentDecisionExisting(q.path,click,original!,q.now);value=encodeRecoveryReceipt(click,receipt);break;}
  case 'Recover':{const receipt=click.flow==='Publication'?recoverPublicationConsentExisting(q.path,click,original!):recoverAbandonmentDecisionExisting(q.path,click,original!);value=receipt===null?null:encodeRecoveryReceipt(click,receipt);break;}
  default:throw new TypeError('Unsupported recovery operation');
 }
 const reply={...binding,ok:true,value};if(boundedSerdeByteCount(reply,RECOVERY_DECISION_REPLY_BYTES)===null)throw new RangeError('Recovery reply exceeds boundary');port.postMessage(reply);
}catch{port.postMessage({ok:false});}finally{port.close();}
