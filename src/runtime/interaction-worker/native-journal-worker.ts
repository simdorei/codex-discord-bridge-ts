import {parentPort,workerData as q} from 'node:worker_threads';
import {admitIngressExisting,admitMappedSlashIngressExisting} from '../../store/ingress-admission.ts';
import {admitBusyInteractionExisting} from '../../store/ingress-busy.ts';
import {BusyChoiceUnavailableError} from '../../store/busy-choice.ts';
import {acknowledgeIngressExisting,beginIngressConfirmationExisting,beginIngressExecutionExisting,recordIngressResultExisting,confirmIngressExisting} from '../../store/ingress-lifecycle.ts';
import {holdIngressExisting} from '../../store/ingress-recovery.ts';
import {getIngressExisting} from '../../store/ingress-read.ts';
import {authorizeAbandonmentDecision} from '../../store/abandonment-routing.ts';
import {deliveredPublicationProposal} from '../../store/publication-binding.ts';
import {newIngressFromWire,storedIngressToWire} from '../prompt-intake/native-journal-wire.ts';
import {intakeNumberWire,intakeNumberFromWire} from '../prompt-intake/native-wire.ts';
import {parseSerdeValue} from '../../core/serde-json-parse.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
const port=parentPort;if(port===null)throw new TypeError('Interaction journal requires native ownership');
const identity=q.identity,key=identity.ingressId,binding={path:q.path,operation:q.operation,identity,origin:q.origin,ownerKind:q.ownerKind,requestId:q.requestId};
try{
 let value:unknown=true;
 if(q.operation==='Admit'||q.operation==='Mapped'||q.operation==='Busy'){
  const request=newIngressFromWire(q.envelope),admitted=q.operation==='Mapped'?admitMappedSlashIngressExisting(q.path,request):q.operation==='Busy'?admitBusyInteractionExisting(q.path,request,q.choiceId,q.action):admitIngressExisting(q.path,request);
  value={...admitted,record:admitted.record===null?null:storedIngressToWire(admitted.record),busyChoice:admitted.busyChoice===null?null:{...admitted.busyChoice,createdAt:intakeNumberWire(admitted.busyChoice.createdAt),expiresAt:intakeNumberWire(admitted.busyChoice.expiresAt)}};
 }else if(q.operation==='Abandonment')value=authorizeAbandonmentDecision(q.path,{...q.input,now:intakeNumberFromWire(q.input.now)}).proposal.thread_id;
 else if(q.operation==='Publication'){
  const delivered=deliveredPublicationProposal(q.path,q.input.proposal_id,q.input.revision);
  delivered.requireActor(q.input.application_id,q.input.channel_id,q.input.owner_user_id,q.input.source_message_id);value=delivered.proposal.thread_id;
 }else if(q.operation==='Read'){const row=getIngressExisting(q.path,key);value=row===null?null:storedIngressToWire(row);}
 else if(q.operation==='Acknowledge')value=acknowledgeIngressExisting(q.path,key,intakeNumberFromWire(q.now));
 else if(q.operation==='Begin')value=beginIngressExecutionExisting(q.path,key,'processing',null,intakeNumberFromWire(q.now));
 else if(q.operation==='BeginConfirmation')value=beginIngressConfirmationExisting(q.path,key,intakeNumberFromWire(q.now));
 else if(q.operation==='Result')recordIngressResultExisting(q.path,key,parseSerdeValue(q.outcome),intakeNumberFromWire(q.now));
 else if(q.operation==='Confirm')confirmIngressExisting(q.path,key,intakeNumberFromWire(q.now));
 else if(q.operation==='Hold')holdIngressExisting(q.path,key,q.reason,q.notExecuted,intakeNumberFromWire(q.now));
 else throw new TypeError('Unknown interaction journal operation');
 const result={...binding,ok:true,value};if(boundedSerdeByteCount(result,16*1024*1024)===null)throw new RangeError('Interaction journal result exceeds boundary');port.postMessage(result);
}catch(error){port.postMessage({...binding,ok:false,...(q.operation==='Busy'&&error instanceof BusyChoiceUnavailableError?{unavailableChoice:error.choiceId}:{})});}finally{port.close();}
