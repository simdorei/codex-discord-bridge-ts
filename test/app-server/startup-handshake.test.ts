import assert from "node:assert/strict";
import {test} from "node:test";
import {initializeObserved,AppServerStartupCleanupError,APP_SERVER_INITIALIZE_TIMEOUT_MS,APP_SERVER_STARTUP_TIMEOUT_MS,type SpawnedHandshakeSession} from "../../src/app-server/startup-handshake.ts";
import {ClientLifecycle} from "../../src/app-server/client-lifecycle.ts";
import {ClientRuntimeState} from "../../src/app-server/runtime-state.ts";
const info={name:"codex-discord-remote",title:"Codex Discord Remote",version:"test"};
function base(){const gate=new ClientLifecycle(),state=new ClientRuntimeState(123),events:string[]=[];return {gate,state,events};}
test("observer precedes initialize/initialized and only then generation one commits",async()=>{
  const f=base(),token={},observer={value:token,dispose(){f.events.push("dispose");}};
  const session:SpawnedHandshakeSession={...f,client:{async request(method,params,timeout){f.events.push(method);assert.equal(f.state.snapshot().initialized,false);assert.equal(timeout,30000);assert.deepEqual(params,{clientInfo:info,capabilities:{experimentalApi:true}});return {};},async notify(method,params){f.events.push(method);assert.deepEqual(params,{});assert.equal(f.state.snapshot().initialized,false);}},async cleanupOwned(){f.events.push("cleanup");}};
  const result=await initializeObserved(session,info,()=>{f.events.push("observe");return observer;});assert.equal(result,observer);assert.equal(result.value,token);assert.deepEqual(f.events,["observe","initialize","initialized"]);assert.equal(f.state.snapshot().generation,1n);assert.equal(f.state.snapshot().healthy,true);assert.equal(APP_SERVER_INITIALIZE_TIMEOUT_MS,30000);assert.equal(APP_SERVER_STARTUP_TIMEOUT_MS,45000);
});
test("observer installation failure cleans owned session before reporting same primary",async()=>{
  const f=base(),primary={},session:SpawnedHandshakeSession={...f,client:{async request(){throw Error("not reached");},async notify(){throw Error("not reached");}},async cleanupOwned(){await Promise.resolve();f.events.push("cleanup");}};
  await assert.rejects(initializeObserved(session,info,()=>{throw primary;}),e=>e===primary);assert.deepEqual(f.events,["cleanup"]);assert.equal(f.state.snapshot().generation,0n);
});
test("initialize failure awaits cleanup then disposes observer, preserving both failures",async()=>{
  const f=base(),primary={},cleanup={},disposal={},session:SpawnedHandshakeSession={...f,client:{async request(){throw primary;},async notify(){throw Error("not reached");}},async cleanupOwned(){f.events.push("cleanup");throw cleanup;}};
  await assert.rejects(initializeObserved(session,info,()=>({value:null,dispose(){f.events.push("dispose");throw disposal;}})),error=>{assert.ok(error instanceof AppServerStartupCleanupError);assert.equal(error.primary,primary);assert.deepEqual(error.cleanup,[cleanup,disposal]);return true;});assert.deepEqual(f.events,["cleanup","dispose"]);assert.equal(f.state.snapshot().initialized,false);
});
test("close after initialized write prevents dead client commit and calls owned cleanup",async()=>{
  const f=base(),session:SpawnedHandshakeSession={...f,client:{async request(){return {};},async notify(){f.gate.sealForClose("closed after initialized");f.state.claimTransportClose("closed after initialized");}},async cleanupOwned(){f.events.push("cleanup");}};
  await assert.rejects(initializeObserved(session,info,()=>({value:null,dispose(){f.events.push("dispose");}})),/closed/);assert.equal(f.state.snapshot().generation,0n);assert.equal(f.state.snapshot().initialized,false);assert.equal(f.state.snapshot().processId,null);assert.deepEqual(f.events,["cleanup","dispose"]);
});
test("explicit startup cancellation is forwarded and cleanup is joined",async()=>{
  const f=base(),abort=new AbortController(),reason={},session:SpawnedHandshakeSession={...f,client:{async request(_m,_p,_t,_h,signal){assert.equal(signal,abort.signal);abort.abort(reason);throw reason;},async notify(){throw Error("not reached");}},async cleanupOwned(){await Promise.resolve();f.events.push("cleanup");}};
  await assert.rejects(initializeObserved(session,info,()=>({value:null,dispose(){f.events.push("dispose");}}),abort.signal),e=>e===reason);assert.deepEqual(f.events,["cleanup","dispose"]);assert.equal(f.state.snapshot().generation,0n);
});
test("already aborted startup still cleans its already-spawned owned session",async()=>{
  const f=base(),abort=new AbortController(),reason={};abort.abort(reason);let observed=0;
  await assert.rejects(initializeObserved({...f,client:{async request(){},async notify(){}},async cleanupOwned(){f.events.push("cleanup");}},info,()=>{observed++;return {value:null,dispose(){}};},abort.signal),e=>e===reason);assert.equal(observed,0);assert.deepEqual(f.events,["cleanup"]);
});
test("initialize metadata is captured before observer callback can mutate caller input",async()=>{
  const f=base(),mutable={...info};let received:unknown;
  await initializeObserved({...f,client:{async request(_m,params){received=params;return {};},async notify(){}},async cleanupOwned(){}},mutable,()=>{mutable.name="changed";return {value:null,dispose(){}};});
  assert.deepEqual(received,{clientInfo:info,capabilities:{experimentalApi:true}});
});
test("invalid observer fails before initialize and still cleans already-spawned session",async()=>{
  const f=base();let requests=0;
  await assert.rejects(initializeObserved({...f,client:{async request(){requests++;},async notify(){}},async cleanupOwned(){f.events.push("cleanup");}},info,()=>undefined as never),/owned startup observer/);assert.equal(requests,0);assert.deepEqual(f.events,["cleanup"]);assert.equal(f.state.snapshot().generation,0n);
});
test("observer disposer is pinned before later callback mutation",async()=>{
  const f=base(),sentinel={},observer={value:null,dispose(){f.events.push("original dispose");}};
  await assert.rejects(initializeObserved({...f,client:{async request(){observer.dispose=()=>{f.events.push("replacement dispose");};throw sentinel;},async notify(){}},async cleanupOwned(){f.events.push("cleanup");}},info,()=>observer),e=>e===sentinel);assert.deepEqual(f.events,["cleanup","original dispose"]);
});
