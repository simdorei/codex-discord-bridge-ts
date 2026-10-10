import assert from "node:assert/strict";
import {test} from "node:test";
import {ClientLifecycle} from "../../src/app-server/client-lifecycle.ts";
import {ClientRuntimeState} from "../../src/app-server/runtime-state.ts";
import {PendingResponses} from "../../src/app-server/pending-responses.ts";
import {ClientCloseCoordinator} from "../../src/app-server/close-coordinator.ts";
import {AppServerWriter} from "../../src/app-server/writer.ts";
import {AppServerRequestClient} from "../../src/app-server/request-client.ts";
import {AppServerResponseClient} from "../../src/app-server/response-client.ts";
import {parseLosslessJson,ServerRequestOccurrence,type RequestId} from "../../src/protocol/ids.ts";
function fixture(onWrite:(frame:Record<string,unknown>,pending:PendingResponses,gate:ClientLifecycle)=>void=()=>{}){
  const gate=new ClientLifecycle(),state=new ClientRuntimeState(),pending=new PendingResponses(gate),logical=new ClientCloseCoordinator(gate,state,pending),frames:Record<string,unknown>[]=[];
  const writer=new AppServerWriter({async writeAll(bytes){const frame=parseLosslessJson<Record<string,unknown>>(Buffer.from(bytes).toString());frames.push(frame);onWrite(frame,pending,gate);},async flush(){}},logical);
  return {gate,state,pending,logical,frames,request:new AppServerRequestClient(gate,pending,writer),response:new AppServerResponseClient(gate,state,writer,()=>{})};
}
test("admitted request adds only its response lease and leaves caller lease owned",async()=>{
  const f=fixture((frame,pending,gate)=>{assert.equal(gate.snapshot().inFlight,2n);pending.respond(frame.id as RequestId,{ok:true,value:"reply"});}),permit=f.gate.admit();
  assert.equal(await f.request.requestAdmitted(permit,"thread/read",{},1000),"reply");assert.equal(f.gate.snapshot().inFlight,1n);assert.equal(f.gate.sealIfQuiescent(()=>true),false);permit.release();assert.equal(f.gate.snapshot().inFlight,0n);
});
test("foreign or released admitted permits cannot dispatch and remain untouched",async()=>{
  const f=fixture(),other=new ClientLifecycle(),foreign=other.admit();await assert.rejects(f.request.requestAdmitted(foreign,"turn/start",{},1000),TypeError);assert.equal(other.snapshot().inFlight,1n);foreign.release();const released=f.gate.admit();released.release();await assert.rejects(f.request.notifyAdmitted(released,"initialized",{}),TypeError);assert.equal(f.frames.length,0);assert.equal(f.gate.snapshot().inFlight,0n);
});
test("admitted notification neither allocates nor releases the caller's permit",async()=>{
  const f=fixture((_frame,_pending,gate)=>assert.equal(gate.snapshot().inFlight,1n)),permit=f.gate.admit();await f.request.notifyAdmitted(permit,"initialized",{});assert.equal(f.pending.size,0);assert.equal(f.gate.snapshot().inFlight,1n);await f.logical.markClosed("closed");await assert.rejects(f.request.notifyAdmitted(permit,"initialized",{}),/closed/);assert.equal(f.frames.length,1);permit.release();
});
test("normal/error/current admitted responses use exactly one retained caller permit",async()=>{
  for(const mode of ["normal","error","current"]){const f=fixture((_frame,_pending,gate)=>assert.equal(gate.snapshot().inFlight,1n)),permit=f.gate.admit(),occurrence=ServerRequestOccurrence.random();f.state.recordServerRequest({id:"id",occurrence,method:"approval",params:{threadId:"t",turnId:"v"}});f.state.recordNotification({method:"turn/started",params:{threadId:"t",turnId:"v"}});
    if(mode==="normal")await f.response.respondAdmitted(permit,"id",occurrence,true);else if(mode==="error")await f.response.respondErrorAdmitted(permit,"id",occurrence,{code:-1n,message:"no",data:null});else await f.response.respondCurrentAdmitted(permit,"id",occurrence,true);
    assert.equal(f.state.hasUnsettledServerRequests,false);assert.equal(f.gate.snapshot().inFlight,1n);permit.release();assert.equal(f.gate.snapshot().inFlight,0n);
  }
});
test("canceled admitted mutation retains response custody independently of caller release",async()=>{
  const f=fixture(),permit=f.gate.admit(),abort=new AbortController(),reason={};let written!:()=>void;const ready=new Promise<void>(resolve=>{written=resolve;});
  const task=f.request.requestAdmitted(permit,"turn/start",{},1000,{preflight(){},writeStarted(){},writeComplete(){written();}},abort.signal),rejected=assert.rejects(task,e=>e===reason);await ready;abort.abort(reason);await rejected;assert.equal(f.gate.snapshot().inFlight,2n);permit.release();assert.equal(f.gate.snapshot().inFlight,1n);await f.logical.markClosed("cleanup");assert.equal(f.gate.snapshot().inFlight,0n);
});
test("foreign response permit fails before claiming the incoming occurrence",async()=>{
  const f=fixture(),other=new ClientLifecycle(),foreign=other.admit(),occurrence=ServerRequestOccurrence.random();f.state.recordServerRequest({id:"id",occurrence,method:"approval",params:{}});
  await assert.rejects(f.response.respondAdmitted(foreign,"id",occurrence,true),TypeError);assert.equal(f.state.pendingServerRequests().length,1);assert.equal(f.frames.length,0);foreign.release();
});
