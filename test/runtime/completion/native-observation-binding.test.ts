import test from 'node:test';import assert from 'node:assert/strict';
import {CompletionSourceIntake} from '../../../src/runtime/completion/source-intake.ts';
import {CompletionSourceReconciler} from '../../../src/runtime/completion/source-reconciler.ts';
import {createNativeObservationState} from '../../../src/runtime/completion/native-observation-state.ts';
import {TerminalFence} from '../../../src/runtime/completion/terminal-fence.ts';
import {NotificationState} from '../../../src/app-server/notification-state.ts';
import {BoundedBroadcast} from '../../../src/app-server/broadcast.ts';
import type {ResidentNotificationEvent} from '../../../src/app-server/resident-forwarders.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {storeFixture} from '../../helpers/store-fixture.ts';
const OWNER='00000000-0000-4000-8000-000000000001' as const;
function fake(){let generation=1n,cleared=0,gaps=0;const n=new NotificationState(),b=new BoundedBroadcast<ResidentNotificationEvent>(8);
 const server={instanceId:OWNER,generation:()=>generation,observationWindow:(g:bigint,a:bigint,u:bigint|null=null)=>({...n.observationWindow(a,u),ownerId:OWNER,generation:g}),markIdleObservationGap:(_r:(e:unknown)=>void)=>{gaps++;},markSourceObservationGap:(_g:bigint,_r:(e:unknown)=>void)=>{gaps++;},subscribeNotifications:()=>b.subscribe(),observationTrackingEnabled:()=>true,reconcileIdleObservationPrefix:(_g:bigint,_n:bigint)=>{cleared++;return true;}};
 return {server,n,setGeneration:(g:bigint)=>{generation=g;},cleared:()=>cleared,gaps:()=>gaps};}
test('native intake activation lock yields main timer then original event certifies and transfers',async()=>storeFixture(async path=>{
 const db=await openInitialized(path),native=createNativeObservationState(path),f=fake();f.n.record({method:'other',params:{threadId:'target'}});
 const errors:unknown[]=[],intake=new CompletionSourceIntake(path,f.server,new TerminalFence(),false,x=>errors.push(x.error),undefined,native.state,undefined,native.state);
 db.exec('BEGIN IMMEDIATE');const p=intake.scanOnce();let done=false;void p.then(()=>{done=true;},()=>{done=true;});
 try{await new Promise(r=>setTimeout(r,50));assert.equal(done,false);db.exec('ROLLBACK');await p;
 assert.equal(intake.forwarded,1n);assert.equal(intake.queue.length,1);assert.equal(state.observationScopeVerifiedExisting(path,{ownerId:OWNER,generation:1n},1n),true);assert.deepEqual(errors,[]);
 }finally{if(db.isTransaction)db.exec('ROLLBACK');await p;intake.close();await native.close();db.close();}
}));
test('generation replacement during activation cannot assign current page to previous scope',async()=>storeFixture(async path=>{
 const f=fake();f.n.record({method:'other',params:{threadId:'target'}});let discovered=false;
 const store={activateObservation:async()=>{f.setGeneration(2n);},discoverObservation:async()=>{discovered=true;}};
 const intake=new CompletionSourceIntake(path,f.server,new TerminalFence(),false,()=>{},undefined,store);await intake.scanOnce();assert.equal(discovered,false);assert.equal(intake.forwarded,0n);assert.equal(intake.queue.length,0);assert.equal(f.gaps(),1);intake.close();
}));
test('generation replacement during discovery cannot forward page or move retained cursor',async()=>storeFixture(async path=>{
 const f=fake();f.n.record({method:'other',params:{threadId:'target'}});
 const store={activateObservation:state.activateObservation,discoverObservation:async(p:string,s:Parameters<typeof state.discoverObservation>[1],n:bigint)=>{await state.discoverObservation(p,s,n);f.setGeneration(2n);}};
 const intake=new CompletionSourceIntake(path,f.server,new TerminalFence(),false,()=>{},undefined,store);await intake.scanOnce();assert.equal(intake.forwarded,0n);assert.equal(intake.queue.length,0);assert.equal(await state.observationScopeVerified(path,{ownerId:OWNER,generation:1n},1n),false);intake.close();
}));
test('reconciler never clears native prefix after generation changed during final verified await',async()=>storeFixture(async path=>{
 const f=fake();const store={activateObservation:state.activateObservation,discoverObservation:state.discoverObservation,nextObservationGap:state.nextObservationGap,finishObservationPage:state.finishObservationPage,observationScopeVerified:async()=>{f.setGeneration(2n);return true;}};
 const reconciler=new CompletionSourceReconciler(path,f.server,false,()=>{},store);await assert.rejects(reconciler.scanOnce(),/generation changed during verification/);assert.equal(f.cleared(),0);
}));
test('native adapter refuses substituted database path and closes against future ledger admission',async()=>storeFixture(async path=>{
 const native=createNativeObservationState(path),scope={ownerId:OWNER,generation:1n};try{assert.throws(()=>native.state.activateObservation(path+'other',scope),/path changed/);}finally{await native.close();}assert.throws(()=>native.state.activateObservation(path,scope),/closed/);
}));
