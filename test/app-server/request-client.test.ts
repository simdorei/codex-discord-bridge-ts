import assert from "node:assert/strict";
import {test} from "node:test";
import {AppServerRequestClient,AppServerRequestError,type RequestHooks} from "../../src/app-server/request-client.ts";
import {ClientLifecycle} from "../../src/app-server/client-lifecycle.ts";
import {ClientRuntimeState} from "../../src/app-server/runtime-state.ts";
import {PendingResponses,PendingReceiverClosedError} from "../../src/app-server/pending-responses.ts";
import {ClientCloseCoordinator} from "../../src/app-server/close-coordinator.ts";
import {AppServerWriter} from "../../src/app-server/writer.ts";
import {parseLosslessJson,type RequestId} from "../../src/protocol/ids.ts";
function fixture(onWrite:(value:Record<string,unknown>,pending:PendingResponses)=>void|Promise<void>,clock?:()=>number){
  const gate=new ClientLifecycle(),state=new ClientRuntimeState(),pending=new PendingResponses(gate),close=new ClientCloseCoordinator(gate,state,pending),frames:Record<string,unknown>[]=[];
  const writer=new AppServerWriter({async writeAll(bytes){const value=parseLosslessJson<Record<string,unknown>>(Buffer.from(bytes).toString());frames.push(value);await onWrite(value,pending);},async flush(){}},close);
  return {gate,pending,close,frames,client:new AppServerRequestClient(gate,pending,writer,clock)};
}
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}
const hooks:RequestHooks={preflight(){},writeStarted(){},writeComplete(){}};
test("request owns two permits, uses fresh UUID and returns lossless response",async()=>{
  const f=fixture((frame,pending)=>{assert.equal(f.gate.snapshot().inFlight,2n);assert.match(frame.id as string,/^[0-9a-f-]{36}$/);pending.respond(frame.id as RequestId,{ok:true,value:9007199254740993n});});
  assert.equal(await f.client.request("turn/start",{},1000),9007199254740993n);assert.equal(f.gate.snapshot().inFlight,0n);assert.equal(f.pending.size,0);
  await f.client.request("turn/start",{},1000);assert.notEqual(f.frames[0]!.id,f.frames[1]!.id);
});
test("deadline is checked again after synchronous durable preflight",async()=>{
  let now=0,started=0;const f=fixture(()=>{},()=>now);
  await assert.rejects(f.client.request("turn/start",{},100,{preflight(){now=100;},writeStarted(){started++;},writeComplete(){}}),error=>error instanceof AppServerRequestError&&error.detail.kind==="Timeout");
  assert.equal(started,0);assert.equal(f.frames.length,0);assert.equal(f.pending.size,0);assert.equal(f.gate.snapshot().inFlight,0n);assert.equal(f.close.closed,false);
});
test("hook order is preflight, started, write, complete before receiver return",async()=>{
  const events:string[]=[],f=fixture((frame,pending)=>{events.push("write");pending.respond(frame.id as RequestId,{ok:true,value:null});});
  await f.client.request("read",{},1000,{preflight(){events.push("preflight");},writeStarted(){events.push("started");},writeComplete(){events.push("complete");}});assert.deepEqual(events,["preflight","started","write","complete"]);
});
test("caller cancellation retains mutation lease but removes observational lease",async()=>{
  for(const method of ["turn/start","thread/read"]){const completed=deferred(),abort=new AbortController(),sentinel={},f=fixture(()=>{});
    const task=f.client.request(method,{},1000,{...hooks,writeComplete(){completed.resolve();}},abort.signal),rejected=assert.rejects(task,e=>e===sentinel);await completed.promise;abort.abort(sentinel);await rejected;
    assert.equal(f.close.closed,false);assert.equal(f.pending.size,method==="turn/start"?1:0);assert.equal(f.gate.snapshot().inFlight,method==="turn/start"?1n:0n);
    await f.close.markClosed("cleanup");assert.equal(f.gate.snapshot().inFlight,0n);
  }
});
test("remote structured error and transport closed keep their distinct kinds",async()=>{
  const remote=fixture((frame,pending)=>{pending.respond(frame.id as RequestId,{ok:false,error:{code:-32000n,message:"usage",data:{reason:"usage_limit"}}});});
  await assert.rejects(remote.client.request("turn/start",{},1000),error=>error instanceof AppServerRequestError&&error.detail.kind==="Remote"&&error.detail.code===-32000n);assert.equal(remote.gate.snapshot().inFlight,0n);
  const eof=fixture((_frame,pending)=>{pending.transportClosedAll("EOF");});await assert.rejects(eof.client.request("thread/read",{},1000),error=>error instanceof AppServerRequestError&&error.detail.kind==="TransportClosed"&&error.detail.reason==="EOF");assert.equal(eof.gate.snapshot().inFlight,0n);
});
test("notify owns only caller permit and creates no response registration",async()=>{
  const f=fixture(frame=>{assert.equal(f.gate.snapshot().inFlight,1n);assert.equal(Object.hasOwn(frame,"id"),false);});await f.client.notify("initialized",{});assert.equal(f.pending.size,0);assert.equal(f.gate.snapshot().inFlight,0n);
});
test("zero deadline does not send and sealed gate rejects before registration",async()=>{
  const f=fixture(()=>{},()=>0);await assert.rejects(f.client.request("thread/read",{},0),error=>error instanceof AppServerRequestError&&error.detail.kind==="Timeout");assert.equal(f.frames.length,0);assert.equal(f.gate.snapshot().inFlight,0n);
  f.gate.seal();await assert.rejects(f.client.request("turn/start",{},1000),/closed/);assert.equal(f.pending.size,0);
});
test("invalid initial clock cannot leave an unsent mutation response lease",async()=>{
  const f=fixture(()=>{},()=>NaN);await assert.rejects(f.client.request("turn/start",{},1000),/finite monotonic/);assert.equal(f.frames.length,0);assert.equal(f.pending.size,0);assert.equal(f.gate.snapshot().inFlight,0n);
});
test("async preflight hook is rejected without invoking its body",async()=>{
  let calls=0;const f=fixture(()=>{});await assert.rejects(f.client.request("turn/start",{},1000,{...hooks,async preflight(){calls++;}}),/synchronous/);assert.equal(calls,0);assert.equal(f.frames.length,0);assert.equal(f.pending.size,0);assert.equal(f.gate.snapshot().inFlight,0n);
});
test("abort reason resembling receiver-close remains the exact caller cancellation",async()=>{
  const completed=deferred(),abort=new AbortController(),reason=new PendingReceiverClosedError(),f=fixture(()=>{});
  const task=f.client.request("thread/read",{},1000,{...hooks,writeComplete(){completed.resolve();}},abort.signal),rejected=assert.rejects(task,e=>e===reason);await completed.promise;abort.abort(reason);await rejected;assert.equal(f.gate.snapshot().inFlight,0n);
});
test("pending deadline after completed write maps timeout and releases both permits",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});const completed=deferred(),f=fixture(()=>{},()=>0);
  const task=f.client.request("turn/start",{},100,{...hooks,writeComplete(){completed.resolve();}}),rejected=assert.rejects(task,error=>error instanceof AppServerRequestError&&error.detail.kind==="Timeout"&&error.detail.timeoutMs===100);await completed.promise;t.mock.timers.tick(100);await rejected;assert.equal(f.pending.size,0);assert.equal(f.gate.snapshot().inFlight,0n);
});
test("writer failure closes transport and removes caller/response registrations",async()=>{
  const sentinel={},f=fixture(()=>{throw sentinel;});await assert.rejects(f.client.request("turn/start",{},1000),e=>e===sentinel);assert.equal(f.close.closed,true);assert.equal(f.pending.size,0);assert.equal(f.gate.snapshot().inFlight,0n);
});
test("invalid request deadline consumes rejected response permit and outer admission",async()=>{
  const f=fixture(()=>{});await assert.rejects(f.client.request("turn/start",{},-1),/deadline/);assert.equal(f.frames.length,0);assert.equal(f.pending.size,0);assert.equal(f.gate.snapshot().inFlight,0n);
});
