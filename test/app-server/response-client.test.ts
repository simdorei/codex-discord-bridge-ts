import assert from "node:assert/strict";
import {test} from "node:test";
import {ClientLifecycle} from "../../src/app-server/client-lifecycle.ts";
import {ClientRuntimeState} from "../../src/app-server/runtime-state.ts";
import {PendingResponses} from "../../src/app-server/pending-responses.ts";
import {ClientCloseCoordinator} from "../../src/app-server/close-coordinator.ts";
import {AppServerWriter} from "../../src/app-server/writer.ts";
import {AppServerResponseClient} from "../../src/app-server/response-client.ts";
import {ServerRequestOccurrence,parseLosslessJson} from "../../src/protocol/ids.ts";
import type {PendingServerRequest} from "../../src/app-server/server-request-state.ts";
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}
function fixture(onWrite:()=>void|Promise<void>=()=>{}){
  const gate=new ClientLifecycle(),state=new ClientRuntimeState(),pending=new PendingResponses(gate),close=new ClientCloseCoordinator(gate,state,pending),frames:unknown[]=[],promoted:PendingServerRequest[]=[];
  const writer=new AppServerWriter({async writeAll(bytes){frames.push(parseLosslessJson(Buffer.from(bytes).toString()));await onWrite();},async flush(){}},close);
  const client=new AppServerResponseClient(gate,state,writer,r=>{promoted.push(r);});
  const request={id:"id",occurrence:ServerRequestOccurrence.random(),method:"approval",params:{threadId:"thread",turnId:"turn"}};state.recordServerRequest(request);state.recordNotification({method:"turn/started",params:request.params});
  return {gate,state,close,writer,client,request,frames,promoted};
}
test("response settles exact claim only after successful write and flush",async()=>{
  const entered=deferred(),release=deferred(),f=fixture(async()=>{entered.resolve();await release.promise;});
  const task=f.client.respond(f.request.id,f.request.occurrence,{approved:true});await entered.promise;
  assert.equal(f.gate.snapshot().inFlight,1n);assert.throws(()=>f.state.serverResponseCandidate(f.request.id,f.request.occurrence),/in flight/);release.resolve();await task;
  assert.equal(f.state.hasUnsettledServerRequests,false);assert.equal(f.gate.snapshot().inFlight,0n);assert.deepEqual(f.frames,[{id:"id",result:{approved:true}}]);
});
test("error response retains strict typed RPC error frame",async()=>{
  const f=fixture();await f.client.respondError(f.request.id,f.request.occurrence,{code:-1n,message:"no",data:null});assert.deepEqual(f.frames,[{id:"id",error:{code:-1n,message:"no",data:null}}]);assert.equal(f.state.hasUnsettledServerRequests,false);
});
test("failed normal or current write leaves indeterminate incoming occurrence",async()=>{
  for(const current of [false,true]){const sentinel={},f=fixture(()=>{throw sentinel;});
    const task=current?f.client.respondCurrent(f.request.id,f.request.occurrence,true):f.client.respond(f.request.id,f.request.occurrence,true);
    await assert.rejects(task,e=>e===sentinel);assert.equal(f.close.closed,true);assert.throws(()=>f.state.serverResponseCandidate(f.request.id,f.request.occurrence),/indeterminate/);assert.equal(f.gate.snapshot().inFlight,0n);
  }
});
test("current response checks turn only after queued writer acquisition",async()=>{
  const entered=deferred(),release=deferred(),f=fixture(async()=>{entered.resolve();await release.promise;});
  const first=f.writer.write({occupy:true},{check(){},dispose(){}},()=>{});await entered.promise;
  const task=f.client.respondCurrent(f.request.id,f.request.occurrence,true),rejected=assert.rejects(task,/stale/);
  assert.equal(f.state.pendingServerRequests().length,1);f.state.recordNotification({method:"turn/started",params:{threadId:"thread",turnId:"new"}});release.resolve();await first;await rejected;
  assert.equal(f.frames.length,1);assert.equal(f.state.pendingServerRequests().length,1);assert.equal(f.close.closed,false);assert.equal(f.gate.snapshot().inFlight,0n);
});
test("normal queued response cancellation marks claim indeterminate without write-start closure",async()=>{
  const entered=deferred(),release=deferred(),abort=new AbortController(),f=fixture(async()=>{entered.resolve();await release.promise;});
  const first=f.writer.write({occupy:true},{check(){},dispose(){}},()=>{});await entered.promise;
  const sentinel={},task=f.client.respond(f.request.id,f.request.occurrence,true,undefined,abort.signal),rejected=assert.rejects(task,e=>e===sentinel);abort.abort(sentinel);await rejected;
  assert.throws(()=>f.state.serverResponseCandidate(f.request.id,f.request.occurrence),/indeterminate/);assert.equal(f.close.closed,false);release.resolve();await first;assert.equal(f.frames.length,1);assert.equal(f.gate.snapshot().inFlight,0n);
});
test("successful response promotes deferred incoming request once",async()=>{
  const entered=deferred(),release=deferred(),f=fixture(async()=>{entered.resolve();await release.promise;});
  const task=f.client.respond(f.request.id,f.request.occurrence,true);await entered.promise;
  f.state.recordServerRequest({...f.request,occurrence:ServerRequestOccurrence.random(),params:{threadId:"thread",turnId:"next"}});release.resolve();await task;assert.equal(f.promoted.length,1);assert.equal(f.state.pendingServerRequests().length,1);
});
test("current successful response claims at preflight and retires only exact occurrence",async()=>{
  const f=fixture(),events:string[]=[];await f.client.respondCurrent(f.request.id,f.request.occurrence,true,{preflight(){events.push("preflight");assert.equal(f.state.pendingServerRequests().length,1);},writeStarted(){events.push("started");assert.throws(()=>f.state.serverResponseCandidate(f.request.id,f.request.occurrence),/in flight/);}});
  assert.deepEqual(events,["preflight","started"]);assert.equal(f.state.hasUnsettledServerRequests,false);assert.equal(f.gate.snapshot().inFlight,0n);
});
test("custom preflight failure holds normal claim but leaves current claim unacquired",async()=>{
  for(const current of [false,true]){const sentinel={},f=fixture(),hooks={preflight(){throw sentinel;},writeStarted(){throw Error("not reached");}};
    const task=current?f.client.respondCurrent(f.request.id,f.request.occurrence,true,hooks):f.client.respond(f.request.id,f.request.occurrence,true,hooks);
    await assert.rejects(task,e=>e===sentinel);assert.equal(f.frames.length,0);assert.equal(f.close.closed,false);assert.equal(f.gate.snapshot().inFlight,0n);
    if(current)assert.equal(f.state.pendingServerRequests().length,1);else assert.throws(()=>f.state.serverResponseCandidate(f.request.id,f.request.occurrence),/indeterminate/);
  }
});
