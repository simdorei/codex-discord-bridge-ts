import {parentPort,workerData as q} from 'node:worker_threads';
import {admitIngressExisting} from '../../store/ingress-admission.ts';
import {beginIngressExecutionExisting,recordIngressProcessingModeExisting,recordIngressResultExisting,confirmIngressExisting} from '../../store/ingress-lifecycle.ts';
import {holdIngressExisting} from '../../store/ingress-recovery.ts';
import {newIngressFromWire,storedIngressToWire} from '../prompt-intake/native-journal-wire.ts';
import {intakeNumberFromWire} from '../prompt-intake/native-wire.ts';
import {parseSerdeValue} from '../../core/serde-json-parse.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
const port=parentPort;if(port===null)throw new TypeError('Message journal requires native ownership');
try{
 let value:unknown=true;
 if(q.operation==='Admit'){const admitted=admitIngressExisting(q.path,newIngressFromWire(q.envelope));value={...admitted,record:admitted.record===null?null:storedIngressToWire(admitted.record)};}
 else if(q.operation==='Mode')recordIngressProcessingModeExisting(q.path,q.id,q.mode);
 else if(q.operation==='Begin')value=beginIngressExecutionExisting(q.path,q.id,q.phase,q.target,intakeNumberFromWire(q.now));
 else if(q.operation==='Result')recordIngressResultExisting(q.path,q.id,parseSerdeValue(q.outcome),intakeNumberFromWire(q.now));
 else if(q.operation==='Confirm')confirmIngressExisting(q.path,q.id,intakeNumberFromWire(q.now));
 else if(q.operation==='Hold')holdIngressExisting(q.path,q.id,q.reason,q.notExecuted,intakeNumberFromWire(q.now));
 else throw new TypeError('Unknown message journal operation');
 const result={ok:true,operation:q.operation,path:q.path,id:q.id,value};if(boundedSerdeByteCount(result,16*1024*1024)===null)throw new RangeError('Journal result exceeds boundary');port.postMessage(result);
}catch{port.postMessage({ok:false});}finally{port.close();}
