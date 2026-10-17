import assert from "node:assert/strict";
import {test} from "node:test";
import {storeFixture} from "../../helpers/store-fixture.ts";
import {queueJob} from "../../helpers/queue-job.ts";
import {QueueForkCoordinator,isNonfatalForkRecoveryBlocker} from "../../../src/runtime/queue-runner/fork-coordinator.ts";
import {BackendFailureError} from "../../../src/runtime/queue-runner/errors.ts";
import {ForkRuntimeError} from "../../../src/runtime/queue-runner/fork-errors.ts";
import {ForkTransitionError} from "../../../src/store/fork-transition-validation.ts";
import {StateAccessFacade as state} from "../../../src/store/state-access-facade.ts";
import {openInitialized} from "../../../src/store/owned-driver.ts";
import {TargetLocks} from "../../../src/runtime/queue-runner/target-locks.ts";
async function sql(path:string,s:string):Promise<void>{const db=await openInitialized(path);try{db.exec(s);}finally{db.close();}}
async function seeds(path:string){for(const id of ["b","a"])await state.enqueue(path,queueJob({jobId:id,targetThreadId:id}));}
test("durably fenced ambiguous target does not prevent the next independent target from being prepared",async()=>{
  await storeFixture(async path=>{await seeds(path);const calls:string[]=[],blocked:string[]=[];
    const c=new QueueForkCoordinator(path,{generation:()=>1n,requiresAppServerFork:()=>true,forkThread:async s=>{calls.push(s);if(s==="a")throw new BackendFailureError({kind:"Other",ambiguous:true,message:"unknown"});return `${s}-new`;}},state,new TargetLocks(),t=>{blocked.push(t);});
    await c.prepareUnmanagedTargets();assert.deepEqual(calls,["a","b"]);assert.deepEqual(blocked,["a"]);assert.ok(await state.unresolvedAppServerForkHandoffForSource(path,"a"));assert.equal(await state.completedAppServerForkTargetForSource(path,"b"),"b-new");
    await c.prepareUnmanagedTargets();assert.deepEqual(calls,["a","b"]);
  });
});
test("definite cancellation without a durable fence remains fatal to that bulk pass",async()=>{
  await storeFixture(async path=>{await seeds(path);const calls:string[]=[];const c=new QueueForkCoordinator(path,{generation:()=>1n,requiresAppServerFork:()=>true,forkThread:async s=>{calls.push(s);throw new BackendFailureError({kind:"Other",ambiguous:false,message:"not dispatched"});}});
    await assert.rejects(()=>c.prepareUnmanagedTargets(),e=>e instanceof ForkRuntimeError&&e.kind==="ForkBackend");assert.deepEqual(calls,["a"]);assert.equal(await state.unresolvedAppServerForkHandoffForSource(path,"a"),null);assert.equal(await state.completedAppServerForkTargetForSource(path,"b"),null);
  });
});
test("held targets and unfenced in-flight jobs are skipped without a fork request",async()=>{
  await storeFixture(async path=>{for(const t of ["held","starting","running","quarantined"])await state.enqueue(path,queueJob({jobId:t,targetThreadId:t}));
    await sql(path,`INSERT INTO codex_dead_generation_holds(target_thread_id,runtime_id,generation,created_at) VALUES ('held','runtime',1,0);
      UPDATE codex_turn_queue SET state='starting' WHERE job_id='starting';
      UPDATE codex_turn_queue SET state='running',turn_id='turn' WHERE job_id='running';
      UPDATE codex_turn_queue SET state='running',turn_id='cdr-quarantined:x',last_error='[cdr-rust:app-server-fork-quarantine:v1] held' WHERE job_id='quarantined';`);
    const c=new QueueForkCoordinator(path,{generation:()=>1n,requiresAppServerFork:()=>true,forkThread:async()=>assert.fail("no eligible target")});await c.prepareUnmanagedTargets();
  });
});
test("validation refusal without a recorded fence cannot be swallowed as a recoverable blocker",async()=>{
  await storeFixture(async path=>{await seeds(path);await sql(path,"INSERT INTO mirror_threads VALUES ('a','p','t',1,2,0),('duplicate','p','t',3,2,0)");
    const c=new QueueForkCoordinator(path,{generation:()=>1n,requiresAppServerFork:()=>true,forkThread:async()=>assert.fail("mapping failed before RPC")});
    await assert.rejects(()=>c.prepareUnmanagedTargets(),e=>e instanceof ForkTransitionError&&e.kind==="MissingOrStaleMapping");assert.equal(await state.unresolvedAppServerForkHandoffForSource(path,"a"),null);
  });
});
test("writer conflict helper requires existing jobs with no active starting/running owner",async()=>{
  await storeFixture(async path=>{let forks=0;const c=new QueueForkCoordinator(path,{generation:()=>1n,requiresAppServerFork:()=>true,forkThread:async()=>{forks++;return "new";}});
    assert.equal(await c.forkWriterConflictIfSafe("source"),false);await state.enqueue(path,queueJob({targetThreadId:"source"}));await sql(path,"UPDATE codex_turn_queue SET state='starting'");
    assert.equal(await c.forkWriterConflictIfSafe("source"),false);await sql(path,"UPDATE codex_turn_queue SET state='pending'");assert.equal(await c.forkWriterConflictIfSafe("source"),true);assert.equal(forks,1);
  });
});
test("non-fork backend has no bulk storage work, and native/recording errors remain fatal",async()=>{
  const c=new QueueForkCoordinator("unused",{generation:()=>1n,requiresAppServerFork:()=>false},{...state,listFiltered:async()=>assert.fail("no read")});await c.prepareUnmanagedTargets();
  assert.equal(isNonfatalForkRecoveryBlocker(new Error("sqlite failure")),false);assert.equal(isNonfatalForkRecoveryBlocker({kind:"ForkBackend"}),false);
  assert.equal(isNonfatalForkRecoveryBlocker(new ForkRuntimeError({kind:"ForkFailureRecording",sourceThreadId:"s",handoffId:"h",failure:{kind:"Other",ambiguous:true,message:"timeout"},recording:new Error("database")})),false);
  assert.equal(isNonfatalForkRecoveryBlocker(new ForkTransitionError({kind:"AdditionalInFlight",sourceThreadId:"s"})),true);
});
