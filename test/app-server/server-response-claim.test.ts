import assert from "node:assert/strict";
import {test} from "node:test";
import {ServerRequestOccurrence} from "../../src/protocol/ids.ts";
import {ClientRuntimeState} from "../../src/app-server/runtime-state.ts";
import {beginServerResponseClaim} from "../../src/app-server/server-response-claim.ts";
function request(state:ClientRuntimeState,params:unknown={threadId:"thread",turnId:"turn"}){const r={id:"id",occurrence:ServerRequestOccurrence.random(),method:"approval",params};state.recordServerRequest(r);return r;}
test("unresolved claim disposal retains indeterminate work and prohibits resend",()=>{
  const state=new ClientRuntimeState(),r=request(state),claim=beginServerResponseClaim(state,r.id,r.occurrence,()=>{});claim.dispose();claim.dispose();
  assert.equal(state.unsettledServerRequests().length,1);assert.throws(()=>state.serverResponseCandidate(r.id,r.occurrence),/indeterminate/);assert.throws(()=>claim.resolve(),/consumed/);
});
test("successful exact response promotes deferred request exactly once",()=>{
  const state=new ClientRuntimeState(),r=request(state),promoted:unknown[]=[],claim=beginServerResponseClaim(state,r.id,r.occurrence,r=>{promoted.push(r);});
  const next={...r,occurrence:ServerRequestOccurrence.random(),params:{threadId:"thread",turnId:"next"}};assert.equal(state.recordServerRequest(next).kind,"Deferred");
  claim.resolve();claim.dispose();assert.equal(promoted.length,1);assert.equal(state.pendingServerRequests().length,1);assert.equal(state.pendingServerRequests()[0]!.params!==r.params,true);assert.throws(()=>claim.resolve(),/consumed/);
});
test("current response requires exact active turn and source direct turnId field",()=>{
  for(const params of [{threadId:"thread"},{threadId:"thread",turnId:""},{threadId:"thread",turnId:" turn"},{threadId:"thread",turn:{id:"turn"}},{threadId:"thread",turnId:"other"}]){
    const state=new ClientRuntimeState(),r=request(state,params);state.recordNotification({method:"turn/started",params:{threadId:"thread",turnId:"turn"}});
    assert.throws(()=>beginServerResponseClaim(state,r.id,r.occurrence,()=>{},true),/stale/);assert.equal(state.pendingServerRequests().length,1);
  }
});
test("current response handles NEL/BOM Rust trim distinction and rejects stale occurrence before field checks",()=>{
  const state=new ClientRuntimeState(),r=request(state,{threadId:"thread",turnId:"\ufeffturn"});state.recordNotification({method:"turn/started",params:{threadId:"thread",turnId:"\ufeffturn"}});
  const claim=beginServerResponseClaim(state,r.id,r.occurrence,()=>{},true);claim.resolve();assert.equal(state.hasUnsettledServerRequests,false);
  const state2=new ClientRuntimeState(),r2=request(state2,{threadId:"thread",turnId:"\u0085turn"});state2.recordNotification({method:"turn/started",params:{threadId:"thread",turnId:"\u0085turn"}});
  assert.throws(()=>beginServerResponseClaim(state2,r2.id,r2.occurrence,()=>{},true),/stale/);
  assert.throws(()=>beginServerResponseClaim(state2,r2.id,ServerRequestOccurrence.random(),()=>{},true),/stale/);
});
test("claimed state error wins before current-turn invalidation",()=>{
  const state=new ClientRuntimeState(),r=request(state);state.recordNotification({method:"turn/started",params:{threadId:"thread",turnId:"turn"}});
  const claim=beginServerResponseClaim(state,r.id,r.occurrence,()=>{},true);state.recordNotification({method:"turn/completed",params:{threadId:"thread",turnId:"turn"}});
  assert.throws(()=>beginServerResponseClaim(state,r.id,r.occurrence,()=>{},true),/in flight/);claim.dispose();
});
test("promotion adapter failure cannot re-resolve or lose the already promoted state",()=>{
  const sentinel={},state=new ClientRuntimeState(),r=request(state),claim=beginServerResponseClaim(state,r.id,r.occurrence,()=>{throw sentinel;});state.recordServerRequest({...r,occurrence:ServerRequestOccurrence.random(),params:{different:true}});
  assert.throws(()=>claim.resolve(),e=>e===sentinel);claim.dispose();assert.throws(()=>claim.resolve(),/consumed/);assert.equal(state.pendingServerRequests().length,1);
});
