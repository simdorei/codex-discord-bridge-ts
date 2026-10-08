import assert from "node:assert/strict";
import {test} from "node:test";
import {storeFixture} from "../helpers/store-fixture.ts";
import {queueJob} from "../helpers/queue-job.ts";
import {StateAccessFacade as state} from "../../src/store/state-access-facade.ts";
import {usingInitializedStore} from "../../src/store/owned-scope.ts";
import {CompletionHistoryContext} from "../../src/runtime/completion/history-context.ts";
import {parseTurnCompletion} from "../../src/app-server/outcomes.ts";
import {turnOriginMarker} from "../../src/store/mirror-event-read.ts";
import type {AppRequest} from "../../src/app-server/requests.ts";
const completion=parseTurnCompletion({threadId:'target',turn:{id:'turn',status:'completed'}},false);
const turn=(id='turn',text='reply',explicit=true,status='completed')=>({id,status,items:[{type:'agentMessage',phase:explicit?'final_answer':'commentary',text}]});
const history=(...turns:unknown[])=>({thread:{id:'target',turns}});
async function seed(path:string,waiting=false){await state.enqueue(path,queueJob({ownerUserId:2n}));const c=(await state.tryBeginAttempt(path,'saved',[],1n))!;await state.markRunningIfClaimed(path,c,'turn');if(waiting)await usingInitializedStore(path,db=>{db.exec('UPDATE codex_turn_queue SET goal_waiting=1');});return (await state.listFiltered(path,'target',null))[0]!;}
function fixture(path:string,results:unknown[],goal:unknown={goal:null}){
 let generation=1n,index=0;const calls:{request:AppRequest;generation:bigint|undefined}[]=[],sleeps:number[]=[];
 const server={generation:()=>generation,execute:async(request:AppRequest,g?:bigint)=>{calls.push({request,generation:g});if(request.method==='thread/goal/get')return goal;const result=results[index++];if(typeof result==='function')return result();if(result===undefined)throw new Error('unexpected history request');return result;}};
 return {ctx:new CompletionHistoryContext(path,server,47123,state,async ms=>{sleeps.push(ms);}),calls,sleeps,setGeneration:(g:bigint)=>{generation=g;}};
}
async function marker(path:string,id:string){await usingInitializedStore(path,db=>{db.prepare('INSERT INTO codex_session_mirror_events(event_digest,codex_thread_id,created_at) VALUES(?,?,0)').run(turnOriginMarker('target',id),'target');});}
test("explicit history Final outranks stored evidence and retains exact full-history timeout and generation",async()=>storeFixture(async path=>{
 const owner=await seed(path);await state.recordObservedFinalAnswer(path,'target','turn',1n,'stored');const f=fixture(path,[history(turn('turn','history'))]);assert.deepEqual(await f.ctx.exactText(1n,1n,completion,owner,false),{text:'history',needsGoalHandoff:false});assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0]!.request,{method:'thread/read',params:{threadId:'target',includeTurns:true},timeoutMs:47123});assert.equal(f.calls[0]!.generation,1n);assert.deepEqual(f.sleeps,[]);
}));
test("matching stored Final outranks commentary but no different generation is borrowed",async()=>storeFixture(async path=>{
 const owner=await seed(path);await state.recordObservedFinalAnswer(path,'target','turn',1n,'stored');const legacy=history(turn('turn','legacy',false));const same=fixture(path,[legacy]);assert.equal((await same.ctx.exactText(1n,1n,completion,owner,false)).text,'stored');
 const other=fixture(path,[legacy,legacy,legacy]);assert.equal((await other.ctx.exactText(1n,2n,completion,owner,false)).text,'legacy');assert.deepEqual(other.sleeps,[100,100]);
}));
test("three reads retain prior fallback across sparse reads and distinguish absent exact reply",async()=>storeFixture(async path=>{
 const owner=await seed(path),f=fixture(path,[history(),history(turn('turn','legacy',false)),history()]);assert.equal((await f.ctx.exactText(1n,1n,completion,owner,false)).text,'legacy');assert.equal(f.calls.length,3);
 const missing=fixture(path,[history(turn('other','wrong')),history(),history()]);assert.equal((await missing.ctx.exactText(1n,1n,completion,owner,false)).text,null);assert.deepEqual(missing.sleeps,[100,100]);
}));
test("RPC and malformed history errors do not silently fall back to cached Final or retry",async()=>storeFixture(async path=>{
 const owner=await seed(path);await state.recordObservedFinalAnswer(path,'target','turn',1n,'stored');const sentinel={rpcFailed:true},rpc=fixture(path,[()=>{throw sentinel;}]);await assert.rejects(rpc.ctx.exactText(1n,1n,completion,owner,false),e=>e===sentinel);assert.equal(rpc.calls.length,1);
 const bad=fixture(path,[{thread:{id:'other',turns:[]}}]);await assert.rejects(bad.ctx.exactText(1n,1n,completion,owner,false),/different thread/);assert.equal(bad.calls.length,1);
}));
test("owner or resident generation changed during read refuses recovered exact text",async()=>{
 for(const mode of ['owner','generation'])await storeFixture(async path=>{const owner=await seed(path);const f=fixture(path,[async()=>{if(mode==='owner')await usingInitializedStore(path,db=>{db.exec("UPDATE codex_turn_queue SET prompt='changed'");});else f.setGeneration(2n);return history(turn());}]);await assert.rejects(f.ctx.exactText(1n,1n,completion,owner,false),/ownership changed during history/);});
});
test("waiting Goal rejects missing/active/duplicate prior turn or any unowned successor",async()=>{
 for(const result of [history(),history(turn('turn','',true,'inProgress')),history(turn(),turn()),history(turn(),turn('successor')),history(turn(),turn('successor','',true,'inProgress'))])await storeFixture(async path=>{const owner=await seed(path,true),f=fixture(path,[result]);await assert.rejects(f.ctx.waitingGoalCompletion(1n,owner),/Goal completion held/);});
});
test("known baseline and completed bot-marked predecessor are allowed, but active marked successor is still held",async()=>storeFixture(async path=>{
 const owner=await seed(path,true);await marker(path,'predecessor');const f=fixture(path,[history(turn(),turn('predecessor')),history(turn(),turn('predecessor','',true,'inProgress'))]);assert.equal((await f.ctx.waitingGoalCompletion(1n,owner)).turnId,'turn');await assert.rejects(f.ctx.waitingGoalCompletion(1n,owner),/unattached turn/);
 const baseline={...owner,baselineTurnIds:['known']};await usingInitializedStore(path,db=>{db.exec(`UPDATE codex_turn_queue SET baseline_turn_ids='["known"]'`);});const allowed=fixture(path,[history(turn(),turn('known'))]);assert.equal((await allowed.ctx.waitingGoalCompletion(1n,baseline)).status,'Completed');
}));
test("observed Goal successor remains sticky across sparse reads instead of becoming a false Final",async()=>storeFixture(async path=>{
 const owner=await seed(path),f=fixture(path,[history(turn('turn','progress',false),turn('successor')),history(),history(turn('turn','exact'))]);assert.deepEqual(await f.ctx.exactText(1n,1n,completion,owner,true),{text:'exact',needsGoalHandoff:true});assert.equal(f.calls.length,3);
}));
test("sticky handoff still validates every subsequent history and waiting owner cannot choose successor",async()=>storeFixture(async path=>{
 const owner=await seed(path),f=fixture(path,[history(turn('turn','legacy',false),turn('next')),history(turn(),turn())]);await assert.rejects(f.ctx.exactText(1n,1n,completion,owner,true),/duplicate history/);
 await usingInitializedStore(path,db=>{db.exec('UPDATE codex_turn_queue SET goal_waiting=1');});const waiting=(await state.listFiltered(path,'target',null))[0]!,held=fixture(path,[history(turn(),turn('next'))]);await assert.rejects(held.ctx.exactText(1n,1n,completion,waiting,true),/waiting owner retained/);assert.equal(held.calls.length,1);
}));
test("owned terminal status drift in Goal history is held rather than converted to progress",async()=>storeFixture(async path=>{
 const owner=await seed(path),f=fixture(path,[history(turn('turn','',true,'failed'))]);await assert.rejects(f.ctx.exactText(1n,1n,completion,owner,true),/terminal status changed/);
}));
test("Goal/get null/status parsing uses original request identity and rejects foreign thread",async()=>{
 for(const [goal,expected] of [[null,null],[{threadId:'target',status:'active'},'Active'],[{threadId:'target',status:'complete'},'Complete']] as const){const f=fixture('unused',[],{goal});assert.equal(await f.ctx.goalStatus(1n,'target'),expected);assert.deepEqual(f.calls[0]!.request.params,{threadId:'target'});}
 await assert.rejects(fixture('unused',[],{goal:{threadId:'other',status:'complete'}}).ctx.goalStatus(1n,'target'),/different thread/);
});
test("exact bot marker lookup does not accept other thread or merely similar marker",async()=>storeFixture(async path=>{
 await marker(path,'prior');assert.equal(await state.hasMirrorEvent(path,turnOriginMarker('target','prior'),'target'),true);assert.equal(await state.hasMirrorEvent(path,turnOriginMarker('target','prior'),'other'),false);assert.equal(await state.hasMirrorEvent(path,turnOriginMarker('target','other'),'target'),false);
}));
test("caller owner mutation cannot rewrite the captured proof and cancellation prevents final owner acknowledgement",async()=>storeFixture(async path=>{
 const owner=await seed(path),f=fixture(path,[()=>{owner.prompt='caller mutation';return history(turn());}]);assert.equal((await f.ctx.exactText(1n,1n,completion,owner,false)).text,'reply');
 const original=(await state.listFiltered(path,'target',null))[0]!,controller=new AbortController(),aborted=fixture(path,[()=>{controller.abort('stop');return history(turn());}]);await assert.rejects(aborted.ctx.exactText(1n,1n,completion,original,false,controller.signal),e=>e==='stop');
}));
test("history timeout validates once and preserves zero without silently selecting a default",()=>{
 const server={generation:()=>1n,execute:async()=>({})};for(const timeout of [-1,1.5,2147483648])assert.throws(()=>new CompletionHistoryContext('unused',server,timeout),RangeError);assert.doesNotThrow(()=>new CompletionHistoryContext('unused',server,0));
});

test("context refuses cross-thread or cross-turn owner before any native history request",async()=>storeFixture(async path=>{
 const owner=await seed(path),f=fixture(path,[]);for(const bad of [{...owner,targetThreadId:'other'},{...owner,turnId:'other'},{...owner,turnId:null}])await assert.rejects(f.ctx.exactText(1n,1n,completion,bad,false),/original owner mismatch/);assert.equal(f.calls.length,0);
}));
