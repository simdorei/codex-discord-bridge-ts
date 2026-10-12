import assert from "node:assert/strict";
import {test,type TestContext} from "node:test";
import {PortableResidentLifecycle} from "../../src/app-server/portable-resident-lifecycle.ts";
import type {IdleReleaseJournal} from "../../src/app-server/idle-release-journal.ts";
import type {ResidentNativeObservation} from "../../src/app-server/resident-native-observation.ts";
import {pinResidentNativeObservation} from "../../src/app-server/resident-native-observation.ts";
async function fixture(t:TestContext,nativeObservation:ResidentNativeObservation){
  const code=`import readline from 'node:readline';const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');const lines=readline.createInterface({input:process.stdin});lines.on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')emit({id:m.id,result:{}});else if(m.method==='emit'){emit({method:'turn/completed',params:{threadId:'T',turnId:'V'}});emit({id:m.id,result:{}});}else if(m.method==='read')emit({id:m.id,result:{}});});`;
  const owner=await PortableResidentLifecycle.start({process:{executable:process.execPath,arguments:["--input-type=module","-e",code],environment:{}},clientInfo:{name:"fixture",title:"Fixture",version:"1"}},()=>"diagnostic",{persistDeadWork(){},oldChildExited(){}},t.signal,{fence:null,renderError:()=>"safe",nativeObservation});t.after(()=>owner.dispose());
  const events:unknown[][]=[];let verified=false,failGap=false,failUpper=false,failExit=false,scopeSideEffect:()=>void=()=>{};
  const journal:IdleReleaseJournal={tracksObservations:()=>true,recordObservationGap:(id,g)=>{events.push(["gap",id,g]);if(failGap)throw new Error("gap write failed");},observeSourceUpper:(id,g,n)=>{events.push(["upper",id,g,n]);if(failUpper)throw new Error("upper write failed");},observationScopeVerified:(id,g,n)=>{events.push(["verify",id,g,n]);scopeSideEffect();return verified;},beforeMutation:()=>null,checkMutation:()=>{},resumeRequired:()=>false,verify:()=>{},transition:i=>i,oldChildExited:(id,g)=>{events.push(["exit",id,g]);if(failExit)throw new Error("exit write failed");}};
  const call=async(method:string)=>{const a=owner.admitRequest();try{return await a.client.requestAdmitted(a.permit,method,{},1000);}finally{a.release();}};
  const snapshot=()=>{const a=owner.admitResponse(owner.generation());try{return a.client.idleMaintenanceSnapshot("T","V");}finally{a.release();}};
  return {owner,journal,events,call,snapshot,verified:(v:boolean)=>{verified=v;},failGap:(v:boolean)=>{failGap=v;},failUpper:(v:boolean)=>{failUpper=v;},failExit:(v:boolean)=>{failExit=v;},onScope:(f:()=>void)=>{scopeSideEffect=f;}};
}

