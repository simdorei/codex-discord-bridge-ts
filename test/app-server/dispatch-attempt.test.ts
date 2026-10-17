import assert from "node:assert/strict";
import {test} from "node:test";
import {DispatchAttempt,type DispatchAttemptInput,type DispatchMutationFence} from "../../src/app-server/dispatch-attempt.ts";
import {MutationOutcomeUnknownError} from "../../src/app-server/maintenance-attempt.ts";
import {AppServerRequestError} from "../../src/app-server/request-client.ts";
const render=(e:unknown)=>e instanceof Error?e.message:"unknown";
const input=(extra:Partial<DispatchAttemptInput>={}):DispatchAttemptInput=>({ownerId:"owner",generation:5n,method:"turn/start",params:{threadId:"T"},repair:false,queueClaim:null,stopClaim:null,origin:{target:"T",stopRevision:1n},...extra});
function fixture(commit=true){const calls:{kind:string;value:any}[]=[];const fence:DispatchMutationFence={beginMutationWithOrigin:c=>{calls.push({kind:"normal",value:c});return commit;},finishMutation:c=>{calls.push({kind:"finish",value:c});},beginQueueMutation:c=>{calls.push({kind:"queue",value:c});return commit;},beginStopMutation:c=>{calls.push({kind:"stop",value:c});return commit;},finishStopMutation:c=>{calls.push({kind:"finish-stop",value:c});}};return {calls,fence,make:(i=input())=>new DispatchAttempt(i,fence,render)};}
test("scoped isolation requires a direct nonblank target, a known operation and a committed wire",()=>{
  for(const method of ["thread/resume","thread/settings/update","turn/start","turn/steer","thread/archive","thread/backgroundTerminals/clean","thread/unsubscribe"]){const f=fixture(),a=f.make(input({method}));assert.equal(a.isolatesTarget(),false);a.begin("wire");assert.equal(a.isolatesTarget(),true);assert.equal(f.calls[0]!.value.scoped,true);}
  for(const params of [{},{threadId:" "},{threadId:"\u0085"},{thread:{id:"T"}}]){const f=fixture(),a=f.make(input({params}));a.begin("w");assert.equal(a.isolatesTarget(),false);assert.equal(f.calls[0]!.value.scoped,false);}
  const f=fixture(false),a=f.make();a.begin("w");assert.equal(a.isolatesTarget(),false);
});
test("unknown calls remain unscoped and only explicitly repaired MCP tool calls can isolate",()=>{
  for(const [method,repair,scoped]of [["unknown",false,false],["mcpServer/tool/call",false,false],["mcpServer/tool/call",true,true]] as const){const f=fixture(),a=f.make(input({method,repair}));a.begin("w");assert.equal(a.isolatesTarget(),scoped);}
});
test("observations and ordinary interrupt do not create claims; original stop custody selects stop path",()=>{
  for(const method of ["thread/read","thread/goal/get","turn/interrupt"]){const f=fixture(),a=f.make(input({method}));a.begin("w");a.writeStarted();a.finish({ok:true,value:{}});assert.equal(f.calls.length,0);}
  const f=fixture(),a=f.make(input({method:"turn/interrupt",stopClaim:{control:"original"},queueClaim:{ignored:true}}));a.begin("wire");assert.equal(a.isolatesTarget(),true);a.writeStarted();a.finish({ok:true,value:{}});assert.deepEqual(f.calls.map(c=>c.kind),["stop","finish-stop"]);assert.deepEqual(f.calls[1]!.value.claim,{control:"original"});assert.equal(Object.hasOwn(f.calls[0]!.value,"method"),false);
});
test("original queue claim is frozen local metadata and finishes on the generic exact wire",()=>{
  const f=fixture(),claim={revision:4n},params={threadId:"T"},i=input({queueClaim:claim,params}),a=f.make(i);claim.revision=99n;params.threadId="other";a.begin(9007199254740993n);a.writeStarted();a.finish({ok:true,value:{}});assert.equal(f.calls[0]!.kind,"queue");assert.deepEqual(f.calls[0]!.value.claim,{revision:4n});assert.deepEqual(f.calls[0]!.value.params,{threadId:"T"});assert.ok(Object.isFrozen(f.calls[0]!.value.claim));assert.equal(f.calls[1]!.kind,"finish");assert.equal(f.calls[1]!.value.wire,9007199254740993n);assert.equal(f.calls[1]!.value.attemptId,f.calls[0]!.value.attemptId);
});
test("installed legacy fences reject unsupported queue and stop authority rather than dropping metadata",()=>{
  const fence:DispatchMutationFence={beginMutationWithOrigin:()=>true,finishMutation(){}};
  const q=new DispatchAttempt(input({queueClaim:{q:true}}),fence,render);assert.throws(()=>q.begin("w"),/does not support claimed queue dispatch/);assert.equal(q.isolatesTarget(),false);
  const s=new DispatchAttempt(input({method:"turn/interrupt",stopClaim:{s:true}}),fence,render);assert.throws(()=>s.begin("w"),/does not support original stop control/);assert.equal(s.isolatesTarget(),false);
});
test("not sent, reply success and owned Remote are exact durable dispositions",()=>{
  const remote=new AppServerRequestError({kind:"Remote",method:"turn/start",code:4n,message:"refused",data:null});
  for(const [started,result,outcome]of [[false,{ok:false,error:new Error("preflight")},"not_sent"],[true,{ok:true,value:{}},"reply_ok"],[true,{ok:false,error:remote},"reply_error"]] as const){const f=fixture(),a=f.make();a.begin("w");if(started)a.writeStarted();const r=a.finish(result);assert.equal(r.ok,result.ok);assert.equal(f.calls[1]!.value.outcome,outcome);assert.equal(a.wasStarted(),started);}
});
test("started timeout and forged Remote keep the durable intent without a finish write",()=>{
  const forged=Object.create(AppServerRequestError.prototype);forged.detail={kind:"Remote"};for(const error of [new AppServerRequestError({kind:"Timeout",method:"turn/start",timeoutMs:10}),forged]){const f=fixture(),a=f.make();a.begin("w");a.writeStarted();const r=a.finish({ok:false,error});assert.equal(r.ok,false);if(r.ok)throw new Error("unexpected success");assert.ok(r.error instanceof MutationOutcomeUnknownError);assert.match(r.error.reason,/durable attempt .* retained; no automatic replay/);assert.equal(f.calls.length,1);assert.equal(a.isolatesTarget(),true);}
});
test("failed completion cannot claim success and a stop claim cannot fall back to generic completion",()=>{
  const f=fixture();f.fence.finishMutation=()=>{throw new Error("commit failed");};const a=f.make();a.begin("w");a.writeStarted();const r=a.finish({ok:true,value:{}});assert.equal(r.ok,false);if(r.ok)throw new Error("unexpected success");assert.ok(r.error instanceof MutationOutcomeUnknownError);assert.match(r.error.reason,/response\/dispatch evidence could not be committed: commit failed/);
  const legacy:DispatchMutationFence={beginMutationWithOrigin:()=>true,finishMutation(){throw new Error("wrong path");},beginStopMutation:()=>true};const b=new DispatchAttempt(input({method:"turn/interrupt",stopClaim:{s:true}}),legacy,render);b.begin("w");b.writeStarted();const result=b.finish({ok:true,value:{}});assert.equal(result.ok,false);if(!result.ok)assert.match((result.error as Error).message,/durable stop completion is not supported/);
});
test("no installed or uncommitted fence preserves original errors, without claiming isolation",()=>{
  for(const fence of [null,fixture(false).fence]){const a=new DispatchAttempt(input(),fence,render);a.begin("w");a.writeStarted();const error={},r=a.finish({ok:false,error});assert.equal(!r.ok&&r.error,error);assert.equal(a.isolatesTarget(),false);}
});
test("attempt callbacks are pinned and completed attempts cannot write a second disposition",()=>{
  const f=fixture(),a=f.make();f.fence.beginMutationWithOrigin=()=>false;f.fence.finishMutation=()=>{throw new Error("changed");};a.begin("w");assert.equal(a.isolatesTarget(),true);assert.throws(()=>a.begin("new"),/already/);a.writeStarted();a.finish({ok:true,value:{}});assert.equal(f.calls.length,2);assert.throws(()=>a.finish({ok:true,value:{}}),/already/);assert.throws(()=>a.writeStarted(),/already/);
});
test("missing own dispatch identity cannot invoke inherited metadata accessors",()=>{
  const inputValue:any=input();delete inputValue.ownerId;const prior=Object.getOwnPropertyDescriptor(Object.prototype,"ownerId");let calls=0,error:unknown;
  const descriptor=Object.create(null);descriptor.configurable=true;descriptor.get=()=>{calls++;return "inherited-owner";};Object.defineProperty(Object.prototype,"ownerId",descriptor);
  try{try{new DispatchAttempt(inputValue,null,render);}catch(e){error=e;}}finally{if(prior)Object.defineProperty(Object.prototype,"ownerId",prior);else Reflect.deleteProperty(Object.prototype,"ownerId");}
  assert.equal(calls,0);assert.ok(error instanceof TypeError);
});
