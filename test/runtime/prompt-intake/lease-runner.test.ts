import assert from "node:assert/strict";
import {test} from "node:test";
import {PromptClaimLeaseRunner,type RenewalTicks} from "../../../src/runtime/prompt-intake/lease-runner.ts";
import type {PromptIntakeClaim} from "../../../src/store/prompt-intake.ts";
const flush=()=>new Promise<void>(r=>setImmediate(r));
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
class ManualTicks implements RenewalTicks{wake:(()=>void)|undefined;closed=false;wait(){return new Promise<void>(r=>{this.wake=r;});}fire(){assert.ok(this.wake);const wake=this.wake;this.wake=undefined;wake();}close(){this.closed=true;this.wake?.();this.wake=undefined;}}
const claim=():PromptIntakeClaim=>({claimToken:"token",intake:{jobId:"job",targetThreadId:"thread",channelId:1n,ownerUserId:2n,discordMessageId:null,rawPrompt:"raw",autoQueueWhenBusy:true,requireCurrentMirror:false,
  attemptCount:0n,lastError:"",retryAfter:0,claimToken:"token",claimExpiresAt:610,createdAt:0,updatedAt:0}});
const renewed=(c:PromptIntakeClaim,expires:number):PromptIntakeClaim=>({claimToken:c.claimToken,intake:{...c.intake,claimExpiresAt:expires}});
test("initial renewal must succeed before processing, and initial failures do not start timers",async()=>{
  for(const fail of [false,true]){const error=new Error("renew"),runner=new PromptClaimLeaseRunner("unused",{renewPromptIntakeClaimIfCurrent:async()=>{if(fail)throw error;return null;},promptIntakeHasDurableOwner:async()=>false},()=>10,()=>assert.fail("no timer before initial ownership"));
    const result=await runner.run(claim(),async()=>assert.fail("no processing"));assert.deepEqual(result,fail?{kind:"Finished",result:{ok:false,error}}:{kind:"Lost"});
  }
});
test("renewal extends current lease while processing owns a separate snapshot",async()=>{
  const ticks=new ManualTicks(),work=deferred<string>(),calls:Array<readonly [number,number,string]>=[];let now=10;
  const runner=new PromptClaimLeaseRunner("unused",{renewPromptIntakeClaimIfCurrent:async(_,c,n,e)=>{calls.push([n,e,c.intake.rawPrompt]);return renewed(c,e);},promptIntakeHasDurableOwner:async()=>false},()=>now,()=>ticks);
  const input=claim(),pending=runner.run(input,async c=>{c.intake.rawPrompt="processor changed";return work.promise;});input.intake.rawPrompt="caller changed";await flush();now=130;ticks.fire();await flush();work.resolve("done");
  assert.deepEqual(await pending,{kind:"Finished",result:{ok:true,value:"done"}});assert.deepEqual(calls,[[10,611,"raw"],[130,730,"raw"]]);assert.equal(ticks.closed,true);
});
test("lease loss requests cancellation but does not report completion until processing settles",async()=>{
  const ticks=new ManualTicks(),work=deferred<string>();let calls=0,signal:AbortSignal|undefined,finished=false;
  const runner=new PromptClaimLeaseRunner("unused",{renewPromptIntakeClaimIfCurrent:async(_,c,_n,e)=>++calls===1?renewed(c,e):null,promptIntakeHasDurableOwner:async()=>false},()=>10,()=>ticks);
  const pending=runner.run(claim(),async(_c,s)=>{signal=s;return work.promise;}).then(r=>{finished=true;return r;});await flush();ticks.fire();await flush();assert.equal(signal?.aborted,true);assert.equal(finished,false);
  work.resolve("late result");assert.deepEqual(await pending,{kind:"Lost"});assert.equal(ticks.closed,true);
});
test("after durable promotion a missing intake lease does not cancel the already-owned queue operation",async()=>{
  const ticks=new ManualTicks(),work=deferred<string>();let calls=0,signal:AbortSignal|undefined;
  const runner=new PromptClaimLeaseRunner("unused",{renewPromptIntakeClaimIfCurrent:async(_,c,_n,e)=>++calls===1?renewed(c,e):null,promptIntakeHasDurableOwner:async()=>true},()=>10,()=>ticks);
  const pending=runner.run(claim(),async(_c,s)=>{signal=s;return work.promise;});await flush();ticks.fire();await flush();assert.equal(signal?.aborted,false);work.resolve("owned result");assert.deepEqual(await pending,{kind:"Finished",result:{ok:true,value:"owned result"}});assert.equal(ticks.closed,true);
});
test("renewal error preserves the primary error and joins even a cancellation-ignoring processor",async()=>{
  const ticks=new ManualTicks(),work=deferred<string>(),error=new Error("database unavailable");let calls=0,finished=false;
  const runner=new PromptClaimLeaseRunner("unused",{renewPromptIntakeClaimIfCurrent:async(_,c,_n,e)=>{if(++calls===1)return renewed(c,e);throw error;},promptIntakeHasDurableOwner:async()=>false},()=>10,()=>ticks);
  const pending=runner.run(claim(),async()=>work.promise).then(r=>{finished=true;return r;});await flush();ticks.fire();await flush();assert.equal(finished,false);work.resolve("ignored late value");
  assert.deepEqual(await pending,{kind:"Finished",result:{ok:false,error}});assert.equal(ticks.closed,true);
});
test("a ready renewal takes precedence when processing completion is ready in the same microtask batch",async()=>{
  const ticks=new ManualTicks(),work=deferred<string>();let calls=0;
  const runner=new PromptClaimLeaseRunner("unused",{renewPromptIntakeClaimIfCurrent:async(_,c,_n,e)=>{calls++;return renewed(c,e);},promptIntakeHasDurableOwner:async()=>false},()=>10,()=>ticks);
  const pending=runner.run(claim(),async()=>work.promise);await flush();work.resolve("done");ticks.fire();assert.deepEqual(await pending,{kind:"Finished",result:{ok:true,value:"done"}});assert.equal(calls,2);
});

