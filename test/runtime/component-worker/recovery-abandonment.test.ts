import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {DatabaseSync} from 'node:sqlite';
import {dirname} from 'node:path';
import {abandonmentStoreFixture} from '../../helpers/abandonment-store-fixture.ts';
import {work} from '../../helpers/interaction-worker-fixture.ts';
import {AdmissionGate,AdmissionPermit,DrainFenceKey} from '../../../src/admission/drain-gate.ts';
import {TargetLocks} from '../../../src/core/keyed-locks.ts';
import {ControlTurnVerifier} from '../../../src/runtime/action-executor/control-turn.ts';
import {handleRecoveryAbandonment} from '../../../src/runtime/component-worker/recovery-abandonment.ts';
import {isConfirmationPlan} from '../../../src/runtime/component-worker/confirmation.ts';
import {proposeAbandonment,bindAbandonmentDelivery} from '../../../src/store/abandonment-proposal.ts';
import {serializeSerdeValue} from '../../../src/core/serde-json.ts';
import type {InboundInteractionWork} from '../../../src/runtime/discord-dispatch/interaction-work.ts';
const id='a'.repeat(32),job='550e8400-e29b-41d4-a716-446655440000';
async function fixture(run:(db:DatabaseSync,path:string,w:InboundInteractionWork,locks:TargetLocks,v:ControlTurnVerifier,gate:AdmissionGate)=>Promise<void>,choice='a'){
 await abandonmentStoreFixture(async(db,path)=>{
  const p=proposeAbandonment(path,{proposal_id:id,job_id:job,ingress_id:'message:5',application_id:4n,now:10,expires_at:20});bindAbandonmentDelivery(path,id,9n,p.review_sha256,11);
  const gate=new AdmissionGate(),w=work(path,6n,gate,`codex_discard:v1:${id}:1:${choice}`),locks=new TargetLocks(),v=new ControlTurnVerifier(path,null,{selectedThreadId:()=>null},locks);
  db.prepare(`INSERT INTO discord_ingress_journal(ingress_id,kind,event_id,application_id,channel_id,owner_user_id,source_message_id,payload_json,runtime_id,state,phase,target_thread_id,created_at,updated_at)
   VALUES('interaction:6','interaction',6,4,1,2,9,?,'app','executing','processing','t',12,12)`).run(serializeSerdeValue({version:1n,work:w.work}));
  try{await run(db,path,w,locks,v,gate);}finally{w.admissionPermit!.release();}
 },true,job);
}
function call(path:string,w:InboundInteractionWork,v:ControlTurnVerifier,now=()=>12){assert.ok('Component' in w.work);return handleRecoveryAbandonment(w,w.work.Component,path,v,now);}
const count=(db:DatabaseSync,table='cdr_recovery_abandonment_decisions')=>db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n;
test('dedicated handler applies each exact decision and mints only display confirmation',async()=>{
 for(const choice of ['a','h'])await fixture(async(db,path,w,locks,v)=>{
  const p=await call(path,w,v);assert.equal(isConfirmationPlan(p),true);assert.equal(p.domain,'recovery-abandonment-confirmation-v1');assert.equal(p.logicalKey,id+':1');
  assert.equal(p.content,choice==='a'?'Saved request permanently abandoned without replay. The thread remains held; no new request was started.':'Saved request kept. The thread remains held; no request was replayed or started.');
  assert.equal(count(db),1);assert.equal(count(db,'codex_turn_queue'),choice==='a'?0:1);assert.equal(count(db,'cdr_async_recovery_policies'),1);assert.equal(locks.activeTargetCount,0);
  assert.deepEqual(await call(path,w,v,()=>99),p);assert.equal(count(db),1);
 },choice);
});
test('missing, forged or released admission cannot perform a disposition',()=>fixture(async(db,path,w,_locks,v)=>{
 for(const permit of [null,Object.create(AdmissionPermit.prototype) as AdmissionPermit])await assert.rejects(call(path,{...w,admissionPermit:permit},v),/matching live normal admission/);
 w.admissionPermit!.release();await assert.rejects(call(path,w,v),/matching live normal admission/);assert.equal(count(db),0);
}));
test('normal mode, exact routed component and canonical custody ingress are mandatory',()=>fixture(async(db,path,w,_locks,v)=>{
 for(const changed of [{processingMode:'ConfirmationOnly' as const},{custodyIngressId:'interaction:other'}])await assert.rejects(call(path,{...w,...changed},v),/matching live normal admission/);
 await assert.rejects(handleRecoveryAbandonment(w,{RecoveryAbandonDecision:{proposal_id:id,revision:2n,decision:'AbandonOnly'}},path,v,()=>12),/matching live normal admission/);assert.equal(count(db),0);
}));
test('custody database must be the same canonical installation',()=>fixture(async(db,path,w,_locks,v)=>{
 await assert.rejects(call(path,{...w,custodyDatabase:dirname(path)},v),/custody database changed/);assert.equal(count(db),0);
}));
test('original actor, application, channel and displayed message are authenticated before lock',()=>fixture(async(db,path,w,locks,v)=>{
 for(const changed of [{userId:8n},{applicationId:8n},{channelId:8n},{sourceMessageId:8n}])await assert.rejects(call(path,{...w,...changed},v),/authenticated delivery/);
 await assert.rejects(call(path,{...w,sourceMessageId:null},v),/source Discord message/);assert.equal(count(db),0);assert.equal(locks.activeTargetCount,0);
}));
test('durable ingress mismatch refuses work and releases shared target lease',()=>fixture(async(db,path,w,locks,v)=>{
 db.exec("UPDATE discord_ingress_journal SET owner_user_id=8 WHERE ingress_id='interaction:6'");await assert.rejects(call(path,w,v),/work differs from original durable ingress/);assert.equal(count(db),0);assert.equal(locks.activeTargetCount,0);
}));
test('two-second lock timeout never releases another owner or leaves a stale waiter',()=>fixture(async(db,path,w,locks,v)=>{
 const owner=await locks.acquire('t');try{await assert.rejects(call(path,w,v),/target is busy/);owner.requireTarget('t');assert.equal(count(db),0);}finally{owner.release();}
 assert.equal(locks.activeTargetCount,0);await call(path,w,v);assert.equal(count(db),1);
}));
test('second authorization detects evidence changed while waiting and applies nothing',()=>fixture(async(db,path,w,locks,v)=>{
 const owner=await locks.acquire('t');let observed!:()=>void;const seen=new Promise<void>(r=>{observed=r;});const pending=call(path,w,v,()=>{observed();return 12;});
 await seen;db.exec("UPDATE codex_turn_queue SET prompt='changed'");owner.release();await assert.rejects(pending,/exact evidence changed/);assert.equal(count(db),0);assert.equal(locks.activeTargetCount,0);
}));
test('cloned admission pins drain until target-locked disposition and all awaited work finish',()=>fixture(async(db,path,w,locks,v,gate)=>{
 const owner=await locks.acquire('t');let observed!:()=>void;const seen=new Promise<void>(r=>{observed=r;});const pending=call(path,w,v,()=>{observed();return 12;});await seen;
 const key=DrainFenceKey.create('app','1|2','test');gate.seal(key);w.admissionPermit!.release();assert.equal(gate.isDrainedFor(key),false);owner.release();await pending;
 assert.equal(gate.isDrainedFor(key),true);assert.equal(count(db),1);assert.equal(locks.activeTargetCount,0);
}));
test('concurrent duplicate clicks serialize to one durable disposition',()=>fixture(async(db,path,w,locks,v)=>{
 const results=await Promise.all([call(path,w,v),call(path,w,v)]);assert.deepEqual(results[0],results[1]);assert.equal(count(db),1);assert.equal(count(db,'codex_request_cancellations'),1);assert.equal(locks.activeTargetCount,0);
}));
test('store failure releases lease without minting successful confirmation',()=>fixture(async(db,path,w,locks,v)=>{
 db.exec("CREATE TRIGGER sabotage_decision BEFORE INSERT ON cdr_recovery_abandonment_decisions BEGIN SELECT RAISE(IGNORE); END");
 await assert.rejects(call(path,w,v),/decision insert was ignored/);assert.equal(count(db),0);assert.equal(count(db,'codex_turn_queue'),1);assert.equal(locks.activeTargetCount,0);
}));
