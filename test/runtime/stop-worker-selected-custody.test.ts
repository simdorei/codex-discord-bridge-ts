import assert from "node:assert/strict";
import {test} from "node:test";
import {StopControlWorker} from "../../src/runtime/action-executor/stop-worker.ts";
import {TargetLocks} from "../../src/core/keyed-locks.ts";
import {StoreIntegrityError} from "../../src/store/schema-assembly.ts";
import type {StopControl,StopClaim} from "../../src/store/stop-control-dispatch.ts";
test("selected change during claim retains StoreIntegrity rather than ordinary input rejection",async()=>{
  const resident="00000000-0000-4000-8000-000000000001" as const,locks=new TargetLocks();let selected="T",claims=0,wires=0;
  const c:StopControl={operation_id:"stop",target:"T",channel:42n,owner:3n,resident,generation:1n,turn:"V",binding:{target:"T",route:"Selected",command:{Stop:{reference:null}}},jobs:[],can_settle:true};
  const server={instanceId:resident,generation:()=>1n,lifecycleSnapshot:()=>({generation:1n,healthy:true,quarantined:false,restartPending:false,processId:1}),activeTurnId:()=>"V",executeStopControl:async()=>{wires++;return {};}};
  const store={pendingStopControlsAfter:()=>[[1n,c] as const],claimStopControl:(_p:string,_c:unknown,check:()=>void):StopClaim|null=>{check();claims++;return null;},recordStopControlError(){},hasObservedCompletion:async()=>{selected="other";return false;},mirroredThreadId:async()=>null};
  const worker=new StopControlWorker("fixture",server,{selectedThreadId:()=>selected},locks,e=>e instanceof Error?e.message:"opaque",()=>{},store);
  await assert.rejects(worker.process(),StoreIntegrityError);assert.equal(claims,0);assert.equal(wires,0);assert.equal(locks.activeTargetCount,0);
});
