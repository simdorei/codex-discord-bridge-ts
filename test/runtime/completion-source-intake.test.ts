import assert from "node:assert/strict";
import {test} from "node:test";
import {setTimeout as delay} from "node:timers/promises";
import {storeFixture} from "../helpers/store-fixture.ts";
import {queueJob} from "../helpers/queue-job.ts";
import {StateAccessFacade as state} from "../../src/store/state-access-facade.ts";
import {NotificationState,type AppNotification} from "../../src/app-server/notification-state.ts";
import {BoundedBroadcast} from "../../src/app-server/broadcast.ts";
import type {ResidentNotificationEvent} from "../../src/app-server/resident-forwarders.ts";
import {CompletionSourceIntake,type SourceIntakeFailure} from "../../src/runtime/completion/source-intake.ts";
import {CompletionEventBudget} from "../../src/runtime/completion/scheduler/envelope.ts";
import {TerminalFence} from "../../src/runtime/completion/terminal-fence.ts";
import {PortableResidentLifecycle} from "../../src/app-server/portable-resident-lifecycle.ts";
const OWNER='00000000-0000-4000-8000-000000000001' as const;
function fake(){const notifications=new NotificationState(),broadcast=new BoundedBroadcast<ResidentNotificationEvent>(8),gaps:bigint[]=[],reports:SourceIntakeFailure[]=[];let gen=1n,idle=0;
 const server={instanceId:OWNER,generation:()=>gen,observationWindow:(g:bigint,after:bigint,upper:bigint|null=null)=>({...notifications.observationWindow(after,upper),ownerId:OWNER,generation:g}),markSourceObservationGap:(g:bigint,_report:(e:unknown)=>void)=>{gaps.push(g);},markIdleObservationGap:(_report:(e:unknown)=>void)=>{idle++;},subscribeNotifications:()=>broadcast.subscribe()};
 return {server,notifications,broadcast,gaps,reports,setGeneration:(g:bigint)=>{gen=g;},idle:()=>idle};
}
async function running(path:string){await state.enqueue(path,queueJob({ownerUserId:2n}));const c=(await state.tryBeginAttempt(path,'saved',[],1n))!;await state.markRunningIfClaimed(path,c,'turn');}
const terminal:AppNotification={method:'turn/completed',params:{threadId:'target',turn:{id:'turn',status:'completed'}}};
const unknown=(thread='target'):AppNotification=>({method:'other',params:{threadId:thread}});
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};}
test("indexed scan journals terminal, stops fence and transfers one charged envelope exactly once",async()=>storeFixture(async path=>{
 await running(path);const f=fake(),fence=new TerminalFence();f.notifications.record(terminal);const intake=new CompletionSourceIntake(path,f.server,fence,false,x=>{f.reports.push(x);});await intake.scanOnce();assert.equal(intake.forwarded,1n);assert.equal(fence.stopped(1n,'target','turn'),true);assert.equal(await state.observationScopeVerified(path,{ownerId:OWNER,generation:1n},1n),true);
 const before=intake.availableBytes,envelope=intake.queue.take()!;assert.equal(envelope.payload.notification.method,'turn/completed');await intake.scanOnce();assert.equal(intake.queue.length,0);envelope.dispose();assert.ok(intake.availableBytes>before);intake.close();assert.deepEqual(f.reports,[]);
}));
test("current broadcast is wakeup only; exact old generation event journals and forwards without advancing current source",async()=>storeFixture(async path=>{
 await running(path);const f=fake();f.setGeneration(2n);const intake=new CompletionSourceIntake(path,f.server,new TerminalFence(),false,x=>{f.reports.push(x);});await intake.acceptWake({kind:'Notification',generation:2n,notification:terminal});assert.equal(intake.queue.length,0);await intake.acceptWake({kind:'Notification',generation:1n,notification:terminal});assert.equal(intake.queue.length,1);assert.equal(intake.forwarded,0n);assert.equal(await state.hasObservedCompletion(path,'target','turn'),true);intake.close();
}));
test("oversized retained notification is a source gap and cursor advances without fake proof",async()=>storeFixture(async path=>{
 const f=fake();f.notifications.record({method:'other',params:{threadId:'target',text:'x'.repeat(2*1024*1024)}});const intake=new CompletionSourceIntake(path,f.server,new TerminalFence(),false,x=>{f.reports.push(x);});await intake.scanOnce();assert.equal(intake.forwarded,1n);assert.equal(intake.queue.length,0);assert.equal(f.gaps.length,1);assert.equal(await state.observationScopeVerified(path,{ownerId:OWNER,generation:1n},1n),false);intake.close();
}));
test("source FIFO is 128 entries and rejected envelope releases bytes while keeping source gap",async()=>storeFixture(async path=>{
 const f=fake();for(let i=0;i<129;i++)f.notifications.record(unknown('T'+i));const budget=new CompletionEventBudget(),intake=new CompletionSourceIntake(path,f.server,new TerminalFence(),false,x=>{f.reports.push(x);},budget);for(let i=0;i<5;i++)await intake.scanOnce();assert.equal(intake.queue.length,128);assert.equal(intake.forwarded,129n);assert.ok(f.reports.some(x=>x.stage==='queue'));assert.ok(f.gaps.length>0);intake.close();assert.equal(budget.availableBytes,budget.capacity);
}));
test("byte pressure does not erase journaled evidence and missing thread does not consume capacity",async()=>storeFixture(async path=>{
 await running(path);const f=fake();f.notifications.record(terminal);f.notifications.record({method:'other',params:{}});const budget=new CompletionEventBudget(1),intake=new CompletionSourceIntake(path,f.server,new TerminalFence(),false,x=>{f.reports.push(x);},budget);await intake.scanOnce();assert.equal(intake.queue.length,0);assert.equal(budget.availableBytes,1);assert.equal(await state.hasObservedCompletion(path,'target','turn'),true);assert.equal(f.reports.filter(x=>x.stage==='bytes').length,1);intake.close();
}));
test("failed discovery reports uncertainty without stopping already-owned event forwarding",async()=>storeFixture(async path=>{
 const f=fake();f.notifications.record(unknown());const injected={activateObservation:state.activateObservation,discoverObservation:async()=>{throw new Error('discover denied');}};const intake=new CompletionSourceIntake(path,f.server,new TerminalFence(),false,x=>{f.reports.push(x);},new CompletionEventBudget(),injected);await intake.scanOnce();assert.equal(intake.forwarded,1n);assert.equal(intake.queue.length,1);assert.equal(f.idle(),1);assert.equal(f.reports[0]!.stage,'discover');assert.equal(await state.observationScopeVerified(path,{ownerId:OWNER,generation:1n},1n),false);intake.close();
}));
test("generation switch resets scan cursor and invalid terminal journal cannot silently certify",async()=>storeFixture(async path=>{
 const f=fake();f.notifications.record({method:'turn/completed',params:{threadId:'target',turn:{id:'turn',status:'inProgress'}}});const intake=new CompletionSourceIntake(path,f.server,new TerminalFence(),false,x=>{f.reports.push(x);});await intake.scanOnce();assert.equal(f.reports[0]!.stage,'journal');f.setGeneration(2n);await intake.scanOnce();assert.equal(intake.queue.length,2);assert.equal(intake.forwarded,1n);intake.close();
}));
test("one owner refuses overlapping scans and abort waits for owned activation before dropping queued work",async()=>storeFixture(async path=>{
 const f=fake(),started=deferred(),release=deferred();const injected={activateObservation:async(p:string,s:Parameters<typeof state.activateObservation>[1])=>{started.resolve();await release.promise;await state.activateObservation(p,s);},discoverObservation:state.discoverObservation};const intake=new CompletionSourceIntake(path,f.server,new TerminalFence(),false,()=>{},new CompletionEventBudget(),injected);const controller=new AbortController(),p=intake.scanOnce(controller.signal);await started.promise;await assert.rejects(intake.scanOnce(),/Only one/);controller.abort('stop');release.resolve();await assert.rejects(p,e=>e==='stop');assert.equal(intake.forwarded,0n);intake.close();
}));
test("owned loop disposes receiver and tick on shutdown and rejects reuse",{timeout:10000},async t=>storeFixture(async path=>{
 const f=fake(),wait=deferred();let closed=0;const ticks={wait:()=>wait.promise,close:()=>{closed++;wait.resolve();}};const intake=new CompletionSourceIntake(path,f.server,new TerminalFence(),false,()=>{}),shutdown=new AbortController(),run=intake.run(shutdown.signal,ticks);while(f.broadcast.receiverCount!==1)await delay(1,undefined,{signal:t.signal});shutdown.abort('stop');await run;assert.equal(f.broadcast.receiverCount,0);assert.equal(f.broadcast.pendingWaiters,0);assert.equal(closed,1);await assert.rejects(intake.scanOnce(),/closed/);
}));
test("rejected tick remains observed and loop cleanup joins the pending receive",async()=>storeFixture(async path=>{
 const f=fake(),sentinel={tickFailed:true};let closed=false;const intake=new CompletionSourceIntake(path,f.server,new TerminalFence(),false,()=>{});await assert.rejects(intake.run(new AbortController().signal,{wait:()=>Promise.reject(sentinel),close:()=>{closed=true;}}),e=>e===sentinel);assert.equal(closed,true);assert.equal(f.broadcast.receiverCount,0);assert.equal(f.broadcast.pendingWaiters,0);
}));
test("actual owned native helper events enter indexed page, durable proof and bounded completion handoff",{timeout:15000},async t=>storeFixture(async path=>{
 await running(path);const code=`import readline from 'node:readline';const emit=v=>process.stdout.write(JSON.stringify(v)+'\\n');readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')emit({id:m.id,result:{}});else if(m.method==='read'){emit({method:'item/completed',params:{threadId:'target',turnId:'turn',item:{type:'agentMessage',phase:'final_answer',text:'native final'}}});emit({method:'turn/completed',params:{threadId:'target',turn:{id:'turn',status:'completed'}}});emit({id:m.id,result:{}});}});`;
 const owner=await PortableResidentLifecycle.start({process:{executable:process.execPath,arguments:['--input-type=module','-e',code],environment:{}},clientInfo:{name:'source-intake-fixture',title:'Fixture',version:'1'}},()=> 'safe',{persistDeadWork(){},oldChildExited(){}},t.signal);t.after(()=>owner.dispose());
 const reports:SourceIntakeFailure[]=[],intake=new CompletionSourceIntake(path,owner,new TerminalFence(),false,x=>{reports.push(x);});t.after(()=>intake.close());const a=owner.admitRequest();try{await a.client.requestAdmitted(a.permit,'read',{},2000,undefined,t.signal);}finally{a.release();}
 await intake.scanOnce();assert.equal(intake.forwarded,2n);assert.equal(intake.queue.length,2);assert.equal(await state.getObservedFinalAnswer(path,'target','turn',1n),'native final');assert.equal(await state.observationScopeVerified(path,{ownerId:owner.instanceId,generation:1n},2n),true);assert.deepEqual(reports,[]);
}));

