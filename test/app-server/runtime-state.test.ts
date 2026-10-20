import assert from "node:assert/strict";
import {test} from "node:test";
import {ClientRuntimeState,AppServerClosedError,deadGenerationWorkIsEmpty} from "../../src/app-server/runtime-state.ts";
import {ServerRequestOccurrence,type RequestId} from "../../src/protocol/ids.ts";
const occurrence=(n:number)=>{const b=Buffer.alloc(16);b.writeBigUInt64BE(BigInt(n),8);return ServerRequestOccurrence.fromBytes(b);};
const request=(id:RequestId,n:number,method="item/tool/requestUserInput",threadId="t",extra:Record<string,unknown>={})=>({id,occurrence:occurrence(n),method,params:{threadId,...extra}});
test("client lifecycle snapshot requires initialize, nonmissing PID and open transport",()=>{
  const s=new ClientRuntimeState(42);assert.deepEqual(s.snapshot(),{generation:0n,healthy:false,initialized:false,processId:42,closedReason:null});s.commitInitialized();assert.equal(s.snapshot().healthy,true);assert.equal(s.snapshot().generation,1n);s.publishClosedReason("first");assert.equal(s.publishClosedReason("later"),"first");assert.equal(s.snapshot().healthy,false);assert.equal(s.snapshot().processId,null);assert.equal(s.snapshot().initialized,false);assert.equal(s.snapshot().generation,1n);assert.throws(()=>s.commitInitialized(),AppServerClosedError);
  const missing=new ClientRuntimeState();missing.commitInitialized();assert.equal(missing.snapshot().healthy,false);assert.throws(()=>new ClientRuntimeState(-1),TypeError);
});
test("dead work is absent before close and empty snapshot does not clear or imply exit",()=>{
  const s=new ClientRuntimeState(42);assert.equal(s.deadGenerationWork(7n),null);s.publishClosedReason("closed");const work=s.deadGenerationWork(7n)!;assert.equal(work.generation,7n);assert.equal(work.closedReason,"closed");assert.equal(deadGenerationWorkIsEmpty(work),true);assert.equal("settleDeadGeneration" in s,false);
});
test("dead snapshot sorts active turns and every pending/claimed/deferred occurrence",()=>{
  const s=new ClientRuntimeState();s.publishClosedReason("fixture closed");for(const [threadId,turnId]of [["z","a"],["a","z"]])s.recordNotification({method:"turn/started",params:{threadId,turn:{id:turnId}}});
  const pending=request("z",3),claimed=request(2n,2,"item/commandExecution/requestApproval","claimed"),deferred=request(2n,1,"item/tool/requestUserInput","deferred");s.recordServerRequest(pending);s.recordServerRequest(claimed);s.beginServerResponse(claimed.id,claimed.occurrence);s.markServerResponseIndeterminate(claimed.id,claimed.occurrence);s.recordServerRequest(deferred);
  const work=s.deadGenerationWork(7n)!;assert.deepEqual(work.activeTurns,[{threadId:"a",turnId:"z"},{threadId:"z",turnId:"a"}]);assert.deepEqual(work.serverRequests.map(r=>r.id),[2n,2n,"z"]);assert.equal(work.serverRequests[0]!.occurrence.equals(deferred.occurrence),true);assert.equal(work.serverRequests[1]!.occurrence.equals(claimed.occurrence),true);assert.equal(s.hasActiveTurns,true);assert.equal(s.hasUnsettledServerRequests,true);assert.equal(deadGenerationWorkIsEmpty(work),false);
});
test("approval and input selectors choose latest pending only with exact MCP URL mode",()=>{
  const s=new ClientRuntimeState();s.recordServerRequest(request("a",1,"execCommandApproval"));const input=request("b",2);s.recordServerRequest(input);s.recordServerRequest(request("c",3,"mcpServer/elicitation/request","t",{mode:"form"}));s.recordServerRequest(request("d",4,"mcpServer/elicitation/request","t",{mode:"url"}));s.recordServerRequest(request("e",5,"item/fileChange/requestApproval","other"));
  assert.equal(s.latestApprovalRequest("t")?.id,"d");assert.equal(s.latestInputRequest("t")?.id,"b");s.beginServerResponse("d",occurrence(4));assert.equal(s.latestApprovalRequest("t")?.id,"a");s.beginServerResponse(input.id,input.occurrence);assert.equal(s.latestInputRequest("t"),null);assert.equal(s.unsettledServerRequests("t").length,4);
});
test("closing hides settings but preserves active and uncertain evidence",()=>{
  const s=new ClientRuntimeState();s.recordNotification({method:"thread/settings/updated",params:{threadId:"t",threadSettings:{model:"m"}}});s.recordNotification({method:"turn/started",params:{threadId:"t",turnId:"u"}});s.recordServerRequest(request(1n,1));assert.deepEqual(s.observedThreadSettings("t"),[1n,{model:"m"}]);s.publishClosedReason("closed");assert.equal(s.observedThreadSettings("t"),null);assert.equal(s.activeTurnId("t"),"u");assert.equal(s.pendingServerRequests().length,1);
});
test("snapshot fields and arrays cannot be mutated to rewrite live state",()=>{
  const s=new ClientRuntimeState(42);s.recordNotification({method:"turn/started",params:{threadId:"t",turnId:"u"}});s.publishClosedReason("closed");const work=s.deadGenerationWork(1n)!;assert.ok(Object.isFrozen(work));assert.ok(Object.isFrozen(work.activeTurns));assert.throws(()=>Object.assign(work.activeTurns[0]!,{turnId:"changed"}),TypeError);assert.equal(s.activeTurnId("t"),"u");assert.throws(()=>Object.assign(s.snapshot(),{healthy:true}),TypeError);
});
