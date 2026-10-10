import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createOrdinaryComponentHandler, PreparedOrdinaryComponentConfirmation} from '../../../src/runtime/component-worker/ordinary-handler.ts';
import {createInteractionProcessor} from '../../../src/runtime/interaction-worker/processor.ts';
import {runInteractionWorker} from '../../../src/runtime/interaction-worker/worker.ts';
import {createInteractionWorkQueue} from '../../../src/runtime/discord-dispatch/interaction-work.ts';
import {AdmissionGate} from '../../../src/admission/drain-gate.ts';
import {ControlTurnVerifier} from '../../../src/runtime/action-executor/control-turn.ts';
import {BusyQueueExecutor} from '../../../src/runtime/action-executor/busy-queue.ts';
import {TargetLocks} from '../../../src/core/keyed-locks.ts';
import {requestFingerprint, threadFingerprint} from '../../../src/discord/components.ts';
import {componentWorkerErrorInfo} from '../../../src/runtime/component-worker/errors.ts';
import {busyComponentErrorInfo} from '../../../src/runtime/component-worker/busy-errors.ts';
import {usingInitializedStore} from '../../../src/store/owned-scope.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {createBusyChoice, getBusyChoice} from '../../../src/store/busy-choice-store.ts';
import {busyReadyMarker} from '../../../src/runtime/component-worker/confirmation.ts';
import {promptFixture, callPromptFixture} from '../../helpers/server-prompt-fixture.ts';
import {work, stage, enqueue, httpFixture, fence} from '../../helpers/interaction-worker-fixture.ts';
import {storeFixture} from '../../helpers/store-fixture.ts';
const current=()=>Date.now()/1000;
const kind=(k:string)=>(e:unknown)=>componentWorkerErrorInfo(e)?.kind===k;
test('real worker and business processor use concrete bound handler through native answer, receipt, clear and final custody',async()=>{
 await promptFixture(async(db,server,r)=>httpFixture(async(http,seen)=>{
  const custom=`codex_approval:v2:${threadFingerprint('t')}:${requestFingerprint(1n,r.occurrence.asBytes(),r.id)}:1`,gate=new AdmissionGate(),f=fence(),w=work(db,3n,gate,custom),q=createInteractionWorkQueue();await stage(w);enqueue(q,w);q.sender.dispose();gate.seal(f);
  const verifier=new ControlTurnVerifier(db,server,{selectedThreadId:()=>null},new TargetLocks());let notified=0;
  const handler=createOrdinaryComponentHandler(db,server,http,null as any,verifier,()=>{notified++;});
  const process=createInteractionProcessor(db,server,http,{async executeWithIngressContext(){throw Error('unexpected slash');},prepareComponent:handler});
  const logs:string[]=[];await runInteractionWorker(q,db,http,{process,notifyDeliveryReady(){notified++;},report(_code,detail){logs.push(detail);}});
  assert.deepEqual(await callPromptFixture(server,'answers'),[{id:'approval',result:{decision:'accept'}}]);assert.deepEqual(logs,[]);assert.deepEqual(seen,['POST','PATCH']);
  assert.equal((await state.getIngress(db,w.custodyIngressId))!.confirmationDelivered,true);assert.equal(notified,1);assert.equal(gate.isDrainedFor(f),true);
 }),{enableResponses:true});
});
test('prepared delivery is an own lazy callback and retries only durable confirmation/clear, never approval',async()=>{
 await promptFixture(async(db,server,r)=>httpFixture(async(http,seen)=>{
  const custom=`codex_approval:v2:${threadFingerprint('t')}:${requestFingerprint(1n,r.occurrence.asBytes(),r.id)}:1`,w=work(db,3n,new AdmissionGate(),custom);await stage(w);
  try {assert.ok('Component'in w.work);const handler=createOrdinaryComponentHandler(db,server,http,null as any,new ControlTurnVerifier(db,server,{selectedThreadId:()=>null},new TargetLocks()),()=>{});
   const prepared=await handler(w,w.work.Component);assert.equal(seen.length,0);assert.ok(Object.hasOwn(prepared,'deliver'));const deliver=prepared.deliver;await deliver();await deliver();assert.deepEqual(seen,['POST','PATCH','PATCH']);assert.equal((await callPromptFixture(server,'answers') as unknown[]).length,1);
  }finally{w.admissionPermit!.release();}
 }),{enableResponses:true});
});
test('Busy Queue concrete branch commits once and ConfirmationOnly reuses ready marker without another intake',async()=>storeFixture(async db=>httpFixture(async(http,seen)=>{
 const at=current(),id=await createBusyChoice(db,{ownerUserId:2n,channelId:1n,targetThreadId:'t',prompt:'queued',allowSteer:false,now:at,timeToLive:1800}),choice=(await getBusyChoice(db,id,at))!;
 const base=work(db,3n,new AdmissionGate(),`codex_busy:${id}:queue`),w=Object.freeze({...base,authorizedBusyChoice:choice});let calls=0;
 const queue=new BusyQueueExecutor(db,{async processAdmittedPrompt(){calls++;return {text:'accepted',waitsForFinal:false,ui:null};}}),handler=createOrdinaryComponentHandler(db,null as any,http,queue,null as any,()=>{});
 try {assert.ok('Component'in w.work);const first=await handler(w,w.work.Component);assert.equal(calls,1);assert.equal(await state.isComponentClaimLive(db,busyReadyMarker(id,2n,1n),current()),true);await first.deliver();
  const again=await handler({...w,processingMode:'ConfirmationOnly'},w.work.Component);await again.deliver();assert.equal(calls,1);assert.deepEqual(seen,['POST','PATCH','PATCH']);
 }finally{w.admissionPermit!.release();}
})));
test('confirmation-only nonbusy and recovery components perform no action',async()=>{
 const handler=createOrdinaryComponentHandler('/unused',null as any,null as any,null as any,null as any,()=>{});
 for(const custom of ['codex_approval:t:1',`codex_pub:v1:${'a'.repeat(32)}:1:a`,`codex_discard:v1:${'a'.repeat(32)}:1:a`]){
  const w=work('/unused',3n,new AdmissionGate(),custom);try{assert.ok('Component'in w.work);
   if(custom.startsWith('codex_approval')){await assert.rejects(handler({...w,processingMode:'ConfirmationOnly'},w.work.Component),e=>{const info=componentWorkerErrorInfo(e);return info?.kind==='Busy'&&busyComponentErrorInfo(info.source)?.kind==='ActionUnconfirmed';});await assert.rejects(handler(w,w.work.Component),kind('LegacyComponentExpired'));}
   else await assert.rejects(handler({...w,processingMode:'ConfirmationOnly'},w.work.Component),kind(custom.startsWith('codex_pub')?'PublicationConsent':'Abandonment'));
  }finally{w.admissionPermit!.release();}
 }
});
test('component argument must equal its owned routed envelope before any store or server read',async()=>{
 const w=work('/unused',3n,new AdmissionGate(),'codex_approval:t:1'),handler=createOrdinaryComponentHandler('/unused',null as any,null as any,null as any,null as any,()=>{});
 try {await assert.rejects(handler(w,{Approval:{thread_id:'other',answer:'Approve'}}),kind('InvalidComponent'));}
 finally {w.admissionPermit!.release();}
 assert.throws(()=>new PreparedOrdinaryComponentConfirmation(Symbol(),'/unused',1n,null,{} as any,null as any),TypeError);
});
test('submitted async question is routed before ConfirmationOnly and can recover display without live server',async()=>storeFixture(async db=>httpFixture(async(http,seen)=>{
 const id='b'.repeat(64);await usingInitializedStore(db,h=>{h.exec("INSERT INTO mirror_threads VALUES('t','p','T',10,1,0)");h.prepare("INSERT INTO cdr_async_questions(id,runtime_id,generation,thread_id,turn_id,item_id,origin_job_id,channel_id,owner_user_id,body,state,message_id,owner_confirmed,chosen,accepted_turn_id,created_at,updated_at) VALUES(?,'old',1,'t','v','item','done',1,2,?,'submitted','9',1,0,'v',0,0)").run(id,'{"index":0,"title":"fixture","options":["yes"]}');});
 const base=work(db,3n,new AdmissionGate(),`codex_async:${id}:0`),w=Object.freeze({...base,processingMode:'ConfirmationOnly' as const});
 const handler=createOrdinaryComponentHandler(db,null as any,http,null as any,new ControlTurnVerifier(db,null,{selectedThreadId:()=>null},new TargetLocks()),()=>{throw Error('no reexecution');});
 try {assert.ok('Component'in w.work);const prepared=await handler(w,w.work.Component);await prepared.deliver();assert.deepEqual(seen,['POST','PATCH']);assert.equal((await state.getAsyncQuestion(db,id)).state,'submitted');}
 finally {w.admissionPermit!.release();}
})));