test("real SQLite lease replacement cancels late preparation before any queue/turn submission",async()=>{
  const {storeFixture}=await import("../../helpers/store-fixture.ts");
  const {admitPromptIntake}=await import("../../../src/store/prompt-intake-write.ts");
  const {tryClaimPromptIntake}=await import("../../../src/store/prompt-intake.ts");
  const {StateAccessFacade}=await import("../../../src/store/state-access-facade.ts");
  const {openInitialized}=await import("../../../src/store/owned-driver.ts");
  const {QueueStartCoordinator}=await import("../../../src/runtime/queue-runner/start-coordinator.ts");
  const {PreparedPromptExecutor}=await import("../../../src/runtime/action-executor/prepared-submission.ts");
  await storeFixture(async path=>{
    const seed=claim().intake;await admitPromptIntake(path,seed);const owned=await tryClaimPromptIntake(path,"job",10,20);assert.ok(owned);
    const ticks=new ManualTicks(),started=deferred<void>(),prepared=deferred<string>();let signal:AbortSignal|undefined,turns=0;
    const queue=new QueueStartCoordinator(path,{generation:()=>1n,residentInstanceId:()=>"resident",activeTurnId:async()=>null,resumeThread:async()=>{},readTurns:async()=>[],startClaimedTurn:async()=>{turns++;return "turn";}},{clock:()=>11});
    const executor=new PreparedPromptExecutor(path,queue,{requiresAppServerFork:()=>false,preparePrompt:async(_raw,_target,s)=>{signal=s;started.resolve();return prepared.promise;},
      busyResult:async()=>assert.fail("durable request must queue"),canonicalizeCompletedTarget:async t=>t,currentMirrorTarget:async(_,t)=>[t,"selected"],prepareActionTarget:async()=>assert.fail("no retarget"),recoverActiveWriterSubmission:async(t,s)=>[t,s]});
    const runner=new PromptClaimLeaseRunner(path,StateAccessFacade,()=>11,()=>ticks);
    const pending=runner.run(owned,(c,s)=>executor.submit({threadId:"thread",sourceLabel:"selected",mirrorMapping:false},{channelId:1n,userId:2n,discordMessageId:null,rawPrompt:"raw",autoQueueWhenBusy:true,intakeClaim:c},s));
    await started.promise;const db=await openInitialized(path);try{db.exec("UPDATE codex_prompt_intakes SET claim_token='replacement'");}finally{db.close();}
    ticks.fire();await flush();assert.equal(signal?.aborted,true);prepared.resolve("late");assert.deepEqual(await pending,{kind:"Lost"});assert.equal(turns,0);assert.deepEqual(await StateAccessFacade.listFiltered(path,null,null),[]);
  });
});

