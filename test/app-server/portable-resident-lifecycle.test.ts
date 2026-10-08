import {GenerationWatchClosedError} from "../../src/app-server/generation-watch.ts";
import assert from "node:assert/strict";
import {test,type TestContext} from "node:test";
import {setTimeout as delay} from "node:timers/promises";
import {PortableResidentLifecycle,type ResidentPersistence} from "../../src/app-server/portable-resident-lifecycle.ts";
import {PortableAppServerSession,type PortableSessionConfig} from "../../src/app-server/portable-session.ts";
import type {DeadGenerationWork} from "../../src/app-server/dead-generation-work.ts";
function config():PortableSessionConfig{
  const code=`import readline from 'node:readline';const emit=v=>process.stdout.write(JSON.stringify(v)+'\\n');const lines=readline.createInterface({input:process.stdin,crlfDelay:Infinity});lines.on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize'||m.method==='read')emit({id:m.id,result:'ok'});else if(m.method==='start'){emit({method:'turn/started',params:{threadId:'t',turnId:'v'}});emit({id:m.id,result:{}});}else if(m.method==='finish'){emit({method:'turn/completed',params:{threadId:'t',turnId:'v'}});emit({id:m.id,result:{}});}else if(m.method==='die')process.exit(0);});`;
  return {process:{executable:process.execPath,arguments:["--input-type=module","-e",code],environment:{}},clientInfo:{name:"resident-lifecycle-fixture",title:"Fixture",version:"0.1.0"}};
}
async function start(t:TestContext,persistence:ResidentPersistence={persistDeadWork(){},oldChildExited(){}}){const owner=await PortableResidentLifecycle.start(config(),()=>"safe diagnostic",persistence,t.signal);t.after(()=>owner.dispose());return owner;}
async function call(owner:PortableResidentLifecycle,method:string,signal?:AbortSignal){const a=owner.admitRequest();try{return await a.client.requestAdmitted(a.permit,method,{},2000,undefined,signal);}finally{a.release();}}
async function finishRestart(owner:PortableResidentLifecycle,signal:AbortSignal){while(!await owner.restartIfQuiescent(signal))await delay(1,undefined,{signal});}
test("owned resident replaces a quiescent native child and keeps owner identity stable",{timeout:15000},async t=>{
  const exits:{id:string;generation:bigint}[]=[],owner=await start(t,{persistDeadWork(){throw new Error("quiescent cleanup must not persist dead work");},oldChildExited(id,generation){exits.push({id,generation});}}),id=owner.instanceId,pid=owner.lifecycleSnapshot().processId;
  assert.equal(owner.generation(),1n);assert.equal(owner.lifecycleSnapshot().healthy,true);assert.equal(await call(owner,"read",t.signal),"ok");assert.equal(await owner.restartIfQuiescent(),false);assert.equal(await owner.forceRestartIfQuiescent(t.signal),true);
  assert.equal(owner.generation(),2n);assert.equal(owner.instanceId,id);assert.notEqual(owner.lifecycleSnapshot().processId,pid);assert.equal(owner.lifecycleSnapshot().healthy,true);assert.deepEqual(exits,[{id,generation:1n}]);assert.equal(await call(owner,"read",t.signal),"ok");
});
test("concurrent force requests captured for one generation create only one replacement",{timeout:15000},async t=>{
  const exits:bigint[]=[],owner=await start(t,{persistDeadWork(){},oldChildExited(_id,generation){exits.push(generation);}});const first=owner.forceRestartIfQuiescent(t.signal),second=owner.forceRestartIfQuiescent(t.signal);assert.deepEqual(await Promise.all([first,second]),[true,true]);assert.equal(owner.generation(),2n);assert.deepEqual(exits,[1n]);assert.equal(await owner.restartGenerationIfQuiescent(1n),true);assert.equal(owner.generation(),2n);
});
test("busy permits and active turns defer replacement without closing current child",{timeout:15000},async t=>{
  const owner=await start(t),pid=owner.lifecycleSnapshot().processId,a=owner.admitRequest();assert.equal(await owner.forceRestartIfQuiescent(t.signal),false);assert.equal(owner.lifecycleSnapshot().processId,pid);a.release();await call(owner,"start",t.signal);assert.equal(await owner.restartIfQuiescent(t.signal),false);await call(owner,"finish",t.signal);assert.equal(await owner.restartIfQuiescent(t.signal),true);assert.equal(owner.generation(),2n);
});
test("actual current-child death persists unfinished work before replacement",{timeout:15000},async t=>{
  const saved:{id:string;work:DeadGenerationWork}[]=[],owner=await start(t,{persistDeadWork(id,work){saved.push({id,work});},oldChildExited(){}});await call(owner,"start",t.signal);const changes=owner.subscribeLifecycleChanges();await assert.rejects(call(owner,"die",t.signal));await changes.changed(t.signal);changes.dispose();assert.equal(owner.lifecycleSnapshot().healthy,false);
  // Node may report the already-closed input once. Preserve that first failure, then
  // explicitly retry the retained exact owner, as Rust close's taken-slot semantics do.
  try{await finishRestart(owner,t.signal);}catch(error){assert.ok(error instanceof AggregateError);assert.ok(error.errors.some(e=>e?.code==="ERR_STREAM_PREMATURE_CLOSE"));assert.equal(owner.generation(),1n);await finishRestart(owner,t.signal);}
  assert.equal(owner.generation(),2n);assert.equal(saved.length,1);assert.equal(saved[0]!.id,owner.instanceId);assert.deepEqual(saved[0]!.work.activeTurns,[{threadId:"t",turnId:"v"}]);assert.equal(await call(owner,"read",t.signal),"ok");
});
test("failed old-child exit journal retains the sealed generation for ordinary retry",{timeout:15000},async t=>{
  const sentinel={};let calls=0;const owner=await start(t,{persistDeadWork(){},oldChildExited(_id,generation){assert.equal(generation,calls<2?1n:2n);if(++calls===1)throw sentinel;}});
  await assert.rejects(owner.forceRestartIfQuiescent(t.signal),e=>e===sentinel);assert.equal(owner.generation(),1n);assert.equal(owner.lifecycleSnapshot().healthy,false);assert.equal(owner.lifecycleSnapshot().restartPending,true);assert.throws(()=>owner.admitRequest(),/closed/);assert.equal(await owner.restartIfQuiescent(t.signal),true);assert.equal(owner.generation(),2n);assert.equal(calls,2);
});
test("replacement observer failure cleans candidate debt and retry uses generation two",{timeout:15000},async t=>{
  const owner=await start(t),sentinel={};owner.requestRestart();let failed:PortableAppServerSession|undefined;
  await assert.rejects(owner.restartIfQuiescent(t.signal,session=>{failed=session;throw sentinel;}),e=>e===sentinel);assert.equal(failed!.resourcesClosed,true);assert.equal(owner.generation(),1n);assert.equal(owner.lifecycleSnapshot().healthy,false);assert.equal(await owner.restartIfQuiescent(t.signal),true);assert.equal(owner.generation(),2n);assert.equal(await call(owner,"read",t.signal),"ok");
});
test("replacement cancellation joins owned cleanup and preserves ordinary retry",{timeout:15000},async t=>{
  const owner=await start(t),controller=new AbortController(),reason={cancelled:true};owner.requestRestart();let closed=false;
  await assert.rejects(owner.restartIfQuiescent(controller.signal,session=>{controller.abort(reason);t.after(()=>{assert.equal(session.resourcesClosed,true);});closed=true;}),e=>e===reason);assert.equal(closed,true);assert.equal(owner.generation(),1n);assert.equal(await owner.restartIfQuiescent(t.signal),true);assert.equal(owner.generation(),2n);
});
test("terminal close with failed journal retains exact cleanup proof and forbids restart",{timeout:15000},async t=>{
  const sentinel={};let calls=0;const owner=await start(t,{persistDeadWork(){},oldChildExited(_id,generation){assert.equal(generation,1n);if(++calls===1)throw sentinel;}});
  await assert.rejects(owner.close(),e=>e===sentinel);assert.equal(owner.generation(),1n);assert.equal(owner.lifecycleSnapshot().healthy,false);assert.throws(()=>owner.admitRequest(),/closed/);assert.equal(await owner.forceRestartIfQuiescent(t.signal),false);await owner.close();assert.equal(calls,2);await owner.close();assert.equal(calls,2);await owner.dispose();await owner.dispose();
});
test("persistence hooks are pinned before caller mutation and async hooks are refused",{timeout:15000},async t=>{
  let original=0,changed=0;const persistence={persistDeadWork(){},oldChildExited(){original++;}};const owner=await start(t,persistence);persistence.oldChildExited=()=>{changed++;};await owner.close();assert.equal(original,1);assert.equal(changed,0);
  await assert.rejects(PortableResidentLifecycle.start(config(),()=>"safe",{persistDeadWork:async()=>{},oldChildExited(){}}),/synchronous/);
});

test("fully reaped session reports first shutdown failure but permits an explicit cleanup retry",{timeout:15000},async t=>{
  const {session}=await PortableAppServerSession.startObserved(config(),()=>({value:null,dispose(){}}),()=>"safe diagnostic",t.signal);t.after(()=>session.close());
  await assert.rejects(session.request("die",{},2000));while(!session.resourcesClosed)await delay(1,undefined,{signal:t.signal});
  await assert.rejects(session.dispose(),error=>error instanceof AggregateError&&error.errors.some(e=>e?.code==="ERR_STREAM_PREMATURE_CLOSE"));assert.equal(session.processExitConfirmed,true);assert.equal(session.resourcesClosed,true);await session.dispose();assert.equal(session.resourcesClosed,true);
});

test("terminal owner disposal closes lifecycle watchers after their last unseen value",{timeout:15000},async t=>{
  const owner=await start(t),watch=owner.subscribeLifecycleChanges();await owner.dispose();await watch.changed(t.signal);assert.equal(watch.borrow(),null);await assert.rejects(watch.changed(AbortSignal.timeout(100)),GenerationWatchClosedError);watch.dispose();
});
