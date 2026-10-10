import assert from "node:assert/strict";
import {test,type TestContext} from "node:test";
import {PortableResidentLifecycle} from "../../src/app-server/portable-resident-lifecycle.ts";
import type {IdleReleaseJournal} from "../../src/app-server/idle-release-journal.ts";
async function fixture(t:TestContext){
  const code=`import readline from 'node:readline';const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');const lines=readline.createInterface({input:process.stdin});lines.on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')emit({id:m.id,result:{}});else if(m.method==='emit'){emit({method:'turn/completed',params:{threadId:'T',turnId:'V'}});emit({id:m.id,result:{}});}else if(m.method==='read')emit({id:m.id,result:{}});});`;
  const owner=await PortableResidentLifecycle.start({process:{executable:process.execPath,arguments:["--input-type=module","-e",code],environment:{}},clientInfo:{name:"fixture",title:"Fixture",version:"1"}},()=>"diagnostic",{persistDeadWork(){},oldChildExited(){}},t.signal);t.after(()=>owner.dispose());
  const events:unknown[][]=[];let verified=false,failGap=false,failUpper=false,failExit=false,scopeSideEffect:()=>void=()=>{};
  const journal:IdleReleaseJournal={tracksObservations:()=>true,recordObservationGap:(id,g)=>{events.push(["gap",id,g]);if(failGap)throw new Error("gap write failed");},observeSourceUpper:(id,g,n)=>{events.push(["upper",id,g,n]);if(failUpper)throw new Error("upper write failed");},observationScopeVerified:(id,g,n)=>{events.push(["verify",id,g,n]);scopeSideEffect();return verified;},beforeMutation:()=>null,checkMutation:()=>{},resumeRequired:()=>false,verify:()=>{},transition:i=>i,oldChildExited:(id,g)=>{events.push(["exit",id,g]);if(failExit)throw new Error("exit write failed");}};
  const call=async(method:string)=>{const a=owner.admitRequest();try{return await a.client.requestAdmitted(a.permit,method,{},1000);}finally{a.release();}};
  const snapshot=()=>{const a=owner.admitResponse(owner.generation());try{return a.client.idleMaintenanceSnapshot("T","V");}finally{a.release();}};
  return {owner,journal,events,call,snapshot,verified:(v:boolean)=>{verified=v;},failGap:(v:boolean)=>{failGap=v;},failUpper:(v:boolean)=>{failUpper=v;},failExit:(v:boolean)=>{failExit=v;},onScope:(f:()=>void)=>{scopeSideEffect=f;}};
}
test("tracked journal installation requires durable prefix even after exact legacy observation confirmation",{timeout:10000},async t=>{
  const f=await fixture(t);assert.equal(f.owner.observationTrackingEnabled(),false);f.owner.installIdleReleaseJournal(f.journal);assert.equal(f.owner.observationTrackingEnabled(),true);assert.equal(f.snapshot().caughtUp,false);
  await f.call("emit");const page=f.owner.observationWindow(1n,0n);assert.equal(page.ownerId,f.owner.instanceId);assert.equal(page.generation,1n);assert.equal(page.sourceUpper,1n);assert.ok(Object.isFrozen(page));const notification=page.events[0]!.notification!;
  f.owner.confirmIdleObservation(1n,notification);assert.equal(f.snapshot().caughtUp,false);assert.equal(f.owner.reconcileIdleObservationPrefix(1n,1n),false);f.verified(true);assert.equal(f.owner.reconcileIdleObservationPrefix(1n,1n),true);assert.equal(f.snapshot().caughtUp,true);
  assert.equal(f.owner.reconcileIdleObservationPrefix(1n,2n),false);assert.equal(f.snapshot().caughtUp,true);
});
test("observational source gaps bind exact native upper and can clear only with verified unchanged epoch",{timeout:10000},async t=>{
  const f=await fixture(t),errors:unknown[]=[];f.owner.installIdleReleaseJournal(f.journal);await f.call("emit");f.owner.markSourceObservationGap(1n,e=>{errors.push(e);});assert.deepEqual(f.events[0],["upper",f.owner.instanceId,1n,1n]);assert.equal(errors.length,0);f.verified(true);assert.equal(f.owner.reconcileIdleObservationPrefix(1n,1n),true);
  f.onScope(()=>f.owner.markSourceObservationGap(1n,e=>{errors.push(e);}));assert.equal(f.owner.reconcileIdleObservationPrefix(1n,1n),false);
});
test("unattributed tracked gap remains sticky despite later prefix certification",{timeout:10000},async t=>{
  const f=await fixture(t);f.owner.installIdleReleaseJournal(f.journal);f.owner.markIdleObservationGap(()=>{});assert.deepEqual(f.events[0],["gap",f.owner.instanceId,1n]);f.verified(true);assert.equal(f.owner.reconcileIdleObservationPrefix(1n,0n),false);
});
test("failed source discovery records unattributed fallback and reports both failures without clearing the hold",{timeout:10000},async t=>{
  const f=await fixture(t),errors:unknown[]=[];f.owner.installIdleReleaseJournal(f.journal);f.failUpper(true);f.failGap(true);f.owner.markSourceObservationGap(1n,e=>{errors.push(e);});assert.deepEqual(errors.map(e=>(e as Error).message),["gap write failed","upper write failed"]);f.verified(true);assert.equal(f.owner.reconcileIdleObservationPrefix(1n,0n),false);
});
test("stale generations cannot read/certify the new native stream and do not consume its notification",{timeout:10000},async t=>{
  const f=await fixture(t);f.owner.installIdleReleaseJournal(f.journal);f.verified(true);assert.equal(await f.owner.forceRestartIfQuiescent(t.signal),true);assert.equal(f.owner.generation(),2n);await f.call("emit");const page=f.owner.observationWindow(2n,0n);assert.equal(page.generation,2n);assert.equal(page.ownerId,f.owner.instanceId);assert.throws(()=>f.owner.observationWindow(1n,0n),/generation mismatch/);assert.throws(()=>f.owner.reconcileIdleObservationPrefix(1n,1n),/generation mismatch/);f.owner.confirmIdleObservation(1n,page.events[0]!.notification!);assert.equal(f.snapshot().caughtUp,false);assert.equal(f.owner.reconcileIdleObservationPrefix(2n,1n),true);
  // Frozen source only enables ledger_required on the client present at install.
  // Its replacement defaults to legacy ack mode; prefix acceptance alone does not
  // update idle_observed_revision. Preserve this separate source behavior explicitly.
  assert.equal(f.snapshot().caughtUp,false);f.owner.confirmIdleObservation(2n,page.events[0]!.notification!);assert.equal(f.snapshot().caughtUp,true);
});
test("journal exit is called only after actual native exit and failed commit retains that owner for retry",{timeout:10000},async t=>{
  const f=await fixture(t);f.owner.installIdleReleaseJournal(f.journal);assert.equal(f.events.length,0);f.failExit(true);await assert.rejects(f.owner.close(),/exit write failed/);assert.equal(f.owner.lifecycleSnapshot().healthy,false);assert.throws(()=>f.owner.admitRequest(),/closed/);assert.deepEqual(f.events[0],["exit",f.owner.instanceId,1n]);f.failExit(false);await f.owner.close();assert.deepEqual(f.events[1],f.events[0]);await f.owner.close();assert.equal(f.events.length,2);
});
test("missing journal stays unverified, installation is once-only and callbacks are pinned",{timeout:10000},async t=>{
  const f=await fixture(t);assert.equal(f.owner.reconcileIdleObservationPrefix(1n,0n),false);f.owner.installIdleReleaseJournal(f.journal);f.journal.observationScopeVerified=()=>true;assert.equal(f.owner.reconcileIdleObservationPrefix(1n,0n),false);assert.throws(()=>f.owner.installIdleReleaseJournal(f.journal),/installed once/);
});
