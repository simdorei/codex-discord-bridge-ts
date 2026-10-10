import assert from "node:assert/strict";
import {test,mock} from "node:test";
import {DelayedTicks,type TickSource} from "../../../src/runtime/delayed-ticks.ts";
import {runPromptIntakeRecoveryWorker,type IntakeWorkerError} from "../../../src/runtime/prompt-intake/recovery-worker.ts";
import {AdmissionGate,DrainFenceKey,DrainGateError} from "../../../src/admission/drain-gate.ts";
const flush=()=>new Promise<void>(r=>setImmediate(r));
class ManualTicks implements TickSource{wake:(()=>void)|undefined;closed=false;wait(){return new Promise<void>(r=>{this.wake=r;});}fire(){assert.ok(this.wake);const r=this.wake;this.wake=undefined;r();}close(){this.closed=true;this.wake?.();}}
test("delayed ticks skip immediate execution and restart interval at late consumption without bursts",async()=>{
  mock.timers.enable({apis:["setTimeout"]});const ticks=new DelayedTicks(30);
  try{let done=false;const first=ticks.wait().then(()=>{done=true;});mock.timers.tick(29);await Promise.resolve();assert.equal(done,false);mock.timers.tick(1);await first;
    mock.timers.tick(1000);await ticks.wait();done=false;const next=ticks.wait().then(()=>{done=true;});mock.timers.tick(29);await Promise.resolve();assert.equal(done,false);mock.timers.tick(1);await next;assert.equal(done,true);
  }finally{ticks.close();mock.timers.reset();}
});
test("worker waits for its first tick and shuts down idle without recovering or releasing foreign ownership",async()=>{
  const ticks=new ManualTicks(),abort=new AbortController(),gate=new AdmissionGate();let calls=0;
  const pending=runPromptIntakeRecoveryWorker({recoverPromptIntakes:async()=>{calls++;return 0;}},gate,abort.signal,{ticks:()=>ticks});await flush();assert.equal(calls,0);abort.abort();await pending;assert.equal(calls,0);assert.equal(ticks.closed,true);
});
test("sealed admission skips recovery while other admission errors are reported and a later tick proceeds",async()=>{
  const ticks=new ManualTicks(),abort=new AbortController(),gate=new AdmissionGate(),events:IntakeWorkerError[]=[];let calls=0,admissions=0;
  const pending=runPromptIntakeRecoveryWorker({recoverPromptIntakes:async()=>{calls++;return 0;}},{tryEnter:()=>{admissions++;if(admissions===1)throw new DrainGateError("Sealed");if(admissions===2)throw new DrainGateError("LockPoisoned");return gate.tryEnter();}},abort.signal,{ticks:()=>ticks,onError:e=>{events.push(e);}});
  ticks.fire();await flush();assert.equal(calls,0);assert.equal(events.length,0);ticks.fire();await flush();assert.equal(events[0]?.stage,"admission");ticks.fire();await flush();assert.equal(calls,1);abort.abort();await pending;
});
test("shutdown during recovery retains the restart admission until the owned cycle actually ends",async()=>{
  const ticks=new ManualTicks(),abort=new AbortController(),gate=new AdmissionGate(),key=DrainFenceKey.create("runtime","1|2","nonce");let enter!:()=>void,release!:()=>void,finished=false;
  const entered=new Promise<void>(r=>{enter=r;}),work=new Promise<void>(r=>{release=r;});
  const pending=runPromptIntakeRecoveryWorker({recoverPromptIntakes:async()=>{enter();await work;return 1;}},gate,abort.signal,{ticks:()=>ticks}).then(()=>{finished=true;});ticks.fire();await entered;
  abort.abort();gate.seal(key);await flush();assert.equal(finished,false);assert.equal(gate.isDrainedFor(key),false);release();await pending;assert.equal(gate.isDrainedFor(key),true);assert.equal(ticks.closed,true);
});
test("recovery error reports through the worker boundary, releases admission, and does not end later ticks",async()=>{
  const ticks=new ManualTicks(),abort=new AbortController(),gate=new AdmissionGate(),error=new Error("recover"),events:IntakeWorkerError[]=[];let calls=0;
  const pending=runPromptIntakeRecoveryWorker({recoverPromptIntakes:async()=>{if(++calls===1)throw error;return 0;}},gate,abort.signal,{ticks:()=>ticks,onError:e=>{events.push(e);}});
  ticks.fire();await flush();assert.deepEqual(events,[{stage:"recovery",error}]);ticks.fire();await flush();assert.equal(calls,2);abort.abort();await pending;
  const key=DrainFenceKey.create("runtime","1|2","nonce");gate.seal(key);assert.equal(gate.isDrainedFor(key),true);
});
