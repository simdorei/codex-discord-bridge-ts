import assert from "node:assert/strict";
import {test} from "node:test";
import {ClientLifecycle} from "../../src/app-server/client-lifecycle.ts";
import {PendingResponses,PendingReceiverClosedError,PendingRegistrationError} from "../../src/app-server/pending-responses.ts";
test("response settles receiver and releases exact admitted permit",async()=>{
  const gate=new ClientLifecycle(),p=new PendingResponses(gate),r=p.register("id",gate.admit(),1000,false);assert.equal(gate.snapshot().inFlight,1n);assert.equal(p.respond("id",{ok:true,value:{n:9007199254740993n}}),true);assert.deepEqual(await r.result,{kind:"Response",result:{ok:true,value:{n:9007199254740993n}}});assert.equal(p.size,0);assert.equal(gate.snapshot().inFlight,0n);r.finish();r.dispose();
});
test("observational cancellation removes its own entry immediately",async()=>{
  const gate=new ClientLifecycle(),p=new PendingResponses(gate),r=p.register("read",gate.admit(),1000,true);r.dispose();await assert.rejects(r.result,PendingReceiverClosedError);assert.equal(p.size,0);assert.equal(gate.sealIfQuiescent(()=>true),true);
});
test("mutation cancellation retains lease until deadline despite disposed caller",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});const gate=new ClientLifecycle(),p=new PendingResponses(gate),r=p.register("mutation",gate.admit(),100,false);r.dispose();assert.equal(p.size,1);assert.equal(gate.sealIfQuiescent(()=>true),false);t.mock.timers.tick(100);assert.deepEqual(await r.result,{kind:"Timeout"});assert.equal(p.size,0);assert.equal(gate.sealIfQuiescent(()=>true),true);
});
test("finished writer failure removes pending entry before releasing permit",async()=>{
  const gate=new ClientLifecycle(),p=new PendingResponses(gate),r=p.register("write",gate.admit(),1000,false);r.finish();r.dispose();await assert.rejects(r.result,PendingReceiverClosedError);assert.equal(p.size,0);assert.equal(gate.snapshot().inFlight,0n);
});
test("old registration cleanup and deadline never remove a newer same-ID occurrence",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});const gate=new ClientLifecycle(),p=new PendingResponses(gate),old=p.register("id",gate.admit(),100,true);p.respond("id",{ok:true,value:"old"});await old.result;
  const next=p.register("id",gate.admit(),1000,false);old.finish();old.dispose();t.mock.timers.tick(100);assert.equal(p.size,1);assert.equal(gate.snapshot().inFlight,1n);p.respond("id",{ok:true,value:"new"});assert.deepEqual(await next.result,{kind:"Response",result:{ok:true,value:"new"}});next.finish();next.dispose();
});
test("duplicate IDs preserve original receiver and release rejected registration permit",async()=>{
  const gate=new ClientLifecycle(),p=new PendingResponses(gate),r=p.register(1n,gate.admit(),1000,false);assert.throws(()=>p.register(1n,gate.admit(),1000,false),PendingRegistrationError);assert.equal(gate.snapshot().inFlight,1n);assert.equal(p.respond("1",{ok:true,value:null}),false);p.respond(1n,{ok:false,error:{code:-1n,message:"failed",data:null}});assert.equal((await r.result).kind,"Response");r.finish();r.dispose();
});
test("capacity 1024 rejects before dispatch and canonical transport close drains every permit",async()=>{
  const gate=new ClientLifecycle(),p=new PendingResponses(gate),registrations=[];for(let i=0;i<1024;i++)registrations.push(p.register(BigInt(i),gate.admit(),10000,false));assert.throws(()=>p.register(1024n,gate.admit(),10000,false),/capacity \(1024\)/);assert.equal(p.size,1024);assert.equal(gate.snapshot().inFlight,1024n);gate.sealForClose("closed");p.transportClosedAll("closed");assert.equal(p.size,0);assert.equal(gate.snapshot().inFlight,0n);assert.ok((await Promise.all(registrations.map(r=>r.result))).every(o=>o.kind==="TransportClosed"&&o.reason==="closed"));for(const r of registrations){r.finish();r.dispose();}
});
test("zero deadline is deferred until after registration and exact response can win first",async()=>{
  const gate=new ClientLifecycle(),p=new PendingResponses(gate),timeout=p.register("timeout",gate.admit(),0,false),response=p.register("response",gate.admit(),0,false);p.respond("response",{ok:true,value:"done"});assert.deepEqual(await timeout.result,{kind:"Timeout"});assert.equal((await response.result).kind,"Response");assert.equal(gate.snapshot().inFlight,0n);timeout.finish();timeout.dispose();response.finish();response.dispose();
});
test("invalid wait consumes only verified owned permit and forged response metadata cannot drop original",async()=>{
  const gate=new ClientLifecycle(),foreign=new ClientLifecycle(),p=new PendingResponses(gate),permit=foreign.admit();assert.throws(()=>p.register("x",permit,1,false),TypeError);assert.equal(foreign.snapshot().inFlight,1n);permit.release();assert.throws(()=>p.register("bad",gate.admit(),-1,false),TypeError);assert.equal(gate.snapshot().inFlight,0n);
  const r=p.register("x",gate.admit(),1000,false);let reads=0;assert.throws(()=>p.respond("x",{ok:true,get value(){reads++;return "bad";}}),TypeError);assert.equal(reads,0);assert.equal(p.size,1);p.transportClosedAll("done");await r.result;r.finish();r.dispose();
});
test("deadline setup failure rolls back registration and its owned permit",t=>{
  const gate=new ClientLifecycle(),p=new PendingResponses(gate),sentinel={timerFailure:true};t.mock.method(globalThis,"setTimeout",()=>{throw sentinel;});assert.throws(()=>p.register("id",gate.admit(),100,false),e=>e===sentinel);assert.equal(p.size,0);assert.equal(gate.snapshot().inFlight,0n);
});
test("registration owns the transferred permit so caller cannot release its pending lease early",async()=>{
  const gate=new ClientLifecycle(),p=new PendingResponses(gate),old=gate.admit(),r=p.register("id",old,1000,false);assert.throws(()=>old.release(),/transferred/);assert.equal(gate.sealIfQuiescent(()=>true),false);p.respond("id",{ok:true,value:null});await r.result;assert.equal(gate.snapshot().inFlight,0n);r.finish();r.dispose();
});
