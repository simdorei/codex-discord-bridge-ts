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
  const code=`import readline from 'node:readline';const mode=${JSON.stringify(mode)};let unloaded=false;const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');const lines=readline.createInterface({input:process.stdin});lines.on('line',line=>{const m=JSON.parse(line),reply=v=>emit({id:m.id,result:v});if(m.method==='initialize')reply({});else if(m.method==='seed'){emit({method:'turn/completed',params:{threadId:'T',turnId:'V'}});reply({});}else if(m.method==='thread/goal/get')reply({goal:null});else if(m.method==='thread/read')reply({thread:{id:'T',status:{type:unloaded?'notLoaded':'idle'},turns:[{id:'V',status:'completed'}]}});else if(m.method==='thread/unsubscribe'){if(mode==='hang')return;setTimeout(()=>{unloaded=true;reply({status:'unsubscribed'});},mode==='slow'?70:0);}});`;
  try{
    owner=await PortableResidentLifecycle.start({process:{executable:process.execPath,arguments:["--input-type=module","-e",code],environment:{}},clientInfo:{name:"fixture",title:"Fixture",version:"1"}},()=>"diagnostic",{persistDeadWork(){},oldChildExited(){}},t.signal,options);
    const current=()=>selectIdleIntentIn(db,"T")! as IdleReleaseToken;
    owner.installIdleReleaseJournal({beforeMutation:(id,g,thread)=>beforeIdleMutationOn(db,id,g,thread),checkMutation(){},resumeRequired:()=>false,verify:(expected,idle)=>verifyIdleIntentIn(db,expected,idle),transition:(old,state,detail)=>transitionIdleIntentOn(db,old,state,detail),oldChildExited:(id,g)=>settleExitedIdleOwnerIn(db,id,g)});
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
