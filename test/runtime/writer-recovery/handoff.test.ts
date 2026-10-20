import test from 'node:test';
import assert from 'node:assert/strict';
import type {DatabaseSync} from 'node:sqlite';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {queueJob} from '../../helpers/queue-job.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {NativeRecoveryOwner,type NativeRecoveryClaim} from '../../../src/runtime/writer-recovery/native-owner.ts';
import {handoffRecovery,recoveryReceiptPath,RecoveryHandoffError,type RecoveryController} from '../../../src/runtime/writer-recovery/handoff.ts';
async function edit<T>(path:string,body:(db:DatabaseSync)=>T):Promise<T>{const db=await openInitialized(path);try{return body(db);}finally{db.close();}}
const root='/repo',operation='a'.repeat(32),receipt='/repo/maintenance_backups/desktop-recovery/'+operation+'/receipt.json';
const inspection={ThreadId:'target',State:'tools_recovery',RecoveryIdentity:'exact-host-identity'};
async function fixture(body:(path:string,owner:NativeRecoveryOwner,claim:NativeRecoveryClaim)=>Promise<void>){
 await storeFixture(async path=>{
  const command={Recover:{reference:'target'}};
  await state.admitIngress(path,{ingressId:'message:3',kind:'message',eventId:3n,applicationId:null,channelId:1n,ownerUserId:2n,sourceMessageId:3n,payload:{version:1n,plan:{Execute:command},lifecycle_binding:{target:'target',route:'Explicit',command}},targetThreadId:'target',canonicalOwner:null,now:1});
  await state.beginIngressExecution(path,'message:3','processing','target',2);
  await state.enqueue(path,queueJob({jobId:'job',ownerUserId:2n,createdAt:1}));
  const owner=new NativeRecoveryOwner(path);try{const claim=await owner.claimOriginal({key:'message:3',channelId:1n,ownerUserId:2n,eventId:3n,reference:'target'});await body(path,owner,claim);}finally{await owner.close();}
 });
}
const cancelled=(path:string)=>edit(path,db=>db.prepare('SELECT count(*) AS n FROM codex_request_cancellations').get()?.n);
test('inspection precedes cancellation and exact-identity dispatch, with joined handoff only',()=>fixture(async(path,owner,claim)=>{
 const order:string[]=[];
 const controller:RecoveryController={inspect:async thread=>{order.push('inspect');assert.equal(thread,'target');assert.equal(await cancelled(path),0);return inspection;},start:async(thread,identity)=>{order.push('start');assert.equal(thread,'target');assert.equal(identity,inspection.RecoveryIdentity);assert.equal(await cancelled(path),1);return {Operation:operation,ReceiptPath:receipt};},join:async()=>{order.push('join');}};
 const result=await handoffRecovery(owner,claim,controller,root,'posix');assert.deepEqual(order,['inspect','start','join']);assert.deepEqual(result,{phase:'dispatched_tools',thread:'target',cancelled:['job'],startedOrUncertain:0,receipt});assert.equal(Object.isFrozen(result.cancelled),true);
}));
for(const bad of [{...inspection,ThreadId:'other'},{...inspection,State:'unlocked'},{...inspection,RecoveryIdentity:1}])test('invalid inspection cannot cancel or dispatch '+JSON.stringify(bad),()=>fixture(async(path,owner,claim)=>{
 let starts=0,joins=0;await assert.rejects(handoffRecovery(owner,claim,{inspect:async()=>bad,start:async()=>{starts++;return {};},join:async()=>{joins++;}},root,'posix'),RecoveryHandoffError);assert.equal(await cancelled(path),0);assert.equal(starts,0);assert.equal(joins,1);
}));
test('dispatch failure retains committed cancellation and never retries',()=>fixture(async(path,owner,claim)=>{
 let starts=0;const failure=new Error('controller failed');
 await assert.rejects(handoffRecovery(owner,claim,{inspect:async()=>inspection,start:async()=>{starts++;throw failure;},join:async()=>{}},root,'posix'),e=>e instanceof RecoveryHandoffError&&e.cancellation?.jobs[0]==='job'&&e.cause===failure);
 assert.equal(starts,1);assert.equal(await cancelled(path),1);await assert.rejects(owner.cancel(claim),/consumed/);
}));
test('original custody changed during inspection refuses cancellation',()=>fixture(async(path,owner,claim)=>{
 let starts=0;await assert.rejects(handoffRecovery(owner,claim,{inspect:async()=>{await edit(path,db=>db.exec("UPDATE discord_ingress_journal SET updated_at=updated_at+1"));return inspection;},start:async()=>{starts++;return {};},join:async()=>{}},root,'posix'),RecoveryHandoffError);assert.equal(await cancelled(path),0);assert.equal(starts,0);
}));
test('wrong receipt after dispatch remains unconfirmed with committed cancellation',()=>fixture(async(path,owner,claim)=>{
 await assert.rejects(handoffRecovery(owner,claim,{inspect:async()=>inspection,start:async()=>({Operation:operation,ReceiptPath:'/elsewhere'}),join:async()=>{}},root,'posix'),e=>e instanceof RecoveryHandoffError&&e.cancellation?.jobs.length===1);assert.equal(await cancelled(path),1);
}));
test('deadline abort is observed and owned controller invocation joined before rejection',()=>fixture(async(path,owner,claim)=>{
 let joined=false,aborted=false;
 await assert.rejects(handoffRecovery(owner,claim,{inspect:async(_thread,signal)=>await new Promise((_,reject)=>{const stop=()=>{aborted=true;reject(signal.reason);};signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();}),start:async()=>assert.fail('no dispatch'),join:async()=>{joined=true;}},root,'posix',undefined,500),RecoveryHandoffError);
 assert.equal(aborted,true);assert.equal(joined,true);assert.equal(await cancelled(path),0);
}));
test('join failure cannot turn a valid dispatch receipt into confirmed completion',()=>fixture(async(path,owner,claim)=>{
 await assert.rejects(handoffRecovery(owner,claim,{inspect:async()=>inspection,start:async()=>({Operation:operation,ReceiptPath:receipt}),join:async()=>{throw new Error('join unverified');}},root,'posix'),e=>e instanceof RecoveryHandoffError&&e.cancellation?.jobs.length===1);
}));
test('receipt binds operation and exact path spelling',()=>{
 assert.equal(recoveryReceiptPath(root,{Operation:operation,ReceiptPath:receipt},'posix'),receipt);
 for(const value of [{Operation:'A'.repeat(32),ReceiptPath:receipt},{Operation:'../escape',ReceiptPath:receipt},{Operation:operation,ReceiptPath:receipt+'/../receipt.json'},{Operation:operation,ReceiptPath:'/elsewhere'}])assert.throws(()=>recoveryReceiptPath(root,value,'posix'));
});