test("activation and window failures do not advance cursor and activation is retried",async()=>storeFixture(async path=>{
 const f=fake();f.notifications.record(unknown());let failed=true;
 const injected={activateObservation:async(p:string,s:Parameters<typeof state.activateObservation>[1])=>{if(failed)throw new Error('activate denied');return state.activateObservation(p,s);},discoverObservation:state.discoverObservation};
 const intake=new CompletionSourceIntake(path,f.server,new TerminalFence(),false,x=>{f.reports.push(x);},new CompletionEventBudget(),injected);await intake.scanOnce();assert.equal(intake.forwarded,0n);assert.equal(f.reports[0]!.stage,'activate');failed=false;
 const original=f.server.observationWindow;f.server.observationWindow=()=>{throw new Error('window denied');};await intake.scanOnce();assert.equal(intake.forwarded,0n);assert.equal(f.reports[1]!.stage,'window');f.server.observationWindow=original;await intake.scanOnce();assert.equal(intake.forwarded,1n);intake.close();
}));
test("closed broadcast ends loop and returns all queued byte ownership",{timeout:10000},async t=>storeFixture(async path=>{
 const f=fake();f.notifications.record(unknown());const budget=new CompletionEventBudget(),intake=new CompletionSourceIntake(path,f.server,new TerminalFence(),false,()=>{},budget),tick=deferred();const run=intake.run(new AbortController().signal,{wait:()=>tick.promise,close:()=>tick.resolve()});while(f.broadcast.receiverCount!==1)await delay(1,undefined,{signal:t.signal});f.broadcast.close();await run;assert.equal(intake.queue.length,0);assert.equal(budget.availableBytes,budget.capacity);assert.equal(f.broadcast.pendingWaiters,0);
}));
