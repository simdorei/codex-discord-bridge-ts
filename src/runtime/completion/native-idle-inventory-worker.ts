import {serveReusableWorker} from '../reusable-worker-entry.ts';
import type {ReusableNativeOperation} from '../reusable-worker-operations.ts';import * as stateIdleReleaseStore from '../../store/idle-release-store.ts';import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
export const runNativeOperation:ReusableNativeOperation=(q,port)=>{
try{let value;switch(q.operation){case 'Pending':value=stateIdleReleaseStore.pendingIdleIntentsExisting(q.path);break;case 'Get':value=stateIdleReleaseStore.getIdleIntentExisting(q.path,q.thread);break;default:throw new TypeError('Invalid idle inventory operation');}const result={ok:true,value};if(boundedSerdeByteCount(result,16*1024*1024)===null)throw new Error('Idle inventory exceeds native boundary');port.postMessage(result);}catch{port.postMessage({ok:false});}finally{port.close();}
};
await serveReusableWorker(runNativeOperation);
