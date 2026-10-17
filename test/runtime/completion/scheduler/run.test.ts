import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setImmediate as tick} from 'node:timers/promises';
import {CompletionScheduler,type CompletionSchedulerPorts} from '../../../../src/runtime/completion/scheduler/run.ts';
import {CompletionDiscovery} from '../../../../src/runtime/completion/scheduler/discovery.ts';
import {CompletionEventBudget} from '../../../../src/runtime/completion/scheduler/envelope.ts';
import type {CompletionEntry} from '../../../../src/store/completion-metadata.ts';
import type {TickSource} from '../../../../src/runtime/delayed-ticks.ts';
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
const entry=(id:string,channel=1n):CompletionEntry=>({source:'Final',id,target:id,turn:'t',channel,bytes:1n,position:{stamp:0,ordinal:0n,id}});
class ManualTicks implements TickSource{closed=false;resolve:(()=>void)|null=null;waits=0;wait():Promise<void>{assert.equal(this.resolve,null);this.waits++;return new Promise(r=>{this.resolve=r;});}fire():void{const r=this.resolve;this.resolve=null;r?.();}close():void{this.closed=true;this.fire();}}
function fixture(overrides:Partial<CompletionSchedulerPorts<string>>={},now:()=>number=()=>performance.now()){
 const budget=new CompletionEventBudget(),sent:string[]=[],states:string[]=[],released:string[]=[],errors:unknown[]=[],gaps:unknown[]=[];let maint=0;
 const scheduler=new CompletionScheduler('/unused',{prepare:work=>{const target=work.kind==='Live'?work.live.target:work.entry.target;return {permit:target,needsNative:false,release:()=>{released.push(target);}};},state:async(_w,p)=>{states.push(p);},http:async e=>{sent.push(e.id);},prepareFailed:e=>{gaps.push(e);},instanceId:()=> 'runtime',generation:()=>1n,freshHeads:async t=>[entry(t)],maintain:async()=>{maint++;},report:e=>{errors.push(e);},gap:e=>{gaps.push(e);},...overrides},{discovery:new CompletionDiscovery([],now),now});
 const live=(target:string)=>budget.chargeOwned({kind:'Notification',generation:1n,notification:{method:'turn/completed',params:{threadId:target,turn:{id:'t',status:'completed'}}}})!;
 return {scheduler,budget,sent,states,released,errors,gaps,maint:()=>maint,live};
}
test('finished input drains live state, fresh priority heads and HTTP before returning',{timeout:5000},async()=>{
 const f=fixture(),ticks=new ManualTicks();f.scheduler.offer(f.live('a'));f.scheduler.offer(f.live('b'));f.scheduler.finishInput();await f.scheduler.run(new AbortController().signal,ticks);assert.deepEqual(f.states,['a','b']);assert.deepEqual(f.sent,['b','a']);assert.equal(f.maint(),1);assert.equal(f.errors.length,0);assert.equal(f.budget.availableBytes,f.budget.capacity);assert.equal(ticks.closed,true);assert.equal(f.scheduler.offer(f.live('late')),false);assert.equal(f.budget.availableBytes,f.budget.capacity);await assert.rejects(f.scheduler.run(new AbortController().signal),/already used/);
});
test('actual IO yield lets independent immediate run during continuously ready batches',{timeout:5000},async()=>{
 let independent=false;const f=fixture({state:async()=>{}});for(let i=0;i<60;i++)f.scheduler.offer(f.live('t'+i));f.scheduler.finishInput();setImmediate(()=>{independent=true;});await f.scheduler.run(new AbortController().signal,new ManualTicks());assert.equal(independent,true);assert.equal(f.sent.length,60);
});
test('input rejection and per-target ready rejection release bytes and mark retained-evidence gaps',{timeout:5000},async()=>{
 const f=fixture({freshHeads:async()=>[]});for(let i=0;i<128;i++)assert.equal(f.scheduler.offer(f.live('same')),true);assert.equal(f.scheduler.offer(f.live('overflow')),false);assert.equal(f.scheduler.pendingInput,128);f.scheduler.finishInput();await f.scheduler.run(new AbortController().signal,new ManualTicks());assert.equal(f.states.length,16);assert.equal(f.gaps.length,113);assert.equal(f.budget.availableBytes,f.budget.capacity);
});
test('one blocked channel does not stop another and same channel never overlaps',{timeout:5000},async()=>{
 const a=deferred(),started=deferred();let active=0,max=0;const seen:string[]=[];
 const f=fixture({freshHeads:async t=>[entry(t,t==='other'?2n:1n)],http:async e=>{seen.push(e.id);if(e.channel===1n){active++;max=Math.max(max,active);await a.promise;active--;}if(e.id==='other')started.resolve();}});for(const t of ['a','a2','other'])f.scheduler.offer(f.live(t));f.scheduler.finishInput();const running=f.scheduler.run(new AbortController().signal,new ManualTicks());await started.promise;assert.equal(active,1);assert.equal(seen.length,2);a.resolve();await running;assert.equal(max,1);assert.equal(seen.length,3);
});
test('failed state reports exact error and never offers fresh delivery heads',{timeout:5000},async()=>{
 const failure=new Error('state'),f=fixture({state:async()=>{throw failure;},freshHeads:async()=>{throw new Error('must not read');}});f.scheduler.offer(f.live('a'));f.scheduler.finishInput();await f.scheduler.run(new AbortController().signal,new ManualTicks());assert.deepEqual(f.errors,[failure]);assert.deepEqual(f.sent,[]);assert.equal(f.budget.availableBytes,f.budget.capacity);
});
test('maintenance is single-flight even when several discovery ticks elapse',{timeout:5000},async()=>{
 let now=0,count=0;const maintenance=deferred(),entered=deferred(),abort=new AbortController(),ticks=new ManualTicks(),f=fixture({maintain:async()=>{count++;entered.resolve();await maintenance.promise;}},()=>now);const running=f.scheduler.run(abort.signal,ticks);await entered.promise;for(let i=0;i<4;i++){now+=40000;ticks.fire();await tick();await tick();}assert.equal(count,1);abort.abort();let done=false;void running.then(()=>{done=true;});await tick();assert.equal(done,false);maintenance.resolve();await running;assert.equal(ticks.closed,true);
});
test('five-second drain boundary cancels state but joins the work before closing',{timeout:5000},async()=>{
 let now=0;const entered=deferred(),finished=deferred(),ticks=new ManualTicks();let signal:AbortSignal|undefined;
 const f=fixture({state:async(_w,_p,s)=>{signal=s;entered.resolve();await finished.promise;},freshHeads:async()=>[]},()=>now);f.scheduler.offer(f.live('a'));f.scheduler.finishInput();let done=false;const running=f.scheduler.run(new AbortController().signal,ticks).then(()=>{done=true;});await entered.promise;now=5001;ticks.fire();await tick();await tick();assert.equal(signal?.aborted,true);assert.equal(done,false);assert.ok(f.budget.availableBytes<f.budget.capacity);finished.resolve();await running;assert.equal(f.budget.availableBytes,f.budget.capacity);
});
test('pre-aborted scheduler disposes input without starting state, maintenance or HTTP',{timeout:5000},async()=>{
 const abort=new AbortController();abort.abort(new Error('cancel'));const f=fixture();f.scheduler.offer(f.live('a'));await f.scheduler.run(abort.signal,new ManualTicks());assert.deepEqual(f.states,[]);assert.equal(f.maint(),0);assert.equal(f.budget.availableBytes,f.budget.capacity);
});

