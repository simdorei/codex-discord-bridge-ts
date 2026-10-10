import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {DatabaseSync} from 'node:sqlite';
import {abandonmentStoreFixture} from '../../helpers/abandonment-store-fixture.ts';
import {work} from '../../helpers/interaction-worker-fixture.ts';
import {AdmissionGate} from '../../../src/admission/drain-gate.ts';
import {proposeAbandonment,bindAbandonmentDelivery} from '../../../src/store/abandonment-proposal.ts';
import {proposePublication,bindPublicationDelivery} from '../../../src/store/publication-proposal.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {stageOrdinaryInteraction as stage,type OrdinaryInteractionStageRequest as Request} from '../../../src/runtime/discord-dispatch/stage-ordinary.ts';
const id='a'.repeat(32),job='550e8400-e29b-41d4-a716-446655440000';
const options={settingsResolver:null,cleanup:{now:()=>12,report:()=>{}}};
async function fixture(kind:'abandonment'|'publication',run:(db:DatabaseSync,path:string,request:Request)=>Promise<void>){
 await abandonmentStoreFixture(async(db,path)=>{
  if(kind==='abandonment'){
   const p=proposeAbandonment(path,{proposal_id:id,job_id:job,ingress_id:'message:5',application_id:4n,now:10,expires_at:20});bindAbandonmentDelivery(path,id,9n,p.review_sha256,11);
  }else{
   const p=await proposePublication(path,{proposal_id:id,job_id:job,application_id:4n,review_text:'review',review_context:{},now:10,expires_at:20});await bindPublicationDelivery(path,id,9n,p.review_sha256,11);
  }
  const w=work(path,6n,new AdmissionGate(),`${kind==='abandonment'?'codex_discard':'codex_pub'}:v1:${id}:1:a`);
  try{await run(db,path,w);}finally{w.admissionPermit!.release();}
 },true,job);
}
for(const kind of ['abandonment','publication'] as const){
 test(`${kind} pre-ACK stage binds exact delivered thread and persists token-free normal payload`,()=>fixture(kind,async(db,path,req)=>{
  const result=await stage(path,req,options);assert.equal(result.kind,'Created');if(result.kind!=='Created')throw Error('fixture');
  try{
   const row=(await state.getIngress(path,'interaction:6'))!;assert.equal(row.state,'staged');assert.equal(row.targetThreadId,'t');assert.equal(row.applicationId,4n);assert.equal(row.sourceMessageId,9n);
   assert.deepEqual(row.payload,{version:1n,processing_mode:'normal',work:req.work,settings_binding:null,request_rejection:null});
   assert.equal(db.prepare('SELECT count(*) n FROM cdr_recovery_abandonment_decisions').get()!.n,0);assert.equal(db.prepare('SELECT count(*) n FROM cdr_recovery_publication_decisions').get()!.n,0);
   await result.custody.acknowledge();result.custody.intoReceipt();assert.equal((await state.getIngress(path,'interaction:6'))!.state,'acknowledged');
   assert.deepEqual(await stage(path,req,options),{kind:'Duplicate'});
  }finally{await result.custody.dispose();}
 }));
 test(`${kind} wrong actor, application, channel and source refuse before persistence`,()=>fixture(kind,async(_db,path,req)=>{
  for(const change of [{userId:8n},{applicationId:8n},{channelId:8n},{sourceMessageId:8n}])await assert.rejects(stage(path,{...req,...change},options),/delivery identity/);
  await assert.rejects(stage(path,{...req,sourceMessageId:null},options),new RegExp(kind+' component has no source message'));
  assert.equal(await state.getIngress(path,'interaction:6'),null);
 }));
 test(`${kind} stale delivery revision refuses without ordinary fallback`,()=>fixture(kind,async(db,path,req)=>{
  const stale=work(path,6n,new AdmissionGate(),`${kind==='abandonment'?'codex_discard':'codex_pub'}:v1:${id}:2:a`);
  try{await assert.rejects(stage(path,stale,options),kind==='abandonment'?/displayed proposal identity differs/:/delivered proposal revision or body changed/);}finally{stale.admissionPermit!.release();}
  assert.equal(await state.getIngress(path,'interaction:6'),null);
 }));
 test(`${kind} cleanup of unacknowledged custody leaves a durable held state`,()=>fixture(kind,async(_db,path,req)=>{
  const result=await stage(path,req,options);assert.equal(result.kind,'Created');if(result.kind!=='Created')throw Error('fixture');await result.custody.dispose();
  const row=(await state.getIngress(path,'interaction:6'))!;assert.equal(row.state,'held');
 }));
}
test('abandonment must be fresh before ACK and checks clock before ingress timestamp',()=>fixture('abandonment',async(db,path,req)=>{
 await assert.rejects(stage(path,req,{...options,cleanup:{...options.cleanup,now:()=>21}}),/expired|fresh|time/);assert.equal(await state.getIngress(path,'interaction:6'),null);
 const times=[12,13],result=await stage(path,req,{...options,cleanup:{...options.cleanup,now:()=>times.shift()??14}});assert.equal(result.kind,'Created');if(result.kind!=='Created')throw Error('fixture');
 try{assert.equal((await state.getIngress(path,'interaction:6'))!.createdAt,13);assert.equal(times.length,0);}finally{await result.custody.dispose();}
}));
test('abandonment stale queue evidence cannot acquire custody',()=>fixture('abandonment',async(db,path,req)=>{
 db.exec("UPDATE codex_turn_queue SET prompt='changed'");await assert.rejects(stage(path,req,options),/evidence changed/);assert.equal(await state.getIngress(path,'interaction:6'),null);
}));
test('publication historical delivery routes after expiry without claiming fresh intent',()=>fixture('publication',async(db,path,req)=>{
 const result=await stage(path,req,{...options,cleanup:{...options.cleanup,now:()=>99}});assert.equal(result.kind,'Created');if(result.kind!=='Created')throw Error('fixture');
 try{assert.equal((await state.getIngress(path,'interaction:6'))!.targetThreadId,'t');assert.equal(db.prepare('SELECT count(*) n FROM cdr_recovery_publication_decisions').get()!.n,0);}finally{await result.custody.dispose();}
}));
