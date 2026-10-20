import {parentPort,workerData as q} from 'node:worker_threads';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
const port=parentPort;if(port===null)throw new Error('Owned Retract worker required');
const op=q.operation,binding={id:q.id,path:q.path,ingressKey:op.ingressKey,eventId:op.eventId,target:op.target,channelId:op.channelId,ownerUserId:op.ownerUserId};
try{

 const value=state.cancelLatestPendingExisting(q.path,op.target,op.channelId,op.ownerUserId,op.now,op.requireMirror);
 port.postMessage({...binding,ok:true,value});
}catch{port.postMessage({...binding,ok:false,value:null});}finally{port.close();}