import {storeFixture} from '../../../helpers/store-fixture.ts';
import {usingInitializedStore} from '../../../../src/store/owned-scope.ts';
import {StateAccessFacade as state} from '../../../../src/store/state-access-facade.ts';
import {deliverCompletionEntry} from '../../../../src/runtime/completion/scheduler/http-work.ts';
test('actual metadata scan and guarded receipt delivery retire Final and finish the rescan',{timeout:5000},async()=>storeFixture(async path=>{
 await usingInitializedStore(path,db=>{db.exec("INSERT INTO codex_delivery_outbox(delivery_id,job_id,target_thread_id,turn_id,channel_id,content,created_at,updated_at) VALUES ('d','j','t','u',1,'final',1,1)");});const errors:unknown[]=[],sent:string[]=[],identity={instanceId:()=> 'runtime',generation:()=>1n};
 const scheduler=new CompletionScheduler(path,{...identity,prepare:()=>{throw new Error('No state work');},state:async()=>{throw new Error('No state work');},prepareFailed:e=>{throw e;},freshHeads:async t=>state.completionHeadsForTarget(path,t,'runtime',1n),maintain:async()=>{},http:async e=>deliverCompletionEntry(path,e,identity,{transport:{sendValidated:async r=>{sent.push(JSON.parse(r.body).content);return 99n;}},failures:{render:()=> 'safe'},now:()=>1},{deliverChecked:async()=>{throw new Error('No question');}}),report:e=>{errors.push(e);},gap:e=>{errors.push(e);}});scheduler.finishInput();await scheduler.run(new AbortController().signal);assert.deepEqual(sent,['final']);assert.deepEqual(errors,[]);assert.deepEqual(await state.listPendingDeliveries(path),[]);
}));
test('negative orphan metadata is consumed before state dispatch and its evidence is retained',{timeout:5000},async()=>storeFixture(async path=>{
 await usingInitializedStore(path,db=>{db.exec("INSERT INTO cdr_async_execution_obligations(question_id,thread_id,origin_job_id,turn_id,channel_id,format_version,revision,answer_state,execution_state,admission_state,policy,claim_json,original_error,created_at,updated_at) VALUES ('q','orphan','lost','turn',1,1,0,'unresolved','unresolved','held','ordinary','{}','original uncertainty',0,0)");});let attempts=0;const errors:unknown[]=[];
 const scheduler=new CompletionScheduler(path,{instanceId:()=> 'runtime',generation:()=>1n,prepare:()=>{attempts++;throw new Error('Unprovable orphan dispatched');},state:async()=>{},http:async()=>{},prepareFailed:e=>{errors.push(e);},freshHeads:async()=>[],maintain:async()=>{},report:e=>{errors.push(e);},gap:e=>{errors.push(e);}});scheduler.finishInput();await scheduler.run(new AbortController().signal);assert.equal(attempts,0);assert.deepEqual(errors,[]);await usingInitializedStore(path,db=>{assert.equal(db.prepare('SELECT count(*) AS n FROM cdr_async_execution_obligations').get()?.n,1);});
}));
