import assert from "node:assert/strict";
import {test} from "node:test";
import {IdleTargetGate,nextObservationGapEpoch} from "../../src/app-server/idle-target-gate.ts";
import {cloneIdleReleaseToken,pinIdleReleaseJournal,type IdleReleaseJournal,type IdleReleaseToken} from "../../src/app-server/idle-release-journal.ts";
const token=(threadId="a",state="Candidate"):IdleReleaseToken=>({intentId:"intent",ownerId:"owner",generation:1n,threadId,turnId:"turn",jobId:"job",revision:1n,state,detail:""});
function journal(overrides:Partial<IdleReleaseJournal>={}):IdleReleaseJournal{return {beforeMutation(){return null;},checkMutation(){},resumeRequired(){return false;},verify(){},transition(t,state,detail){return {...t,state,detail,revision:t.revision+1n};},oldChildExited(){},...overrides};}
test("ordinary concurrent target mutations retain counts until each explicit release",()=>{
  const gate=new IdleTargetGate();gate.install(journal());const a=gate.admit("owner",1n,"a"),b=gate.admit("owner",1n,"a");assert.equal(a.kind,"Ordinary");assert.equal(b.kind,"Ordinary");a.permit.release();assert.throws(()=>gate.reserve(token()),/admitted target mutation/);b.permit.release();const hold=gate.reserve(token());hold.release();assert.throws(()=>{if(a.kind==="Ordinary")a.permit.preflight();},/released/);
});
test("journal installation is once and only while no mutation or exclusive lease is active",()=>{
  const gate=new IdleTargetGate(),lease=gate.admit("",0n,null);assert.throws(()=>gate.install(journal()),/installed once before intake/);lease.permit.release();gate.install(journal());assert.throws(()=>gate.install(journal()),/installed once before intake/);const absent=new IdleTargetGate();assert.throws(()=>absent.reserve(token()),/not installed/);
});
test("exclusive target blocks its own and global mutations but permits unrelated targets",()=>{
  const gate=new IdleTargetGate();gate.install(journal());const hold=gate.reserve(token());assert.throws(()=>gate.admit("owner",1n,"a"),/maintenance is in flight/);assert.throws(()=>gate.admit("owner",1n,null),/maintenance is in flight/);const other=gate.admit("owner",1n,"b");other.permit.release();assert.throws(()=>gate.reserve(token()),/admitted target mutation/);hold.release();const replacement=gate.reserve(token());hold.release();replacement.requireHeld();assert.throws(()=>hold.requireHeld(),/released/);replacement.release();
});
test("global mutation blocks every exclusive reservation until it releases",()=>{
  const gate=new IdleTargetGate();gate.install(journal());const global=gate.admit("owner",1n,null);assert.throws(()=>gate.reserve(token("a")),/admitted target mutation/);assert.throws(()=>gate.reserve(token("b")),/admitted target mutation/);global.permit.release();const a=gate.reserve(token("a")),b=gate.reserve(token("b"));a.release();b.release();
});
test("journal resubscription token owns exact immutable data and exclusive target lease",()=>{
  const gate=new IdleTargetGate(),input=token("a","AwaitUnload");gate.install(journal({beforeMutation(owner,generation,thread){assert.deepEqual([owner,generation,thread],["owner",1n,"a"]);return input;}}));const admitted=gate.admit("owner",1n,"a");assert.equal(admitted.kind,"Resubscribe");if(admitted.kind!=="Resubscribe")throw Error("wrong kind");assert.notEqual(admitted.token,input);Object.assign(input,{detail:"changed"});assert.equal(admitted.token.detail,"");assert.ok(Object.isFrozen(admitted.token));assert.equal(admitted.permit.thread,"a");assert.throws(()=>gate.admit("owner",1n,"a"),/maintenance/);admitted.permit.release();
});
test("resubscription conflict preserves journal result without granting an exclusive lease",()=>{
  for(const target of [null,"a"]){let resume=false,before=0;const gate=new IdleTargetGate();gate.install(journal({beforeMutation(){before++;return resume?token("a","AwaitUnload"):null;}}));const existing=gate.admit("owner",1n,target);resume=true;assert.throws(()=>gate.admit("owner",1n,"a"),/durable hold retained/);assert.ok(before>=1);existing.permit.release();const admitted=gate.admit("owner",1n,"a");assert.equal(admitted.kind,"Resubscribe");admitted.permit.release();}
});
test("reserve requires idle verification exactly for Candidate and journal failure retains no lease",()=>{
  const gate=new IdleTargetGate(),checks:boolean[]=[],sentinel={};let fail=true;gate.install(journal({verify(t,idle){checks.push(idle);assert.ok(Object.isFrozen(t));if(fail)throw sentinel;}}));assert.throws(()=>gate.reserve(token()),e=>e===sentinel);fail=false;const ordinary=gate.admit("owner",1n,"a");ordinary.permit.release();for(const state of ["Candidate","candidate","AwaitUnload","Settled"]){const hold=gate.reserve(token("a",state));hold.release();}assert.deepEqual(checks,[true,true,false,false,false]);
});
test("ordinary preflight checks latest durable hold and failure does not lose the counted lease",()=>{
  const gate=new IdleTargetGate(),sentinel={};let calls=0,fail=false;gate.install(journal({checkMutation(thread){assert.equal(thread,"a");calls++;if(fail)throw sentinel;}}));const a=gate.admit("owner",1n,"a"),global=gate.admit("owner",1n,null);if(a.kind!=="Ordinary"||global.kind!=="Ordinary")throw Error("wrong admission");a.permit.preflight();global.permit.preflight();assert.equal(calls,1);fail=true;assert.throws(()=>a.permit.preflight(),e=>e===sentinel);assert.throws(()=>gate.reserve(token()),/admitted target mutation/);a.permit.release();global.permit.release();
});
test("gap epochs reject stale proof and unattributed loss stays latched without blocking ordinary work",()=>{
  const gate=new IdleTargetGate();assert.equal(gate.observationsVerified(),true);assert.equal(gate.clearGap(0n),true);gate.markGap();const old=gate.gapEpoch();gate.markGap();assert.equal(gate.clearGap(old),false);assert.equal(gate.observationsVerified(),false);assert.equal(gate.clearGap(gate.gapEpoch()),true);assert.equal(gate.observationsVerified(),true);gate.holdUnattributedGap();gate.markGap();assert.equal(gate.gapEpoch(),(1n<<64n)-1n);assert.equal(gate.clearGap(gate.gapEpoch()),false);const a=gate.admit("owner",1n,"b");a.permit.release();assert.equal(gate.observationsVerified(),false);assert.equal(nextObservationGapEpoch((1n<<64n)-2n),(1n<<64n)-1n);
});
test("default observation journal methods fail closed and do not imply durable coverage",()=>{
  const pinned=pinIdleReleaseJournal(journal());assert.equal(pinned.tracksObservations(),false);assert.equal(pinned.observationScopeVerified("owner",1n,0n),false);assert.throws(()=>pinned.recordObservationGap("owner",1n),/durable observation journal unavailable/);assert.throws(()=>pinned.observeSourceUpper("owner",1n,1n),/source observation journal unavailable/);
});
test("journal function identities are pinned and async or getter methods are rejected before execution",()=>{
  let original=0,changed=0,calls=0;const input=journal({checkMutation(){original++;}}),gate=new IdleTargetGate();gate.install(input);input.checkMutation=()=>{changed++;};const admission=gate.admit("owner",1n,"a");if(admission.kind!=="Ordinary")throw Error("wrong kind");admission.permit.preflight();admission.permit.release();assert.equal(original,1);assert.equal(changed,0);assert.throws(()=>pinIdleReleaseJournal(journal({async checkMutation(){calls++;}})),/synchronous/);const getter=Object.defineProperty(journal(),"verify",{get(){calls++;return ()=>{};}});assert.throws(()=>pinIdleReleaseJournal(getter),/synchronous/);assert.equal(calls,0);
});
test("malformed token or journal output never becomes mutation/resubscription authority",()=>{
  assert.throws(()=>cloneIdleReleaseToken({...token(),generation:1}),TypeError);assert.throws(()=>cloneIdleReleaseToken({...token(),revision:1n<<63n}),TypeError);assert.throws(()=>cloneIdleReleaseToken({...token(),extra:"x"}),TypeError);const gate=new IdleTargetGate();gate.install(journal({beforeMutation(){return Promise.resolve(token()) as unknown as IdleReleaseToken;}}));assert.throws(()=>gate.admit("owner",1n,"a"),/synchronously/);const reserve=gate.reserve(token());reserve.release();
});
test("journal reentry fails promptly and later explicit admission is still usable",()=>{
  const gate=new IdleTargetGate();let reenter=true;gate.install(journal({beforeMutation(){if(reenter)gate.admit("owner",1n,"b");return null;}}));assert.throws(()=>gate.admit("owner",1n,"a"),/reenter/);reenter=false;const admission=gate.admit("owner",1n,"a");admission.permit.release();const hold=gate.reserve(token());hold.release();
});
test("invalid scope data is refused before journal effects",()=>{
  let calls=0;const pinned=pinIdleReleaseJournal(journal({oldChildExited(){calls++;},verify(){calls++;},transition(t){calls++;return t;}}));assert.throws(()=>pinned.oldChildExited("owner",-1n),TypeError);assert.throws(()=>pinned.verify(token(),1 as unknown as boolean),TypeError);assert.throws(()=>pinned.transition(token(),"bad\ud800",""),TypeError);assert.equal(calls,0);
});
