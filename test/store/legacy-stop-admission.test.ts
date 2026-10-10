import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {storeFixture} from '../helpers/store-fixture.ts';import {queueJob} from '../helpers/queue-job.ts';
import {StateAccessFacade as state} from '../../src/store/state-access-facade.ts';import {openInitialized} from '../../src/store/owned-driver.ts';
import {admitIngress} from '../../src/store/ingress-admission.ts';import {asyncResolutionAdmissionHeld} from '../../src/store/async-resolution-admission.ts';
import {asyncQuestionReceiptKey} from '../../src/store/async-question-delivery-state.ts';import {recordAsyncTerminalNotification} from '../../src/store/async-resolution-terminal.ts';
import {selectJob} from '../../src/store/queue-read.ts';import {serializeSerdeValue as json} from '../../src/core/serde-json.ts';
import {legacyStopSupersededIn} from '../../src/store/async-resolution-legacy-stop.ts';
const STOP='message:39',ORIGIN='message:40',THREAD='thread-b';
async function edit<T>(path:string,run:(db:DatabaseSync)=>T):Promise<T>{const db=await openInitialized(path);try{return run(db);}finally{db.close();}}
async function stop(path:string,command='Stop',extra:Record<string,unknown>={}){await edit(path,db=>{
 db.prepare("INSERT INTO discord_ingress_journal(ingress_id,kind,event_id,source_message_id,channel_id,owner_user_id,payload_json,state,phase,target_thread_id,created_at,updated_at) VALUES(?,'message',39,39,20,30,?,'held','processing',?,1000,1000)").run(STOP,json({version:1n,plan:{Execute:{[command]:{reference:null}}},lifecycle_binding:null,...extra}),THREAD);
 db.prepare("INSERT INTO cdr_recovery_ingress_order(ingress_id,kind,event_id,origin) VALUES(?,'message',39,'legacy')").run(STOP);
});}
async function origin(path:string){await admitIngress(path,{ingressId:ORIGIN,kind:'message',eventId:40n,applicationId:null,channelId:20n,ownerUserId:30n,sourceMessageId:40n,targetThreadId:THREAD,canonicalOwner:null,now:1,payload:{version:1n,plan:{Execute:{Ask:{prompt:'original input'}}}}});}
async function execution(path:string,status:'completed'|'failed'|'interrupted'|null='completed'){
 await edit(path,db=>db.exec("INSERT INTO mirror_threads VALUES('thread-b','project','title',10,20,0)"));
 await state.enqueue(path,queueJob({jobId:'origin',targetThreadId:THREAD,channelId:20n,ownerUserId:30n,discordMessageId:40n,prompt:'original input',queued:false,createdAt:1}));
 const claim=(await state.tryBeginAttempt(path,'origin',[],1n))!;await state.markRunningIfClaimed(path,claim,'original');
 const id=await state.observeAsyncQuestion(path,{runtime_id:'resident',generation:1n,thread_id:THREAD,turn_id:'original',item_id:'question-call',body:{index:0n,source_text:'original context',title:'Continue?',options:['yes','no']},now:2});
 const q=await state.getAsyncQuestion(path,id),key=asyncQuestionReceiptKey(q);await state.beginDeliveryReceipt(path,key,'payload');await state.confirmDeliveryReceipt(path,key,'1234');await state.bindAsyncQuestionReceipt(path,id,true);
 await state.beginAsyncQuestionDispatch(path,{id,runtime_id:'resident',generation:1n,channel:20n,actor:30n,message:'1234',option:0n,mode:'Steer',baseline_turn_ids:[],prompt:'only this answer',now:3});
 await edit(path,db=>db.prepare("UPDATE discord_ingress_journal SET owner_kind='prompt',owner_id='origin',state='owned',phase='result_recorded' WHERE ingress_id=?").run(ORIGIN));
 if(status!==null){await recordAsyncTerminalNotification(path,THREAD,'original',1n,'resident',json({threadId:THREAD,turn:{id:'original',status}}));const owner=await edit(path,db=>selectJob(db,'origin'));await state.stageOwnedQueueCompletion(path,owner,'Final',4,{observer:'resident',generation:1n});}
 return id;
}
const oldRow=(path:string)=>edit(path,db=>db.prepare('SELECT * FROM discord_ingress_journal WHERE ingress_id=?').get(STOP));
test('old unbound Stop stays recorded but does not revive after separate newly admitted normal completion',async()=>storeFixture(async path=>{
 await stop(path);const before=await oldRow(path);assert.equal(await asyncResolutionAdmissionHeld(path,THREAD),false);await origin(path);await execution(path);
 assert.equal(await asyncResolutionAdmissionHeld(path,THREAD),false);assert.deepEqual(await oldRow(path),before);
 await state.enqueue(path,queueJob({jobId:'next',targetThreadId:THREAD,channelId:20n,ownerUserId:30n,createdAt:5}));assert.notEqual(await state.tryBeginAttempt(path,'next',[],1n),null);
}));
test('later stop, Archive and mismatched or missing original custody retain hold',async()=>{
 for(const mode of ['later','archive','active','no_origin','other_owner','other_channel','other_job','other_event','bound','missing_certificate'])await storeFixture(async path=>{
  if(mode==='later')await origin(path);await stop(path,mode==='archive'?'Archive':'Stop');if(mode!=='later')await origin(path);await execution(path,mode==='active'?null:'completed');
  const statements:Record<string,string>={no_origin:"UPDATE discord_ingress_journal SET owner_id=NULL WHERE ingress_id='message:40'",other_owner:"UPDATE discord_ingress_journal SET owner_user_id=31 WHERE ingress_id='message:40'",other_channel:"UPDATE discord_ingress_journal SET channel_id=21 WHERE ingress_id='message:40'",other_job:"UPDATE discord_ingress_journal SET owner_id='different' WHERE ingress_id='message:40'",other_event:"UPDATE discord_ingress_journal SET event_id=41,source_message_id=41 WHERE ingress_id='message:40'",bound:"UPDATE discord_ingress_journal SET payload_json=json_set(payload_json,'$.lifecycle_binding',json('{}')) WHERE ingress_id='message:39'",missing_certificate:"UPDATE cdr_async_execution_obligations SET revision=revision+1"};
  if(statements[mode])await edit(path,db=>db.exec(statements[mode]!));const before=await oldRow(path);assert.equal(await asyncResolutionAdmissionHeld(path,THREAD),true,mode);assert.deepEqual(await oldRow(path),before);assert.equal(await asyncResolutionAdmissionHeld(path,'unrelated'),false);
 });
});
test('failed or interrupted certified terminal is not the user-required normal completion',async()=>{
 for(const status of ['failed','interrupted'] as const)await storeFixture(async path=>{await stop(path);await origin(path);await execution(path,status);assert.equal(await edit(path,db=>db.prepare('SELECT count(*) n FROM cdr_async_terminal_settlements').get()?.n),1);assert.equal(await asyncResolutionAdmissionHeld(path,THREAD),true,status);});
});
test('missing or legacy-only input ordering is not proof of a later new request',async()=>{
 for(const legacy of [false,true])await storeFixture(async path=>{await stop(path);await edit(path,db=>{db.prepare("INSERT INTO discord_ingress_journal(ingress_id,kind,event_id,source_message_id,channel_id,owner_user_id,payload_json,state,phase,target_thread_id,created_at,updated_at) VALUES(?,'message',40,40,20,30,'{}','owned','result_recorded',?,1,1)").run(ORIGIN,THREAD);if(legacy)db.prepare("INSERT INTO cdr_recovery_ingress_order(ingress_id,kind,event_id,origin) VALUES(?,'message',40,'legacy')").run(ORIGIN);});await execution(path);assert.equal(await asyncResolutionAdmissionHeld(path,THREAD),true);});
});
test('superseded old Stop never releases individual execution holds or retries old stopped job',async()=>storeFixture(async path=>{
 await stop(path);await origin(path);await execution(path);await state.enqueue(path,queueJob({jobId:'stopped',targetThreadId:THREAD,channelId:20n,ownerUserId:30n,createdAt:5}));
 await edit(path,db=>db.exec("INSERT INTO cdr_execution_holds VALUES('stopped','thread-b','user stopped this request','{}',5)"));const before=await state.listQueueJobs(path);
 assert.equal(await asyncResolutionAdmissionHeld(path,THREAD),false);assert.equal(await state.tryBeginAttempt(path,'stopped',[],1n),null);assert.deepEqual(await state.listQueueJobs(path),before);
 assert.equal(await edit(path,db=>db.prepare("SELECT reason FROM cdr_execution_holds WHERE job_id='stopped'").get()?.reason),'user stopped this request');
}));
test('superseded Stop skips invalid outcome conversion but never bypasses recovery policy',async()=>storeFixture(async path=>{
 await stop(path);await origin(path);await execution(path);await edit(path,db=>db.exec("UPDATE discord_ingress_journal SET outcome_json=CAST(x'80' AS TEXT) WHERE ingress_id='message:39'"));
 assert.equal(await asyncResolutionAdmissionHeld(path,THREAD),false);
 await edit(path,db=>db.prepare("INSERT INTO cdr_async_recovery_policies(thread_id,format_version,policy,proposal_sha256,original_turn_id,origin_job_id,pending_job_id) VALUES(?,1,'publishing_recovery',?,'original','origin','pending')").run(THREAD,"a".repeat(64)));
 assert.equal(await asyncResolutionAdmissionHeld(path,THREAD),true);
}));
test('only exact decoded unbound legacy Stop shape reaches SQL; all explicit bindings retain hold',()=>{
 const db=new DatabaseSync(':memory:');db.close();const valid={version:1n,plan:{Execute:{Stop:{reference:null}}}};
 for(const extra of [{version:1},{version:2n},{plan:{Execute:{Stop:{reference:'target'}}}},{plan:{Execute:{Stop:{reference:null,extra:true}}}},{plan:{Execute:{Archive:{reference:null}}}},...['lifecycle_binding','stop_origin','work','command'].flatMap(k=>[{[k]:{}},{[k]:false},{[k]:''},{[k]:0n}])])assert.equal(legacyStopSupersededIn(db,THREAD,STOP,{...valid,...extra}),false);
 assert.throws(()=>legacyStopSupersededIn(db,THREAD,STOP,valid),{code:'ERR_INVALID_STATE'});
});
test('missing order table or view never manufactures new-admission proof; incompatible table errors',()=>{
 const db=new DatabaseSync(':memory:'),payload={version:1n,plan:{Execute:{Stop:{reference:null}}}};
 try{assert.equal(legacyStopSupersededIn(db,THREAD,STOP,payload),false);db.exec('CREATE VIEW cdr_recovery_ingress_order AS SELECT 1');assert.equal(legacyStopSupersededIn(db,THREAD,STOP,payload),false);db.exec('DROP VIEW cdr_recovery_ingress_order;CREATE TABLE cdr_recovery_ingress_order(x)');assert.throws(()=>legacyStopSupersededIn(db,THREAD,STOP,payload));}finally{db.close();}
});
