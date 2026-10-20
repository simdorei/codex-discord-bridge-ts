import assert from "node:assert/strict";
import {test} from "node:test";
import {ServerRequestOccurrence} from "../../src/protocol/ids.ts";
import {ResponseAttempt,pinResponseFence,type ResponseFence,type DurableResponseClaim,type DurableResponseCompletion,type CapturedResponseAuthority} from "../../src/app-server/response-attempt.ts";
import {pinResidentNativeResponseCompletion,type ResidentNativeResponseCompletion} from '../../src/app-server/resident-native-response-completion.ts';
import {MutationOutcomeUnknownError} from "../../src/app-server/maintenance-attempt.ts";
const original=()=>({id:"approval",occurrence:ServerRequestOccurrence.random(),method:"approval",params:{threadId:"T",turnId:"V"}});
const render=(e:unknown)=>e instanceof Error?e.message:"unknown";
function fixture(authority:CapturedResponseAuthority={value:{revision:5n}}){const calls:unknown[]=[],fence:ResponseFence={beginResponse:c=>{calls.push(c);},finishResponse:c=>{calls.push(c);}};const request=original(),payload={id:"approval",result:{approved:true}},a=new ResponseAttempt("owner",7n,request,authority,payload,fence,()=>{calls.push("check");},render);return {a,calls,fence,request,payload};}
test("response begin and completion keep original occurrence, authority and wire payload frozen",()=>{
  const f=fixture(),bytes=f.request.occurrence.asBytes();f.request.params.threadId="changed";f.payload.result.approved=false;f.a.begin();assert.equal(f.calls[0],"check");const begin=f.calls[1] as DurableResponseClaim;assert.deepEqual(begin.request.params,{threadId:"T",turnId:"V"});assert.deepEqual(begin.request.occurrence.asBytes(),bytes);assert.deepEqual(begin.payload,{id:"approval",result:{approved:true}});assert.ok(Object.isFrozen(begin.request.params));f.a.writeStarted();assert.deepEqual(f.a.finish({ok:true}),{ok:true});assert.equal((f.calls[2] as DurableResponseCompletion).outcome,"flushed");
});
test("not-started durable responses finish not_sent and preserve the primary error",()=>{
  const f=fixture(),error=new Error("writer deadline");f.a.begin();const result=f.a.finish({ok:false,error});assert.equal(!result.ok&&result.error,error);assert.equal((f.calls[2] as DurableResponseCompletion).outcome,"not_sent");
});
test("started ambiguous response is retained with no finish write or automatic replay",()=>{
  const f=fixture();f.a.begin();f.a.writeStarted();const result=f.a.finish({ok:false,error:new Error("pipe lost")});assert.equal(result.ok,false);if(result.ok)throw new Error("unexpected success");assert.ok(result.error instanceof MutationOutcomeUnknownError);assert.match(result.error.reason,/original response admission retained; no automatic replay/);assert.equal(f.calls.length,2);
});
test("Some(JSON null) still requires durable begin while None skips admission",()=>{
  const present=fixture({value:null});present.a.begin();assert.equal(present.calls.length,2);assert.equal((present.calls[1] as DurableResponseClaim).authority,null);present.a.writeStarted();present.a.finish({ok:true});assert.equal(present.calls.length,3);
  const absent=fixture(null);absent.a.begin();absent.a.writeStarted();absent.a.finish({ok:true});assert.deepEqual(absent.calls,["check"]);
});
test("failed admission does not fabricate completion and failed finish cannot report success",()=>{
  const request=original(),calls:unknown[]=[],fence:ResponseFence={beginResponse(){throw new Error("begin failed");},finishResponse:c=>{calls.push(c);}},a=new ResponseAttempt("o",1n,request,{value:{}},{},fence,()=>{},render);assert.throws(()=>a.begin(),/begin failed/);const error={};assert.equal(!a.finish({ok:false,error}).ok,true);assert.equal(calls.length,0);
  const b=new ResponseAttempt("o",1n,request,{value:{}},{},{beginResponse(){},finishResponse(){throw new Error("finish failed");}},()=>{},render);b.begin();b.writeStarted();const result=b.finish({ok:true});assert.equal(result.ok,false);if(!result.ok)assert.match((result.error as Error).message,/finish failed; original response admission retained/);
});
test("legacy missing response callbacks fail closed, callbacks pin once, and result getters do not run",()=>{
  const a=new ResponseAttempt("o",1n,original(),{value:{}},{},{},()=>{},render);assert.throws(()=>a.begin(),/original response admission is unavailable/);
  const f=fixture();f.fence.beginResponse=()=>{throw new Error("changed");};f.a.begin();let calls=0;assert.throws(()=>f.a.finish({get ok():true{calls++;return true;}}),TypeError);assert.equal(calls,0);f.a.writeStarted();f.a.finish({ok:true});assert.throws(()=>f.a.finish({ok:true}),/already/);
});
function ownedFixture(){
 const request=original(),payload={id:'approval',result:{approved:true}},authority={value:{revision:7n}},calls:unknown[]=[],receipt=Object.freeze({});
 const native:ResidentNativeResponseCompletion={captureResponse:claim=>{calls.push(claim);return receipt;},finishResponse:async(r,o)=>{assert.equal(r,receipt);calls.push(o);},close:async()=>{}};
 const a=new ResponseAttempt('owner',7n,request,authority,payload,{beginResponse:c=>{calls.push(c);},finishResponse:()=>assert.fail('legacy synchronous completion invoked')},()=>{calls.push('check');},render,native);
 return {a,calls,native,request,payload,authority};
}
test('owned finish retains privately captured original, uses no legacy fallback, and consumes exactly once',async()=>{
 const f=ownedFixture();f.request.params.threadId='changed';f.payload.result.approved=false;f.authority.value.revision=8n;
 const capture=f.calls[0] as DurableResponseClaim;f.a.begin();assert.deepEqual(f.calls.slice(1),['check',capture]);assert.deepEqual(capture.payload,{id:'approval',result:{approved:true}});assert.deepEqual(capture.authority,{revision:7n});
 assert.throws(()=>f.a.finish({ok:true}),/explicit asynchronous/);f.a.writeStarted();assert.deepEqual(await f.a.finishOwned({ok:true}),{ok:true});assert.equal(f.calls.at(-1),'flushed');await assert.rejects(f.a.finishOwned({ok:true}),/already/);
});
test('owned not_sent preserves primary error and started uncertainty performs no completion',async()=>{
 const f=ownedFixture(),error={failure:true};f.a.begin();const result=await f.a.finishOwned({ok:false,error});assert.equal(!result.ok&&result.error,error);assert.equal(f.calls.at(-1),'not_sent');
 const g=ownedFixture();g.a.begin();g.a.writeStarted();const unknown=await g.a.finishOwned({ok:false,error});assert.ok(!unknown.ok&&unknown.error instanceof MutationOutcomeUnknownError);assert.equal(g.calls.length,3);
});
test('owned completion cancellation is passed unchanged and never becomes success or replay',async()=>{
 const stop=new AbortController(),reason={cancel:true};stop.abort(reason);let observed:AbortSignal|undefined;
 const native:ResidentNativeResponseCompletion={captureResponse:()=>Object.freeze({}),finishResponse:async(_r,_o,signal)=>{observed=signal;signal?.throwIfAborted();},close:async()=>{}};
 const a=new ResponseAttempt('owner',1n,original(),{value:null},{},{beginResponse(){},finishResponse(){assert.fail('sync fallback');}},()=>{},render,native);a.begin();a.writeStarted();const r=await a.finishOwned({ok:true},stop.signal);assert.equal(observed,stop.signal);assert.ok(!r.ok&&r.error instanceof MutationOutcomeUnknownError);await assert.rejects(a.finishOwned({ok:true}),/already/);
});
test('legacy completion remains synchronous and rejects async, generator and disguised Promise hooks',()=>{
 for(const finishResponse of [async()=>{},function*(){}])assert.throws(()=>pinResponseFence({finishResponse} as ResponseFence),/synchronous/);
 const pinned=pinResponseFence({finishResponse:()=>Promise.resolve() as unknown as void});assert.throws(()=>pinned.finishResponse({} as DurableResponseCompletion),/synchronous/);
});
test('native capture is synchronous, frozen and pinned; finish and close require real void Promises',async()=>{
 const base={captureResponse:()=>Object.freeze({}),finishResponse:async()=>{},close:async()=>{}};
 for(const captureResponse of [async()=>Object.freeze({}),function*(){},()=>Promise.resolve(Object.freeze({})),()=>({})]){
  assert.throws(()=>{const p=pinResidentNativeResponseCompletion({...base,captureResponse} as ResidentNativeResponseCompletion);p.captureResponse({} as DurableResponseClaim);});
 }
 const input={...base},p=pinResidentNativeResponseCompletion(input);input.captureResponse=()=>{throw Error('changed');};assert.ok(Object.isFrozen(p.captureResponse({} as DurableResponseClaim)));
 for(const finishResponse of [()=>undefined,async()=>true])await assert.rejects(pinResidentNativeResponseCompletion({...base,finishResponse} as unknown as ResidentNativeResponseCompletion).finishResponse({},'flushed'),/Promise|void/);
 await assert.rejects(pinResidentNativeResponseCompletion({...base,close:()=>undefined} as unknown as ResidentNativeResponseCompletion).close(),/Promise/);
});
