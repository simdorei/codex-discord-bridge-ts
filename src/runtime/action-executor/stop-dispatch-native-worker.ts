import {parentPort,workerData as q} from 'node:worker_threads';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {StoreIntegrityError} from '../../store/schema-assembly.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {snapshotSettingsBinding} from './settings-snapshot.ts';
import {captureStopDispatch,captureStopDispatchDiagnostic,stopDispatchBinding,assertStopDispatchRequestBudget,STOP_DISPATCH_REPLY_BYTES} from './stop-dispatch-snapshot.ts';
const port=parentPort;if(port===null)throw new Error('Owned Stop dispatch worker required');
let binding:ReturnType<typeof stopDispatchBinding>|undefined;
try{
 if((q.operation!=='Claim'&&q.operation!=='Error'))throw new TypeError('Unsupported Stop dispatch profile');
 const control=captureStopDispatch(q.control);binding=stopDispatchBinding(q.id,q.path,q.operation,control);for(const [key,value] of Object.entries(binding))if(q[key]!==value)throw new TypeError('Crossed Stop dispatch request');
 assertStopDispatchRequestBudget(binding,control,q.token,q.diagnostic);let token:string|null=null;
 if(q.operation==='Claim'){
  if(q.token!==null||q.diagnostic!==null)throw new TypeError('Unexpected Stop claim input');const route=snapshotSettingsBinding(control.binding).route,proof=q.proof;
  const check=()=>{if(route!=='Selected'){if(proof!==null)throw new StoreIntegrityError('Unexpected selected Stop proof');return;}
   if(proof===null||typeof proof!=='object'||Object.keys(proof).length!==4||proof.requestId!==q.id||proof.operationId!==control.operation_id||proof.target!==control.target||!(proof.active instanceof SharedArrayBuffer)||proof.active.byteLength!==4||Atomics.load(new Int32Array(proof.active),0)!==1)throw new StoreIntegrityError('Original held selection custody differs; no Stop claim');
  };
  check();token=state.claimStopControl(q.path,control,check)?.token??null;
 }else{
  if(q.proof!==null||typeof q.token!=='string'||!/^[0-9a-f-]{36}$/.test(q.token)||typeof q.diagnostic!=='string'||captureStopDispatchDiagnostic(q.diagnostic)!==q.diagnostic)throw new TypeError('Invalid Stop error completion');
  state.recordStopControlError(q.path,{control,token:q.token},q.diagnostic);
 }
 const reply={...binding,ok:true,token};if(boundedSerdeByteCount(reply,STOP_DISPATCH_REPLY_BYTES)===null)throw new RangeError('Stop dispatch acknowledgement exceeds byte budget');port.postMessage(reply);
}catch{port.postMessage({...binding,ok:false});}finally{port.close();}
