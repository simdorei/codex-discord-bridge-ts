import {parentPort,workerData as q} from 'node:worker_threads';
import {BridgeState} from './bridge-state.ts';
import {boundedSerdeByteCount} from '../core/serde-byte-count.ts';
const port=parentPort;if(port===null)throw new Error('Bridge native operation requires parent owner');
const reply=(value:object)=>port.postMessage({...value,id:q.id,path:q.path,kind:q.operation.kind});
try{
 if(process.platform==='win32')throw new Error('Windows Bridge owner unqualified');const bridge=new BridgeState(q.path,1048576),op=q.operation;let value:unknown=null;
 switch(op.kind){case 'Selected':value=bridge.selectedThreadId();break;case 'Tracked':value=bridge.trackedThreadIds();break;case 'Settings':value=bridge.threadSettings(op.id);break;case 'Select':bridge.setSelectedThreadId(op.id);break;case 'Remember':bridge.rememberThreadSettings(op.id,op.model,op.reasoning,op.speed);break;case 'Fork':bridge.applyThreadFork(op.source,op.target);break;case 'ClearScope':value=bridge.clearSelectedIfInScope(op.scope);break;default:throw new TypeError('Unknown Bridge operation');}
 if(boundedSerdeByteCount(value,1048000)===null)throw new RangeError('Bridge operation output exceeds budget');reply({ok:true,value});
}catch{reply({ok:false,value:null});}finally{port.close();}