test("real atomic promotion keeps an in-flight backend result owned when intake renewal returns no row",async()=>{
  const {storeFixture}=await import("../../helpers/store-fixture.ts");
  const {admitPromptIntake}=await import("../../../src/store/prompt-intake-write.ts");
  const {tryClaimPromptIntake}=await import("../../../src/store/prompt-intake.ts");
  const {StateAccessFacade}=await import("../../../src/store/state-access-facade.ts");
  const {QueueStartCoordinator}=await import("../../../src/runtime/queue-runner/start-coordinator.ts");
  await storeFixture(async path=>{await admitPromptIntake(path,claim().intake);const owned=await tryClaimPromptIntake(path,"job",10,20);assert.ok(owned);
    const ticks=new ManualTicks(),started=deferred<void>(),ack=deferred<string>();let signal:AbortSignal|undefined;
    const queue=new QueueStartCoordinator(path,{generation:()=>1n,residentInstanceId:()=>"resident",activeTurnId:async()=>null,resumeThread:async()=>{},readTurns:async()=>[],startClaimedTurn:async()=>{started.resolve();return ack.promise;}},{clock:()=>11});
    const runner=new PromptClaimLeaseRunner(path,StateAccessFacade,()=>11,()=>ticks),pending=runner.run(owned,async(c,s)=>{signal=s;return queue.submitPromptIntake(c,"thread","prepared");});
    await started.promise;ticks.fire();await flush();assert.equal(signal?.aborted,false);ack.resolve("turn");const result=await pending;
    assert.equal(result.kind,"Finished");if(result.kind!=="Finished"||!result.result.ok)assert.fail("expected owned result");assert.equal(result.result.value.turnId,"turn");assert.equal(ticks.closed,true);
  });
});

test('external pre-abort performs no renewal or processing',async()=>{
  const controller=new AbortController(),reason=new Error('shutdown');controller.abort(reason);
  const runner=new PromptClaimLeaseRunner('unused',{renewPromptIntakeClaimIfCurrent:async()=>assert.fail('no renewal'),promptIntakeHasDurableOwner:async()=>false});
  await assert.rejects(runner.run(claim(),async()=>assert.fail('no processing'),controller.signal),e=>e===reason);
});
test('external cancellation joins cancellation-ignoring preparation and closes renewal source',async()=>{
  const ticks=new ManualTicks(),work=deferred<string>(),controller=new AbortController(),reason=new Error('shutdown');let signal:AbortSignal|undefined,finished=false;
  const runner=new PromptClaimLeaseRunner('unused',{renewPromptIntakeClaimIfCurrent:async(_,c,_n,e)=>renewed(c,e),promptIntakeHasDurableOwner:async()=>false},()=>10,()=>ticks);
  const pending=runner.run(claim(),async(_c,s)=>{signal=s;return work.promise;},controller.signal).finally(()=>{finished=true;});
  const checked=assert.rejects(pending,e=>e===reason);await flush();controller.abort(reason);await flush();assert.equal(signal?.reason,reason);assert.equal(finished,false);
  work.resolve('late');await checked;assert.equal(ticks.closed,true);
});
test('external cancellation during initial renewal prevents processor and timer creation',async()=>{
  const renewal=deferred<PromptIntakeClaim>(),controller=new AbortController(),reason=new Error('cancel renewal');
  const runner=new PromptClaimLeaseRunner('unused',{renewPromptIntakeClaimIfCurrent:async()=>renewal.promise,promptIntakeHasDurableOwner:async()=>false},()=>10,()=>assert.fail('no timer'));
  const pending=runner.run(claim(),async()=>assert.fail('no processing'),controller.signal),checked=assert.rejects(pending,e=>e===reason);
  controller.abort(reason);renewal.resolve(claim());await checked;
});
test('external cancellation still joins after intake has acquired a durable queue owner',async()=>{
  const ticks=new ManualTicks(),work=deferred<string>(),controller=new AbortController(),reason=new Error('shutdown');let calls=0,signal:AbortSignal|undefined;
  const runner=new PromptClaimLeaseRunner('unused',{renewPromptIntakeClaimIfCurrent:async(_,c,_n,e)=>++calls===1?renewed(c,e):null,promptIntakeHasDurableOwner:async()=>true},()=>10,()=>ticks);
  const pending=runner.run(claim(),async(_c,s)=>{signal=s;return work.promise;},controller.signal),checked=assert.rejects(pending,e=>e===reason);
  await flush();ticks.fire();await flush();controller.abort(reason);assert.equal(signal?.reason,reason);work.resolve('late');await checked;assert.equal(ticks.closed,true);
});
