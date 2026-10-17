import assert from "node:assert/strict";
import {test} from "node:test";
import {parseAsyncQuestions,isAsyncAgentMessage} from "../../src/app-server/async-questions.ts";
import {extractCompletedFinalAnswer} from "../../src/app-server/outcomes.ts";
import {observeAsyncQuestionNotification,preparePendingAsyncQuestions} from "../../src/runtime/async-question-observation.ts";
import {StateAccessFacade as state} from "../../src/store/state-access-facade.ts";
import {usingInitializedStore} from "../../src/store/owned-scope.ts";
import {storeFixture} from "../helpers/store-fixture.ts";
import {queueJob} from "../helpers/queue-job.ts";
const event=(questions:unknown=[{title:"question",options:["yes","no"]}])=>({threadId:"target",turnId:"turn",item:{id:"item",type:"agentMessage",delivery:"async",phase:"final_answer",text:"context",questions}});
async function seed(path:string){await state.enqueue(path,queueJob({ownerUserId:2n}));const c=(await state.tryBeginAttempt(path,"saved",[],1n))!;await state.markRunningIfClaimed(path,c,"turn");}
test("valid async bodies retain original identities, duplicate labels and immutable question positions",()=>{
 const input=event([{title:"A",options:["yes"]},{title:"B",options:["yes"]}]),q=parseAsyncQuestions(input)!;assert.equal(q.threadId,'target');assert.equal(q.itemId,'item');assert.equal(q.questions.length,2);assert.equal(q.questions[1]!.title,'B');assert.equal(Object.isFrozen(q.questions[0]!.options),true);assert.equal(extractCompletedFinalAnswer(input),null);
});
test("null/missing options mean free text; derived sequence and unknown fields preserve valid body",()=>{
 const q=parseAsyncQuestions(event([{title:"a"},{title:"b",options:null},["c",["yes"]],{title:"d",options:[],ignored:{x:1n}}]))!;assert.deepEqual(q.questions.map(q=>[q.title,[...q.options]]),[['a',[]],['b',[]],['c',['yes']],['d',[]]]);
});
test("malformed choice vector retains all producer text/metadata and never becomes final",()=>{
 for(const value of ["wrong",[{title:"a",options:[{label:"yes"}]}],[{title:"good",options:[]},{bad:"missing title"}],[["a",[],"excess"]]]){
 const input=event(value),parsed=parseAsyncQuestions(input)!;assert.deepEqual(parsed.questions,[]);assert.match(parsed.text,/context\n질문 형식 오류:/);assert.match(parsed.text,/원문 질문 데이터:/);assert.equal(isAsyncAgentMessage(input.item),true);assert.equal(extractCompletedFinalAnswer(input),null);
 }
});
test("unsupported renderability does not change classification or erase 26 options",()=>{
 const parsed=parseAsyncQuestions(event([{title:"many",options:Array.from({length:26},(_,i)=>String(i))}]))!;assert.equal(parsed.questions[0]!.options.length,26);
});
test("identity requires nonblank Rust whitespace but retains original untrimmed strings and BOM",()=>{
 const input=event();input.threadId=' target ';assert.equal(parseAsyncQuestions(input)!.threadId,' target ');input.threadId='\ufeff';assert.equal(parseAsyncQuestions(input)!.threadId,'\ufeff');input.threadId='\u0085';assert.throws(()=>parseAsyncQuestions(input),/missing threadId/);
 const turn=event();turn.turnId=' ';assert.throws(()=>parseAsyncQuestions(turn),/missing turnId/);const item=event();item.item.id='';assert.throws(()=>parseAsyncQuestions(item),/missing id/);
});
test("nonasync notifications are ignored before generation/clock validation",async()=>{
 const input=event();input.item.delivery='other';let clock=0;assert.equal(parseAsyncQuestions(input),null);await observeAsyncQuestionNotification('unused','runtime',-1n,input,()=>{clock++;return 0;});assert.equal(clock,0);
});
test("forged accessors and proxies are rejected without executing application hooks",()=>{
 let calls=0;const input=event();Object.defineProperty(input.item,'questions',{get(){calls++;throw new Error('hook');}});assert.throws(()=>parseAsyncQuestions(input));assert.equal(calls,0);assert.throws(()=>parseAsyncQuestions(new Proxy({}, {get(){calls++;throw new Error('trap');}})));assert.equal(calls,0);
});
test("live observation records and promotes distinct questions with one clock snapshot",async()=>storeFixture(async path=>{
 await seed(path);let calls=0;await observeAsyncQuestionNotification(path,'runtime',1n,event([{title:'A',options:['yes']},{title:'B',options:['yes']}]),()=>{calls++;return 123;});assert.equal(calls,1);const q=await state.pendingAsyncQuestions(path,'runtime');assert.equal(q.length,2);assert.notEqual(q[0]!.id,q[1]!.id);assert.deepEqual(q.map(q=>q.body.index),[0n,1n]);assert.deepEqual(q.map(q=>q.body.source_text),['context','context']);
}));
test("empty/null question list becomes one retained free-text question with empty source context",async()=>storeFixture(async path=>{
 await seed(path);await observeAsyncQuestionNotification(path,'runtime',1n,event(null),()=>0);const q=(await state.pendingAsyncQuestions(path,'runtime'))[0]!;assert.equal(q.body.title,'context');assert.equal(q.body.source_text,'');assert.deepEqual(q.body.options,[]);
}));
test("oversized later question leaves earlier durable inbox entry but does not promote a partial batch",async()=>storeFixture(async path=>{
 await seed(path);await assert.rejects(observeAsyncQuestionNotification(path,'runtime',1n,event([{title:'valid',options:[]},{title:'x'.repeat(32769),options:[]}]),()=>1),/oversized/);
 await usingInitializedStore(path,db=>{assert.equal(db.prepare('SELECT count(*) AS n FROM cdr_async_question_inbox').get()?.n,1);assert.equal(db.prepare('SELECT count(*) AS n FROM cdr_async_questions').get()?.n,0);});
}));
test("invalid generation rejects before clock or records; current params captured before await",async()=>storeFixture(async path=>{
 await seed(path);let calls=0;await assert.rejects(observeAsyncQuestionNotification(path,'runtime',1n<<63n,event(),()=>{calls++;return 0;}),/invalid question generation/);assert.equal(calls,0);
 const input=event();const pending=observeAsyncQuestionNotification(path,'runtime',1n,input,()=>1);input.item.text='changed';await pending;assert.equal((await state.pendingAsyncQuestions(path,'runtime'))[0]!.body.source_text,'context');
}));
test("prepare order is retire then reconcile then clock/compact and stops on first failure",async()=>{
 const order:string[]=[];const fake={recordAsyncQuestionObservation:async()=>{},reconcileAsyncQuestionObservations:async()=>{order.push('reconcile');return 0n;},retireOldAsyncQuestionOwner:async()=>{order.push('retire');return 0n;},compactTerminalAsyncQuestions:async()=>{order.push('compact');return 0n;}};
 await preparePendingAsyncQuestions('unused','runtime',1n,()=>{order.push('clock');return 1;},fake);assert.deepEqual(order,['retire','reconcile','clock','compact']);order.length=0;const sentinel={fail:true};fake.reconcileAsyncQuestionObservations=async()=>{order.push('reconcile');throw sentinel;};await assert.rejects(preparePendingAsyncQuestions('unused','runtime',1n,()=>{order.push('clock');return 1;},fake),e=>e===sentinel);assert.deepEqual(order,['retire','reconcile']);
});
