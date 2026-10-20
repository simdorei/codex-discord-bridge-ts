import assert from "node:assert/strict";
import {test} from "node:test";
import {drainStdout,drainStderr,type AppServerLineReader} from "../../src/app-server/transport-drain.ts";
import {BoundedDiagnostics} from "../../src/app-server/diagnostics.ts";
import {ClientLifecycle} from "../../src/app-server/client-lifecycle.ts";
import {ClientRuntimeState} from "../../src/app-server/runtime-state.ts";
import {PendingResponses} from "../../src/app-server/pending-responses.ts";
import {ClientCloseCoordinator} from "../../src/app-server/close-coordinator.ts";
import {TransportLineDispatcher} from "../../src/app-server/transport-dispatch.ts";
function reader(lines:string[]):AppServerLineReader{let index=0;return {async nextLine(){return lines[index++]??null;}};}
test("stdout drains in order and awaits exact EOF close",async()=>{
  const events:string[]=[],diagnostics=new BoundedDiagnostics();
  await drainStdout(reader(["first","","third"]),{handleStdoutLine:line=>{events.push(line);}},{async markClosed(reason){await Promise.resolve();events.push(reason);}},diagnostics,()=>"error");
  assert.deepEqual(events,["first","","third","app-server stdout closed"]);assert.deepEqual(diagnostics.snapshot().lines,[]);
});
test("read rejection logs once and waits close cleanup before finishing",async()=>{
  const diagnostics=new BoundedDiagnostics(),sentinel={io:true},events:string[]=[];let reads=0;
  await drainStdout({async nextLine(){reads++;throw sentinel;}},{handleStdoutLine:()=>{throw Error("not reached");}},{async markClosed(reason){events.push(reason);await Promise.resolve();events.push("cleaned");}},diagnostics,(stream,error)=>{assert.equal(stream,"stdout");assert.equal(error,sentinel);return "pipe failed";});
  assert.equal(reads,1);assert.deepEqual(events,["app-server stdout read failed","cleaned"]);assert.deepEqual(diagnostics.snapshot().lines,["stdout read failed: pipe failed"]);
});
test("dispatch error is not relabeled as I/O and is not swallowed",async()=>{
  const sentinel={},diagnostics=new BoundedDiagnostics();let closes=0,renders=0;
  await assert.rejects(drainStdout(reader(["x"]),{handleStdoutLine(){throw sentinel;}},{async markClosed(){closes++;}},diagnostics,()=>{renders++;return "bad";}),e=>e===sentinel);
  assert.equal(closes,0);assert.equal(renders,0);assert.deepEqual(diagnostics.snapshot().lines,[]);
});
test("stderr retains empty lines and EOF does not require a closer",async()=>{
  const diagnostics=new BoundedDiagnostics();await drainStderr(reader(["a","","한"]),diagnostics,()=>"error");assert.deepEqual(diagnostics.snapshot().lines,["a","","한"]);
});
test("stderr read failure records diagnostic and returns",async()=>{
  const diagnostics=new BoundedDiagnostics(),sentinel={};await drainStderr({async nextLine(){throw sentinel;}},diagnostics,(stream,error)=>{assert.equal(stream,"stderr");assert.equal(error,sentinel);return "failed";});assert.deepEqual(diagnostics.snapshot().lines,["stderr read failed: failed"]);
});
test("logical stdout integration processes response then EOF closes remaining request",async()=>{
  const gate=new ClientLifecycle(),state=new ClientRuntimeState(123),pending=new PendingResponses(gate),diagnostics=new BoundedDiagnostics();state.commitInitialized();
  const a=pending.register("a",gate.admit(),1000,false),b=pending.register("b",gate.admit(),1000,false),close=new ClientCloseCoordinator(gate,state,pending);
  const dispatcher=new TransportLineDispatcher(gate,state,pending,diagnostics,{enqueueNotification(){},enqueueServerRequest(){},renderParseError:()=>"parse failed"});
  await drainStdout(reader(['{"id":"a","result":true}']),dispatcher,close,diagnostics,()=>"read failed");
  assert.deepEqual(await a.result,{kind:"Response",result:{ok:true,value:true}});assert.deepEqual(await b.result,{kind:"TransportClosed",reason:"app-server stdout closed"});
  assert.equal(gate.snapshot().inFlight,0n);assert.equal(await gate.waitClosed(),"app-server stdout closed");assert.equal(state.snapshot().processId,null);assert.equal(state.snapshot().healthy,false);
});
test("close cleanup failure remains visible without a second close attempt",async()=>{
  const sentinel={},diagnostics=new BoundedDiagnostics();let closes=0;
  await assert.rejects(drainStdout(reader([]),{handleStdoutLine(){}},{async markClosed(){closes++;throw sentinel;}},diagnostics,()=>"error"),e=>e===sentinel);assert.equal(closes,1);assert.deepEqual(diagnostics.snapshot().lines,[]);
});
