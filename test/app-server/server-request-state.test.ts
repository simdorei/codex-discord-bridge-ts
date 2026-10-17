import assert from "node:assert/strict";
import {test} from "node:test";
import {ServerRequestOccurrence,type RequestId} from "../../src/protocol/ids.ts";
import {ServerRequestState,ServerRequestRecordError,ServerResponseStateError,type PendingServerRequest} from "../../src/app-server/server-request-state.ts";
const occurrence=(n:number)=>{const b=Buffer.alloc(16);b.writeBigUInt64BE(BigInt(n),8);return ServerRequestOccurrence.fromBytes(b);};
const request=(id:RequestId,n:number,command="same"):PendingServerRequest=>({id,occurrence:occurrence(n),method:"item/commandExecution/requestApproval",params:{threadId:"thread-a",command}});
const stateError=(kind:ServerResponseStateError["kind"])=>(e:unknown)=>e instanceof ServerResponseStateError&&e.kind===kind;
test("exact response resolution promotes immediate same-ID reuse without exposing it early",()=>{
  const s=new ServerRequestState(),old=request("same",1,"old"),next=request("same",2,"new");assert.equal(s.record(old).kind,"Broadcast");s.beginResponse(old.id,old.occurrence);assert.deepEqual(s.pending(),[]);
  assert.equal(s.record(next).kind,"Deferred");assert.deepEqual(s.pending(),[]);assert.deepEqual(s.unsettled().map(r=>(r.params as {command:string}).command),["old","new"]);
  assert.equal(s.resolve(old.id,old.occurrence)?.occurrence.equals(next.occurrence),true);assert.equal(s.pending()[0]?.occurrence.equals(next.occurrence),true);assert.equal(s.unsettledCount,1);
});
test("identical claimed redelivery is suppressed, identical reuse after resolution is fresh",()=>{
  const s=new ServerRequestState(),old=request("same",1);s.record(old);s.beginResponse(old.id,old.occurrence);assert.equal(s.record(request("same",2)).kind,"Duplicate");assert.equal(s.unsettledCount,1);assert.equal(s.resolve(old.id,old.occurrence),null);
  const fresh=request("same",3);assert.equal(s.record(fresh).kind,"Broadcast");assert.throws(()=>s.responseCandidate(old.id,old.occurrence),stateError("StaleServerRequest"));assert.ok(s.responseCandidate(fresh.id,fresh.occurrence));
});
test("second response claim refuses and indeterminate remains unsettled without replay",()=>{
  const s=new ServerRequestState(),r=request(7n,7);s.record(r);s.beginResponse(r.id,r.occurrence);assert.throws(()=>s.beginResponse(r.id,r.occurrence),stateError("ServerRequestResponseInFlight"));s.markIndeterminate(r.id,r.occurrence);
  assert.throws(()=>s.beginResponse(r.id,r.occurrence),stateError("ServerRequestResponseIndeterminate"));assert.equal(s.record(request(7n,8)).kind,"Duplicate");assert.throws(()=>s.beginResponse(7n,occurrence(8)),stateError("StaleServerRequest"));assert.equal(s.pending().length,0);assert.equal(s.unsettledCount,1);assert.equal(s.hasUnsettled,true);
});
test("one deferred candidate deduplicates and rejects conflicting third metadata",()=>{
  const s=new ServerRequestState(),old=request("x",1,"old"),next=request("x",2,"new");s.record(old);s.beginResponse(old.id,old.occurrence);assert.equal(s.record(next).kind,"Deferred");assert.equal(s.record(request("x",3,"new")).kind,"Deferred");
  assert.throws(()=>s.record(request("x",4,"other")),e=>e instanceof ServerRequestRecordError&&e.kind==="Conflict");assert.equal(s.unsettledCount,2);s.resolve(old.id,old.occurrence);assert.equal(s.pending()[0]?.occurrence.equals(next.occurrence),true);
});
test("saturation keeps all 500 unsettled entries until exact resolution frees a slot",()=>{
  const s=new ServerRequestState();for(let i=0;i<500;i++)s.record(request(BigInt(i),i+1));s.beginResponse(0n,occurrence(1));
  assert.throws(()=>s.record(request(500n,501)),e=>e instanceof ServerRequestRecordError&&e.kind==="Saturated");assert.equal(s.unsettled().length,500);assert.equal(s.record(request(1n,999)).kind,"Duplicate");s.resolve(0n,occurrence(1));assert.equal(s.record(request(500n,501)).kind,"Broadcast");assert.equal(s.unsettledCount,500);
});
test("integer and string request IDs remain distinct and occurrence bytes compare by value",()=>{
  const s=new ServerRequestState();s.record(request(1n,1,"int"));s.record(request("1",2,"string"));assert.equal(s.pending().length,2);s.beginResponse(1n,occurrence(1));assert.throws(()=>s.responseCandidate(1n,occurrence(1)),/Integer\(1\) already has a response in flight/);assert.equal(s.pending()[0]?.id,"1");
});
test("filters preserve arrival order across pending, claimed and deferred requests",()=>{
  const s=new ServerRequestState(),a=request("a",1),b={...request("b",2),params:{conversationId:" other "}};s.record(a);s.record(b);s.beginResponse(a.id,a.occurrence);s.record({...request("a",3,"new"),params:{thread:{id:"other"}}});
  assert.deepEqual(s.pending("other").map(r=>r.id),["b"]);assert.deepEqual(s.unsettled("other").map(r=>r.id),["b","a"]);assert.equal(s.pending(" other ").length,0);
});
test("metadata is copied without changing numeric representation and reads are immutable",()=>{
  const s=new ServerRequestState(),params={threadId:"t",nested:{value:1n}},r={...request("a",1),params};s.record(r);params.nested.value=2n;assert.equal(((s.pending()[0]?.params as typeof params).nested.value),1n);assert.throws(()=>{(s.pending()[0]!.params as typeof params).nested.value=3n;},TypeError);
  assert.equal(s.record({...request("a",2),params:{nested:{value:1n},threadId:"t"}}).kind,"Duplicate");assert.throws(()=>s.record({...request("a",3),params:{threadId:"t",nested:{value:1.0}}}),ServerRequestRecordError);
});
test("same-event-loop racing claims have exactly one winner",async()=>{
  const s=new ServerRequestState(),r=request(8n,8);s.record(r);const results=await Promise.allSettled([Promise.resolve().then(()=>s.beginResponse(r.id,r.occurrence)),Promise.resolve().then(()=>s.beginResponse(r.id,r.occurrence))]);assert.equal(results.filter(x=>x.status==="fulfilled").length,1);assert.equal(results.filter(x=>x.status==="rejected").length,1);
});
test("hostile record accessors and forged occurrences execute no application getters",()=>{
  const s=new ServerRequestState();let calls=0;const r=request("a",1);Object.defineProperty(r,"id",{get(){calls++;return "a";}});assert.throws(()=>s.record(r),TypeError);
  const fake=Object.create(ServerRequestOccurrence.prototype);Object.defineProperty(fake,"asBytes",{get(){calls++;return ()=>new Uint8Array(16);}});assert.throws(()=>s.record({...request("a",1),occurrence:fake}),TypeError);assert.equal(calls,0);assert.equal(s.hasUnsettled,false);
});
