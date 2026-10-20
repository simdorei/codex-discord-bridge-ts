import assert from "node:assert/strict";
import {test} from "node:test";
import {ClientLifecycle} from "../../src/app-server/client-lifecycle.ts";
import {ClientRuntimeState} from "../../src/app-server/runtime-state.ts";
import {ResidentAdmissionState,ResidentStateError,type ResidentDeadClientPort} from "../../src/app-server/resident-state.ts";
import {cloneDeadGenerationWork,deadGenerationWorkEqual,type DeadGenerationWork} from "../../src/app-server/dead-generation-work.ts";
import {ServerRequestOccurrence} from "../../src/protocol/ids.ts";
const occurrence=(n:number)=>{const b=Buffer.alloc(16);b[15]=n;return ServerRequestOccurrence.fromBytes(b);};
function fixture(){
  const gate=new ClientLifecycle(),runtime=new ClientRuntimeState(7);let exited=false;
  const port:ResidentDeadClientPort=Object.freeze({identity:Object.freeze({}),admitOperation:()=>gate.admit(),sealAdmissions:()=>{gate.sealForCleanup("seal");},sealIfQuiescent:()=>gate.sealIfQuiescent(()=>!runtime.hasActiveTurns&&!runtime.hasUnsettledServerRequests),withOpen:<T>(f:()=>T):T=>gate.withOpen(f),hasOwnedChildExited:()=>exited,isTransportClosed:()=>runtime.snapshot().closedReason!==null,sealIfNoAdmissions:()=>gate.sealIfQuiescent(()=>true),deadGenerationWork:(g:bigint)=>runtime.deadGenerationWork(g),settleDeadGenerationExact:(work:DeadGenerationWork)=>exited&&gate.snapshot().sealed&&gate.snapshot().inFlight===0n&&runtime.settleDeadGenerationAfterExactMatch(work)});
  return {gate,runtime,port,state:new ResidentAdmissionState(port),exit(){exited=true;},closed(){runtime.publishClosedReason("peer closed");},work(){runtime.recordNotification({method:"turn/started",params:{threadId:"t",turnId:"v"}});runtime.recordServerRequest({id:1n,occurrence:occurrence(1),method:"approval",params:{threadId:"t",large:18446744073709551615n}});}};
}
test("live quarantine may drain but published closure alone cannot authorize dead-work settlement",()=>{
  const f=fixture();f.work();f.state.markTimeout(1n);let calls=0;assert.equal(f.state.fenceDeadGenerationBeforeRestart(()=>{calls++;}),true);assert.equal(calls,0);f.closed();assert.equal(f.state.fenceDeadGenerationBeforeRestart(()=>{calls++;}),false);assert.equal(calls,0);assert.equal(f.runtime.hasActiveTurns,true);
});
test("actual exit waits for final closure and all admitted operations before durable capture",()=>{
  const f=fixture();f.work();const lease=f.state.admitRequest();f.state.requestRestart();f.exit();let calls=0;assert.equal(f.state.fenceDeadGenerationBeforeRestart(()=>{calls++;}),false);f.closed();assert.equal(f.state.fenceDeadGenerationBeforeRestart(()=>{calls++;}),false);assert.equal(calls,0);lease.release();assert.equal(f.state.fenceDeadGenerationBeforeRestart(()=>{calls++;}),true);assert.equal(calls,1);assert.equal(f.runtime.hasActiveTurns,false);assert.equal(f.runtime.hasUnsettledServerRequests,false);
});
test("persistence observes exact immutable work before any transient evidence is cleared",()=>{
  const f=fixture();f.work();f.closed();f.exit();f.state.markCurrentClosed(f.port,1n);const revision=f.runtime.notificationRevision;let saved!:DeadGenerationWork;
  assert.equal(f.state.fenceDeadGenerationBeforeRestart(work=>{saved=work;assert.equal(f.runtime.hasActiveTurns,true);assert.equal(f.runtime.hasUnsettledServerRequests,true);assert.equal(work.serverRequests[0]!.params!==null,true);assert.ok(Object.isFrozen(work));assert.throws(()=>Object.assign(work,{closedReason:"other"}),TypeError);}),true);
  assert.equal(f.runtime.hasActiveTurns,false);assert.equal(f.runtime.notificationRevision,revision);assert.equal(f.state.deadGenerationWork(1n),null);assert.equal(f.state.settleDeadGeneration(1n,saved),"AlreadySettled");let replay!:DeadGenerationWork;assert.equal(f.state.fenceDeadGenerationBeforeRestart(w=>{replay=w;}),true);assert.ok(deadGenerationWorkEqual(saved,replay));
});
test("empty dead work is still durably captured while ordinary public empty reads return null",()=>{
  const f=fixture();f.closed();f.exit();f.state.markCurrentClosed(f.port,1n);assert.equal(f.state.deadGenerationWork(1n),null);let calls=0;assert.equal(f.state.fenceDeadGenerationBeforeRestart(w=>{calls++;assert.deepEqual(w.activeTurns,[]);assert.deepEqual(w.serverRequests,[]);}),true);assert.equal(calls,1);
});
test("failed persistence and async persistence leave all work intact for a later explicit retry",()=>{
  const f=fixture();f.work();f.closed();f.exit();f.state.markCurrentClosed(f.port,1n);const sentinel={};assert.throws(()=>f.state.fenceDeadGenerationBeforeRestart(()=>{throw sentinel;}),e=>e===sentinel);assert.equal(f.runtime.hasActiveTurns,true);let calls=0;assert.throws(()=>f.state.fenceDeadGenerationBeforeRestart(async()=>{calls++;}),/synchronous/);assert.equal(calls,0);assert.equal(f.runtime.hasUnsettledServerRequests,true);assert.equal(f.state.fenceDeadGenerationBeforeRestart(()=>{}),true);
});
test("snapshot change during persistence refuses settlement and preserves newer evidence",()=>{
  const f=fixture();f.work();f.closed();f.exit();f.state.markCurrentClosed(f.port,1n);assert.throws(()=>f.state.fenceDeadGenerationBeforeRestart(()=>f.runtime.recordNotification({method:"turn/started",params:{threadId:"new",turnId:"turn"}})),error=>error instanceof ResidentStateError&&error.detail.kind==="DeadGenerationFence");assert.equal(f.runtime.activeTurnId("new"),"turn");assert.equal(f.runtime.hasUnsettledServerRequests,true);
});
test("terminal close during persistence refuses settlement",()=>{
  const f=fixture();f.work();f.closed();f.exit();f.state.markCurrentClosed(f.port,1n);assert.throws(()=>f.state.fenceDeadGenerationBeforeRestart(()=>{f.state.prepareClose();}),error=>error instanceof ResidentStateError&&error.detail.kind==="DeadGenerationFence");assert.equal(f.runtime.hasActiveTurns,true);assert.equal(f.state.snapshot().accepting,false);
});
test("intentional quiescent cleanup authorization survives missing exit without invoking persistence",()=>{
  const f=fixture();f.state.requestRestart();assert.equal(f.state.restartCandidate().kind,"Sealed");assert.equal(f.state.fenceDeadGenerationBeforeRestart(()=>{throw new Error("must not persist");}),true);assert.equal(f.state.restartCleanupAuthorized(1n),true);
});
test("exact cached settlement is idempotent even after a new generation while changed old work mismatches",()=>{
  const f=fixture(),next=fixture();f.work();f.closed();f.exit();f.state.markCurrentClosed(f.port,1n);let saved!:DeadGenerationWork;f.state.fenceDeadGenerationBeforeRestart(w=>{saved=w;});f.state.recordReplacement(next.port,2n);f.state.installReplacementWith(next.port,2n,()=>{});assert.equal(f.state.settleDeadGeneration(1n,saved),"AlreadySettled");assert.equal(f.state.settleDeadGeneration(2n,saved),"SnapshotChanged");assert.throws(()=>f.state.settleDeadGeneration(1n,{...saved,closedReason:"other"}),/generation mismatch/);assert.equal(f.state.currentClient(),next.port);
});
test("runtime exact-match settlement clears pending, claimed and deferred together only after close",()=>{
  const f=fixture();f.work();const first=f.runtime.pendingServerRequests()[0]!;f.runtime.beginServerResponse(first.id,first.occurrence);f.runtime.markServerResponseIndeterminate(first.id,first.occurrence);f.runtime.recordServerRequest({id:1n,occurrence:occurrence(2),method:"input",params:{threadId:"other"}});f.runtime.recordServerRequest({id:"pending",occurrence:occurrence(3),method:"input",params:{}});f.closed();const work=f.runtime.deadGenerationWork(1n)!;assert.equal(work.serverRequests.length,3);assert.equal(f.runtime.settleDeadGenerationAfterExactMatch({...work,closedReason:"wrong"}),false);assert.equal(f.runtime.unsettledServerRequests().length,3);assert.equal(f.runtime.settleDeadGenerationAfterExactMatch(work),true);assert.equal(f.runtime.unsettledServerRequests().length,0);assert.equal(f.runtime.pendingServerRequests().length,0);assert.equal(f.runtime.hasActiveTurns,false);assert.throws(()=>f.runtime.resolveServerRequest(first.id,first.occurrence),/stale/);
});
test("snapshot validation rejects hostile getters/proxies and preserves exact order and integer values",()=>{
  const f=fixture();f.work();f.closed();const work=f.runtime.deadGenerationWork(1n)!,copy=cloneDeadGenerationWork(work);assert.ok(deadGenerationWorkEqual(work,copy));assert.notEqual(work.serverRequests[0]!.occurrence,copy.serverRequests[0]!.occurrence);let calls=0;const getter=Object.defineProperty({...work},"closedReason",{get(){calls++;return "x";}});assert.throws(()=>cloneDeadGenerationWork(getter),TypeError);assert.throws(()=>cloneDeadGenerationWork(new Proxy(work,{ownKeys(){calls++;return [];}})),TypeError);assert.equal(calls,0);assert.throws(()=>cloneDeadGenerationWork({...work,unexpected:true}),TypeError);assert.throws(()=>cloneDeadGenerationWork({...work,activeTurns:[,]}),TypeError);assert.equal(deadGenerationWorkEqual(work,cloneDeadGenerationWork({...work,serverRequests:[{...work.serverRequests[0]!,params:{threadId:"t",large:1n}}]})),false);
});

