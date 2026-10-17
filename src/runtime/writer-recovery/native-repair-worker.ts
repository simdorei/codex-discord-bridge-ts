import {parentPort,workerData as input} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {usingExistingStore,withStoreTransaction,commitStore} from '../../store/owned-scope.ts';
import {getOwn} from '../../store/async-resolution-json-helpers.ts';
const port=parentPort;if(port===null)throw new Error('Repair claim requires native ownership');
const binding={id:input.id,path:input.path,operation:'claimRepair'};
try{
 if(input.operation!==binding.operation)throw new TypeError('Unknown Repair claim operation');
 const record=input.record,scope=getOwn(record.payload,'lifecycle_binding');
 if(getOwn(getOwn(scope,'command'),'Repair')===undefined)throw new TypeError('Original Repair custody required');
 const proof=input.proof,check=()=>{
  if(proof===null)return; // Legacy direct construction retains its synchronous Selected checks.
  if(getOwn(scope,'route')!=='Selected'||Object.keys(proof).length!==4||proof.requestId!==input.id||proof.operationId!==record.ingressId||proof.target!==record.targetThreadId||!(proof.active instanceof SharedArrayBuffer)||proof.active.byteLength!==4||Atomics.load(new Int32Array(proof.active),0)!==1)throw new TypeError('Original held Repair selection differs');
 };
 const value=usingExistingStore(input.path,db=>withStoreTransaction(db,'IMMEDIATE',()=>{
  check();state.validateRecoveryEffectIn(db,scope,record.channelId,null);
  const saved=state.claimIngressRecoverySnapshotIn(db,record,input.now);
  state.validateRecoveryEffectIn(db,scope,record.channelId,null);check();
  return commitStore({record:saved,location:DatabaseSync.prototype.location.call(db,'main')});
 }),100);
 port.postMessage({...binding,ok:true,...value});
}catch{port.postMessage({...binding,ok:false});}finally{port.close();}
