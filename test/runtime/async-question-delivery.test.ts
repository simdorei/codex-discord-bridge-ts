import assert from "node:assert/strict";
import {test} from "node:test";
import {storeFixture} from "../helpers/store-fixture.ts";
import {queueJob} from "../helpers/queue-job.ts";
import {usingInitializedStore} from "../../src/store/owned-scope.ts";
import {StateAccessFacade as state} from "../../src/store/state-access-facade.ts";
import {observeAsyncQuestionNotification} from "../../src/runtime/async-question-observation.ts";
import {deliverPendingAsyncQuestions,deliverCheckedAsyncQuestion} from "../../src/runtime/async-question-delivery.ts";
import {DiscordTransportFault} from "../../src/runtime/completion/receipt-sender.ts";
import type {IdempotentMessageRequest} from "../../src/discord/idempotent-message.ts";
const render=()=>"public-safe question delivery failed";
async function seed(path:string,options:string[][]=[['yes'],['yes']]){
 await state.enqueue(path,queueJob({ownerUserId:2n}));const c=(await state.tryBeginAttempt(path,'saved',[],1n))!;await state.markRunningIfClaimed(path,c,'turn');await usingInitializedStore(path,db=>{db.exec("INSERT INTO mirror_threads(codex_thread_id,project_key,thread_title,discord_channel_id,discord_thread_id,updated_at) VALUES('target','p','t',10,1,0)");});
 await observeAsyncQuestionNotification(path,'runtime',1n,{threadId:'target',turnId:'turn',item:{id:'item',type:'agentMessage',delivery:'async',text:'shared context',questions:options.map((options,i)=>({title:'Q'+i,options}))}},()=>1);
}
function transport(log:IdempotentMessageRequest[]){return {sendValidated:async(request:IdempotentMessageRequest)=>{log.push(request);return BigInt(100+log.length);}};}
test("question item context is sent once, each body and controls have distinct receipts and correct message binding",async()=>storeFixture(async path=>{
 await seed(path);const requests:IdempotentMessageRequest[]=[];await deliverPendingAsyncQuestions(path,'runtime',1n,transport(requests),render,()=>2);assert.equal(requests.length,5);const bodies=requests.map(r=>JSON.parse(r.body));assert.equal(bodies.filter(b=>b.content==='shared context').length,1);assert.equal(bodies.filter(b=>b.components).length,2);
 await usingInitializedStore(path,db=>{const rows=db.prepare("SELECT state,message_id FROM cdr_async_questions ORDER BY json_extract(body,'$.index')").all();assert.deepEqual(rows.map(r=>r.state),['open','open']);assert.deepEqual(rows.map(r=>r.message_id),['103','105']);});
 await deliverPendingAsyncQuestions(path,'runtime',1n,transport(requests),render,()=>3);assert.equal(requests.length,5);
}));
test("unrenderable options retain body and a separate unsupported controls receipt",async()=>storeFixture(async path=>{
 await seed(path,[[]]);const requests:IdempotentMessageRequest[]=[];await deliverPendingAsyncQuestions(path,'runtime',1n,transport(requests),render,()=>2);assert.equal(requests.length,3);const last=JSON.parse(requests[2]!.body);assert.match(last.content,/선택 버튼을 만들 수 없습니다/);assert.equal(last.components,undefined);
 await usingInitializedStore(path,db=>{assert.equal(db.prepare('SELECT state FROM cdr_async_questions').get()?.state,'unsupported');});
}));
test("unknown transport outcome is not resent or promoted to an open question",async()=>storeFixture(async path=>{
 await seed(path,[['yes']]);let sends=0;const network={sendValidated:async()=>{sends++;throw new Error('unknown');}};await assert.rejects(deliverPendingAsyncQuestions(path,'runtime',1n,network,render,()=>2),/unconfirmed/);await assert.rejects(deliverPendingAsyncQuestions(path,'runtime',1n,network,render,()=>3),/outcome unknown/);assert.equal(sends,1);
 const q=(await state.pendingAsyncQuestions(path,'runtime'))[0]!;assert.equal(q.state,'observed');assert.equal(q.messageId,null);assert.equal(q.error,'public-safe question delivery failed');
}));
test("mapping change and generation mismatch make zero HTTP calls",async()=>storeFixture(async path=>{
 await seed(path,[['yes']]);const q=(await state.pendingAsyncQuestions(path,'runtime'))[0]!,requests:IdempotentMessageRequest[]=[];await deliverCheckedAsyncQuestion(path,2n,transport(requests),q,render);assert.equal(requests.length,0);
 await usingInitializedStore(path,db=>{db.exec('UPDATE mirror_threads SET discord_thread_id=3');});await assert.rejects(deliverCheckedAsyncQuestion(path,1n,transport(requests),q,render),/mapping changed/);assert.equal(requests.length,0);
}));
test("one question failure retains first error while later question can complete using shared item receipt",async()=>storeFixture(async path=>{
 await seed(path);const requests:IdempotentMessageRequest[]=[];const network={sendValidated:async(request:IdempotentMessageRequest)=>{requests.push(request);const body=JSON.parse(request.body);if(body.content.startsWith('질문 1\n'))throw new DiscordTransportFault('Validation','rejected body');return BigInt(100+requests.length);}};
 await assert.rejects(deliverPendingAsyncQuestions(path,'runtime',1n,network,render,()=>2),/definite rejection/);assert.equal(requests.filter(r=>JSON.parse(r.body).content==='shared context').length,1);
 await usingInitializedStore(path,db=>{assert.deepEqual(db.prepare("SELECT state FROM cdr_async_questions ORDER BY json_extract(body,'$.index')").all().map(r=>r.state),['observed','open']);});
}));
