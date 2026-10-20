import {serveReusableWorker} from './reusable-worker-entry.ts';
import type {ReusableNativeOperation} from './reusable-worker-operations.ts';
import {BridgeState} from './bridge-state.ts';
import {boundedSerdeByteCount} from '../core/serde-byte-count.ts';
export const runNativeOperation:ReusableNativeOperation=(q,port)=>{
const reply=(value:object)=>port.postMessage({...value,id:q.id,path:q.path,kind:q.operation.kind});
try{
 const bridge=new BridgeState(q.path,1048576),op=q.operation;let value:unknown=null;
 switch(op.kind){case 'Selected':value=bridge.selectedThreadId();break;case 'Tracked':value=bridge.trackedThreadIds();break;case 'Settings':value=bridge.threadSettings(op.id);break;case 'Select':bridge.setSelectedThreadId(op.id);break;case 'Remember':bridge.rememberThreadSettings(op.id,op.model,op.reasoning,op.speed);break;case 'Fork':bridge.applyThreadFork(op.source,op.target);break;case 'ClearScope':value=bridge.clearSelectedIfInScope(op.scope);break;default:throw new TypeError('Unknown Bridge operation');}
 if(boundedSerdeByteCount(value,1048000)===null)throw new RangeError('Bridge operation output exceeds budget');reply({ok:true,value});
}catch{reply({ok:false,value:null});}finally{port.close();}
};
await serveReusableWorker(runNativeOperation);
