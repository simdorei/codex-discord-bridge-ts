import {parentPort,workerData as q} from 'node:worker_threads';
import {resumeRecoveryCandidateEvidence as evidence} from '../../store/resume-restart-recovery.ts';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
const scan=state.scanResumeRecoveryCandidates,recover=state.recoverIdleResume;
import {StoreIntegrityError} from '../../store/schema-assembly.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {passiveErrorText} from '../../core/passive-error-text.ts';
const port=parentPort;if(port===null)throw new Error('Resume recovery requires owned native worker');
let mutating=false;
try{
 if(q.operation==='scan'){
  const result=scan(q.path,q.runtime).map(c=>({attemptId:c.attemptId,target:c.target,original:evidence(c)}));
  if(boundedSerdeByteCount(result,4194304)===null)throw new StoreIntegrityError('Resume candidate snapshot exceeds bounded native transport');port.postMessage({ok:true,result});
 }else if(q.operation==='recover'){
  // A new scan cannot replace the ORIGINAL observed snapshot. Exact original
  // bytes, target and attempt all must still match before entering the transaction.
  const c=scan(q.path,q.runtime).find(c=>c.attemptId===q.candidate.attemptId&&c.target===q.candidate.target&&evidence(c)===q.candidate.original);
  if(c===undefined)throw new StoreIntegrityError('Resume candidate changed during native observation');
  mutating=true;const result=recover(q.path,q.runtime,q.resident,q.generation,c,q.metadata,q.latest);port.postMessage({ok:true,result});
 }else throw new StoreIntegrityError('Invalid resume native operation');
}catch(error){
 // Source validation holds are known refusals. Native/cleanup failures after a
 // mutating call may include an unobserved commit and must stop startup globally.
 const uncertain=mutating&&!(error instanceof StoreIntegrityError);
 const detail=[...passiveErrorText(error,'Native resume recovery failed')].slice(0,2048).join('');port.postMessage({ok:false,uncertain,detail});
}finally{port.close();}
