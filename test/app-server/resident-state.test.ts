import assert from "node:assert/strict";
import {test} from "node:test";
import {ClientLifecycle} from "../../src/app-server/client-lifecycle.ts";
import {ResidentAdmissionState,ResidentStateError,nextResidentGeneration,type ResidentClientPort} from "../../src/app-server/resident-state.ts";
function client(identity:object={}){
  const gate=new ClientLifecycle();let active=false,unsettled=false;
  const port:ResidentClientPort=Object.freeze({identity,admitOperation:()=>gate.admit(),sealAdmissions:()=>{gate.sealForCleanup("resident seal");},sealIfQuiescent:()=>gate.sealIfQuiescent(()=>!active&&!unsettled),withOpen<T>(operation:()=>T):T{return gate.withOpen(operation);}});
  return {port,gate,setActive(value:boolean){active=value;},setUnsettled(value:boolean){unsettled=value;}};
}
const kind=(name:string)=>(error:unknown)=>error instanceof ResidentStateError&&error.detail.kind===name;
test("resident admission starts generation one and owns the exact client permit",()=>{
  const c=client(),state=new ResidentAdmissionState(c.port),admission=state.admitRequest();assert.equal(admission.client,c.port);assert.equal(admission.generation,1n);assert.equal(c.gate.snapshot().inFlight,1n);admission.release();assert.equal(c.gate.snapshot().inFlight,0n);assert.equal(state.currentClient(),c.port);
});
test("generation mismatch wins before closed or quarantine checks",()=>{
  const c=client(),state=new ResidentAdmissionState(c.port);state.markTimeout(1n);assert.throws(()=>state.admitRequest(2n),kind("GenerationMismatch"));state.prepareClose();assert.throws(()=>state.admitRequest(2n),kind("GenerationMismatch"));assert.throws(()=>state.admitRequest(1n),/closed/);
});
test("matching timeout/cancel quarantines requests but permits responses to drain",async()=>{
  const c=client(),state=new ResidentAdmissionState(c.port),changes=state.subscribeLifecycleChanges();state.markTimeout(2n);assert.equal(state.snapshot().quarantined,false);state.markTimeout(1n);await changes.changed();assert.equal(changes.borrow(),1n);assert.throws(()=>state.admitRequest(1n),kind("GenerationQuarantined"));const reply=state.admitResponse(1n);reply.release();state.markCancelled(1n);await changes.changed();changes.dispose();
});
test("restart candidate waits for permits, active turns and unresolved requests",()=>{
  const c=client(),state=new ResidentAdmissionState(c.port);assert.equal(state.restartCandidate().kind,"NotPending");state.requestRestart();const admission=state.admitRequest();assert.equal(state.restartCandidate().kind,"Busy");admission.release();c.setActive(true);assert.equal(state.restartCandidate().kind,"Busy");c.setActive(false);c.setUnsettled(true);assert.equal(state.restartCandidate().kind,"Busy");c.setUnsettled(false);assert.equal(state.restartCandidate(2n).kind,"NotPending");assert.equal(state.restartCandidate(1n).kind,"Sealed");assert.equal(state.restartCleanupAuthorized(1n),true);assert.equal(state.restartCleanupAuthorized(2n),false);assert.throws(()=>state.admitResponse(1n),/closed/);
});
test("failed replacement install retains cleanup debt and does not poison candidate",()=>{
  const old=client(),next=client(),state=new ResidentAdmissionState(old.port),sentinel={};state.requestRestart();state.restartCandidate();state.recordReplacement(next.port,2n);assert.throws(()=>state.installReplacementWith(next.port,2n,()=>{throw sentinel;}),e=>e===sentinel);assert.equal(state.generation(),1n);assert.equal(state.replacementCleanup()!.client,next.port);assert.equal(next.gate.snapshot().poisoned,false);state.installReplacementWith(next.port,2n,()=>{});assert.equal(state.currentClient(),next.port);assert.equal(state.generation(),2n);assert.equal(state.snapshot().quarantined,false);assert.equal(state.snapshot().restartPending,false);assert.equal(state.restartCleanupAuthorized(2n),false);
});
test("replacement debt uses exact generation and connection identity",()=>{
  const old=client(),next=client(),other=client(),state=new ResidentAdmissionState(old.port);assert.throws(()=>state.recordReplacement(next.port,3n),/does not follow 2/);state.recordReplacement(next.port,2n);assert.throws(()=>state.recordReplacement(other.port,2n),/another replacement/);assert.throws(()=>state.finishReplacementCleanup({client:other.port,generation:2n}),/changed identity/);assert.throws(()=>state.installReplacementWith(other.port,2n,()=>{}),/identity or generation/);state.finishReplacementCleanup({client:next.port,generation:2n});assert.equal(state.replacementCleanup(),null);assert.throws(()=>state.finishReplacementCleanup({client:next.port,generation:2n}),/missing/);
});
test("sealed replacement cannot install and terminal close cannot revive admission",()=>{
  const old=client(),next=client(),state=new ResidentAdmissionState(old.port);state.recordReplacement(next.port,2n);next.gate.seal();assert.throws(()=>state.installReplacementWith(next.port,2n,()=>{}),/closed/);const plan=state.prepareClose();assert.equal(plan.current,old.port);assert.equal(plan.replacement!.client,next.port);assert.throws(()=>state.recordReplacement(client().port,2n),/closed/);assert.throws(()=>state.installReplacementWith(next.port,2n,()=>{}),/closed/);state.requestRestart();assert.equal(state.restartCandidate().kind,"NotPending");state.finishReplacementCleanup(plan.replacement!);state.finishCurrentClose(old.port);state.finishCurrentClose(old.port);assert.equal(state.snapshot().client,null);
});
test("death notification checks exact current identity and generation",()=>{
  const c=client(),other=client(),state=new ResidentAdmissionState(c.port);state.markCurrentClosed(other.port,1n);state.markCurrentClosed(c.port,2n);assert.equal(state.snapshot().accepting,true);state.markCurrentClosed(c.port,1n);assert.equal(state.snapshot().accepting,false);assert.equal(state.snapshot().restartPending,true);assert.throws(()=>state.currentClient(),/closed/);
});
test("recovery publication refuses stale/pending client and preserves callback error without poison",()=>{
  const c=client(),state=new ResidentAdmissionState(c.port),sentinel={};assert.equal(state.withRecoveryCurrent(c.port,1n,()=>42),42);assert.throws(()=>state.withRecoveryCurrent(c.port,1n,()=>{throw sentinel;}),e=>e===sentinel);assert.equal(c.gate.snapshot().poisoned,false);assert.throws(()=>state.withRecoveryCurrent(client().port,1n,()=>{}),kind("MutationHeld"));state.requestRestart();assert.throws(()=>state.withRecoveryCurrent(c.port,1n,()=>{}),kind("MutationHeld"));
});
test("reentrant recovery callbacks fail promptly without poisoning or changing admission",()=>{
  const c=client(),state=new ResidentAdmissionState(c.port);assert.throws(()=>state.withRecoveryCurrent(c.port,1n,()=>state.admitRequest()),/reenter/);assert.equal(c.gate.snapshot().poisoned,false);const a=state.admitRequest();a.release();
});
test("terminal cleanup rejects the wrong identity and generation increment is checked",()=>{
  const c=client(),state=new ResidentAdmissionState(c.port);assert.throws(()=>state.finishCurrentClose(c.port),/no longer terminal/);state.prepareClose();assert.throws(()=>state.finishCurrentClose(client().port),/changed identity/);assert.equal(state.replacementGeneration(),2n);assert.equal(nextResidentGeneration((1n<<64n)-2n),(1n<<64n)-1n);assert.throws(()=>nextResidentGeneration((1n<<64n)-1n),/overflow/);assert.throws(()=>nextResidentGeneration(-1n),TypeError);
});
test("async replacement hook is rejected before its body can mutate anything",()=>{
  const old=client(),next=client(),state=new ResidentAdmissionState(old.port);state.recordReplacement(next.port,2n);let calls=0;
  assert.throws(()=>state.installReplacementWith(next.port,2n,async()=>{calls++;}),/synchronous/);assert.equal(calls,0);assert.equal(state.generation(),1n);assert.equal(state.replacementCleanup()!.client,next.port);assert.equal(next.gate.snapshot().poisoned,false);
});
test("a Promise-shaped quiescence result cannot authorize current-client cleanup",()=>{
  const c=client(),bad=Object.freeze({...c.port,sealIfQuiescent:()=>Promise.resolve(true)}) as unknown as ResidentClientPort,state=new ResidentAdmissionState(bad);state.requestRestart();
  assert.throws(()=>state.restartCandidate(),/synchronous boolean/);assert.equal(state.restartCleanupAuthorized(1n),false);assert.equal(state.snapshot().accepting,true);assert.equal(c.gate.snapshot().sealed,false);
});
test("async recovery publication is refused before execution and admission stays unpoisoned",()=>{
  const c=client(),state=new ResidentAdmissionState(c.port);let calls=0;assert.throws(()=>state.withRecoveryCurrent(c.port,1n,async()=>{calls++;}),/synchronous/);assert.equal(calls,0);assert.equal(c.gate.snapshot().poisoned,false);
});
test("old client death and timeout cannot quarantine or disable an installed new generation",()=>{
  const old=client(),next=client(),state=new ResidentAdmissionState(old.port);state.requestRestart();state.restartCandidate(1n);state.recordReplacement(next.port,2n);state.installReplacementWith(next.port,2n,()=>{});
  state.markCurrentClosed(old.port,1n);state.markCurrentClosed(old.port,2n);state.markTimeout(1n);state.markCancelled(1n);
  assert.equal(state.currentClient(),next.port);assert.equal(state.snapshot().quarantined,false);assert.equal(state.snapshot().restartPending,false);const admission=state.admitRequest(2n);assert.equal(admission.client,next.port);admission.release();assert.equal(next.gate.snapshot().inFlight,0n);
});
