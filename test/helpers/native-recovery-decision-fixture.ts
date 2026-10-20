import assert from 'node:assert/strict';
import type {DatabaseSync} from 'node:sqlite';
import {abandonmentStoreFixture} from './abandonment-store-fixture.ts';
import {work,httpFixture} from './interaction-worker-fixture.ts';
import {AdmissionGate} from '../../src/admission/drain-gate.ts';
import {TargetLocks} from '../../src/core/keyed-locks.ts';
import {ControlTurnVerifier} from '../../src/runtime/action-executor/control-turn.ts';
import {NativeRecoveryDecisionOwner} from '../../src/runtime/component-worker/recovery-decision-native.ts';
import {handleRecoveryAbandonment} from '../../src/runtime/component-worker/recovery-abandonment.ts';
import {handleRecoveryPublication} from '../../src/runtime/component-worker/recovery-publication.ts';
import {createOrdinaryComponentHandler} from '../../src/runtime/component-worker/ordinary-handler.ts';
import {proposeAbandonment,bindAbandonmentDelivery} from '../../src/store/abandonment-proposal.ts';
import {proposePublication,bindPublicationDelivery} from '../../src/store/publication-proposal.ts';
import {serializeSerdeValue} from '../../src/core/serde-json.ts';
export const proposalId='d'.repeat(32),jobId='550e8400-e29b-41d4-a716-446655440000',interactionId=9007199254740993n;
export type Flow='Publication'|'Abandonment';
export async function nativeRecoveryFixture(flow:Flow,choice:'a'|'h',run:(f:any)=>Promise<void>) {
 await abandonmentStoreFixture(async(db,path)=>httpFixture(async(http,httpSeen)=>{
  const now=Date.now()/1000;
  if(flow==='Publication'){const p=await proposePublication(path,{proposal_id:proposalId,job_id:jobId,application_id:4n,review_text:'Exact review 😀',review_context:{big:9007199254740993n},now,expires_at:now+120});await bindPublicationDelivery(path,proposalId,9n,p.review_sha256,now);}
  else {const p=proposeAbandonment(path,{proposal_id:proposalId,job_id:jobId,ingress_id:'message:5',application_id:4n,now,expires_at:now+120});bindAbandonmentDelivery(path,proposalId,9n,p.review_sha256,now);}
  const gate=new AdmissionGate(),locks=new TargetLocks(),verifier=new ControlTurnVerifier(path,null,{selectedThreadId:()=>null},locks),owner=new NativeRecoveryDecisionOwner(path),table=`cdr_recovery_${flow==='Publication'?'publication':'abandonment'}_decisions`;
  const click=(event=interactionId,selected=choice)=>work(path,event,gate,`codex_${flow==='Publication'?'pub':'discard'}:v1:${proposalId}:1:${selected}`);
  const insert=(w:ReturnType<typeof work>)=>db.prepare(`INSERT INTO discord_ingress_journal(ingress_id,kind,event_id,application_id,channel_id,owner_user_id,source_message_id,payload_json,runtime_id,state,phase,target_thread_id,created_at,updated_at) VALUES(?,'interaction',?,4,1,2,9,?,'app','executing','processing','t',?,?)`).run(w.custodyIngressId,w.interactionId,serializeSerdeValue({version:1n,work:w.work}),now,now);
  const w=click();insert(w);
  const call=async(input=w,clock=()=>now,selectedOwner=owner)=>{assert.ok('Component'in input.work);return flow==='Publication'?handleRecoveryPublication(input,input.work.Component,path,verifier,clock,selectedOwner):handleRecoveryAbandonment(input,input.work.Component,path,verifier,clock,selectedOwner);};
  const prepare=createOrdinaryComponentHandler(path,null as never,http,null as never,verifier,()=>assert.fail('no queue notification'),undefined,true,undefined,undefined,undefined,undefined,owner);
  const count=(name=table)=>db.prepare(`SELECT count(*) AS n FROM ${name}`).get()!.n;
  try{await run({db,path,http,httpSeen,now,gate,locks,verifier,owner,click,insert,w,call,prepare,count,table});}finally{await owner.close();w.admissionPermit!.release();assert.equal(locks.activeTargetCount,0);}
 }),true,jobId);
}
