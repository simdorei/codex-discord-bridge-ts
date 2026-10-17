import assert from "node:assert/strict";
import {test} from "node:test";
import {storeFixture} from "../helpers/store-fixture.ts";
import {queueJob} from "../helpers/queue-job.ts";
import {StateAccessFacade as state} from "../../src/store/state-access-facade.ts";
import {usingInitializedStore} from "../../src/store/owned-scope.ts";
import {CompletionSourceCertifier} from "../../src/runtime/completion/source-certifier.ts";
import type {AppNotification} from "../../src/app-server/notification-state.ts";
const owner='11111111-1111-4111-8111-111111111111' as const,scope={ownerId:owner,generation:1n};
const server={instanceId:owner,generation:()=>1n};
const event=(method:string,params:unknown):AppNotification=>({method,params});
const final=event('item/completed',{threadId:'target',turnId:'turn',item:{type:'agentMessage',phase:'final_answer',text:'exact final'}});
const terminal=event('turn/completed',{threadId:'target',turn:{id:'turn',status:'completed'}});
async function setup(path:string,running=true){await state.activateObservation(path,scope);await state.discoverObservation(path,scope,1n);if(running){await state.enqueue(path,queueJob({ownerUserId:2n}));const c=(await state.tryBeginAttempt(path,'saved',[],1n))!;await state.markRunningIfClaimed(path,c,'turn');}}
const proved=(path:string)=>state.observationScopeVerified(path,scope,1n);
test("live final is journaled before exact source proof; unknown original ownership does not certify",async()=>{
 for(const running of [true,false])await storeFixture(async path=>{await setup(path,running);await new CompletionSourceCertifier(path,server,false).certifyEvent(scope,1n,final);assert.equal(await proved(path),running);assert.equal(await state.getObservedFinalAnswer(path,'target','turn',1n),running?'exact final':null);});
});
test("terminal metadata is journaled with the exact resident before source proof",async()=>storeFixture(async path=>{
 await setup(path);const c=new CompletionSourceCertifier(path,server,false);await c.certifyEvent(scope,1n,terminal);assert.equal(await proved(path),true);await usingInitializedStore(path,db=>{assert.equal(db.prepare('SELECT resident_owner FROM codex_observed_completions').get()?.resident_owner,owner);});
}));
test("existing conflicting final journal leaves original payload intact and source unconfirmed",async()=>storeFixture(async path=>{
 await setup(path);await state.recordObservedFinalAnswer(path,'target','turn',1n,'different');await new CompletionSourceCertifier(path,server,false).certifyEvent(scope,1n,final);assert.equal(await proved(path),false);assert.equal(await state.getObservedFinalAnswer(path,'target','turn',1n),'different');
}));
test("started identity is proof only with exact running owner; missing identity stays unconfirmed",async()=>{
 for(const [params,expected] of [[{threadId:'target',turnId:'turn'},true],[{threadId:'target'},false],[{threadId:'target',turnId:'other'},false]] as const)await storeFixture(async path=>{await setup(path);await new CompletionSourceCertifier(path,server,false).certifyEvent(scope,1n,event('turn/started',params));assert.equal(await proved(path),expected);});
});
test("commentary and goal updates cannot certify omitted store effects",async()=>{
 for(const [method,enabled,expected] of [['item/delta',true,false],['item/delta',false,true],['item/completed',true,false],['item/completed',false,true],['thread/goal/updated',false,false],['other',true,true]] as const)await storeFixture(async path=>{await setup(path,false);await new CompletionSourceCertifier(path,server,enabled).certifyEvent(scope,1n,event(method,{}));assert.equal(await proved(path),expected);});
});
test("async question source proof uses identical struct bytes for all indexed occurrences",async()=>storeFixture(async path=>{
 await setup(path);await new CompletionSourceCertifier(path,server,false,()=>1).certifyEvent(scope,1n,event('item/completed',{threadId:'target',turnId:'turn',item:{id:'item',type:'agentMessage',delivery:'async',text:'context',questions:[{title:'A',options:['yes']},{title:'B',options:null}]}}));assert.equal(await proved(path),true);const q=await state.pendingAsyncQuestions(path,owner);assert.equal(q.length,2);assert.deepEqual(q.map(v=>v.body.index),[0n,1n]);
}));
test("over-32 question event retains observations but conservatively leaves source unconfirmed",async()=>storeFixture(async path=>{
 await setup(path);await new CompletionSourceCertifier(path,server,false,()=>1).certifyEvent(scope,1n,event('item/completed',{threadId:'target',turnId:'turn',item:{id:'item',type:'agentMessage',delivery:'async',questions:Array.from({length:33},()=>({title:'same',options:[]}))}}));assert.equal(await proved(path),false);assert.equal((await state.pendingAsyncQuestions(path,owner)).length,33);
}));
test("wrong scope is refused before journals; generation change after journaling cannot certify",async()=>storeFixture(async path=>{
 await setup(path);const c=new CompletionSourceCertifier(path,server,false);await assert.rejects(c.certifyEvent({...scope,ownerId:'different'},1n,final),/scope changed/);assert.equal(await state.getObservedFinalAnswer(path,'target','turn',1n),null);
 let reads=0;const changing={instanceId:owner,generation:()=>++reads===1?1n:2n};await assert.rejects(new CompletionSourceCertifier(path,changing,false).certifyEvent(scope,1n,final),/generation changed during journal/);assert.equal(await state.getObservedFinalAnswer(path,'target','turn',1n),'exact final');assert.equal(await proved(path),false);
}));
test("required journal error never advances proof and malformed events never become NoRequiredStore",async()=>storeFixture(async path=>{
 await setup(path);const c=new CompletionSourceCertifier(path,server,false);await assert.rejects(c.certifyEvent(scope,1n,event('turn/completed',{threadId:'target',turn:{id:'turn',status:'inProgress'}})));assert.equal(await proved(path),false);
 await usingInitializedStore(path,db=>{db.exec("CREATE TRIGGER reject_final BEFORE INSERT ON codex_observed_final_answers BEGIN SELECT RAISE(ABORT,'final denied'); END");});await assert.rejects(c.certifyEvent(scope,1n,final),/final denied/);assert.equal(await proved(path),false);
}));
test("input snapshot survives caller mutation and an out-of-i64 sequence is checked after journal",async()=>storeFixture(async path=>{
 await setup(path);const c=new CompletionSourceCertifier(path,server,false),input={method:'item/completed',params:{threadId:'target',turnId:'turn',item:{type:'agentMessage',phase:'final_answer',text:'original'}}};const pending=c.certifyEvent(scope,1n<<63n,input);input.params.item.text='changed';await assert.rejects(pending);assert.equal(await state.getObservedFinalAnswer(path,'target','turn',1n),'original');assert.equal(await proved(path),false);
}));
