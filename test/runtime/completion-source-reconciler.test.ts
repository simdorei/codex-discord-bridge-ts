import assert from "node:assert/strict";
import {test} from "node:test";
import {setTimeout as delay} from "node:timers/promises";
import {storeFixture} from "../helpers/store-fixture.ts";
import {queueJob} from "../helpers/queue-job.ts";
import {StateAccessFacade as state} from "../../src/store/state-access-facade.ts";
import {usingInitializedStore} from "../../src/store/owned-scope.ts";
import {NotificationState,type AppNotification} from "../../src/app-server/notification-state.ts";
import {CompletionSourceReconciler,type SourceReconcileFailure} from "../../src/runtime/completion/source-reconciler.ts";
import {installRuntimeIdleJournal} from "../../src/runtime/idle-release-journal.ts";
import {PortableResidentLifecycle} from "../../src/app-server/portable-resident-lifecycle.ts";
const OWNER='00000000-0000-4000-8000-000000000001' as const,scope={ownerId:OWNER,generation:1n};
const final:AppNotification={method:'item/completed',params:{threadId:'target',turnId:'turn',item:{type:'agentMessage',phase:'final_answer',text:'exact final'}}};
function fake(){const notifications=new NotificationState(),cleared:{generation:bigint;through:bigint}[]=[],reports:SourceReconcileFailure[]=[];let gen=1n,idle=0;
 const server={observationTrackingEnabled:()=>true,instanceId:OWNER,generation:()=>gen,observationWindow:(g:bigint,after:bigint,upper:bigint|null=null):ReturnType<PortableResidentLifecycle["observationWindow"]>=>({...notifications.observationWindow(after,upper),ownerId:OWNER,generation:g}),reconcileIdleObservationPrefix:(generation:bigint,through:bigint)=>{cleared.push({generation,through});return true;},markIdleObservationGap:(_report:(e:unknown)=>void)=>{idle++;}};
 return {server,notifications,cleared,reports,setGeneration:(g:bigint)=>{gen=g;},idle:()=>idle};
}
async function running(path:string){await state.enqueue(path,queueJob({ownerUserId:2n}));const c=(await state.tryBeginAttempt(path,'saved',[],1n))!;await state.markRunningIfClaimed(path,c,'turn');}
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};}
test("retained original final is journaled and native prefix is requested only after durable scope proof",async()=>storeFixture(async path=>{
 await running(path);const f=fake();f.notifications.record(final);const r=new CompletionSourceReconciler(path,f.server,false,x=>{f.reports.push(x);});await r.scanOnce();assert.equal(await state.getObservedFinalAnswer(path,'target','turn',1n),'exact final');assert.equal(await state.observationScopeVerified(path,scope,1n),true);assert.deepEqual(f.cleared,[{generation:1n,through:1n}]);assert.deepEqual(f.reports,[]);
}));
test("missing oversized source occurrence never clears gap even after cursor scans it",async()=>storeFixture(async path=>{
 const f=fake();f.notifications.record({method:'other',params:{threadId:'target',body:'x'.repeat(2*1024*1024)}});const r=new CompletionSourceReconciler(path,f.server,false,()=>{});for(let i=0;i<3;i++)await r.scanOnce();assert.equal(await state.observationScopeVerified(path,scope,1n),false);assert.deepEqual(f.cleared,[]);
}));
test("bounded pages preserve proof CAS and eventually cover multiple pages without skipping unverified spans",async()=>storeFixture(async path=>{
 const f=fake();for(let i=0;i<70;i++)f.notifications.record({method:'other',params:{threadId:'target',i}});const r=new CompletionSourceReconciler(path,f.server,false,()=>{});await r.scanOnce();assert.equal(f.cleared.length,0);for(let i=0;i<10&&f.cleared.length===0;i++)await r.scanOnce();assert.equal(await state.observationScopeVerified(path,scope,70n),true);assert.equal(f.cleared.at(-1)?.through,70n);
}));
test("event journal failure is reported but cannot acknowledge the unresolved source range",async()=>storeFixture(async path=>{
 await running(path);const f=fake();f.notifications.record(final);await usingInitializedStore(path,db=>{db.exec("CREATE TRIGGER deny_final BEFORE INSERT ON codex_observed_final_answers BEGIN SELECT RAISE(ABORT,'denied final'); END");});const r=new CompletionSourceReconciler(path,f.server,false,x=>{f.reports.push(x);});await r.scanOnce();assert.equal(f.reports[0]!.stage,'event');assert.equal(f.cleared.length,0);assert.equal(await state.observationScopeVerified(path,scope,1n),false);
}));
test("different original window scope refuses before discovery or prefix mutation",async()=>storeFixture(async path=>{
 const f=fake();const original=f.server.observationWindow;f.server.observationWindow=(g,a,u)=>({...original(g,a,u),ownerId:'00000000-0000-4000-8000-000000000002'});const r=new CompletionSourceReconciler(path,f.server,false,()=>{});await assert.rejects(r.scanOnce(),/different original observation stream/);assert.equal(f.cleared.length,0);
}));
test("cancellation after required journal has committed stops final prefix acknowledgement",async()=>storeFixture(async path=>{
 await running(path);const f=fake();f.notifications.record(final);const controller=new AbortController();const injected={activateObservation:state.activateObservation,discoverObservation:state.discoverObservation,nextObservationGap:state.nextObservationGap,finishObservationPage:async(...args:Parameters<typeof state.finishObservationPage>)=>{const result=await state.finishObservationPage(...args);controller.abort('stop');return result;},observationScopeVerified:state.observationScopeVerified};
 const r=new CompletionSourceReconciler(path,f.server,false,()=>{},injected);await assert.rejects(r.scanOnce(controller.signal),e=>e==='stop');assert.equal(await state.getObservedFinalAnswer(path,'target','turn',1n),'exact final');assert.equal(f.cleared.length,0);
}));
test("generation change during page prevents stale final clearance and retains original evidence",async()=>storeFixture(async path=>{
 await running(path);const f=fake();f.notifications.record(final);const actual=f.server.reconcileIdleObservationPrefix;f.server.reconcileIdleObservationPrefix=(gen,through)=>{if(gen!==f.server.generation())throw new Error('native generation changed');return actual(gen,through);};
 const injected={activateObservation:state.activateObservation,discoverObservation:state.discoverObservation,nextObservationGap:state.nextObservationGap,finishObservationPage:state.finishObservationPage,observationScopeVerified:async(...args:Parameters<typeof state.observationScopeVerified>)=>{const result=await state.observationScopeVerified(...args);f.setGeneration(2n);return result;}};
 await assert.rejects(new CompletionSourceReconciler(path,f.server,false,()=>{},injected).scanOnce(),/native generation changed/);assert.equal(f.cleared.length,0);assert.equal(await state.getObservedFinalAnswer(path,'target','turn',1n),'exact final');
}));
test("run reports pass failure, retains gap and closes the only pending tick on shutdown",{timeout:10000},async t=>storeFixture(async path=>{
 const f=fake(),entered=deferred(),tick=deferred(),shutdown=new AbortController();let closed=0;const injected={activateObservation:async()=>{entered.resolve();throw new Error('activation denied');},discoverObservation:state.discoverObservation,nextObservationGap:state.nextObservationGap,finishObservationPage:state.finishObservationPage,observationScopeVerified:state.observationScopeVerified};const r=new CompletionSourceReconciler(path,f.server,false,x=>{f.reports.push(x);},injected),run=r.run(shutdown.signal,{wait:()=>tick.promise,close:()=>{closed++;tick.resolve();}});await entered.promise;while(f.reports.length===0)await delay(1,undefined,{signal:t.signal});shutdown.abort();await run;assert.equal(f.idle(),1);assert.equal(f.reports[0]!.stage,'pass');assert.equal(closed,1);await assert.rejects(r.scanOnce(),/closed/);
}));
test("actual native indexed event replay proves durable prefix through the installed runtime journal",{timeout:15000},async t=>storeFixture(async path=>{
 await running(path);const code=`import readline from 'node:readline';const emit=v=>process.stdout.write(JSON.stringify(v)+'\\n');readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')emit({id:m.id,result:{}});else if(m.method==='read'){emit({method:'item/completed',params:{threadId:'target',turnId:'turn',item:{type:'agentMessage',phase:'final_answer',text:'native final'}}});emit({id:m.id,result:{}});}});`;
 const owner=await PortableResidentLifecycle.start({process:{executable:process.execPath,arguments:['--input-type=module','-e',code],environment:{}},clientInfo:{name:'source-reconcile-fixture',title:'Fixture',version:'1'}},()=> 'safe',{persistDeadWork(){},oldChildExited(){}},t.signal);try{assert.equal(owner.observationTrackingEnabled(),false);installRuntimeIdleJournal(owner,path,()=> 'safe');assert.equal(owner.observationTrackingEnabled(),true);const a=owner.admitRequest();try{await a.client.requestAdmitted(a.permit,'read',{},2000,undefined,t.signal);}finally{a.release();}
 const errors:SourceReconcileFailure[]=[];await new CompletionSourceReconciler(path,owner,false,x=>{errors.push(x);}).scanOnce();assert.equal(await state.getObservedFinalAnswer(path,'target','turn',1n),'native final');assert.equal(await state.observationScopeVerified(path,{ownerId:owner.instanceId,generation:1n},1n),true);assert.equal(owner.reconcileIdleObservationPrefix(1n,1n),true);assert.deepEqual(errors,[]);
 }finally{await owner.dispose();}
}));

test("run without installed observation tracking closes ticks and performs no store operation",async()=>{
 const f=fake();f.server.observationTrackingEnabled=()=>false;let calls=0,closed=0;
 const unexpected=async()=>{calls++;throw new Error('must not run');};
 const r=new CompletionSourceReconciler('unused',f.server,false,()=>{calls++;},{activateObservation:unexpected,discoverObservation:unexpected,nextObservationGap:unexpected,finishObservationPage:unexpected,observationScopeVerified:unexpected});
 await r.run(new AbortController().signal,{wait:unexpected,close:()=>{closed++;}});assert.equal(calls,0);assert.equal(closed,1);
});
