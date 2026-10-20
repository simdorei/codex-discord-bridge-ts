import {parentPort,workerData as q} from 'node:worker_threads';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {recordIngressResultExisting} from '../../store/ingress-lifecycle.ts';
const port=parentPort;if(port===null)throw new Error('Owned archive worker required');
const binding={id:q.id,path:q.path,kind:q.operation.kind};
try{
 let value:string|null=null;const op=q.operation;
 switch(op.kind){case 'Reserve':value=state.reserveArchiveScopeExisting(q.path,op.scope,op.own);break;case 'Verified':state.markArchiveVerifiedExisting(q.path,op.operation);break;case 'ReleaseRejected':state.releaseRejectedArchiveExisting(q.path,op.operation);break;case 'Refused':recordIngressResultExisting(q.path,op.key,{kind:'archive_not_dispatched',version:1n,archive_dispatched:false,error:op.error},Date.now()/1000);break;default:throw new TypeError('Unsupported archive write');}
 port.postMessage({...binding,ok:true,value});
}catch{port.postMessage({...binding,ok:false,value:null});}finally{port.close();}
