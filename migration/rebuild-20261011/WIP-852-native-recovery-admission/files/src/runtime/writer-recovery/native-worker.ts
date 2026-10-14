import {parentPort,workerData} from 'node:worker_threads';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {usingExistingStore,withStoreTransaction,rollbackStore} from '../../store/owned-scope.ts';
import {getOwn} from '../../store/async-resolution-json-helpers.ts';
import type {OriginalRecoveryInput} from './native-owner.ts';
import type {StoredIngress} from '../../store/ingress-read.ts';
if(parentPort===null)throw new Error('Recovery persistence requires native ownership');
const input=workerData as {id:string;path:string;operation:'claim'|'claimOriginal'|'check'|'cancel';record:StoredIngress;now:number};
let result:unknown;
try{
 const binding=getOwn(input.record.payload,'lifecycle_binding'),command=getOwn(binding,'command');
 if(input.operation!=='claimOriginal'&&(getOwn(command,'Recover')===undefined||getOwn(binding,'route')==='Selected'))throw new Error('Native recovery requires original explicit or mapped Recover custody');
 let value:unknown;
 switch(input.operation){
  case 'claimOriginal':{const e=input.record as unknown as OriginalRecoveryInput;value=state.claimOriginalRecoverExisting(input.path,e.key,e.channelId,e.ownerUserId,e.eventId,e.reference,input.now);break;}
  case 'claim':value=state.claimIngressRecoverySnapshotExisting(input.path,input.record,input.now);break;
  case 'check':usingExistingStore(input.path,db=>withStoreTransaction(db,'DEFERRED',()=>{state.validateIngressRecoverySnapshotIn(db,input.record);return rollbackStore(undefined);}),100);value=null;break;
  case 'cancel':value=state.cancelForRecoveryExisting(input.path,input.record.targetThreadId!,input.record.channelId,input.record.ownerUserId,input.now,db=>{state.validateIngressRecoverySnapshotIn(db,input.record);return undefined;});break;
  default:throw new Error('Unknown recovery persistence operation');
 }
 result={id:input.id,path:input.path,operation:input.operation,ok:true,value};
}catch{result={id:input.id,path:input.path,operation:input.operation,ok:false};}
parentPort.postMessage(result);parentPort.close();
