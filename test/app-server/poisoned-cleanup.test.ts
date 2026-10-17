import assert from "node:assert/strict";
import {test} from "node:test";
import {ClientLifecycle,ClientLifecyclePoisonedError} from "../../src/app-server/client-lifecycle.ts";
import {ClientRuntimeState} from "../../src/app-server/runtime-state.ts";
import {PendingResponses} from "../../src/app-server/pending-responses.ts";
import {ClientCloseCoordinator} from "../../src/app-server/close-coordinator.ts";
import {ClientProcessCloser} from "../../src/app-server/process-close.ts";
import {AppServerWriter} from "../../src/app-server/writer.ts";
test("poisoned admission still permits owned cleanup without permitting new work",async()=>{
  const gate=new ClientLifecycle(),state=new ClientRuntimeState(123),pending=new PendingResponses(gate),logical=new ClientCloseCoordinator(gate,state,pending),writer=new AppServerWriter({async writeAll(){},async flush(){}},logical),events:string[]=[];
  state.commitInitialized();const reply=pending.register("pending",gate.admit(),1000,false);
  const closer=new ClientProcessCloser(logical,state,writer,{async wait(){events.push("reaped");},startKill(){events.push("kill");}},async()=>{events.push("shutdown");});
  const primary={};assert.throws(()=>gate.withOpen(()=>{throw primary;}),e=>e===primary);assert.throws(()=>gate.admit(),ClientLifecyclePoisonedError);
  try{await closer.close();assert.deepEqual(events,["shutdown","reaped"]);assert.equal(state.snapshot().healthy,false);assert.equal(state.processExitConfirmed,true);assert.equal((await reply.result).kind,"TransportClosed");assert.equal(await gate.waitClosed(),"closed by client");assert.equal(gate.snapshot().poisoned,true);assert.equal(gate.snapshot().inFlight,0n);assert.throws(()=>gate.admit(),ClientLifecyclePoisonedError);}
  finally{pending.transportClosedAll("test cleanup");}
});
test("poisoned stdout handler can publish logical failure while retaining incoming work",async()=>{
  const gate=new ClientLifecycle(),state=new ClientRuntimeState(123),pending=new PendingResponses(gate),logical=new ClientCloseCoordinator(gate,state,pending);state.commitInitialized();
  assert.throws(()=>gate.withOpen(()=>{throw Error("handler");}));await logical.markClosed("stdout handler failed");assert.equal(state.snapshot().healthy,false);assert.equal(state.processExitConfirmed,false);assert.equal(await gate.waitClosed(),"stdout handler failed");assert.equal(gate.snapshot().poisoned,true);
});
test("cleanup close is not allowed to reenter an active critical callback",()=>{
  const gate=new ClientLifecycle(),state=new ClientRuntimeState(),logical=new ClientCloseCoordinator(gate,state,new PendingResponses(gate));
  assert.throws(()=>gate.withOpen(()=>logical.beginClientClose("reentrant")),/reenter/);assert.equal(gate.snapshot().sealed,false);assert.equal(gate.snapshot().poisoned,true);
});
test("poisoned client still reaps its actual owned native helper",{timeout:10000},async t=>{
  const {OwnedPortableAppServerProcess}=await import("../../src/app-server/portable-process.ts"),{NodeAppServerInput}=await import("../../src/app-server/node-streams.ts");
  const native=await OwnedPortableAppServerProcess.spawn({executable:process.execPath,arguments:["-e","process.stdin.resume();"],environment:{}});t.after(()=>native.forceDispose());
  const gate=new ClientLifecycle(),state=new ClientRuntimeState(native.processId),pending=new PendingResponses(gate),logical=new ClientCloseCoordinator(gate,state,pending),writer=new AppServerWriter(native.input,logical),closer=new ClientProcessCloser(logical,state,writer,native,async input=>{assert.ok(input instanceof NodeAppServerInput);try{await input.shutdown();}finally{await input.destroyAndJoin();}});
  state.commitInitialized();assert.throws(()=>gate.withOpen(()=>{throw Error("synthetic callback failure");}));await closer.close();await native.forceDispose();assert.equal(native.exitConfirmed,true);assert.equal(native.stdioClosed,true);assert.equal(state.processExitConfirmed,true);assert.equal(state.snapshot().healthy,false);assert.equal(gate.snapshot().poisoned,true);assert.throws(()=>gate.admit(),ClientLifecyclePoisonedError);
});
