import {ResidentForwarders,type ResidentNotificationEvent,type ResidentServerRequestEvent} from "../../src/app-server/resident-forwarders.ts";
import {GenerationWatch} from "../../src/app-server/generation-watch.ts";
import {BoundedBroadcast} from "../../src/app-server/broadcast.ts";
import assert from "node:assert/strict";
import {test,type TestContext} from "node:test";
import {PortableAppServerSession,type PortableSessionConfig} from "../../src/app-server/portable-session.ts";
import {ResidentAdmissionState} from "../../src/app-server/resident-state.ts";
function config():PortableSessionConfig{
  const code=`import readline from 'node:readline';const emit=v=>process.stdout.write(JSON.stringify(v)+'\\n');const lines=readline.createInterface({input:process.stdin,crlfDelay:Infinity});lines.on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')emit({id:m.id,result:{}});else if(m.method==='read')emit({id:m.id,result:'ok'});else if(m.method==='start'){emit({method:'turn/started',params:{threadId:'t',turnId:'v'}});emit({id:m.id,result:{}});}else if(m.method==='finish'){emit({method:'turn/completed',params:{threadId:'t',turnId:'v'}});emit({id:m.id,result:{}});}else if(m.method==='approval'){emit({id:'approval',method:'approval',params:{threadId:'t',turnId:'v'}});emit({id:m.id,result:{}});}else if(m.method==='note')emit({method:'noted'});else if(m.method==='die')process.exit(0);});`;
  return {process:{executable:process.execPath,arguments:["--input-type=module","-e",code],environment:{}},clientInfo:{name:"resident-fixture",title:"Resident fixture",version:"0.1.0"}};
}
async function start(t:TestContext){
  const result=await PortableAppServerSession.startObserved(config(),session=>{const requests=session.subscribeServerRequests(),notifications=session.subscribeNotifications();return {value:{requests,notifications},dispose(){requests.dispose();notifications.dispose();}};},()=>"safe diagnostic",t.signal);
  t.after(async()=>{try{await result.session.dispose();}finally{result.observer.dispose();}});return result;
}
test("native resident binding has stable identity and preserves one caller admission",{timeout:10000},async t=>{
  const {session,observer}=await start(t),port=session.residentClient(),state=new ResidentAdmissionState(port);assert.equal(port,session.residentClient());assert.equal(Object.isFrozen(port),true);
  const admission=state.admitRequest(1n);assert.equal(port.admissionSnapshot().inFlight,1n);let atWrite=0n;
  assert.equal(await port.requestAdmitted(admission.permit,"read",{},1000,{preflight(){},writeStarted(){atWrite=port.admissionSnapshot().inFlight;},writeComplete(){}},t.signal),"ok");assert.equal(atWrite,2n);assert.equal(port.admissionSnapshot().inFlight,1n);
  await port.notifyAdmitted(admission.permit,"note",{},t.signal);assert.equal((await observer.value.notifications.receive(t.signal)).method,"noted");assert.equal(port.admissionSnapshot().inFlight,1n);
  state.requestRestart();assert.equal(state.restartCandidate().kind,"Busy");admission.release();assert.equal(state.restartCandidate().kind,"Sealed");assert.equal(port.admissionSnapshot().closeIntent,null);await assert.rejects(session.request("read",{},1000),/closed/);await session.dispose();assert.equal(session.resourcesClosed,true);
});
test("native quiescence checks active turns and unsettled incoming requests separately",{timeout:10000},async t=>{
  const {session,observer}=await start(t),port=session.residentClient(),state=new ResidentAdmissionState(port);state.requestRestart();
  await session.request("start",{},1000);assert.equal(session.activeTurnId("t"),"v");assert.equal(state.restartCandidate().kind,"Busy");
  await session.request("approval",{},1000);const request=await observer.value.requests.receive(t.signal);await session.request("finish",{},1000);assert.equal(session.activeTurnId("t"),null);assert.equal(state.restartCandidate().kind,"Busy");
  const reply=state.admitResponse(1n);await port.respondAdmitted(reply.permit,request.id,request.occurrence,true,undefined,t.signal);assert.equal(session.pendingServerRequests().length,0);assert.equal(state.restartCandidate().kind,"Busy");reply.release();assert.equal(state.restartCandidate().kind,"Sealed");assert.equal(state.restartCleanupAuthorized(1n),true);
});
test("foreign and released native permits cannot write or claim an incoming response",{timeout:10000},async t=>{
  const a=await start(t),b=await start(t),pa=a.session.residentClient(),pb=b.session.residentClient(),permit=pa.admitOperation();
  assert.notEqual(pa.identity,pb.identity);await b.session.request("approval",{},1000);const request=await b.observer.value.requests.receive(t.signal);
  await assert.rejects(pb.requestAdmitted(permit,"read",{},1000),/owned client permit/);await assert.rejects(pb.notifyAdmitted(permit,"note",{}),/owned client permit/);
  await assert.rejects(pb.respondAdmitted(permit,request.id,request.occurrence,true),/owned client permit/);await assert.rejects(pb.respondErrorAdmitted(permit,request.id,request.occurrence,{code:-1n,message:"no",data:null}),/owned client permit/);await assert.rejects(pb.respondCurrentAdmitted(permit,request.id,request.occurrence,true),/owned client permit/);assert.equal(b.session.pendingServerRequests().length,1);
  permit.release();await assert.rejects(pa.requestAdmitted(permit,"read",{},1000),/owned client permit/);assert.equal(pa.admissionSnapshot().inFlight,0n);assert.equal(pb.admissionSnapshot().inFlight,0n);
  const local=pb.admitOperation();try{await pb.respondErrorAdmitted(local,request.id,request.occurrence,{code:-1n,message:"denied",data:null});}finally{local.release();}assert.equal(b.session.pendingServerRequests().length,0);
});
test("native current response drains quarantined generation and replacement keeps client generation separate",{timeout:10000},async t=>{
  const old=await start(t),next=await start(t),port=old.session.residentClient(),replacement=next.session.residentClient(),state=new ResidentAdmissionState(port);
  await old.session.request("start",{},1000);await old.session.request("approval",{},1000);const request=await old.observer.value.requests.receive(t.signal);state.markTimeout(1n);const reply=state.admitResponse(1n);
  try{await port.respondCurrentAdmitted(reply.permit,request.id,request.occurrence,{approved:true});}finally{reply.release();}
  // This fixture completes the turn via the underlying owner; a full resident dispatch
  // controller and durable settlement are deliberately not simulated by this library test.
  await old.session.request("finish",{},1000);assert.equal(state.restartCandidate().kind,"Sealed");await old.session.dispose();state.recordReplacement(replacement,2n);state.installReplacementWith(replacement,2n,()=>{});
  assert.equal(state.generation(),2n);assert.equal(next.session.lifecycleSnapshot().generation,1n);state.markCurrentClosed(port,1n);const admitted=state.admitRequest(2n);try{assert.equal(await admitted.client.requestAdmitted(admitted.permit,"read",{},1000),"ok");}finally{admitted.release();}assert.equal(replacement.admissionSnapshot().inFlight,0n);
});
test("native cleanup remains possible after trusted publication poisons admission",{timeout:10000},async t=>{
  const {session}=await start(t),port=session.residentClient(),sentinel={};assert.throws(()=>port.withOpen(()=>{throw sentinel;}),e=>e===sentinel);assert.equal(port.admissionSnapshot().poisoned,true);port.sealAdmissions();assert.equal(port.admissionSnapshot().sealed,true);assert.throws(()=>port.admitOperation(),/poisoned/);await session.dispose();assert.equal(session.resourcesClosed,true);assert.equal(port.admissionSnapshot().poisoned,true);
});

