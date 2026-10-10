import {ServerRequestOccurrence} from "../../src/protocol/ids.ts";
import {withStopOrigin} from "../../src/app-server/dispatch-origin.ts";
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
  const claims:unknown[]=[],origins:unknown[]=[],options:ResidentMaintenanceOptions={renderError:e=>e instanceof Error?e.message:"unknown",fence:{requestOrigin:(m,p)=>{origins.push([m,p]);return {target:"T",stopRevision:0n};},checkRequest(){},beginMutationWithOrigin:claim=>{claims.push(claim);return true;},finishMutation:c=>{claims.push(c);},responseAuthority:request=>{claims.push({kind:"response-authority",...request});return mode==="noResponseAuthority"?null:{value:mode==="responseNull"?null:{custody:"original",revision:5n}};},...(mode==="responseLegacy"?{}:{beginResponse:(claim:unknown)=>{claims.push({kind:"begin-response",...(claim as object)});if(mode==="responseBeginFail")throw new Error("response begin failed");},finishResponse:(completion:unknown)=>{claims.push({kind:"finish-response",...(completion as object)});if(mode==="responseFinishFail")throw new Error("response finish failed");}}),...(mode==="legacyFence"?{}:{beginQueueMutation:(c:unknown)=>{claims.push({kind:"queue",...(c as object)});return true;},beginStopMutation:(c:unknown)=>{claims.push({kind:"stop",...(c as object)});return true;},finishStopMutation:(c:unknown)=>{claims.push({kind:"finish-stop",...(c as object)});}})}};
  const code=`import readline from 'node:readline';const mode=${JSON.stringify(mode)};let unloaded=false;const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');const lines=readline.createInterface({input:process.stdin});lines.on('line',line=>{const m=JSON.parse(line),reply=v=>emit({id:m.id,result:v});if(m.id==='approval'&&m.method===undefined){emit({method:'fixture/answered',params:m});return;}if(m.method==='ask'){emit({id:'approval',method:'approval',params:{threadId:'T',turnId:'V'}});reply({});return;}if(m.method==='initialize')reply({});else if(m.method==='seed'){emit({method:'turn/completed',params:{threadId:'T',turnId:'V'}});reply({});}else if(m.method==='thread/resume'){if(mode==='resumeHang')return;setTimeout(()=>reply({thread:{id:mode==='resumeWrong'?'wrong':'T'},params:m.params}),mode==='resumeSlow'?60:0);}else if(m.method==='thread/goal/get')reply({goal:null});else if(m.method==='thread/read')reply({thread:{id:'T',status:{type:unloaded?'notLoaded':'idle'},turns:[{id:'V',status:'completed'}]}});else if(m.method==='thread/unsubscribe'){if(mode==='hang')return;setTimeout(()=>{unloaded=true;reply({status:'unsubscribed'});},mode==='slow'?70:0);}else if(mode==='rpcHang')return;else if(mode==='rpcRemote')emit({id:m.id,error:{code:-7,message:'rejected'}});else setTimeout(()=>reply({method:m.method,params:m.params}),mode==='rpcDelayed'?250:0);});`;
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
test("native nested resubscription keeps first task-local stop origin instead of refreshing explicit metadata",{timeout:15000},async t=>withOwner(t,"normal",async f=>{
  f.db.exec("UPDATE cdr_idle_release SET state='AwaitUnload'");await withStopOrigin({target:"T",stopRevision:3n},async()=>withStopOrigin({target:"T",stopRevision:8n},async()=>{const result=await f.owner.prepareTargetMutation("thread/resume",{threadId:"T"},1n,{target:"T",stopRevision:99n});assert.equal(result.kind,"Completed");}));assert.deepEqual((f.claims[0] as {origin:unknown}).origin,{target:"T",stopRevision:3n});
}));
test("ordinary resident request binds one original origin, exact native request and completion",{timeout:15000},async t=>withOwner(t,"normal",async f=>{
  const result=await f.owner.request("turn/start",{threadId:"T",prompt:"hello"},1000,1n);assert.deepEqual(result,{method:"turn/start",params:{threadId:"T",prompt:"hello"}});assert.equal(f.claims.length,2);assert.equal((f.claims[0] as any).scoped,true);assert.equal((f.claims[1] as any).outcome,"reply_ok");assert.equal(f.origins.length,1);const a=f.owner.admitRequest();assert.equal(a.client.admissionSnapshot().inFlight,1n);a.release();
}));
test("queue metadata is validated before bytes and reaches only the queue fence, never RPC params",{timeout:15000},async t=>withOwner(t,"normal",async f=>{
  const request={method:"turn/start",params:{threadId:"T",prompt:"queued"},timeoutMs:1000},claim={target_thread_id:"T",app_server_generation:1n,claimId:"original"};const value=await f.owner.executeQueueTurn(request,1n,claim);assert.deepEqual(value,{method:"turn/start",params:request.params});assert.equal((f.claims[0] as any).kind,"queue");assert.deepEqual((f.claims[0] as any).claim,claim);
  const count=f.claims.length;assert.throws(()=>f.owner.executeQueueTurn(request,1n,{...claim,target_thread_id:"other"}),/original claim/);assert.throws(()=>f.owner.executeQueueTurn(request,1n,{...claim,app_server_generation:2n}),/original claim/);assert.equal(f.claims.length,count);
}));
test("stop control binds resident, generation, target and turn with its original completion callback",{timeout:15000},async t=>withOwner(t,"normal",async f=>{
  const request={method:"turn/interrupt",params:{threadId:"T",turnId:"V"},timeoutMs:1000},claim={control:{target:"T",turn:"V",generation:1n,resident:f.owner.instanceId},custody:"original"};let checks=0;const result=await f.owner.executeStopControl(request,1n,claim,()=>{checks++;});assert.deepEqual(result,{method:"turn/interrupt",params:request.params});assert.equal((f.claims[0] as any).kind,"stop");assert.equal((f.claims[1] as any).kind,"finish-stop");assert.deepEqual((f.claims[1] as any).claim,claim);assert.equal(checks,4);
  assert.throws(()=>f.owner.executeStopControl(request,1n,{...claim,control:{...claim.control,resident:"foreign"}},()=>{}),/original durable authority/);assert.throws(()=>f.owner.executeStopControl({...request,params:{threadId:"T",turnId:"wrong"}},1n,claim,()=>{}),/original durable authority/);
}));
test("installed legacy fence cannot silently accept queue or original stop claims",{timeout:15000},async t=>withOwner(t,"legacyFence",async f=>{
  await assert.rejects(f.owner.executeQueueTurn({method:"turn/start",params:{threadId:"T"},timeoutMs:1000},1n,{target_thread_id:"T",app_server_generation:1n}),/does not support claimed queue/);assert.equal(f.claims.length,0);
  await assert.rejects(f.owner.executeStopControl({method:"turn/interrupt",params:{threadId:"T",turnId:"V"},timeoutMs:1000},1n,{control:{target:"T",turn:"V",generation:1n,resident:f.owner.instanceId}},()=>{}),/does not support original stop/);assert.equal(f.claims.length,0);
}));
test("native request timeout distinguishes scoped durable isolation from unscoped unknown operations",{timeout:15000},async t=>withOwner(t,"rpcHang",async f=>{
  await assert.rejects(f.owner.request("turn/start",{threadId:"T"},35,1n),/outcome remains unknown/);assert.equal(f.owner.lifecycleSnapshot().quarantined,false);assert.equal(f.claims.length,1);
  await assert.rejects(f.owner.request("unknown/action",{threadId:"T"},35,1n),/outcome remains unknown/);assert.equal(f.owner.lifecycleSnapshot().quarantined,true);assert.equal(f.claims.length,2);
}));
test("native Remote reply records reply_error without converting a healthy target into quarantine",{timeout:15000},async t=>withOwner(t,"rpcRemote",async f=>{
  await assert.rejects(f.owner.request("turn/start",{threadId:"T"},1000,1n),/rejected/);assert.equal((f.claims[1] as any).outcome,"reply_error");assert.equal(f.owner.lifecycleSnapshot().quarantined,false);
}));
test("ordinary dispatch requiring resume does not resend an original resume request",{timeout:15000},async t=>withOwner(t,"normal",async f=>{
  f.db.exec("UPDATE cdr_idle_release SET state='AwaitUnload'");const params={threadId:"T",model:"M"},result=await f.owner.request("thread/resume",params,1000,1n);assert.deepEqual((result as any).params,params);assert.equal(f.claims.length,2);assert.equal(f.origins.length,1);
}));
test("already-aborted requests create no origin capture, target mutation or wire claim",{timeout:15000},async t=>withOwner(t,"normal",async f=>{
  const abort=new AbortController(),reason={cancelled:true};abort.abort(reason);const before=f.current();assert.throws(()=>f.owner.request("turn/start",{threadId:"T"},1000,1n,abort.signal),e=>e===reason);assert.equal(f.origins.length,0);assert.equal(f.claims.length,0);assert.deepEqual(f.current(),before);
}));
test("cancellation during managed resume abandons only the caller wait and releases late target admission",{timeout:15000},async t=>withOwner(t,"resumeSlow",async f=>{
  f.db.exec("UPDATE cdr_idle_release SET state='AwaitUnload'");const abort=new AbortController(),reason={cancelled:true};const operation=f.owner.request("turn/start",{threadId:"T"},1000,1n,abort.signal),rejected=assert.rejects(operation,e=>e===reason);while(f.current().state!=="Resubscribing")await delay(1,undefined,{signal:t.signal});abort.abort(reason);await rejected;
  while(f.current().state!=="Settled")await delay(1,undefined,{signal:t.signal});await delay(1,undefined,{signal:t.signal});assert.equal(f.claims.length,2);assert.equal((f.claims[0] as any).method,"thread/resume");const next=await f.owner.prepareTargetMutation("turn/start",{threadId:"T"},1n);assert.equal(next.kind,"Ready");if(next.kind==="Ready")next.permit?.release();const a=f.owner.admitRequest();assert.equal(a.client.admissionSnapshot().inFlight,1n);a.release();
}));
test("caller cancellation after a flushed scoped mutation preserves its durable intent without global quarantine",{timeout:15000},async t=>withOwner(t,"rpcDelayed",async f=>{
  const abort=new AbortController(),reason={aborted:true},operation=f.owner.request("turn/start",{threadId:"T"},1000,1n,abort.signal),rejected=assert.rejects(operation,e=>e===reason);
  while(f.claims.length===0)await delay(1,undefined,{signal:t.signal});
  // A later observational round-trip shares the same serialized native writer and
  // establishes that the prior write completed before caller cancellation.
  await f.owner.request("thread/read",{threadId:"other",includeTurns:false},1000,1n);abort.abort(reason);await rejected;assert.equal(f.owner.lifecycleSnapshot().quarantined,false);assert.equal(f.claims.length,1);
  await delay(300,undefined,{signal:t.signal});assert.equal(f.claims.length,1);const a=f.owner.admitRequest();assert.equal(a.client.admissionSnapshot().inFlight,1n);a.release();
}));
test("caller cancellation of a flushed unscoped unknown request quarantines the same generation",{timeout:15000},async t=>withOwner(t,"rpcDelayed",async f=>{
  const abort=new AbortController(),reason={aborted:true},operation=f.owner.request("unknown/action",{threadId:"T"},1000,1n,abort.signal),rejected=assert.rejects(operation,e=>e===reason);while(f.claims.length===0)await delay(1,undefined,{signal:t.signal});await f.owner.request("thread/read",{threadId:"other"},1000,1n);abort.abort(reason);await rejected;assert.equal(f.owner.lifecycleSnapshot().quarantined,true);assert.equal(f.claims.length,1);assert.throws(()=>f.owner.admitRequest(),/quarantined/);
}));
test("request DTO accessors cannot change the validated queue method or run before dispatch checks",{timeout:15000},async t=>withOwner(t,"normal",async f=>{
  let calls=0;const request={get method(){calls++;return calls===1?"turn/start":"unknown/action";},params:{threadId:"T"},timeoutMs:1000};await assert.rejects(async()=>f.owner.executeQueueTurn(request,1n,{target_thread_id:"T",app_server_generation:1n}),TypeError);assert.equal(calls,0);assert.equal(f.origins.length,0);assert.equal(f.claims.length,0);
}));
async function approval(f:Fixture,t:TestContext){const receiver=f.owner.subscribeServerRequests();try{await f.call("ask");const event=await receiver.receive(t.signal);assert.equal(event.kind,"Request");if(event.kind!=="Request")throw new Error("unexpected gap");return event.request;}finally{receiver.dispose();}}
async function answered(receiver:ReturnType<PortableResidentLifecycle["subscribeNotifications"]>,t:TestContext){for(;;){const event=await receiver.receive(t.signal);if(event.kind==="Notification"&&event.notification.method==="fixture/answered")return event.notification.params;}}
test("resident response snapshots exact original occurrence/authority and records only after native flush",{timeout:15000},async t=>withOwner(t,"normal",async f=>{
  const request=await approval(f,t),receiver=f.owner.subscribeNotifications();try{await f.owner.respond(request.id,request.occurrence,{approved:true},1n);assert.deepEqual(await answered(receiver,t),{id:"approval",result:{approved:true}});const calls=f.claims as any[];assert.deepEqual(calls.map(c=>c.kind),["response-authority","begin-response","finish-response"]);assert.deepEqual(calls[1].request.params,{threadId:"T",turnId:"V"});assert.deepEqual(calls[1].request.occurrence.asBytes(),request.occurrence.asBytes());assert.deepEqual(calls[1].authority,{custody:"original",revision:5n});assert.equal(calls[2].outcome,"flushed");await assert.rejects(f.owner.respond(request.id,request.occurrence,{},1n),/stale/);}finally{receiver.dispose();}
}));
test("error responses bind their exact error payload and preserve explicit Some-null authority",{timeout:15000},async t=>withOwner(t,"responseNull",async f=>{
  const request=await approval(f,t),receiver=f.owner.subscribeNotifications();try{await f.owner.respondError(request.id,request.occurrence,{code:-7n,message:"refused",data:null},1n);assert.deepEqual(await answered(receiver,t),{id:"approval",error:{code:-7n,message:"refused",data:null}});assert.equal((f.claims[1] as any).authority,null);assert.equal((f.claims[2] as any).outcome,"flushed");}finally{receiver.dispose();}
}));
test("missing durable response authority preserves legacy path, but declared authority requires supporting callbacks",{timeout:15000},async t=>{
  await withOwner(t,"noResponseAuthority",async f=>{const request=await approval(f,t);await f.owner.respond(request.id,request.occurrence,true,1n);assert.equal(f.claims.length,1);});
  await withOwner(t,"responseLegacy",async f=>{const request=await approval(f,t);await assert.rejects(f.owner.respond(request.id,request.occurrence,true,1n),/original response admission is unavailable/);assert.equal(f.claims.length,1);await assert.rejects(f.owner.respond(request.id,request.occurrence,true,1n),/indeterminate/);});
});
test("failed durable response finish remains unknown after actual flush and cannot be resent",{timeout:15000},async t=>withOwner(t,"responseFinishFail",async f=>{
  const request=await approval(f,t),receiver=f.owner.subscribeNotifications();try{await assert.rejects(f.owner.respond(request.id,request.occurrence,true,1n),/response finish failed; original response admission retained/);assert.deepEqual(await answered(receiver,t),{id:"approval",result:true});await assert.rejects(f.owner.respond(request.id,request.occurrence,true,1n),/stale/);assert.equal(f.owner.lifecycleSnapshot().quarantined,false);}finally{receiver.dispose();}
}));
test("response target waits retain original payload and authority rather than recapturing after resume",{timeout:15000},async t=>withOwner(t,"resumeSlow",async f=>{
  const request=await approval(f,t);f.db.exec("UPDATE cdr_idle_release SET state='AwaitUnload'");const result={approved:true},operation=f.owner.respond(request.id,request.occurrence,result,1n);result.approved=false;await operation;const captures=(f.claims as any[]).filter(c=>c.kind==="response-authority"),begins=(f.claims as any[]).filter(c=>c.kind==="begin-response");assert.equal(captures.length,1);assert.equal(begins.length,1);assert.deepEqual(begins[0].payload,{id:"approval",result:{approved:true}});assert.deepEqual(begins[0].request.params,captures[0].request.params);
}));
test("stale response occurrence is rejected before any durable authority capture",{timeout:15000},async t=>withOwner(t,"normal",async f=>{
  const request=await approval(f,t);await assert.rejects(f.owner.respond(request.id,ServerRequestOccurrence.random(),true,1n),/stale/);assert.equal(f.claims.length,0);await f.owner.respond(request.id,request.occurrence,true,1n);
}));
test("an occurrence consumed during target wait is not reselected by ID and cannot commit response authority",{timeout:15000},async t=>withOwner(t,"resumeSlow",async f=>{
  const request=await approval(f,t);f.db.exec("UPDATE cdr_idle_release SET state='AwaitUnload'");const operation=f.owner.respond(request.id,request.occurrence,{first:true},1n),rejected=assert.rejects(operation,/stale/);while(f.current().state!=="Resubscribing")await delay(1,undefined,{signal:t.signal});const a=f.owner.admitResponse(1n);try{await a.client.respondAdmitted(a.permit,request.id,request.occurrence,{separate:true});}finally{a.release();}await rejected;assert.equal((f.claims as any[]).filter(c=>c.kind==="begin-response").length,0);
}));
test("invalid observation window returns a normal error without poisoning later native admissions",{timeout:15000},async t=>withOwner(t,"normal",async f=>{
  assert.throws(()=>f.owner.observationWindow(1n,0n,99n),/invalid observation window/);assert.equal(f.owner.observationWindow(1n,0n).sourceUpper,1n);assert.ok(await f.owner.request("thread/read",{threadId:"T"},1000,1n));
}));
test("explicitly scoped node_repl repair accepts only its bounded methods and retains target isolation",{timeout:15000},async t=>withOwner(t,"rpcHang",async f=>{
  const params={threadId:"T",server:"node_repl",tool:"js",arguments:{code:"1+1"}};await assert.rejects(f.owner.requestForToolRepair("mcpServer/tool/call",params,35,1n),/outcome remains unknown/);assert.equal(f.owner.lifecycleSnapshot().quarantined,false);assert.equal((f.claims[0] as any).scoped,true);
  for(const [method,params]of [["turn/start",{threadId:"T"}],["mcpServer/tool/call",{threadId:"T",server:"other",tool:"js"}],["mcpServer/tool/call",{threadId:"T",server:"node_repl",tool:"delete"}],["thread/read",{threadId:""}]] as const)assert.throws(()=>f.owner.requestForToolRepair(method,params,1000,1n),/scoped node_repl request/);assert.equal(f.claims.length,1);
}));
test("repair eligibility is rechecked after waits and can deny actual write after durable preparation",{timeout:15000},async t=>withOwner(t,"normal",async f=>{
  let checks=0;const error=new Error("custody changed");await assert.rejects(f.owner.requestForToolRepairChecked("mcpServer/tool/call",{threadId:"T",server:"node_repl",tool:"js_reset"},1000,1n,()=>{if(++checks===4)throw error;}),e=>e===error);assert.equal(checks,4);assert.equal(f.claims.length,2);assert.equal((f.claims[1] as any).outcome,"not_sent");assert.equal(f.owner.lifecycleSnapshot().quarantined,false);
}));
test("native recovery observation is pinned to one live current admission and read-only request",{timeout:15000},async t=>withOwner(t,"normal",async f=>{
  const pin=f.owner.admitResponse(1n);try{const value=await f.owner.requestForRecoveryObservation(pin,{method:"thread/read",params:{threadId:"T"},timeoutMs:1000});assert.equal((value as any).thread.id,"T");assert.equal(f.claims.length,0);assert.throws(()=>f.owner.requestForRecoveryObservation(pin,{method:"turn/start",params:{threadId:"T"},timeoutMs:1000}),/exact read-only requests/);assert.throws(()=>f.owner.requestForRecoveryObservation(pin,{method:"thread/read",params:{threadId:""},timeoutMs:1000}),/exact read-only requests/);}finally{pin.release();}
  assert.throws(()=>f.owner.requestForRecoveryObservation(pin,{method:"thread/read",params:{threadId:"T"},timeoutMs:1000}),/current owned client permit/);
}));
test("recovery cannot cross native owners or proceed after restart is pending",{timeout:15000},async t=>withOwner(t,"normal",async a=>withOwner(t,"normal",async b=>{
  const pin=a.owner.admitResponse(1n);try{await assert.rejects(b.owner.requestForRecoveryObservation(pin,{method:"thread/read",params:{threadId:"T"},timeoutMs:1000}),/no longer current and open/);a.owner.requestRestart();await assert.rejects(a.owner.requestForRecoveryObservation(pin,{method:"thread/read",params:{threadId:"T"},timeoutMs:1000}),/no longer current and open/);assert.equal(a.claims.length,0);assert.equal(b.claims.length,0);}finally{pin.release();}
})));
test("shape-compatible or proxied native recovery pins cannot execute injected client methods",{timeout:15000},async t=>withOwner(t,"normal",async f=>{
  const pin=f.owner.admitResponse(1n);let calls=0;try{const fake=Object.freeze({...pin,client:new Proxy(pin.client,{get(){calls++;throw new Error("proxy read");}})});assert.throws(()=>f.owner.requestForRecoveryObservation(fake,{method:"thread/read",params:{threadId:"T"},timeoutMs:1000}),/native recovery client/);const copied=Object.freeze({...pin,client:Object.freeze({...pin.client,requireOwnedAdmission(){calls++;}})});assert.throws(()=>f.owner.requestForRecoveryObservation(copied,{method:"thread/read",params:{threadId:"T"},timeoutMs:1000}),/native recovery client/);assert.equal(calls,0);}finally{pin.release();}
}));
