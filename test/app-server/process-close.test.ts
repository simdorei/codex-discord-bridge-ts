import assert from "node:assert/strict";
import {test} from "node:test";
import {ClientLifecycle} from "../../src/app-server/client-lifecycle.ts";
import {ClientRuntimeState} from "../../src/app-server/runtime-state.ts";
import {PendingResponses} from "../../src/app-server/pending-responses.ts";
import {ClientCloseCoordinator} from "../../src/app-server/close-coordinator.ts";
import {AppServerWriter,type OwnedAppServerInput} from "../../src/app-server/writer.ts";
import {ClientProcessCloser,type OwnedChildWait} from "../../src/app-server/process-close.ts";
import {AppServerRequestError} from "../../src/app-server/request-client.ts";
import {OwnedPortableAppServerProcess} from "../../src/app-server/portable-process.ts";
import {NodeAppServerInput} from "../../src/app-server/node-streams.ts";
function fixture(child:OwnedChildWait|null,shutdown:(input:OwnedAppServerInput)=>Promise<void>=async()=>{}){
  const gate=new ClientLifecycle(),state=new ClientRuntimeState(123),pending=new PendingResponses(gate),logical=new ClientCloseCoordinator(gate,state,pending),writer=new AppServerWriter({async writeAll(){},async flush(){}},logical);state.commitInitialized();
  return {gate,state,pending,logical,writer,closer:new ClientProcessCloser(logical,state,writer,child,shutdown,{gracefulMs:1,forcedMs:1})};
}
const canceledWait=(signal?:AbortSignal)=>new Promise<void>((_resolve,reject)=>{if(signal?.aborted){reject(signal.reason);return;}signal?.addEventListener("abort",()=>reject(signal.reason),{once:true});});
test("graceful close takes input once, reaps, then publishes and drains pending",async()=>{
  const events:string[]=[],f=fixture({async wait(){events.push("wait");},startKill(){events.push("kill");}},async()=>{events.push("shutdown");});
  const response=f.pending.register("p",f.gate.admit(),1000,false);await f.closer.close();assert.deepEqual(events,["shutdown","wait"]);assert.equal(f.state.processExitConfirmed,true);assert.equal(f.closer.hasRetainedChild,false);assert.equal(f.state.snapshot().healthy,false);assert.equal((await response.result).kind,"TransportClosed");assert.equal(await f.gate.waitClosed(),"closed by client");await f.closer.close();assert.deepEqual(events,["shutdown","wait"]);
});
test("shutdown failure stays first even when wait and kill also fail",async()=>{
  const shutdown={},wait={},kill={},f=fixture({async wait(){throw wait;},startKill(){throw kill;}},async()=>{throw shutdown;});await assert.rejects(f.closer.close(),e=>e===shutdown);assert.equal(f.state.processExitConfirmed,false);assert.equal(f.closer.hasRetainedChild,true);assert.equal(f.logical.closed,true);assert.equal(await f.gate.waitClosed(),"closed by client");
});
test("graceful timeout forces kill but only successful second wait proves exit",async()=>{
  let waits=0,kills=0;const f=fixture({wait(signal){return waits++===0?canceledWait(signal):Promise.resolve();},startKill(){kills++;}});await f.closer.close();assert.equal(waits,2);assert.equal(kills,1);assert.equal(f.state.processExitConfirmed,true);assert.equal(f.closer.hasRetainedChild,false);
});
test("forced timeout retains exact child and a later close can confirm it",async()=>{
  let exited=false,kills=0;const f=fixture({wait:signal=>exited?Promise.resolve():canceledWait(signal),startKill(){kills++;}});
  await assert.rejects(f.closer.close(),error=>error instanceof AppServerRequestError&&error.detail.kind==="Timeout"&&error.detail.method==="process/exit");assert.equal(f.state.processExitConfirmed,false);assert.equal(f.closer.hasRetainedChild,true);exited=true;await f.closer.close();assert.equal(kills,1);assert.equal(f.state.processExitConfirmed,true);assert.equal(f.closer.hasRetainedChild,false);
});
test("input is taken under the same writer lock after an in-flight write finishes",async()=>{
  let release!:()=>void,entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;}),blocked=new Promise<void>(resolve=>{release=resolve;}),gate=new ClientLifecycle(),state=new ClientRuntimeState(1),pending=new PendingResponses(gate),logical=new ClientCloseCoordinator(gate,state,pending),events:string[]=[];
  const writer=new AppServerWriter({async writeAll(){entered();await blocked;events.push("written");},async flush(){events.push("flush");}},logical),closer=new ClientProcessCloser(logical,state,writer,null,async()=>{events.push("shutdown");});
  const write=writer.write({},{check(){},dispose(){}},()=>{});await ready;const close=closer.close();await Promise.resolve();assert.deepEqual(events,[]);assert.equal(logical.closed,true);release();await write;await close;assert.deepEqual(events,["written","flush","shutdown"]);assert.equal(state.processExitConfirmed,false);
});
test("concurrent close callers share one child reaping and one input take",async()=>{
  let shutdowns=0,waits=0;const f=fixture({async wait(){waits++;await Promise.resolve();},startKill(){throw Error("not reached");}},async()=>{shutdowns++;await Promise.resolve();});await Promise.all([f.closer.close(),f.closer.close()]);assert.equal(shutdowns,1);assert.equal(waits,1);assert.equal(f.state.processExitConfirmed,true);
});
test("actual native helper closes gracefully after serialized stdin shutdown",{timeout:10000},async t=>{
  const child=await OwnedPortableAppServerProcess.spawn({executable:process.execPath,arguments:["-e",'process.stdin.resume();'],environment:{}});t.after(()=>child.forceDispose());
  const gate=new ClientLifecycle(),state=new ClientRuntimeState(child.processId),pending=new PendingResponses(gate),logical=new ClientCloseCoordinator(gate,state,pending),writer=new AppServerWriter(child.input,logical),kill=t.mock.method(child,"startKill");
  const closer=new ClientProcessCloser(logical,state,writer,child,async input=>{assert.ok(input instanceof NodeAppServerInput);try{await input.shutdown();}finally{await input.destroyAndJoin();}});
  await closer.close();assert.equal(kill.mock.calls.length,0);assert.equal(child.exitConfirmed,true);assert.equal(state.processExitConfirmed,true);assert.equal(closer.hasRetainedChild,false);kill.mock.restore();
});
