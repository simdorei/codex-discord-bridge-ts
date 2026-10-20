import {parentPort,workerData as q} from 'node:worker_threads';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {StoreIntegrityError} from '../../store/schema-assembly.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {captureStopAcceptance,stopAcceptanceIngress,stopAcceptanceBinding,assertStopAcceptanceRequestBudget,STOP_ACCEPTANCE_REPLY_BYTES,type StopAcceptanceDisplay} from './stop-acceptance-snapshot.ts';
const port=parentPort;if(port===null)throw new Error('Owned Stop acceptance worker required');
let binding:ReturnType<typeof stopAcceptanceBinding>|undefined;
try{

 const op=captureStopAcceptance({scope:q.operation.scope,binding:q.operation.binding,ingress:stopAcceptanceIngress(q.operation),resident:q.operation.resident,now:q.operation.now});
 binding=stopAcceptanceBinding(q.id,q.path,op);assertStopAcceptanceRequestBudget(binding,op);for(const [key,value] of Object.entries(binding))if(q[key]!==value)throw new TypeError('Crossed Stop request');
 if(q.operation.operationId!==op.operationId)throw new TypeError('Stop operation differs');
 const proof=q.proof;
 // A real transaction callback, backed by the parent owner's held opaque lease.
 // This shared word transports liveness only; the owner authenticates its lease
 // before ordinary worker submission and retains it through actual exit.
 const checkSelected=()=>{
  if(op.binding.route!=='Selected'){if(proof!==null)throw new StoreIntegrityError('Unexpected selected Stop proof');return;}
  if(proof===null||typeof proof!=='object'||Object.keys(proof).length!==4||proof.requestId!==q.id||proof.operationId!==op.operationId||proof.target!==op.scope.target||!(proof.active instanceof SharedArrayBuffer)||proof.active.byteLength!==4||Atomics.load(new Int32Array(proof.active),0)!==1)throw new StoreIntegrityError('Original held selection custody differs; no stop acceptance');
 };
 checkSelected();const ingress=stopAcceptanceIngress(op);let value:StopAcceptanceDisplay;
 const running=op.resident===null?null:state.acceptRunningStop(q.path,op.scope,op.binding,ingress,op.resident.id,op.resident.generation,checkSelected,()=>op.now);
 if(running!==null){if(running.operation_id!==op.operationId)throw new TypeError('Running operation differs');value={kind:'Running',operationId:op.operationId};}
 else {const receipt=state.acceptUnresolvedStop(q.path,op.scope,op.binding,ingress,checkSelected,()=>op.now);if(receipt===null)throw new TypeError('No original Stop receipt');value={kind:'Unresolved',operationId:op.operationId,jobs:receipt.jobs.length,ingresses:receipt.ingresses?.length??0};}
 const reply={...binding,ok:true,value};if(boundedSerdeByteCount(reply,STOP_ACCEPTANCE_REPLY_BYTES)===null)throw new RangeError('Stop receipt exceeds byte budget');port.postMessage(reply);
}catch{port.postMessage({...binding,ok:false});}finally{port.close();}
