import assert from 'node:assert/strict';
import {test} from 'node:test';
import {abandonmentStoreFixture} from '../../helpers/abandonment-store-fixture.ts';
import {work,httpFixture,enqueue} from '../../helpers/interaction-worker-fixture.ts';
import {AdmissionGate,DrainFenceKey} from '../../../src/admission/drain-gate.ts';
import {proposeAbandonment,bindAbandonmentDelivery} from '../../../src/store/abandonment-proposal.ts';
import {proposePublication,bindPublicationDelivery} from '../../../src/store/publication-proposal.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {stageOrdinaryInteraction} from '../../../src/runtime/discord-dispatch/stage-ordinary.ts';
import {createOrdinaryComponentHandler} from '../../../src/runtime/component-worker/ordinary-handler.ts';
import {createInteractionProcessor} from '../../../src/runtime/interaction-worker/processor.ts';
import {runInteractionWorker} from '../../../src/runtime/interaction-worker/worker.ts';
import {createInteractionWorkQueue} from '../../../src/runtime/discord-dispatch/interaction-work.ts';
import {ControlTurnVerifier} from '../../../src/runtime/action-executor/control-turn.ts';
import {TargetLocks} from '../../../src/core/keyed-locks.ts';
const id='a'.repeat(32),job='550e8400-e29b-41d4-a716-446655440000';
for(const kind of ['abandonment','publication'] as const)for(const choice of ['a','h']){
 test(`${kind}/${choice}: actual custody, worker, dedicated sink and confirmation complete without native execution`,()=>abandonmentStoreFixture(async(db,path)=>httpFixture(async(http,seen)=>{
  const at=Date.now()/1000;
  if(kind==='abandonment'){
   const p=proposeAbandonment(path,{proposal_id:id,job_id:job,ingress_id:'message:5',application_id:4n,now:at,expires_at:at+600});bindAbandonmentDelivery(path,id,9n,p.review_sha256,at);
  }else{
   const p=await proposePublication(path,{proposal_id:id,job_id:job,application_id:4n,review_text:'review',review_context:{},now:at,expires_at:at+600});await bindPublicationDelivery(path,id,9n,p.review_sha256,at);
  }
  const gate=new AdmissionGate(),w=work(path,6n,gate,`${kind==='abandonment'?'codex_discard':'codex_pub'}:v1:${id}:1:${choice}`);
  const staged=await stageOrdinaryInteraction(path,w,{settingsResolver:null,cleanup:{report(){throw Error('unexpected custody cleanup error');}}});
  assert.equal(staged.kind,'Created');if(staged.kind!=='Created')throw Error('fixture');
  try{await staged.custody.acknowledge();staged.custody.intoReceipt();}finally{await staged.custody.dispose();}
  const locks=new TargetLocks(),verifier=new ControlTurnVerifier(path,null,{selectedThreadId:()=>null},locks),q=createInteractionWorkQueue();
  const handler=createOrdinaryComponentHandler(path,null as any,http,null as any,verifier,()=>{throw Error('native delivery notification forbidden');});
  const process=createInteractionProcessor(path,null as any,http,{async executeWithIngressContext(){throw Error('native action forbidden');},prepareComponent:handler});
  enqueue(q,w);q.sender.dispose();const fence=DrainFenceKey.create('app','1|2','test');gate.seal(fence);const logs:string[]=[];let notified=0;
  await runInteractionWorker(q,path,http,{process,notifyDeliveryReady(){notified++;},report(code,detail){logs.push(code+':'+detail);}});
  assert.deepEqual(logs,[]);assert.deepEqual(seen,['POST','PATCH']);assert.equal(notified,1);assert.equal(gate.isDrainedFor(fence),true);assert.equal(locks.activeTargetCount,0);
  const ingress=(await state.getIngress(path,w.custodyIngressId))!;assert.equal(ingress.state,'completed');assert.equal(ingress.confirmationDelivered,true);
  assert.equal(db.prepare(`SELECT count(*) n FROM cdr_recovery_${kind}_decisions`).get()!.n,1);
  assert.equal(db.prepare('SELECT count(*) n FROM codex_turn_queue').get()!.n,kind==='abandonment'&&choice==='a'?0:1);
  assert.equal(db.prepare('SELECT count(*) n FROM cdr_async_recovery_policies').get()!.n,1);
 }),true,job));
}
