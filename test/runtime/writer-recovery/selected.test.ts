import test from 'node:test';
import assert from 'node:assert/strict';
import {dirname,join} from 'node:path';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {queueJob} from '../../helpers/queue-job.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {NativeBridgeStateOwner} from '../../../src/runtime/bridge-state-native.ts';
import {NativeRecoveryOwner} from '../../../src/runtime/writer-recovery/native-owner.ts';
import {handoffRecovery} from '../../../src/runtime/writer-recovery/handoff.ts';
const envelope={key:'message:3',channelId:1n,ownerUserId:2n,eventId:3n,reference:null};
async function fixture(body:(path:string,bridge:NativeBridgeStateOwner,owner:NativeRecoveryOwner)=>Promise<void>){
 await storeFixture(async path=>{
  const command={Recover:{reference:null}},bridge=new NativeBridgeStateOwner(join(dirname(path),'bridge.json'));
  await bridge.execute({kind:'Select',id:'target'});
  await state.admitIngress(path,{ingressId:'message:3',kind:'message',eventId:3n,applicationId:null,channelId:1n,ownerUserId:2n,sourceMessageId:3n,payload:{version:1n,plan:{Execute:command},lifecycle_binding:{target:'target',route:'Selected',command}},targetThreadId:'target',canonicalOwner:null,now:1});
  await state.beginIngressExecution(path,'message:3','processing','target',2);
  await state.enqueue(path,queueJob({jobId:'job',ownerUserId:2n,createdAt:1}));
  const owner=new NativeRecoveryOwner(path,bridge);try{await body(path,bridge,owner);}finally{await owner.close();}
 });
}
async function counts(path:string){const db=await openInitialized(path);try{return {cancelled:db.prepare('SELECT count(*) AS n FROM codex_request_cancellations').get()?.n,phase:db.prepare('SELECT phase FROM discord_ingress_journal').get()?.phase};}finally{db.close();}}
test('selected original recovery keeps original target through actual native cancellation',()=>fixture(async(path,_bridge,owner)=>{
 const claim=await owner.claimOriginal(envelope);assert.equal(owner.target(claim),'target');await owner.check(claim);assert.deepEqual(await owner.cancel(claim),{jobs:['job'],startedOrUncertain:0});assert.equal((await counts(path)).cancelled,1);
}));
test('changed selected target is refused before durable original claim',()=>fixture(async(path,bridge,owner)=>{
 await bridge.execute({kind:'Select',id:'other'});await assert.rejects(owner.claimOriginal(envelope));assert.deepEqual(await counts(path),{cancelled:0,phase:'processing'});
}));
test('selection changed away and back cannot refresh the original epoch proof',()=>fixture(async(path,bridge,owner)=>{
 const claim=await owner.claimOriginal(envelope);await bridge.execute({kind:'Select',id:'other'});await bridge.execute({kind:'Select',id:'target'});await assert.rejects(owner.cancel(claim),/stale/);assert.equal((await counts(path)).cancelled,0);
}));
test('selection changed by inspection cannot reach cancellation or restart',()=>fixture(async(path,bridge,owner)=>{
 const claim=await owner.claimOriginal(envelope);let starts=0,joins=0;
 await assert.rejects(handoffRecovery(owner,claim,{inspect:async()=>{await bridge.execute({kind:'Select',id:'other'});return {ThreadId:'target',State:'tools_recovery',RecoveryIdentity:'owned'};},start:async()=>{starts++;return {};},join:async()=>{joins++;}},'/repo','posix'));
 assert.equal(starts,0);assert.equal(joins,1);assert.equal((await counts(path)).cancelled,0);
}));
test('snapshot reads reject forged and foreign owner tokens',()=>fixture(async(_path,bridge)=>{
 const token=await bridge.captureSelected();assert.equal(bridge.selectedFromSnapshot(token),'target');assert.throws(()=>bridge.selectedFromSnapshot({...token}),/stale/);const foreign=new NativeBridgeStateOwner('/unused');assert.throws(()=>foreign.selectedFromSnapshot(token),/stale/);
}));
test('concurrent selected preparation is bounded and close joins it',()=>fixture(async(_path,_bridge,owner)=>{
 const pending=owner.claimOriginal(envelope),rejected=assert.rejects(pending);await assert.rejects(owner.claimOriginal(envelope),/busy|running/);await owner.close();await rejected;
}));

test('closed owner cannot authorize a later synchronous controller boundary',()=>fixture(async(_path,_bridge,owner)=>{
 const claim=await owner.claimOriginal(envelope);await owner.close();assert.throws(()=>owner.checkSelection(claim),/closed/);
}));
test('subclass selection override cannot manufacture a native epoch proof',()=>storeFixture(async path=>{
 class FakeBridge extends NativeBridgeStateOwner{override async execute(){return 'fabricated';}}
 const bridge=new FakeBridge(join(dirname(path),'missing.json'));const snapshot=await NativeBridgeStateOwner.prototype.captureSelected.call(bridge);assert.equal(bridge.selectedFromSnapshot(snapshot),null);assert.throws(()=>bridge.validateSelected(snapshot,'fabricated'),/stale|differs/);
}));
