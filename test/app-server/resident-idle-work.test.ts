import assert from "node:assert/strict";
import {test,type TestContext} from "node:test";
import {setTimeout as delay} from "node:timers/promises";
import type {DatabaseSync} from "node:sqlite";
import {PortableResidentLifecycle} from "../../src/app-server/portable-resident-lifecycle.ts";
import type {ResidentMaintenanceOptions} from "../../src/app-server/maintenance-transport.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {selectIdleIntentIn} from "../../src/store/idle-release-row.ts";
import {beforeIdleMutationOn,transitionIdleIntentOn,verifyIdleIntentIn,settleExitedIdleOwnerIn} from "../../src/store/idle-release-store.ts";
import {storeFixture} from "../helpers/store-fixture.ts";
import type {IdleReleaseToken} from "../../src/app-server/idle-release-journal.ts";
interface Fixture{owner:PortableResidentLifecycle;db:DatabaseSync;current():IdleReleaseToken;call(method:string):Promise<unknown>;claims:unknown[];origins:unknown[];options:ResidentMaintenanceOptions}
async function withOwner(t:TestContext,mode:string,body:(fixture:Fixture)=>Promise<void>):Promise<void>{await storeFixture(async path=>{
  const db=await openInitialized(path);let owner:PortableResidentLifecycle|undefined;
  const claims:unknown[]=[],origins:unknown[]=[],options:ResidentMaintenanceOptions={renderError:e=>e instanceof Error?e.message:"unknown",fence:{requestOrigin:(m,p)=>{origins.push([m,p]);return {target:"T",stopRevision:0n};},checkRequest(){},beginMutationWithOrigin:claim=>{claims.push(claim);return true;},finishMutation:c=>{claims.push(c);}}};
  const code=`import readline from 'node:readline';const mode=${JSON.stringify(mode)};let unloaded=false;const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');const lines=readline.createInterface({input:process.stdin});lines.on('line',line=>{const m=JSON.parse(line),reply=v=>emit({id:m.id,result:v});if(m.method==='initialize')reply({});else if(m.method==='seed'){emit({method:'turn/completed',params:{threadId:'T',turnId:'V'}});reply({});}else if(m.method==='thread/resume'){if(mode==='resumeHang')return;setTimeout(()=>reply({thread:{id:mode==='resumeWrong'?'wrong':'T'},params:m.params}),mode==='resumeSlow'?60:0);}else if(m.method==='thread/goal/get')reply({goal:null});else if(m.method==='thread/read')reply({thread:{id:'T',status:{type:unloaded?'notLoaded':'idle'},turns:[{id:'V',status:'completed'}]}});else if(m.method==='thread/unsubscribe'){if(mode==='hang')return;setTimeout(()=>{unloaded=true;reply({status:'unsubscribed'});},mode==='slow'?70:0);}});`;
  try{
    owner=await PortableResidentLifecycle.start({process:{executable:process.execPath,arguments:["--input-type=module","-e",code],environment:{}},clientInfo:{name:"fixture",title:"Fixture",version:"1"}},()=>"diagnostic",{persistDeadWork(){},oldChildExited(){}},t.signal,options);
    const current=()=>selectIdleIntentIn(db,"T")! as IdleReleaseToken;
    owner.installIdleReleaseJournal({beforeMutation:(id,g,thread)=>beforeIdleMutationOn(db,id,g,thread),checkMutation:(thread)=>{const row=selectIdleIntentIn(db,thread);if(row!==null&&row.state!=="Candidate"&&row.state!=="Settled")throw new Error("target mutation held");},resumeRequired:()=>false,verify:(expected,idle)=>verifyIdleIntentIn(db,expected,idle),transition:(old,state,detail)=>transitionIdleIntentOn(db,old,state,detail),oldChildExited:(id,g)=>settleExitedIdleOwnerIn(db,id,g)});
    db.prepare("INSERT INTO cdr_idle_release(intent_id,owner_id,generation,thread_id,turn_id,job_id,revision,state) VALUES('i',?,1,'T','V','job',1,'Candidate')").run(owner.instanceId);
    const native=owner,call=async(method:string)=>{const a=native.admitRequest();try{return await a.client.requestAdmitted(a.permit,method,{},1000);}finally{a.release();}};
    await call("seed");const event=owner.observationWindow(1n,0n).events[0]!.notification!;owner.confirmIdleObservation(1n,event);
    await body({owner,db,current,call,claims,origins,options});
  }finally{try{if(owner)await owner.dispose();}finally{db.close();}}
});}
test("resident owns full idle release from real SQLite permission through native ACK and fresh unload read",{timeout:15000},async t=>withOwner(t,"normal",async f=>{
  await f.owner.releaseIdleSubscription(f.current());assert.equal(f.current().state,"AwaitUnload");assert.equal(f.current().revision,3n);assert.equal(f.claims.length,2);assert.deepEqual(f.origins[0],["thread/unsubscribe",{threadId:"T"}]);
  await f.owner.releaseIdleSubscription(f.current());assert.equal(f.current().state,"Settled");assert.equal(f.current().detail,"UnloadedConfirmed");assert.equal(f.current().revision,4n);assert.equal(f.claims.length,2);const a=f.owner.admitRequest();assert.equal(a.client.admissionSnapshot().inFlight,1n);a.release();
}));
test("foreign owner or generation releases reserved permits and cannot issue native maintenance",{timeout:15000},async t=>withOwner(t,"normal",async f=>{
  f.db.prepare("UPDATE cdr_idle_release SET owner_id='foreign'").run();await assert.rejects(f.owner.releaseIdleSubscription(f.current()),/owner mismatch/);assert.equal(f.current().state,"Candidate");assert.equal(f.claims.length,0);
  f.db.prepare("UPDATE cdr_idle_release SET owner_id=?,generation=9").run(f.owner.instanceId);await assert.rejects(f.owner.releaseIdleSubscription(f.current()),/generation mismatch/);assert.equal(f.claims.length,0);
  f.db.exec("UPDATE cdr_idle_release SET generation=1");await f.owner.releaseIdleSubscription(f.current());assert.equal(f.current().state,"AwaitUnload");
}));
test("caller not observing the promise does not release admission early or permit a competing restart",{timeout:15000},async t=>withOwner(t,"slow",async f=>{
  const operation=f.owner.releaseIdleSubscription(f.current());while(f.current().state!=="Dispatching")await delay(1,undefined,{signal:t.signal});assert.equal(await f.owner.forceRestartIfQuiescent(t.signal),false);assert.equal(f.owner.generation(),1n);await operation;assert.equal(f.current().state,"AwaitUnload");assert.equal(await f.owner.restartIfQuiescent(t.signal),true);assert.equal(f.owner.generation(),2n);assert.equal(f.current().state,"Settled");assert.equal(f.current().detail,"OldServerExited");
}));
test("terminal close joins in-flight owned maintenance before recording native exit in the store",{timeout:15000},async t=>withOwner(t,"hang",async f=>{
  const operation=f.owner.releaseIdleSubscription(f.current()),settled=operation.then(()=>({ok:true}),error=>({ok:false,error}));while(f.current().state!=="Dispatching")await delay(1,undefined,{signal:t.signal});await f.owner.close();assert.equal((await settled).ok,false);assert.equal(f.current().state,"Settled");assert.equal(f.current().detail,"OldServerExited");assert.throws(()=>f.owner.admitRequest(),/closed/);
}));
test("owner options are pinned and unknown intent phases cannot enter the native release workflow",{timeout:15000},async t=>withOwner(t,"normal",async f=>{
  if(f.options.fence)f.options.fence.requestOrigin=()=>{throw new Error("changed callback");};f.db.exec("UPDATE cdr_idle_release SET state='Unknown'");await assert.rejects(f.owner.releaseIdleSubscription(f.current()),/only Candidate/);assert.equal(f.claims.length,0);f.db.exec("UPDATE cdr_idle_release SET state='Candidate'");await f.owner.releaseIdleSubscription(f.current());assert.equal(f.current().state,"AwaitUnload");
}));
test("ordinary target mutation performs one real resume then returns a counted ready permit",{timeout:15000},async t=>withOwner(t,"normal",async f=>{
  f.db.exec("UPDATE cdr_idle_release SET state='AwaitUnload'");const prepared=await f.owner.prepareTargetMutation("turn/start",{threadId:"T",prompt:"next"},1n,{target:"T",stopRevision:5n});assert.equal(prepared.kind,"Ready");if(prepared.kind!=="Ready")throw new Error("unexpected completed");assert.ok(prepared.permit);assert.equal(f.current().state,"Settled");assert.equal(f.current().detail,"SupersededByConfirmedResubscribe");assert.equal(f.claims.length,2);assert.equal(f.origins.length,0);
  const claim=f.claims[0] as {method:string;params:unknown;origin:unknown};assert.equal(claim.method,"thread/resume");assert.deepEqual(claim.params,{threadId:"T"});assert.deepEqual(claim.origin,{target:"T",stopRevision:5n});f.owner.checkActualTargetMutation(prepared.permit,1n,"turn/start",{threadId:"T"});prepared.permit.release();assert.throws(()=>f.owner.checkActualTargetMutation(prepared.permit,1n,"turn/start",{threadId:"T"}),/released/);
}));
test("an original thread/resume returns Completed with its exact settings and must not replay another resume",{timeout:15000},async t=>withOwner(t,"normal",async f=>{
  f.db.exec("UPDATE cdr_idle_release SET state='AwaitUnload'");const params={threadId:"T",model:"exact-model",extra:{key:"v"}},result=await f.owner.prepareTargetMutation("thread/resume",params,1n);assert.equal(result.kind,"Completed");if(result.kind!=="Completed")throw new Error("unexpected ready");assert.deepEqual((result.value as {params:unknown}).params,params);assert.equal(f.claims.length,2);assert.equal(f.current().state,"Settled");
}));
test("source read-only/new-thread allowlist bypasses held existing target while unknown methods remain held",{timeout:15000},async t=>withOwner(t,"normal",async f=>{
  f.db.exec("UPDATE cdr_idle_release SET state='Unknown'");for(const method of ["thread/read","thread/turns/list","thread/goal/get","thread/list","thread/loaded/list","model/list","account/rateLimits/read","account/usage/read","thread/start"]){const p=await f.owner.prepareTargetMutation(method,{threadId:"T"},1n);assert.deepEqual(p,{kind:"Ready",permit:null});}
  await assert.rejects(f.owner.prepareTargetMutation("unknown/new-mutation",{threadId:"T"},1n),/requires review/);assert.equal(f.claims.length,0);assert.equal(f.current().state,"Unknown");
}));
test("preparation keeps original params/origin during asynchronous resume and fences concurrent same-target work",{timeout:15000},async t=>withOwner(t,"resumeSlow",async f=>{
  f.db.exec("UPDATE cdr_idle_release SET state='AwaitUnload'");const params={threadId:"T",model:"original"},origin={target:"T",stopRevision:5n},pending=f.owner.prepareTargetMutation("thread/resume",params,1n,origin);params.model="changed";origin.stopRevision=6n;
  await assert.rejects(f.owner.prepareTargetMutation("turn/start",{threadId:"T"},1n),/maintenance is in flight/);const result=await pending;assert.equal(result.kind,"Completed");const claim=f.claims[0] as {params:unknown;origin:unknown};assert.deepEqual(claim.params,{threadId:"T",model:"original"});assert.deepEqual(claim.origin,{target:"T",stopRevision:5n});
}));
test("wrong native resume identity retains Unknown and denies the original mutation",{timeout:15000},async t=>withOwner(t,"resumeWrong",async f=>{
  f.db.exec("UPDATE cdr_idle_release SET state='AwaitUnload'");await assert.rejects(f.owner.prepareTargetMutation("turn/start",{threadId:"T"},1n),/wrong identity/);assert.equal(f.current().state,"Unknown");assert.equal(f.claims.length,2);await assert.rejects(f.owner.prepareTargetMutation("turn/start",{threadId:"T"},1n),/requires review/);
}));
test("final mutation check rejects generation changes before touching a counted target permit",{timeout:15000},async t=>withOwner(t,"normal",async f=>{
  const prepared=await f.owner.prepareTargetMutation("turn/start",{threadId:"T"},1n);if(prepared.kind!=="Ready")throw new Error("unexpected completed");assert.equal(f.current().state,"Settled");assert.equal(await f.owner.forceRestartIfQuiescent(t.signal),true);assert.equal(f.owner.generation(),2n);assert.throws(()=>f.owner.checkActualTargetMutation(prepared.permit,1n,"turn/start",{threadId:"T"}),/generation mismatch/);prepared.permit?.release();
}));
test("dispatch eligibility callback runs before any target state change and rejects async callbacks",{timeout:15000},async t=>withOwner(t,"normal",async f=>{
  const before=f.current(),sentinel=new Error("authority refused");await assert.rejects(f.owner.prepareTargetMutation("turn/start",{threadId:"T"},1n,null,()=>{throw sentinel;}),e=>e===sentinel);assert.deepEqual(f.current(),before);await assert.rejects(f.owner.prepareTargetMutation("turn/start",{threadId:"T"},1n,null,async()=>{}),/synchronous/);assert.deepEqual(f.current(),before);
}));
test("unexpected second resubscription is refused and its temporary exclusive permit is released",{timeout:15000},async t=>withOwner(t,"normal",async f=>{
  f.db.exec("UPDATE cdr_idle_release SET state='AwaitUnload'; CREATE TRIGGER rehold_after_resume AFTER UPDATE ON cdr_idle_release WHEN NEW.state='Settled' AND NEW.detail='SupersededByConfirmedResubscribe' BEGIN UPDATE cdr_idle_release SET state='AwaitUnload' WHERE thread_id=NEW.thread_id; END");
  await assert.rejects(f.owner.prepareTargetMutation("turn/start",{threadId:"T"},1n),/unexpected second resubscription/);assert.equal(f.current().state,"Resubscribing");assert.equal(f.claims.length,2);
  f.db.exec("DROP TRIGGER rehold_after_resume; UPDATE cdr_idle_release SET state='Settled'");const next=await f.owner.prepareTargetMutation("turn/start",{threadId:"T"},1n);assert.equal(next.kind,"Ready");if(next.kind==="Ready")next.permit?.release();
}));
