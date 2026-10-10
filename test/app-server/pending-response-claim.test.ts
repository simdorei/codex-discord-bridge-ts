import assert from "node:assert/strict";
import {test} from "node:test";
import {ClientLifecycle} from "../../src/app-server/client-lifecycle.ts";
import {PendingResponses,PendingReceiverClosedError} from "../../src/app-server/pending-responses.ts";

test("wire sender is detached inside open gate but releases only after gate exits",async()=>{
  const gate=new ClientLifecycle(),pending=new PendingResponses(gate);
  const r=pending.register("id",gate.admit(),1000,false);
  const claim=gate.withOpen(()=>pending.takeResponse("id"));assert.ok(claim);
  assert.equal(pending.size,0);assert.equal(gate.snapshot().inFlight,1n);
  assert.equal(gate.snapshot().poisoned,false);assert.equal(gate.sealIfQuiescent(()=>true),false);
  claim.respond({ok:true,value:{n:9007199254740993n}});
  assert.deepEqual(await r.result,{kind:"Response",result:{ok:true,value:{n:9007199254740993n}}});
  assert.equal(gate.snapshot().inFlight,0n);assert.equal(gate.sealIfQuiescent(()=>true),true);
  claim.dispose();assert.throws(()=>claim.respond({ok:true,value:null}),/consumed/);
});
test("detached sender wins after seal and is not drained by close",async()=>{
  const gate=new ClientLifecycle(),pending=new PendingResponses(gate);
  const r=pending.register("id",gate.admit(),1000,false);
  const claim=gate.withOpen(()=>pending.takeResponse("id"))!;
  gate.sealForClose("EOF");pending.transportClosedAll("EOF");
  assert.equal(gate.snapshot().inFlight,1n);claim.respond({ok:true,value:"arrived"});
  assert.deepEqual(await r.result,{kind:"Response",result:{ok:true,value:"arrived"}});
  assert.equal(gate.snapshot().inFlight,0n);
});
test("detached explicit disposal closes receiver exactly once",async()=>{
  const gate=new ClientLifecycle(),pending=new PendingResponses(gate),r=pending.register("id",gate.admit(),1000,false);
  const claim=pending.takeResponse("id")!;claim.dispose();claim.dispose();
  await assert.rejects(r.result,PendingReceiverClosedError);assert.equal(gate.snapshot().inFlight,0n);
  assert.throws(()=>claim.respond({ok:true,value:null}),/consumed/);assert.equal(pending.takeResponse("missing"),undefined);
});
test("detached deadline and old registration cannot affect reused ID",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  const gate=new ClientLifecycle(),pending=new PendingResponses(gate),old=pending.register("id",gate.admit(),10,true);
  const claim=pending.takeResponse("id")!,next=pending.register("id",gate.admit(),100,false);
  old.finish();old.dispose();t.mock.timers.tick(10);
  assert.equal(pending.size,1);assert.equal(gate.snapshot().inFlight,2n);
  claim.respond({ok:true,value:"old"});assert.equal((await old.result).kind,"Response");
  assert.equal(pending.size,1);assert.equal(gate.snapshot().inFlight,1n);
  pending.respond("id",{ok:true,value:"new"});assert.deepEqual(await next.result,{kind:"Response",result:{ok:true,value:"new"}});
  assert.equal(gate.snapshot().inFlight,0n);
});
test("zero deadline queued callback cannot expire detached sender",async()=>{
  const gate=new ClientLifecycle(),pending=new PendingResponses(gate),r=pending.register("id",gate.admit(),0,false);
  const claim=pending.takeResponse("id")!;await Promise.resolve();
  assert.equal(gate.snapshot().inFlight,1n);claim.respond({ok:true,value:null});
  assert.equal((await r.result).kind,"Response");assert.equal(gate.snapshot().inFlight,0n);
});
test("rejected DTO invokes no getter and leaves claim explicitly disposable",async()=>{
  const gate=new ClientLifecycle(),pending=new PendingResponses(gate),r=pending.register("id",gate.admit(),1000,false);
  const claim=pending.takeResponse("id")!;let calls=0;
  assert.throws(()=>claim.respond({ok:true,get value(){calls++;return null;}}),TypeError);
  assert.equal(calls,0);assert.equal(gate.snapshot().inFlight,1n);
  claim.dispose();await assert.rejects(r.result,PendingReceiverClosedError);assert.equal(gate.snapshot().inFlight,0n);
});
