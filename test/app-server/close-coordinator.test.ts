import assert from "node:assert/strict";
import {test} from "node:test";
import {ClientLifecycle} from "../../src/app-server/client-lifecycle.ts";
import {ClientRuntimeState} from "../../src/app-server/runtime-state.ts";
import {PendingResponses} from "../../src/app-server/pending-responses.ts";
import {ClientCloseCoordinator} from "../../src/app-server/close-coordinator.ts";
import {ServerRequestOccurrence} from "../../src/protocol/ids.ts";
test("losing close cannot publish before winning pending cleanup finishes",async()=>{
  const lifecycle=new ClientLifecycle(),state=new ClientRuntimeState(42),pending=new PendingResponses(lifecycle);state.commitInitialized();const request=pending.register("pending",lifecycle.admit(),10000,false);
  let release!:()=>void;const blocked=new Promise<void>(resolve=>release=resolve);let cleanup=0;
  const closer=new ClientCloseCoordinator(lifecycle,state,{async transportClosedAll(reason){cleanup++;assert.equal(lifecycle.snapshot().sealed,true);assert.equal(state.snapshot().initialized,false);assert.equal(state.snapshot().processId,null);assert.equal(pending.size,1);await blocked;pending.transportClosedAll(reason);}});
  let published=false;const closed=lifecycle.waitClosed().then(reason=>{published=true;return reason;});const first=closer.markClosed("first");assert.equal(closer.closed,true);assert.equal(state.snapshot().closedReason,"first");
  await closer.markClosed("second");assert.equal(cleanup,1);assert.equal(published,false);assert.equal(lifecycle.snapshot().closedReason,null);assert.equal(lifecycle.snapshot().inFlight,1n);
  release();await first;assert.equal(await closed,"first");assert.deepEqual(await request.result,{kind:"TransportClosed",reason:"first"});assert.equal(lifecycle.snapshot().inFlight,0n);assert.equal(pending.size,0);request.finish();request.dispose();
});
test("requested close intent wins observed EOF and all outgoing responses settle before signal",async()=>{
  const lifecycle=new ClientLifecycle(),state=new ClientRuntimeState(),pending=new PendingResponses(lifecycle),one=pending.register(1n,lifecycle.admit(),1000,false),two=pending.register(2n,lifecycle.admit(),1000,false);
  lifecycle.sealForClose("requested shutdown");const closer=new ClientCloseCoordinator(lifecycle,state,pending);await closer.markClosed("EOF");assert.equal(await lifecycle.waitClosed(),"requested shutdown");assert.equal(state.snapshot().closedReason,"requested shutdown");assert.equal(pending.size,0);assert.equal(lifecycle.snapshot().inFlight,0n);assert.equal((await one.result).kind,"TransportClosed");assert.equal((await two.result).kind,"TransportClosed");one.finish();one.dispose();two.finish();two.dispose();
});
test("cleanup failure leaves close unpublished and a loser cannot fabricate completion",async()=>{
  const lifecycle=new ClientLifecycle(),state=new ClientRuntimeState(),sentinel={cleanup:true};let calls=0;const closer=new ClientCloseCoordinator(lifecycle,state,{transportClosedAll(){calls++;throw sentinel;}});
  await assert.rejects(closer.markClosed("first"),e=>e===sentinel);await closer.markClosed("second");assert.equal(calls,1);assert.equal(closer.closed,true);assert.equal(state.snapshot().closedReason,"first");assert.equal(lifecycle.snapshot().closedReason,null);
});
test("transport close never settles incoming approvals or active turn evidence",async()=>{
  const lifecycle=new ClientLifecycle(),state=new ClientRuntimeState(),pending=new PendingResponses(lifecycle);state.recordNotification({method:"turn/started",params:{threadId:"t",turnId:"u"}});state.recordServerRequest({id:"approval",occurrence:ServerRequestOccurrence.fromBytes(new Uint8Array(16)),method:"item/commandExecution/requestApproval",params:{threadId:"t"}});
  await new ClientCloseCoordinator(lifecycle,state,pending).markClosed("EOF");const dead=state.deadGenerationWork(7n)!;assert.equal(dead.activeTurns.length,1);assert.equal(dead.serverRequests.length,1);assert.equal(state.hasUnsettledServerRequests,true);
});