function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
test("async resident verification captures exact original scope and does not call sync verifier",async t=>{
 const proof=deferred<boolean>(),calls:unknown[][]=[];const f=await fixture(t,{verified:async(...args)=>{calls.push(args);return await proof.promise;},close:async()=>{}});
 f.owner.installIdleReleaseJournal(f.journal);await f.call("emit");const pending=f.owner.reconcileIdleObservationPrefixAsync(1n,1n);
 assert.deepEqual(calls,[[f.owner.instanceId,1n,1n]]);assert.equal(f.snapshot().caughtUp,false);await new Promise(r=>setTimeout(r,20));assert.equal(f.events.length,0);
 proof.resolve(true);assert.equal(await pending,true);assert.equal(f.snapshot().caughtUp,true);
});
test("new source gap during awaited proof prevents even native prefix acknowledgement",async t=>{
 const proof=deferred<boolean>();const f=await fixture(t,{verified:async()=>await proof.promise,close:async()=>{}});f.owner.installIdleReleaseJournal(f.journal);await f.call("emit");
 const pending=f.owner.reconcileIdleObservationPrefixAsync(1n,1n);f.owner.markSourceObservationGap(1n,()=>{});proof.resolve(true);
 assert.equal(await pending,false);assert.equal(f.snapshot().caughtUp,false);
});
test("unattributed gap remains sticky after native verified read",async t=>{
 const f=await fixture(t,{verified:async()=>true,close:async()=>{}});f.owner.installIdleReleaseJournal(f.journal);f.owner.markIdleObservationGap(()=>{});assert.equal(await f.owner.reconcileIdleObservationPrefixAsync(1n,0n),false);
});
test("native verification false or rejection cannot release observations and releases admission",async t=>{
 let reject=false;const marker=new Error("proof failed");const f=await fixture(t,{verified:async()=>{if(reject)throw marker;return false;},close:async()=>{}});f.owner.installIdleReleaseJournal(f.journal);
 assert.equal(await f.owner.reconcileIdleObservationPrefixAsync(1n,0n),false);reject=true;await assert.rejects(f.owner.reconcileIdleObservationPrefixAsync(1n,0n),e=>e===marker);assert.equal(f.snapshot().caughtUp,false);
 assert.equal(await f.owner.forceRestartIfQuiescent(t.signal),true);
});
test("original verification admission prevents replacement while pending and stale generation is refused",async t=>{
 const proof=deferred<boolean>();let calls=0;const f=await fixture(t,{verified:async()=>{calls++;return await proof.promise;},close:async()=>{}});f.owner.installIdleReleaseJournal(f.journal);
 const pending=f.owner.reconcileIdleObservationPrefixAsync(1n,0n);assert.equal(await f.owner.forceRestartIfQuiescent(t.signal),false);assert.equal(f.owner.generation(),1n);proof.resolve(true);await pending;
 assert.equal(await f.owner.forceRestartIfQuiescent(t.signal),true);assert.throws(()=>f.owner.reconcileIdleObservationPrefixAsync(1n,0n),/generation mismatch/);assert.equal(calls,1);
});
test("two managed verifications are bounded and terminal close joins before publishing exit",async t=>{
 const proof=deferred<boolean>();let verifierClosed=false;const f=await fixture(t,{verified:async()=>await proof.promise,close:async()=>{verifierClosed=true;}});f.owner.installIdleReleaseJournal(f.journal);
 const a=f.owner.reconcileIdleObservationPrefixAsync(1n,0n),b=f.owner.reconcileIdleObservationPrefixAsync(1n,0n);
 await assert.rejects(f.owner.reconcileIdleObservationPrefixAsync(1n,0n),/capacity/);let done=false;const closing=f.owner.close().then(()=>{done=true;});
 await new Promise(r=>setTimeout(r,40));assert.equal(done,false);assert.equal(verifierClosed,false);assert.equal(f.events.some(e=>e[0]==="exit"),false);
 proof.resolve(true);assert.deepEqual(await Promise.all([a,b]),[false,false]);await closing;assert.equal(verifierClosed,true);assert.equal(f.events.filter(e=>e[0]==="exit").length,1);
});
test("native verifier capability rejects getters and non-Promise or nonboolean returns",async()=>{
 let calls=0;assert.throws(()=>pinResidentNativeObservation({get verified(){calls++;return async()=>true;},close:async()=>{}}));assert.equal(calls,0);
 const sync=pinResidentNativeObservation({verified:()=>true,close:async()=>{}} as unknown as ResidentNativeObservation);await assert.rejects(sync.verified("o",1n,0n),/Promise/);
 const bad=pinResidentNativeObservation({verified:async()=>1,close:async()=>null} as unknown as ResidentNativeObservation);await assert.rejects(bad.verified("o",1n,0n),/boolean/);await assert.rejects(bad.close(),/void/);
});
test("native callback pin is immutable after caller changes its object",async()=>{
 const input={verified:async()=>true,close:async()=>{}};const pinned=pinResidentNativeObservation(input);input.verified=async()=>false;assert.equal(await pinned.verified("o",1n,0n),true);assert.equal(Object.isFrozen(pinned),true);
});
