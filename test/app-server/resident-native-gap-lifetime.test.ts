import assert from "node:assert/strict";
import {test,type TestContext} from "node:test";
import {PortableResidentLifecycle} from "../../src/app-server/portable-resident-lifecycle.ts";
import type {IdleReleaseJournal} from "../../src/app-server/idle-release-journal.ts";
import type {ResidentNativeObservation} from "../../src/app-server/resident-native-observation.ts";
import {pinResidentNativeObservation} from "../../src/app-server/resident-native-observation.ts";
async function fixture(t:TestContext,nativeObservation:ResidentNativeObservation,cleanupError?:unknown){
  const code=`import readline from 'node:readline';const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');const lines=readline.createInterface({input:process.stdin});lines.on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')emit({id:m.id,result:{}});else if(m.method==='emit'){emit({method:'turn/completed',params:{threadId:'T',turnId:'V'}});emit({id:m.id,result:{}});}else if(m.method==='read')emit({id:m.id,result:{}});});`;
  const owner=await PortableResidentLifecycle.start({process:{executable:process.execPath,arguments:["--input-type=module","-e",code],environment:{}},clientInfo:{name:"fixture",title:"Fixture",version:"1"}},()=>"diagnostic",{persistDeadWork(){},oldChildExited(){}},t.signal,{fence:null,renderError:()=>"safe",nativeObservation});t.after(async()=>{if(cleanupError===undefined)await owner.dispose();else await assert.rejects(owner.dispose(),e=>e===cleanupError);});
  const events:unknown[][]=[];let verified=false,failGap=false,failUpper=false,failExit=false,scopeSideEffect:()=>void=()=>{};
  const journal:IdleReleaseJournal={tracksObservations:()=>true,recordObservationGap:(id,g)=>{events.push(["gap",id,g]);if(failGap)throw new Error("gap write failed");},observeSourceUpper:(id,g,n)=>{events.push(["upper",id,g,n]);if(failUpper)throw new Error("upper write failed");},observationScopeVerified:(id,g,n)=>{events.push(["verify",id,g,n]);scopeSideEffect();return verified;},beforeMutation:()=>null,checkMutation:()=>{},resumeRequired:()=>false,verify:()=>{},transition:i=>i,oldChildExited:(id,g)=>{events.push(["exit",id,g]);if(failExit)throw new Error("exit write failed");}};
  const call=async(method:string)=>{const a=owner.admitRequest();try{return await a.client.requestAdmitted(a.permit,method,{},1000);}finally{a.release();}};
  const snapshot=()=>{const a=owner.admitResponse(owner.generation());try{return a.client.idleMaintenanceSnapshot("T","V");}finally{a.release();}};
  return {owner,journal,events,call,snapshot,verified:(v:boolean)=>{verified=v;},failGap:(v:boolean)=>{failGap=v;},failUpper:(v:boolean)=>{failUpper=v;},failExit:(v:boolean)=>{failExit=v;},onScope:(f:()=>void)=>{scopeSideEffect=f;}};
}

