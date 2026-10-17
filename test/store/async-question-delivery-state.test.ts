import assert from "node:assert/strict";
import {test} from "node:test";
import {storeFixture} from "../helpers/store-fixture.ts";
import {queueJob} from "../helpers/queue-job.ts";
import {usingInitializedStore} from "../../src/store/owned-scope.ts";
import {StateAccessFacade as state} from "../../src/store/state-access-facade.ts";
import {asyncQuestionReceiptKey} from "../../src/store/async-question-delivery-state.ts";
async function seed(path:string,owned=true){
  if(owned){await state.enqueue(path,queueJob({ownerUserId:2n}));const c=(await state.tryBeginAttempt(path,"saved",[],1n))!;await state.markRunningIfClaimed(path,c,"turn");}
  await usingInitializedStore(path,db=>{db.prepare("INSERT INTO cdr_async_questions(id,runtime_id,generation,thread_id,turn_id,item_id,origin_job_id,channel_id,owner_user_id,body,created_at,updated_at) VALUES('q','runtime',1,'target','turn','item','saved',1,2,?,0,0)").run('{"index":0,"title":"title","options":["yes"]}');});
}
const exec=(path:string,sql:string)=>usingInitializedStore(path,db=>{db.exec(sql);});
async function receipt(path:string,message:string|null){await usingInitializedStore(path,db=>{db.prepare('INSERT INTO codex_delivery_receipts(receipt_key,content_hash,message_id) VALUES(?,?,?)').run('[1,"async-question-v1","q",0]','hash',message);});}
test("question ownership latches exact original running turn and remains valid after job removal",async()=>storeFixture(async path=>{
 await seed(path);assert.equal(await state.confirmAsyncQuestionOwner(path,'q'),true);await exec(path,'DELETE FROM codex_turn_queue');assert.equal(await state.confirmAsyncQuestionOwner(path,'q'),true);
}));
test("already confirmed ownership skips malformed body while ordinary read still rejects it",async()=>storeFixture(async path=>{
 await seed(path,false);await exec(path,"UPDATE cdr_async_questions SET owner_confirmed=1,body='bad'");assert.equal(await state.confirmAsyncQuestionOwner(path,'q'),true);await assert.rejects(state.getAsyncQuestion(path,'q'),SyntaxError);
}));
test("absent or mismatched execution ownership cannot be inferred from a question",async()=>{
 for(const sql of ["DELETE FROM codex_turn_queue","UPDATE codex_turn_queue SET goal_waiting=1","UPDATE codex_turn_queue SET owner_user_id=3","UPDATE codex_turn_queue SET channel_id=3","UPDATE codex_turn_queue SET turn_id='other'","UPDATE codex_turn_queue SET turn_observation_generation=2","UPDATE codex_turn_queue SET turn_id='cdr-quarantined:turn',last_error='[cdr-rust:app-server-fork-quarantine:v1] ';UPDATE cdr_async_questions SET turn_id='cdr-quarantined:turn'"]){await storeFixture(async path=>{await seed(path);await exec(path,sql);assert.equal(await state.confirmAsyncQuestionOwner(path,'q'),false);});}
});
test("duplicate nonpending owner prevents latch and current observation generation takes precedence",async()=>storeFixture(async path=>{
 await seed(path);await exec(path,"INSERT INTO codex_turn_queue(job_id,target_thread_id,channel_id,prompt,queued,ack_sent,state,attempt_count,baseline_turn_ids,created_at,updated_at,app_server_generation) VALUES('other','target',1,'p',1,1,'quarantined',0,'[]',0,0,1)");assert.equal(await state.confirmAsyncQuestionOwner(path,'q'),false);
 await exec(path,"DELETE FROM codex_turn_queue WHERE job_id='other';UPDATE codex_turn_queue SET app_server_generation=2,turn_observation_generation=1");assert.equal(await state.confirmAsyncQuestionOwner(path,'q'),true);
}));
test("receipt binding requires original owner and a nonnull durable HTTP receipt",async()=>storeFixture(async path=>{
 await seed(path);await assert.rejects(state.bindAsyncQuestionReceipt(path,'q',true),/message receipt is not confirmed/);await receipt(path,null);await assert.rejects(state.bindAsyncQuestionReceipt(path,'q',true),/message receipt is not confirmed/);
 await exec(path,"UPDATE codex_delivery_receipts SET message_id='000123'");await state.bindAsyncQuestionReceipt(path,'q',true);const q=await state.getAsyncQuestion(path,'q');assert.equal(q.state,'open');assert.equal(q.messageId,'000123');assert.equal(asyncQuestionReceiptKey(q),'[1,"async-question-v1","q",0]');
}));
test("unowned question cannot bind even when a receipt exists; unsupported and terminal states stay exact",async()=>storeFixture(async path=>{
 await seed(path,false);await receipt(path,'m');await assert.rejects(state.bindAsyncQuestionReceipt(path,'q',false),/ownership is not confirmed/);
 await exec(path,"UPDATE cdr_async_questions SET owner_confirmed=1");await state.bindAsyncQuestionReceipt(path,'q',false);assert.equal((await state.getAsyncQuestion(path,'q')).state,'unsupported');
 await exec(path,"UPDATE codex_delivery_receipts SET message_id='other'");await state.bindAsyncQuestionReceipt(path,'q',true);const q=await state.getAsyncQuestion(path,'q');assert.equal(q.state,'unsupported');assert.equal(q.messageId,'m');
}));
test("pending list uses original runtime/state then created_at, index, id with a 100-row bound",async()=>storeFixture(async path=>{
 await seed(path,false);await exec(path,"DELETE FROM cdr_async_questions");await usingInitializedStore(path,db=>{const insert=db.prepare("INSERT INTO cdr_async_questions(id,runtime_id,generation,thread_id,turn_id,item_id,origin_job_id,channel_id,owner_user_id,body,created_at,updated_at) VALUES(?,'runtime',1,'target','turn',?,'saved',1,2,?,0,0)");for(let i=105;i>=0;i--)insert.run('q'+i,'i'+i,JSON.stringify({index:i,title:'t',options:[]}));});
 const q=await state.pendingAsyncQuestions(path,'runtime');assert.equal(q.length,100);assert.equal(q[0]!.body.index,0n);assert.equal(q[99]!.body.index,99n);assert.deepEqual(await state.pendingAsyncQuestions(path,'other'),[]);
}));
test("mapping validation rejects unmapped/changed channel and active target fences",async()=>storeFixture(async path=>{
 await seed(path);const q=await state.getAsyncQuestion(path,'q');await assert.rejects(state.requireCurrentAsyncQuestionMapping(path,q),/mapping changed/);
 await usingInitializedStore(path,db=>{db.exec("INSERT INTO mirror_threads(codex_thread_id,project_key,thread_title,discord_channel_id,discord_thread_id,updated_at) VALUES('target','project','title',10,1,0)");});await state.requireCurrentAsyncQuestionMapping(path,q);
 await exec(path,"INSERT INTO codex_archive_fences(target_thread_id,operation_id,phase) VALUES('target','archive','attempted')");await assert.rejects(state.requireCurrentAsyncQuestionMapping(path,q),/target is fenced/);
}));
test("missing question and malformed durable queue state remain typed failures",async()=>storeFixture(async path=>{await seed(path);await exec(path,"UPDATE codex_turn_queue SET state='quarantined'");await assert.rejects(state.confirmAsyncQuestionOwner(path,'q'),/invalid durable queue state/);await assert.rejects(state.confirmAsyncQuestionOwner(path,'missing'),/row not found/);await assert.rejects(state.getAsyncQuestion(path,'missing'),/row not found/);}));
