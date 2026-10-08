import assert from "node:assert/strict";
import {test} from "node:test";
import {storeFixture} from "../helpers/store-fixture.ts";
import {queueJob} from "../helpers/queue-job.ts";
import {StateAccessFacade as state} from "../../src/store/state-access-facade.ts";
import {usingInitializedStore} from "../../src/store/owned-scope.ts";
import {initialCompletionCursor,type CompletionEntry} from "../../src/store/completion-metadata.ts";
import type {AppRequest} from "../../src/app-server/requests.ts";
import type {ResidentNotificationEvent} from "../../src/app-server/resident-forwarders.ts";
import {PortableResidentLifecycle} from "../../src/app-server/portable-resident-lifecycle.ts";
import {QueueStartCoordinator,type QueueStartBackend} from "../../src/runtime/queue-runner/start-coordinator.ts";
import {StagedCompletionHandler} from "../../src/runtime/completion/staged-handler.ts";
import {prepareCompletionState} from "../../src/runtime/completion/scheduler/state-admission.ts";
import {CompletionEventBudget} from "../../src/runtime/completion/scheduler/envelope.ts";
import {CompletionSourceIntake} from "../../src/runtime/completion/source-intake.ts";
import {TerminalFence} from "../../src/runtime/completion/terminal-fence.ts";
import {AdmissionGate,DrainFenceKey} from "../../src/admission/drain-gate.ts";
const OWNER='00000000-0000-4000-8000-000000000001' as const;
const event=(method:string,params:unknown,generation=1n):ResidentNotificationEvent=>({kind:'Notification',generation,notification:{method,params}});
const terminal=(status='completed')=>event('turn/completed',{threadId:'target',turn:{id:'turn',status,error:status==='failed'?{message:'failure detail'}:null}});
const history=(text='exact')=>({thread:{id:'target',turns:[{id:'turn',status:'completed',items:[{type:'agentMessage',phase:'final_answer',text}]}]}});
async function seed(path:string){await state.enqueue(path,queueJob({ownerUserId:2n}));const c=(await state.tryBeginAttempt(path,'saved',[],1n))!;return (await state.markRunningIfClaimed(path,c,'turn'))!;}
function setup(path:string,options:{goal?:string|null;read?:()=>Promise<unknown>;gate?:AdmissionGate}={}){
 const requests:AppRequest[]=[];let notices=0,starts=0;let active:string|null=null;
 const server={instanceId:OWNER,generation:()=>1n,activeTurnId:()=>active,execute:async(request:AppRequest)=>{requests.push(request);if(request.method==='thread/goal/get')return {goal:options.goal==null?null:{threadId:'target',status:options.goal}};return options.read?options.read():history();}};
 const backend:QueueStartBackend={generation:()=>1n,residentInstanceId:()=>OWNER,activeTurnId:async()=>server.activeTurnId(),resumeThread:async()=>{},readTurns:async()=>[{turnId:'turn',status:'Completed'}],startClaimedTurn:async()=>{starts++;return 'unexpected-next';}};
 const queue=new QueueStartCoordinator(path,backend,{...(options.gate===undefined?{}:{admission:options.gate}),notifyDeliveryReady:()=>{notices++;}}),handler=new StagedCompletionHandler(server,queue,{commentaryEnabled:true,historyReadTimeoutMs:47123,render:()=> 'safe state failure',sleep:async()=>{}});
 return {server,queue,handler,requests,notices:()=>notices,starts:()=>starts,setActive:(v:string|null)=>{active=v;}};
}
async function handle(path:string,f:ReturnType<typeof setup>,input:ResidentNotificationEvent){const budget=new CompletionEventBudget(),live=budget.chargeOwned(input)!;assert.ok(live);const admitted=prepareCompletionState(path,f.queue.locks,{kind:'Live',live})!;try{await f.handler.handleLive(input,admitted.permit);}finally{admitted.release();live.dispose();}}
async function entry(path:string,source:'Queue'|'Observed'):Promise<CompletionEntry>{return (await state.completionPage(path,source,initialCompletionCursor(),OWNER,1n)).page.entries[0]!;}
async function durable(path:string,f:ReturnType<typeof setup>,source:'Queue'|'Observed'){const item=await entry(path,source);assert.ok(item);const admitted=prepareCompletionState(path,f.queue.locks,{kind:'Durable',entry:item})!;try{await f.handler.handleDurable(item,admitted.permit);}finally{admitted.release();}}
test("live completed stages exact Final under admission without inline HTTP or next queued start",async()=>storeFixture(async path=>{
 await seed(path);await state.enqueue(path,queueJob({jobId:'next',ownerUserId:2n,createdAt:1}));const f=setup(path);await handle(path,f,terminal());assert.equal((await state.listPendingDeliveries(path))[0]!.content,'Final\nexact');assert.equal((await state.listFiltered(path,'target',null))[0]!.state,'Pending');assert.equal(f.starts(),0);assert.equal(f.notices(),1);assert.deepEqual(f.requests.map(r=>r.method),['thread/goal/get','thread/read']);assert.equal(f.queue.locks.activeTargetCount,0);
}));
test("failed and interrupted terminals do not request history or masquerade as Final",async()=>{
 for(const status of ['failed','interrupted'])await storeFixture(async path=>{await seed(path);const f=setup(path);await handle(path,f,terminal(status));assert.equal(f.requests.length,0);const text=(await state.listPendingDeliveries(path))[0]!.content;assert.match(text,status==='failed'?/^Failed\nfailure detail$/:/^Interrupted\n/);});
});
test("Active Goal stages progress, retains original owner and started event performs exact handoff",async()=>storeFixture(async path=>{
 await seed(path);const f=setup(path,{goal:'active'});await handle(path,f,terminal());assert.equal((await state.listPendingDeliveries(path)).length,0);assert.equal((await state.pendingGoalProgress(path))[0]!.content,'[Goal progress]\nexact');let job=(await state.listFiltered(path,'target',null))[0]!;assert.equal(job.goalWaiting,true);await handle(path,f,event('turn/started',{threadId:'target',turnId:'next'}));job=(await state.listFiltered(path,'target',null))[0]!;assert.equal(job.turnId,'next');assert.equal(job.goalWaiting,false);assert.equal(f.starts(),0);
}));
test("missing exact reply produces explicit error delivery, not a fabricated Final",async()=>storeFixture(async path=>{
 await seed(path);const f=setup(path,{read:async()=>({thread:{id:'target',turns:[]}})});await handle(path,f,terminal());assert.match((await state.listPendingDeliveries(path))[0]!.content,/^ERROR: Codex turn completed, but its exact final reply/);assert.equal(f.requests.filter(r=>r.method==='thread/read').length,3);
}));
test("captured owner drift refuses state completion while retaining independently observed terminal",async()=>storeFixture(async path=>{
 await seed(path);const f=setup(path),input=terminal(),live=new CompletionEventBudget().chargeOwned(input)!,admitted=prepareCompletionState(path,f.queue.locks,{kind:'Live',live})!;try{await usingInitializedStore(path,db=>{db.exec("UPDATE codex_turn_queue SET prompt='changed'");});await assert.rejects(f.handler.handleLive(input,admitted.permit),/admission owner changed/);assert.equal(await state.hasObservedCompletion(path,'target','turn'),true);assert.equal((await state.listPendingDeliveries(path)).length,0);assert.equal(f.requests.length,0);}finally{admitted.release();live.dispose();}
}));
test("commentary is staged, reasoning is never output, and async message branch only wakes existing question work",async()=>storeFixture(async path=>{
 await seed(path);const f=setup(path);await handle(path,f,event('item/reasoning/summaryTextDelta',{threadId:'target',turnId:'turn',itemId:'reason',delta:'private summary'}));assert.equal((await state.pendingCommentary(path)).length,0);
 await handle(path,f,event('item/completed',{threadId:'target',turnId:'turn',item:{id:'c',type:'agentMessage',phase:'commentary',text:'visible progress'}}));assert.equal((await state.pendingCommentary(path))[0]!.text,'visible progress');
 await handle(path,f,event('item/completed',{threadId:'target',turnId:'turn',item:{id:'q',type:'agentMessage',delivery:'async',text:'question',questions:[]}}));assert.equal((await state.pendingAsyncQuestions(path,OWNER)).length,0);assert.equal(f.requests.length,0);assert.equal(f.notices(),2);
}));
test("durable Observed replay never mints resident terminal proof from stored JSON",async()=>storeFixture(async path=>{
 await seed(path);await usingInitializedStore(path,db=>{db.prepare("INSERT INTO codex_observed_completions(thread_id,turn_id,generation,payload) VALUES('target','turn',1,?)").run(JSON.stringify({threadId:'target',turn:{id:'turn',status:'completed'}}));});const f=setup(path);await durable(path,f,'Observed');assert.equal((await state.listPendingDeliveries(path))[0]!.content,'Final\nexact');await usingInitializedStore(path,db=>{assert.equal(db.prepare('SELECT count(*) AS n FROM cdr_idle_release').get()?.n,0);});
}));
test("durable parse failure records central public-safe diagnostic and retains original evidence",async()=>storeFixture(async path=>{
 await seed(path);await usingInitializedStore(path,db=>{db.exec("INSERT INTO codex_observed_completions(thread_id,turn_id,generation,payload) VALUES('target','turn',1,'bad json')");});const f=setup(path);await assert.rejects(durable(path,f,'Observed'),SyntaxError);await usingInitializedStore(path,db=>{const row=db.prepare('SELECT payload,last_error FROM codex_observed_completions').get()!;assert.equal(row.payload,'bad json');assert.equal(row.last_error,'safe state failure');});
}));
test("restart drain snapshot admits controls atomically and closes queue recovery once controls close",async()=>storeFixture(async path=>{
 await seed(path);const gate=new AdmissionGate(),key=DrainFenceKey.create('runtime','1|2','nonce');const [initial,wasDraining]=gate.tryEnterControlObserved();assert.equal(wasDraining,false);initial.release();gate.seal(key);const [control,draining]=gate.tryEnterControlObserved();assert.equal(draining,true);assert.equal(gate.isDrainedFor(key),false);control.release();const f=setup(path,{gate});gate.closeControls(key);await durable(path,f,'Queue');assert.equal(f.requests.length,0);assert.equal((await state.listPendingDeliveries(path)).length,0);assert.equal((await state.listFiltered(path,'target',null)).length,1);
}));
test("draining with open controls can reconcile existing terminal without starting new work",async()=>storeFixture(async path=>{
 await seed(path);const gate=new AdmissionGate(),key=DrainFenceKey.create('runtime','1|2','nonce');gate.seal(key);const f=setup(path,{gate});await durable(path,f,'Queue');assert.equal((await state.listPendingDeliveries(path))[0]!.content,'Final\nexact');assert.equal(f.starts(),0);assert.equal(gate.isDrainedFor(key),true);
}));
test("actual VM helper source events reach staged Final storage under the same target admission",{timeout:15000},async t=>storeFixture(async path=>{
 await seed(path);const code=`import readline from 'node:readline';const emit=v=>process.stdout.write(JSON.stringify(v)+'\\n');readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')emit({id:m.id,result:{}});else if(m.method==='read'){emit({method:'item/completed',params:{threadId:'target',turnId:'turn',item:{type:'agentMessage',phase:'final_answer',text:'native final'}}});emit({method:'turn/completed',params:{threadId:'target',turn:{id:'turn',status:'completed'}}});emit({id:m.id,result:{}});}else if(m.method==='thread/goal/get')emit({id:m.id,result:{goal:null}});else if(m.method==='thread/read')emit({id:m.id,result:{thread:{id:'target',turns:[{id:'turn',status:'completed',items:[{type:'agentMessage',phase:'final_answer',text:'native final'}]}]}}});});`;
 const owner=await PortableResidentLifecycle.start({process:{executable:process.execPath,arguments:['--input-type=module','-e',code],environment:{}},clientInfo:{name:'staged-handler-fixture',title:'Fixture',version:'1'}},()=> 'safe',{persistDeadWork(){},oldChildExited(){}},t.signal,{renderError:()=> 'safe',fence:{requestOrigin:()=>null,checkRequest(){},beginMutationWithOrigin(){throw new Error('Read cannot create mutation claim');},finishMutation(){throw new Error('Read cannot finish mutation claim');}}});
 let intake:CompletionSourceIntake|undefined;try{
  const backend:QueueStartBackend={generation:()=>owner.generation(),residentInstanceId:()=>owner.instanceId,activeTurnId:async t=>owner.activeTurnId(t),resumeThread:async()=>{throw new Error('no resume');},readTurns:async()=>[],startClaimedTurn:async()=>{throw new Error('no start');}};const queue=new QueueStartCoordinator(path,backend),handler=new StagedCompletionHandler(owner,queue,{commentaryEnabled:false,historyReadTimeoutMs:2000,render:()=> 'safe'});intake=new CompletionSourceIntake(path,owner,new TerminalFence(),false,()=>{});
  const a=owner.admitRequest();try{await a.client.requestAdmitted(a.permit,'read',{},2000,undefined,t.signal);}finally{a.release();}await intake.scanOnce();for(;;){const live=intake.queue.take();if(!live)break;const admitted=prepareCompletionState(path,queue.locks,{kind:'Live',live})!;try{await handler.handleLive(live.payload,admitted.permit,t.signal);}finally{admitted.release();live.dispose();}}
  assert.equal((await state.listPendingDeliveries(path))[0]!.content,'Final\nnative final');assert.equal((await state.listFiltered(path,'target',null)).length,0);assert.equal(queue.locks.activeTargetCount,0);
 }finally{intake?.close();await owner.dispose();}
}));