function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
async function until(check:()=>boolean){const end=Date.now()+3000;while(!check()){assert.ok(Date.now()<end,"condition timeout");await new Promise(r=>setTimeout(r,5));}}
test("gap producer returns promptly and coalesces only original stream pending upper while retaining unknown",async t=>{
 const first=deferred<void>(),calls:unknown[][]=[];let n=0;const f=await fixture(t,{verified:async()=>true,discoverGap:async(...args)=>{calls.push(["upper",...args]);if(n++===0)await first.promise;},recordGap:async(...args)=>{calls.push(["unknown",...args]);},close:async()=>{}});
 f.owner.installIdleReleaseJournal(f.journal);await f.call("emit");f.owner.markSourceObservationGap(1n,()=>{});assert.equal(calls.length,1);
 await f.call("emit");f.owner.markSourceObservationGap(1n,()=>{});await f.call("emit");f.owner.markSourceObservationGap(1n,()=>{});f.owner.markIdleObservationGap(()=>{});
 assert.equal(await f.owner.reconcileIdleObservationPrefixAsync(1n,3n),false);assert.equal(calls.length,1);first.resolve();await until(()=>calls.length===3);
 assert.deepEqual(calls,[["upper",f.owner.instanceId,1n,1n],["upper",f.owner.instanceId,1n,3n],["unknown",f.owner.instanceId,1n]]);assert.equal(await f.owner.reconcileIdleObservationPrefixAsync(1n,3n),false);
});
test("close freezes new gap writes and joins captured persistence before exit journal",async t=>{
 const first=deferred<void>(),calls:unknown[][]=[],reports:unknown[]=[];const f=await fixture(t,{verified:async()=>true,discoverGap:async(...args)=>{calls.push(args);await first.promise;},recordGap:async()=>{},close:async()=>{}});f.owner.installIdleReleaseJournal(f.journal);f.owner.markSourceObservationGap(1n,e=>{reports.push(e);});
 let done=false;const closing=f.owner.close().then(()=>{done=true;});await new Promise(r=>setTimeout(r,40));assert.equal(done,false);assert.equal(f.events.some(e=>e[0]==="exit"),false);f.owner.markSourceObservationGap(1n,e=>{reports.push(e);});assert.equal(calls.length,1);assert.ok(reports.length>0);first.resolve();await closing;assert.equal(f.events.filter(e=>e[0]==="exit").length,1);
});
test("failed discovery attempts only one original unknown fallback and retains failure reports",async t=>{
 const errors:unknown[]=[],calls:unknown[][]=[],a=new Error("discover failed"),b=new Error("unknown failed");const f=await fixture(t,{verified:async()=>true,discoverGap:async(...args)=>{calls.push(["upper",...args]);throw a;},recordGap:async(...args)=>{calls.push(["unknown",...args]);throw b;},close:async()=>{}});f.owner.installIdleReleaseJournal(f.journal);f.owner.markSourceObservationGap(1n,e=>{errors.push(e);});await until(()=>errors.length===2);assert.deepEqual(errors,[a,b]);assert.deepEqual(calls,[["upper",f.owner.instanceId,1n,0n],["unknown",f.owner.instanceId,1n]]);assert.equal(await f.owner.reconcileIdleObservationPrefixAsync(1n,0n),false);
});
test("replacement joins old gap before old exit and opens only replacement generation",async t=>{
 const first=deferred<void>();let calls=0;const f=await fixture(t,{verified:async()=>true,discoverGap:async()=>{calls++;if(calls===1)await first.promise;},recordGap:async()=>{},close:async()=>{}});f.owner.installIdleReleaseJournal(f.journal);f.owner.markSourceObservationGap(1n,()=>{});let done=false;const restart=f.owner.forceRestartIfQuiescent(t.signal).then(v=>{done=true;return v;});await new Promise(r=>setTimeout(r,40));assert.equal(done,false);assert.equal(f.owner.generation(),1n);assert.equal(f.events.some(e=>e[0]==="exit"),false);first.resolve();assert.equal(await restart,true);assert.equal(f.owner.generation(),2n);f.owner.markSourceObservationGap(2n,()=>{});await until(()=>calls===2);
});
test("paired gap callbacks require own functions and asynchronous void acknowledgement",async()=>{
 assert.throws(()=>pinResidentNativeObservation({verified:async()=>true,close:async()=>{},discoverGap:async()=>{}}),/paired/);let getters=0;assert.throws(()=>pinResidentNativeObservation({verified:async()=>true,close:async()=>{},get discoverGap(){getters++;return async()=>{};},recordGap:async()=>{}}));assert.equal(getters,0);
 const bad=pinResidentNativeObservation({verified:async()=>true,close:async()=>{},discoverGap:()=>undefined,recordGap:async()=>1} as unknown as ResidentNativeObservation);await assert.rejects(bad.discoverGap!("o",1n,1n),/Promise/);await assert.rejects(bad.recordGap!("o",1n),/void/);
});
test("central diagnostic failure remains cleanup failure and cannot publish successful exit",async t=>{
 const marker=new Error("report failed");let reports=0;const f=await fixture(t,{verified:async()=>false,discoverGap:async()=>{throw new Error("write failed");},recordGap:async()=>{},close:async()=>{}},marker);f.owner.installIdleReleaseJournal(f.journal);f.owner.markSourceObservationGap(1n,()=>{reports++;throw marker;});await until(()=>reports===1);await assert.rejects(f.owner.close(),e=>e===marker);assert.equal(f.events.some(e=>e[0]==="exit"),false);
});