test("actual native exit fences exact unfinished work before clearing transient state",{timeout:10000},async t=>{
  const {session,observer}=await start(t),port=session.residentClient(),state=new ResidentAdmissionState(port);
  await session.request("start",{},1000);await session.request("approval",{},1000);const request=await observer.value.requests.receive(t.signal);
  await assert.rejects(session.request("die",{},1000));await session.dispose();assert.equal(session.resourcesClosed,true);assert.equal(port.hasOwnedChildExited(),true);assert.equal(port.isTransportClosed(),true);
  state.markCurrentClosed(port,1n);let persisted=0;
  assert.equal(state.fenceDeadGenerationBeforeRestart(work=>{persisted++;assert.equal(work.generation,1n);assert.deepEqual(work.activeTurns,[{threadId:"t",turnId:"v"}]);assert.equal(work.serverRequests.length,1);assert.equal(work.serverRequests[0]!.occurrence.equals(request.occurrence),true);assert.equal(session.activeTurnId("t"),"v");assert.equal(session.pendingServerRequests().length,1);}),true);
  assert.equal(persisted,1);assert.equal(session.activeTurnId("t"),null);assert.equal(session.pendingServerRequests().length,0);assert.equal(state.deadGenerationWork(1n),null);
});

test("native resident forwarders activate only after state ownership and report exact-generation death",{timeout:10000},async t=>{
  const watch=new GenerationWatch(1n),notifications=new BoundedBroadcast<ResidentNotificationEvent>(1000),requests=new BoundedBroadcast<ResidentServerRequestEvent>(500),nr=notifications.subscribe(),rr=requests.subscribe();
  let state:ResidentAdmissionState<ReturnType<PortableAppServerSession["residentClient"]>>|undefined;
  const {session,observer}=await PortableAppServerSession.startObserved(config(),session=>({value:new ResidentForwarders(session,1n,notifications,requests,watch.subscribe(),{waitClosed:signal=>session.waitClosed(signal),onClosed(){state!.markCurrentClosed(session.residentClient(),1n);}}),dispose(){}}),()=>"safe diagnostic",t.signal);
  state=new ResidentAdmissionState(session.residentClient());t.after(async()=>{watch.replace(0n);try{await observer.value.join();}finally{try{await session.dispose();}finally{nr.dispose();rr.dispose();}}});
  observer.value.activate();await session.request("start",{},1000);await session.request("approval",{},1000);const event=await rr.receive(t.signal);assert.equal(event.kind,"Request");assert.equal(event.generation,1n);const notification=await nr.receive(t.signal);assert.equal(notification.kind,"Notification");assert.equal(notification.generation,1n);
  const changed=state.subscribeLifecycleChanges();await assert.rejects(session.request("die",{},1000));await changed.changed(t.signal);assert.equal(state.snapshot().accepting,false);assert.equal(state.restartPendingFor(1n),true);changed.dispose();watch.replace(0n);await observer.value.join();assert.equal(watch.receiverCount,0);
});
