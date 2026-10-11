import {parentPort,workerData as q} from 'node:worker_threads';
import {createMutationCustodyFence} from './mutation-custody-fence.ts';
import {ownedResidentFailure} from '../app-server/resident-state.ts';
import {passiveErrorText} from '../core/passive-error-text.ts';
const port=parentPort;if(port===null)throw new Error('Custody read requires an owned native worker');
const bounded=(value:string)=>{let output='',count=0;for(const ch of value){if(count++===2048)break;output+=ch;}return output;};
try{
 // Only this existing-only read method is dispatched. No activation, admission
 // claim, response mutation, schema initialization, or arbitrary operation name.
 const fence=createMutationCustodyFence(q.path,q.runtime,error=>bounded(passiveErrorText(error,'Native custody read failed')));
 fence.checkRequest(q.generation,q.method,q.params);port.postMessage({ok:true});
}catch(error){const failure=ownedResidentFailure(error);const kind=failure?.kind==='MutationHeld'||failure?.kind==='DeadGenerationFence'?failure.kind:null;const detail=kind!==null&&failure!==null&&'message' in failure?failure.message:passiveErrorText(error,'Native custody read failed');port.postMessage({ok:false,kind,detail:bounded(detail)});}
finally{port.close();}
