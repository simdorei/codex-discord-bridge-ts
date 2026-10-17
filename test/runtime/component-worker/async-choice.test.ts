import assert from 'node:assert/strict';
import {test} from 'node:test';
import {handleAsyncChoice} from '../../../src/runtime/component-worker/async-choice.ts';
import {componentWorkerErrorInfo} from '../../../src/runtime/component-worker/errors.ts';
import {isConfirmationPlan} from '../../../src/runtime/component-worker/confirmation.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {usingInitializedStore} from '../../../src/store/owned-scope.ts';
import {selectJob} from '../../../src/store/queue-read.ts';
import {ControlTurnVerifier} from '../../../src/runtime/action-executor/control-turn.ts';
import {TargetLocks} from '../../../src/core/keyed-locks.ts';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {queueJob} from '../../helpers/queue-job.ts';
import {asyncChoiceServer, type Config} from '../../helpers/async-choice-server.ts';
const work = {sourceMessageId:9n,channelId:1n,userId:2n,processingMode:'Execute' as const};
const kind=(k:string)=>(e:unknown)=>componentWorkerErrorInfo(e)?.kind===k;
async function fixture(config:Config,run:(f:{db:string;server:Parameters<typeof handleAsyncChoice>[4];verifier:ControlTurnVerifier;locks:TargetLocks;seen:()=>Promise<any[]>})=>Promise<void>){
 await storeFixture(async db=>asyncChoiceServer(config,async(server,_q,seen)=>{
  if(config.active==='v'){await state.enqueue(db,queueJob({jobId:'job',targetThreadId:'t',channelId:1n,ownerUserId:2n}));await usingInitializedStore(db,h=>h.exec("UPDATE codex_turn_queue SET state='running',turn_id='v' WHERE job_id='job'"));}
  await usingInitializedStore(db,h=>{h.exec("INSERT INTO mirror_threads VALUES('t','p','T',10,1,0)");h.prepare("INSERT INTO cdr_async_questions(id,runtime_id,generation,thread_id,turn_id,item_id,origin_job_id,channel_id,owner_user_id,body,state,message_id,owner_confirmed,created_at,updated_at) VALUES('q',?,1,'t','v','item','job',1,2,?,'open','9',1,0,0)").run(server.instanceId,'{"index":0,"source_text":"context","title":"Choose","options":["yes","no"]}');});
  const locks=new TargetLocks(),verifier=new ControlTurnVerifier(db,server,{selectedThreadId:()=>null},locks);await run({db,server,verifier,locks,seen});assert.equal(locks.activeTargetCount,0);
 }));
}
const mutations=(seen:any[])=>seen.filter(r=>r.method==='turn/steer'||r.method==='turn/start');
test('active original question claims once, sends exact selected answer and returns owned confirmation',async()=>fixture({active:'v'},async f=>{
 let notified=0;const plan=await handleAsyncChoice(work,'q',1n,f.db,f.server,f.verifier,()=>{notified++;},()=>10);
 assert.ok(isConfirmationPlan(plan));assert.equal(plan.domain,'async-question-confirmation-v1');assert.equal(plan.logicalKey,'q');assert.equal(notified,1);
 const sent=mutations(await f.seen());assert.equal(sent.length,1);assert.equal(sent[0].method,'turn/steer');assert.equal(sent[0].params.expectedTurnId,'v');
 const answer=JSON.parse(sent[0].params.input[0].text.split('\n')[1]);assert.deepEqual(answer,{original_turn_id:'v',question_index:0,question_item_id:'item',question_title:'Choose',selected_option:'no',selected_option_index:1,thread_id:'t'});
 assert.equal((await state.getAsyncQuestion(f.db,'q')).state,'submitted');assert.equal((await state.getAsyncQuestion(f.db,'q')).chosen,1n);
}));
test('submitted same option returns confirmation only, different option is AlreadyHandled without RPC',async()=>fixture({active:'v'},async f=>{
 const plan=await handleAsyncChoice(work,'q',0n,f.db,f.server,f.verifier,()=>{},()=>10);const repeat=await handleAsyncChoice({...work,processingMode:'ConfirmationOnly'},'q',0n,f.db,f.server,f.verifier,()=>{throw Error('no notify repeat');},()=>11);assert.deepEqual(repeat,plan);
 await assert.rejects(handleAsyncChoice(work,'q',1n,f.db,f.server,f.verifier,()=>{}),kind('AlreadyHandled'));assert.equal(mutations(await f.seen()).length,1);
}));
test('completed original question reserves Start baseline, confirms distinct new turn and promotes its quarantined job',async()=>fixture({},async f=>{
 await handleAsyncChoice(work,'q',0n,f.db,f.server,f.verifier,()=>{},()=>10);const sent=await f.seen();assert.deepEqual(sent.map(r=>r.method),['thread/turns/list','thread/goal/get','thread/read','thread/turns/list','thread/goal/get','thread/read','turn/start']);
 const q=await state.getAsyncQuestion(f.db,'q');assert.equal(q.state,'submitted');assert.equal(q.replyJobId,'async-question:q');const job=await usingInitializedStore(f.db,db=>selectJob(db,q.replyJobId!));assert.equal(job.turnId,'next');assert.equal(job.state,'Running');assert.deepEqual(job.baselineTurnIds,['old','v']);
}));
test('actor, source message and option mismatch never read server history or claim',async()=>fixture({},async f=>{
 for(const changed of [{...work,userId:3n},{...work,channelId:3n},{...work,sourceMessageId:8n}])await assert.rejects(handleAsyncChoice(changed,'q',0n,f.db,f.server,f.verifier,()=>{}),kind('AsyncQuestion'));
 await assert.rejects(handleAsyncChoice({...work,sourceMessageId:null},'q',0n,f.db,f.server,f.verifier,()=>{}),kind('MissingSourceMessage'));
 await assert.rejects(handleAsyncChoice(work,'q',2n,f.db,f.server,f.verifier,()=>{}),kind('AsyncQuestion'));assert.deepEqual(await f.seen(),[]);assert.equal((await state.getAsyncQuestion(f.db,'q')).state,'open');
}));
test('ConfirmationOnly refuses unsubmitted choice and a changed mapping blocks even display recovery',async()=>fixture({active:'v'},async f=>{
 await assert.rejects(handleAsyncChoice({...work,processingMode:'ConfirmationOnly'},'q',0n,f.db,f.server,f.verifier,()=>{}),kind('ActionUnconfirmed'));
 await handleAsyncChoice(work,'q',0n,f.db,f.server,f.verifier,()=>{},()=>10);await usingInitializedStore(f.db,db=>db.exec("UPDATE mirror_threads SET codex_thread_id='other'"));
 await assert.rejects(handleAsyncChoice(work,'q',0n,f.db,f.server,f.verifier,()=>{}),kind('Store'));assert.equal(mutations(await f.seen()).length,1);
}));
test('changed second preflight rejects durable claim and removes reserved Start job before any mutation',async()=>fixture({changeSecondList:true},async f=>{
 await assert.rejects(handleAsyncChoice(work,'q',0n,f.db,f.server,f.verifier,()=>{},()=>10),kind('AsyncQuestion'));assert.equal((await state.getAsyncQuestion(f.db,'q')).state,'rejected');assert.equal(mutations(await f.seen()).length,0);
 const count=await usingInitializedStore(f.db,db=>db.prepare('SELECT count(*) AS n FROM codex_turn_queue').get()!.n);assert.equal(count,0);
}));
test('native remote/usage rejection is definite and cleans the Start reservation without Reserve',async()=>{
 for(const dispatch of ['remote','usage'] as const)await fixture({dispatch},async f=>{await assert.rejects(handleAsyncChoice(work,'q',0n,f.db,f.server,f.verifier,()=>{},()=>10),kind('AppServer'));assert.equal((await state.getAsyncQuestion(f.db,'q')).state,'rejected');assert.equal(mutations(await f.seen()).length,1);assert.equal(await usingInitializedStore(f.db,db=>db.prepare('SELECT count(*) AS n FROM codex_turn_queue').get()!.n),0);});
});
test('missing accepted identity remains dispatching, holds reserved job and never retries',async()=>fixture({dispatch:'missing'},async f=>{
 await assert.rejects(handleAsyncChoice(work,'q',0n,f.db,f.server,f.verifier,()=>{},()=>10),kind('ActionOutcomeIndeterminate'));const q=await state.getAsyncQuestion(f.db,'q');assert.equal(q.state,'dispatching');assert.match(q.error,/omitted accepted turn identity/);assert.equal((await usingInitializedStore(f.db,db=>selectJob(db,q.replyJobId!))).state,'Quarantined');
 await assert.rejects(handleAsyncChoice(work,'q',0n,f.db,f.server,f.verifier,()=>{}),kind('AsyncQuestion'));assert.equal(mutations(await f.seen()).length,1);
}));
test('accepted wrong identity cannot confirm; original sealed dispatch stays held',async()=>fixture({active:'v',dispatch:'wrong'},async f=>{
 await assert.rejects(handleAsyncChoice(work,'q',0n,f.db,f.server,f.verifier,()=>{},()=>10),kind('Store'));assert.equal((await state.getAsyncQuestion(f.db,'q')).state,'dispatching');assert.equal(mutations(await f.seen()).length,1);
}));
test('native transport loss after mutation attempt remains unknown and prevents automatic repeat',async()=>fixture({dispatch:'close'},async f=>{
 await assert.rejects(handleAsyncChoice(work,'q',0n,f.db,f.server,f.verifier,()=>{},()=>10),kind('AppServer'));const q=await state.getAsyncQuestion(f.db,'q');assert.equal(q.state,'dispatching');assert.notEqual(q.error,'');
 await assert.rejects(handleAsyncChoice(work,'q',0n,f.db,f.server,f.verifier,()=>{}),kind('AsyncQuestion'));
}));
test('concurrent clicks on one question share target lock and emit one native answer',async()=>fixture({active:'v'},async f=>{
 let notices=0;const run=()=>handleAsyncChoice(work,'q',0n,f.db,f.server,f.verifier,()=>{notices++;},()=>10);
 const [a,b]=await Promise.all([run(),run()]);assert.deepEqual(a,b);assert.equal(notices,1);assert.equal(mutations(await f.seen()).length,1);assert.equal((await state.getAsyncQuestion(f.db,'q')).state,'submitted');
}));
