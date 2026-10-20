import assert from "node:assert/strict";
import {test} from "node:test";
import {ClientLifecycle} from "../../src/app-server/client-lifecycle.ts";
import {ResidentAdmissionState,type ResidentClientPort} from "../../src/app-server/resident-state.ts";
import {WrittenRequestGuard,type WrittenRequestCompletion} from "../../src/app-server/written-request-guard.ts";
function fixture(){const gate=new ClientLifecycle(),port:ResidentClientPort=Object.freeze({identity:Object.freeze({}),admitOperation:()=>gate.admit(),sealAdmissions:()=>{gate.sealForCleanup("seal");},sealIfQuiescent:()=>gate.sealIfQuiescent(()=>true),withOpen:<T>(f:()=>T):T=>gate.withOpen(f)});return {gate,port,state:new ResidentAdmissionState(port)};}
const completions:WrittenRequestCompletion[]=["Success","Io","Closed","TransportClosed","ResponseChannelClosed","Timeout","OtherError"];
test("all completed classifications before write-start preserve generation admission",()=>{
  for(const completion of completions){const {state}=fixture(),guard=new WrittenRequestGuard(state,1n);guard.finish(completion);guard.dispose();assert.equal(state.snapshot().quarantined,false,completion);assert.equal(state.snapshot().restartPending,false,completion);}
});
test("only explicit transport and I/O completion failures quarantine a started request",()=>{
  for(const completion of completions){const {state}=fixture(),guard=new WrittenRequestGuard(state,1n);guard.confirmWriteStarted();guard.finish(completion);guard.dispose();assert.equal(state.snapshot().quarantined,["Io","Closed","TransportClosed","ResponseChannelClosed"].includes(completion),completion);}
});
test("unfinished started request disposes into quarantine without releasing the caller lease",async()=>{
  const {state,gate}=fixture(),lease=state.admitRequest(),guard=new WrittenRequestGuard(state,1n),watch=state.subscribeLifecycleChanges();guard.confirmWriteStarted();guard.dispose();await watch.changed();assert.equal(watch.borrow(),1n);assert.equal(state.snapshot().quarantined,true);assert.equal(gate.snapshot().inFlight,1n);guard.dispose();lease.release();assert.equal(gate.snapshot().inFlight,0n);watch.dispose();
});
test("unstarted disposal does not quarantine and post-dispose use is rejected",()=>{
  const {state}=fixture(),guard=new WrittenRequestGuard(state,1n);guard.dispose();assert.equal(state.snapshot().quarantined,false);assert.throws(()=>guard.confirmWriteStarted(),/completed/);assert.throws(()=>guard.finish("Success"),/completed/);assert.throws(()=>guard.isolateAfterFlush(),/completed/);
});
test("only the current confirmed flush flag suppresses unfinished cancellation",()=>{
  const {state}=fixture(),guard=new WrittenRequestGuard(state,1n);guard.confirmWriteStarted();const old=guard.isolateAfterFlush();old.confirmFlushed();assert.equal(guard.isIsolated(),true);const current=guard.isolateAfterFlush();old.confirmFlushed();assert.equal(guard.isIsolated(),false);current.confirmFlushed();assert.equal(guard.isIsolated(),true);guard.dispose();assert.equal(state.snapshot().quarantined,false);
  const other=fixture(),unflushed=new WrittenRequestGuard(other.state,1n);unflushed.confirmWriteStarted();unflushed.isolateAfterFlush();unflushed.dispose();assert.equal(other.state.snapshot().quarantined,true);
});
test("explicit transport failure still quarantines after isolated flush",()=>{
  for(const kind of ["Io","Closed","TransportClosed","ResponseChannelClosed"] as const){const {state}=fixture(),guard=new WrittenRequestGuard(state,1n);guard.confirmWriteStarted();guard.isolateAfterFlush().confirmFlushed();guard.finish(kind);guard.dispose();assert.equal(state.snapshot().quarantined,true,kind);}
});
test("old-generation guard cannot quarantine installed replacement and terminal close stays terminal",()=>{
  const {state}=fixture(),next=fixture(),guard=new WrittenRequestGuard(state,1n);guard.confirmWriteStarted();state.requestRestart();state.restartCandidate();state.recordReplacement(next.port,2n);state.installReplacementWith(next.port,2n,()=>{});guard.dispose();assert.equal(state.snapshot().quarantined,false);assert.equal(state.snapshot().restartPending,false);
  const terminal=new WrittenRequestGuard(state,2n);terminal.confirmWriteStarted();state.prepareClose();terminal.dispose();assert.equal(state.snapshot().restartPending,false);assert.equal(state.snapshot().accepting,false);
});
test("invalid completion fails closed and finally disposal retains ambiguity",()=>{
  const {state}=fixture(),guard=new WrittenRequestGuard(state,1n);guard.confirmWriteStarted();assert.throws(()=>guard.finish("unknown" as WrittenRequestCompletion),TypeError);guard.dispose();assert.equal(state.snapshot().quarantined,true);assert.throws(()=>new WrittenRequestGuard(state,-1n),TypeError);assert.throws(()=>new WrittenRequestGuard(state,1n<<64n),TypeError);
});
test("failed cancellation publication remains retryable rather than silently completing",()=>{
  const sentinel={};let count=0;const guard=new WrittenRequestGuard({markCancelled(){if(++count===1)throw sentinel;}},1n);guard.confirmWriteStarted();assert.throws(()=>guard.dispose(),e=>e===sentinel);guard.dispose();guard.dispose();assert.equal(count,2);
});