test("changed occurrence, method, turn ordering or payload cannot satisfy exact-match settlement",()=>{
  const f=fixture();f.work();f.runtime.recordNotification({method:"turn/started",params:{threadId:"second",turnId:"other"}});f.closed();const work=f.runtime.deadGenerationWork(1n)!;
  const changed=[{...work,activeTurns:[...work.activeTurns].reverse()},{...work,serverRequests:[{...work.serverRequests[0]!,occurrence:occurrence(9)}]},{...work,serverRequests:[{...work.serverRequests[0]!,method:"changed"}]},{...work,serverRequests:[{...work.serverRequests[0]!,params:{threadId:"other"}}]}];
  for(const candidate of changed){assert.equal(f.runtime.settleDeadGenerationAfterExactMatch(candidate),false);assert.equal(f.runtime.hasActiveTurns,true);assert.equal(f.runtime.hasUnsettledServerRequests,true);}
});

test("explicit native port settlement refuses closed-but-live work",()=>{
  const f=fixture();f.work();f.closed();f.state.markCurrentClosed(f.port,1n);const work=f.runtime.deadGenerationWork(1n)!;
  assert.equal(f.state.settleDeadGeneration(1n,work),"NotEligible");assert.equal(f.runtime.hasActiveTurns,true);assert.equal(f.runtime.hasUnsettledServerRequests,true);
  const error=new ResidentStateError({kind:"DeadGenerationFence",message:"snapshot changed"});assert.equal(error.message,"dead app-server work could not be durably fenced: snapshot changed");
});
