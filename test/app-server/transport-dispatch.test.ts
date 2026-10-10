import assert from "node:assert/strict";
import {test} from "node:test";
import {TransportLineDispatcher,type TransportDispatchPorts} from "../../src/app-server/transport-dispatch.ts";
import {ClientLifecycle} from "../../src/app-server/client-lifecycle.ts";
import {ClientRuntimeState} from "../../src/app-server/runtime-state.ts";
import {PendingResponses} from "../../src/app-server/pending-responses.ts";
import {BoundedDiagnostics} from "../../src/app-server/diagnostics.ts";
import {AppServerClosedError} from "../../src/app-server/client-errors.ts";
import type {PendingServerRequest} from "../../src/app-server/server-request-state.ts";
import type {AppNotification} from "../../src/app-server/notification-state.ts";
function fixture(overrides:Partial<TransportDispatchPorts>={}){
  const gate=new ClientLifecycle(),state=new ClientRuntimeState(),pending=new PendingResponses(gate),diagnostics=new BoundedDiagnostics();
  const requests:PendingServerRequest[]=[],notifications:AppNotification[]=[],errors:unknown[]=[];
  const dispatch=new TransportLineDispatcher(gate,state,pending,diagnostics,{enqueueServerRequest:r=>{requests.push(r);},enqueueNotification:n=>{notifications.push(n);},renderParseError:(stage,error)=>{errors.push(error);return stage+" error";},...overrides});
  return {gate,state,pending,diagnostics,requests,notifications,errors,dispatch};
}
test("stdout distinguishes Rust whitespace, malformed JSON, invalid RPC and ignored values",()=>{
  const f=fixture();f.dispatch.handleStdoutLine(" \u0085\u2028");assert.deepEqual(f.diagnostics.snapshot().lines,[]);
  f.dispatch.handleStdoutLine("\ufeff");f.dispatch.handleStdoutLine('{"id":null}');f.dispatch.handleStdoutLine("[]");
  assert.deepEqual(f.diagnostics.snapshot().lines,["non-JSON stdout (json error): \ufeff","invalid JSON-RPC message: rpc error","ignored non-object app-server message"]);assert.equal(f.errors.length,2);
});
test("malformed line preview uses 200 Unicode scalars",()=>{
  const f=fixture();f.dispatch.handleStdoutLine("😀".repeat(250));assert.equal(f.diagnostics.snapshot().lines[0],"non-JSON stdout (json error): "+"😀".repeat(200));
});
test("response dispatch resolves bigint data outside gate without reentry or poisoned admission",async()=>{
  const f=fixture(),r=f.pending.register("id",f.gate.admit(),1000,false);
  f.dispatch.handleStdoutLine('{"id":"id","result":{"n":9007199254740993}}');
  assert.deepEqual(await r.result,{kind:"Response",result:{ok:true,value:{n:9007199254740993n}}});assert.equal(f.gate.snapshot().inFlight,0n);assert.equal(f.gate.snapshot().poisoned,false);
  f.dispatch.handleStdoutLine('{"id":"id","result":null}');assert.equal(f.diagnostics.snapshot().lines[0],'late or unknown response id: String("id")');
});
test("sealed lifecycle drops all incoming state changes and keeps pending for close cleanup",async()=>{
  const f=fixture(),r=f.pending.register(1n,f.gate.admit(),1000,false);f.gate.sealForClose("closed");
  f.dispatch.handleStdoutLine('{"id":1,"result":true}');f.dispatch.handleStdoutLine('{"id":2,"method":"approval"}');f.dispatch.handleStdoutLine('{"method":"turn/started","params":{"threadId":"t","turnId":"v"}}');
  assert.equal(f.pending.size,1);assert.equal(f.requests.length,0);assert.equal(f.notifications.length,0);assert.equal(f.state.notificationRevision,0n);
  assert.deepEqual(f.diagnostics.snapshot().lines,['response rejected after lifecycle seal: Integer(1)','server request rejected after lifecycle seal: Integer(2)','notification rejected after lifecycle seal: turn/started']);
  f.pending.transportClosedAll("closed");assert.equal((await r.result).kind,"TransportClosed");
});
test("server request duplicate/conflict/deferred preserves canonical occurrence without poisoning",()=>{
  const f=fixture(),line='{"id":"a","method":"approval","params":{"n":1}}';
  f.dispatch.handleStdoutLine(line);f.dispatch.handleStdoutLine(line);assert.equal(f.requests.length,1);
  f.dispatch.handleStdoutLine('{"id":"a","method":"approval","params":{"n":2}}');assert.equal(f.requests.length,1);assert.match(f.diagnostics.snapshot().lines[0]!,/canonical payload retained/);
  const canonical=f.requests[0]!;f.state.beginServerResponse(canonical.id,canonical.occurrence);
  f.dispatch.handleStdoutLine('{"id":"a","method":"approval","params":{"n":2}}');assert.equal(f.requests.length,1);assert.equal(f.state.unsettledServerRequests().length,2);assert.equal(f.gate.snapshot().poisoned,false);
});
test("notification state is recorded before immutable queued publication",()=>{
  let seen=0n;const f=fixture({enqueueNotification:n=>{seen=f.state.notificationRevision;assert.ok(Object.isFrozen(n));assert.ok(Object.isFrozen(n.params));}});
  f.dispatch.handleStdoutLine('{"method":"turn/started","params":{"threadId":"t","turnId":"v"}}');assert.equal(seen,1n);assert.equal(f.state.activeTurnId("t"),"v");
});
test("queue adapter failure remains visible even if it throws ClosedError",()=>{
  const error=new AppServerClosedError(),f=fixture({enqueueNotification:()=>{throw error;}});
  assert.throws(()=>f.dispatch.handleStdoutLine('{"method":"event"}'),e=>e===error);assert.equal(f.gate.snapshot().poisoned,true);assert.equal(f.diagnostics.snapshot().lines.length,0);
});
test("server request capacity failure is diagnostic and does not poison subsequent responses",async()=>{
  const f=fixture();for(let i=0;i<501;i++)f.dispatch.handleStdoutLine(`{"id":${i},"method":"approval"}`);
  assert.equal(f.requests.length,500);assert.match(f.diagnostics.snapshot().lines[0]!,/saturated at 500/);assert.equal(f.gate.snapshot().poisoned,false);
  const r=f.pending.register("reply",f.gate.admit(),1000,false);f.dispatch.handleStdoutLine('{"id":"reply","error":{"code":-1,"message":"failed"}}');assert.equal((await r.result).kind,"Response");
});
test("async queue adapter is rejected and its rejected Promise is consumed",async()=>{
  const f=fixture({enqueueNotification:()=>Promise.reject(new Error("async forbidden"))});
  assert.throws(()=>f.dispatch.handleStdoutLine('{"method":"event"}'),/synchronously/);assert.equal(f.gate.snapshot().poisoned,true);await Promise.resolve();
});
test("invalid diagnostic renderer output is rejected without coercion",()=>{
  let calls=0;const f=fixture({renderParseError:()=>({toString(){calls++;return "unsafe";}} as unknown as string)});
  assert.throws(()=>f.dispatch.handleStdoutLine("bad"),/public-safe diagnostic text/);assert.equal(calls,0);assert.deepEqual(f.diagnostics.snapshot().lines,[]);
});
