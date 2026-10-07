import assert from "node:assert/strict";
import {test} from "node:test";
import {storeFixture} from "../../helpers/store-fixture.ts";
import {QueueForkCoordinator,type ForkBackend} from "../../../src/runtime/queue-runner/fork-coordinator.ts";
import {ForkRuntimeError} from "../../../src/runtime/queue-runner/fork-errors.ts";
import {BackendFailureError} from "../../../src/runtime/queue-runner/errors.ts";
import {TargetLocks} from "../../../src/runtime/queue-runner/target-locks.ts";
import {StateAccessFacade as state} from "../../../src/store/state-access-facade.ts";
import {openInitialized} from "../../../src/store/owned-driver.ts";
import {queueJob} from "../../helpers/queue-job.ts";
async function sql(path:string,s:string):Promise<void>{const db=await openInitialized(path);try{db.exec(s);}finally{db.close();}}
function backend(fork:(s:string)=>Promise<string>,requires=true):ForkBackend{return {generation:()=>1n,requiresAppServerFork:()=>requires,forkThread:fork};}
test("simultaneous target preparation issues one fork after a durable intent and shares the completed result",async()=>{
  await storeFixture(async path=>{let calls=0;const locks=new TargetLocks(),b=backend(async source=>{calls++;assert.ok(await state.unresolvedAppServerForkHandoffForSource(path,source));return "new";}),c=new QueueForkCoordinator(path,b,state,locks);
    const results=await Promise.all([c.ensureTarget("source"),c.ensureTarget("source")]);assert.equal(calls,1);assert.equal(results[0]?.threadId,"new");assert.equal(results[1]?.threadId,"new");assert.equal(locks.activeTargetCount,0);
    assert.equal((await c.ensureTarget("new")).threadId,"new");assert.equal(calls,1);
  });
});
test("ambiguous or unknown fork outcomes stay fenced and a later call cannot replay RPC",async()=>{
  for(const known of [true,false])await storeFixture(async path=>{let calls=0;const failure=known?new BackendFailureError({kind:"Other",ambiguous:true,message:"timeout"}):new Error("unexpected adapter loss"),locks=new TargetLocks();
    const c=new QueueForkCoordinator(path,backend(async()=>{calls++;throw failure;}),state,locks);
    await assert.rejects(()=>c.ensureTarget("source"),known?(e=>e instanceof ForkRuntimeError&&e.kind==="ForkBackend"):(e=>e===failure));
    await assert.rejects(()=>c.ensureTarget("source"),e=>e instanceof ForkRuntimeError&&e.kind==="UnresolvedForkHandoff");assert.equal(calls,1);assert.equal(locks.activeTargetCount,0);
    assert.equal((await state.unresolvedAppServerForkHandoffForSource(path,"source"))?.forkFailureAmbiguous,true);
  });
});
test("a definite backend failure cancels only its exact fence and missing backend support is definite",async()=>{
  await storeFixture(async path=>{const c=new QueueForkCoordinator(path,backend(async()=>{throw new BackendFailureError({kind:"Other",ambiguous:false,message:"not dispatched"});}));
    await assert.rejects(()=>c.ensureTarget("source"),e=>e instanceof ForkRuntimeError&&e.kind==="ForkBackend");assert.equal(await state.unresolvedAppServerForkHandoffForSource(path,"source"),null);
    const missing=new QueueForkCoordinator(path,{generation:()=>1n,requiresAppServerFork:()=>true});await assert.rejects(()=>missing.ensureTarget("source"),/not supported/);assert.equal(await state.unresolvedAppServerForkHandoffForSource(path,"source"),null);
  });
});
test("staging failure does not repeat a successful RPC and error retains the observed target",async()=>{
  await storeFixture(async path=>{let calls=0;const failure=new Error("staging unavailable"),c=new QueueForkCoordinator(path,backend(async()=>{calls++;return "returned";}),{...state,stageAppServerForkTarget:async()=>{throw failure;}});
    await assert.rejects(()=>c.ensureTarget("source"),e=>e instanceof ForkRuntimeError&&e.kind==="ForkTargetStage"&&e.details.kind==="ForkTargetStage"&&e.details.targetThreadId==="returned"&&e.details.staging===failure);
    await assert.rejects(()=>c.ensureTarget("source"),/automatic retry is blocked/);assert.equal(calls,1);
  });
});
test("self-target response reaches the store refusal without reacquiring its own mutex",async()=>{
  await storeFixture(async path=>{const locks=new TargetLocks(),c=new QueueForkCoordinator(path,backend(async s=>s),state,locks);
    await assert.rejects(()=>c.ensureTarget("source"),e=>e instanceof ForkRuntimeError&&e.kind==="ForkFinalize");assert.equal(locks.activeTargetCount,0);
    assert.equal((await state.unresolvedAppServerForkHandoffForSource(path,"source"))?.observedTargetThreadId,"source");
  });
});
test("crossing fork responses cannot convert each other's source intent into a completed ownership cycle",async()=>{
  await storeFixture(async path=>{let calls=0,release!:()=>void;const barrier=new Promise<void>(r=>{release=r;}),locks=new TargetLocks();
    const c=new QueueForkCoordinator(path,backend(async s=>{calls++;if(calls===2)release();await barrier;return s==="a"?"b":"a";}),state,locks);
    const results=await Promise.allSettled([c.ensureTarget("a"),c.ensureTarget("b")]);assert.equal(results.every(r=>r.status==="rejected"),true);assert.equal(locks.activeTargetCount,0);
    assert.equal(await state.completedAppServerForkTargetForSource(path,"a"),null);assert.equal(await state.completedAppServerForkTargetForSource(path,"b"),null);
  });
});
test("non-fork backend skips locks/RPC only after the source hold check",async()=>{
  await storeFixture(async path=>{const c=new QueueForkCoordinator(path,backend(async()=>assert.fail("unexpected fork"),false));assert.deepEqual(await c.ensureTarget("source"),{threadId:"source",forkedFrom:null,quarantinedJobId:null});
    await sql(path,"INSERT INTO codex_dead_generation_holds(target_thread_id,runtime_id,generation,created_at) VALUES ('source','runtime',1,0)");await assert.rejects(()=>c.ensureTarget("source"),/manual review is required/);
  });
});
test("backend generation is checked even when an ambiguous job supplies the handoff generation",async()=>{
  await storeFixture(async path=>{await state.enqueue(path,queueJob({targetThreadId:"source"}));await sql(path,"UPDATE codex_turn_queue SET state='starting',last_error='known'");let called=false;
    const c=new QueueForkCoordinator(path,{generation:()=>-1n,requiresAppServerFork:()=>true,forkThread:async()=>{called=true;return "new";}});
    await assert.rejects(()=>c.ensureTarget("source"),/does not fit/);assert.equal(called,false);assert.equal(await state.unresolvedAppServerForkHandoffForSource(path,"source"),null);
  });
});
