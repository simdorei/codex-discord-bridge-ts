import assert from "node:assert/strict";
import {test} from "node:test";
import {MaintenanceAttempt,MutationOutcomeUnknownError,type MaintenanceClaim,type MaintenanceCompletion,type MaintenanceMutationFence} from "../../src/app-server/maintenance-attempt.ts";
import {AppServerRequestError,ownedRequestFailure} from "../../src/app-server/request-client.ts";
import type {IdleReleaseToken} from "../../src/app-server/idle-release-journal.ts";
import type {IdleRpcResult} from "../../src/app-server/idle-maintenance.ts";
const token:IdleReleaseToken={intentId:"i",ownerId:"owner",generation:7n,threadId:"T",turnId:"V",jobId:"job",revision:2n,state:"Dispatching",detail:""};
const render=(e:unknown)=>e instanceof Error?e.message:"unknown";
function fixture(commit=true){const claims:MaintenanceClaim[]=[],finishes:MaintenanceCompletion[]=[];const fence:MaintenanceMutationFence={beginMutationWithOrigin:c=>{claims.push(c);return commit;},finishMutation:c=>{finishes.push(c);}};return {claims,finishes,fence,attempt:(method="thread/unsubscribe",origin:unknown=null)=>new MaintenanceAttempt(token,method,{threadId:"T"},origin,fence,render)};}
const ok=(phase:"NotStarted"|"Partial"|"Flushed"="Flushed"):IdleRpcResult=>({ok:true,value:{done:true},phase});
test("attempt pins original owner, wire ID, parameters and origin before committing a scoped claim",()=>{
  const f=fixture(),params={threadId:"T"},origin={revision:9n},source={...token},attempt=new MaintenanceAttempt(source,"thread/unsubscribe",params,origin,f.fence,render);
  source.ownerId="changed";params.threadId="changed";origin.revision=10n;attempt.begin(9007199254740993n);const claim=f.claims[0]!;assert.equal(claim.ownerId,"owner");assert.equal(claim.wire,9007199254740993n);assert.deepEqual(claim.params,{threadId:"T"});assert.deepEqual(claim.origin,{revision:9n});assert.equal(claim.scoped,true);assert.match(claim.attemptId,/^[a-f0-9-]{36}$/);assert.ok(Object.isFrozen(claim));assert.ok(Object.isFrozen(claim.params));
  const result=attempt.finish(ok());assert.equal(result.ok,true);assert.deepEqual(f.finishes[0],{ownerId:"owner",generation:7n,attemptId:claim.attemptId,wire:claim.wire,outcome:"reply_ok"});
});
test("known observations never create or finish a durable mutation attempt",()=>{
  for(const method of ["thread/read","thread/goal/get","thread/turns/list","mcpServerStatus/list"]){const f=fixture(),attempt=f.attempt(method);attempt.begin("wire");attempt.finish(ok());assert.equal(f.claims.length,0);assert.equal(f.finishes.length,0);}
});
test("explicit legacy false and absent fence return raw errors without inventing durable isolation",()=>{
  const error=new Error("timeout"),f=fixture(false),a=f.attempt();a.begin("wire");const r=a.finish({ok:false,error,phase:"Flushed"});assert.equal(!r.ok&&r.error,error);assert.equal(f.finishes.length,0);
  const b=new MaintenanceAttempt(token,"thread/unsubscribe",{},null,null,render);b.begin("wire");assert.equal(b.finish(ok()).ok,true);
});
test("not-sent, successful reply and owned remote error settle only their exact outcomes",()=>{
  const remote=new AppServerRequestError({kind:"Remote",method:"thread/unsubscribe",code:-1n,message:"refused",data:null});
  for(const [result,outcome]of [[{ok:false,error:new Error("prewrite deadline"),phase:"NotStarted"},"not_sent"],[ok(),"reply_ok"],[{ok:false,error:remote,phase:"Flushed"},"reply_error"]] as const){const f=fixture(),a=f.attempt();a.begin("wire");const actual=a.finish(result);assert.equal(actual.ok,result.ok);assert.equal(f.finishes[0]!.outcome,outcome);if(!actual.ok&&!result.ok)assert.equal(actual.error,result.error);}
});
test("partial, flushed timeout and forged Remote error retain attempts with no automatic replay",()=>{
  const forged=Object.create(AppServerRequestError.prototype);forged.detail={kind:"Remote"};
  for(const error of [new AppServerRequestError({kind:"Timeout",method:"thread/unsubscribe",timeoutMs:8000}),forged,new Error("I/O lost")]){const f=fixture(),a=f.attempt();a.begin("wire");const result=a.finish({ok:false,error,phase:"Flushed"});assert.equal(result.ok,false);if(result.ok)throw new Error("unexpected success");assert.ok(result.error instanceof MutationOutcomeUnknownError);assert.match(result.error.reason,/durable maintenance attempt .* retained; no automatic replay/);assert.equal(f.finishes.length,0);}
});
test("failed finish records unknown result, even when the server returned success",()=>{
  const f=fixture();f.fence.finishMutation=()=>{throw new Error("DB not committed");};const a=f.attempt();a.begin("wire");const result=a.finish(ok());assert.equal(result.ok,false);if(result.ok)throw new Error("unexpected success");assert.ok(result.error instanceof MutationOutcomeUnknownError);assert.match(result.error.reason,/maintenance result not committed: DB not committed/);
});
test("failed begin cannot acquire a wire commitment or create a false finish",()=>{
  const f=fixture();f.fence.beginMutationWithOrigin=()=>{throw new Error("cannot persist");};const a=f.attempt();assert.throws(()=>a.begin("wire"),/cannot persist/);const error=new Error("cannot persist");const result=a.finish({ok:false,error,phase:"NotStarted"});assert.equal(!result.ok&&result.error,error);assert.equal(f.finishes.length,0);assert.throws(()=>a.begin("wire"),/already/);
});
test("callbacks are pinned, one attempt cannot begin/finish twice, and invalid phase cannot settle",()=>{
  const f=fixture(),a=f.attempt();f.fence.beginMutationWithOrigin=()=>false;f.fence.finishMutation=()=>{throw new Error("replacement");};a.begin("wire");assert.throws(()=>a.begin("other"),/already/);assert.throws(()=>a.finish({ok:true,value:{},phase:"invalid"} as unknown as IdleRpcResult),/exact maintenance outcome/);assert.equal(f.finishes.length,0);a.finish(ok());assert.equal(f.finishes.length,1);assert.throws(()=>a.finish(ok()),/already finished/);
});
test("request failure classification uses owned immutable construction metadata without proxy or accessor execution",()=>{
  let calls=0;const fake=new Proxy({},{get(){calls++;throw new Error("trap");},getPrototypeOf(){calls++;throw new Error("trap");}});assert.equal(ownedRequestFailure(fake),null);assert.equal(ownedRequestFailure(Object.create(AppServerRequestError.prototype)),null);assert.equal(calls,0);
  const remote=new AppServerRequestError({kind:"Remote",method:"m",code:1n,message:"remote",data:null});Object.defineProperty(remote,"detail",{get(){calls++;throw new Error("getter");}});assert.equal(ownedRequestFailure(remote)?.kind,"Remote");assert.equal(calls,0);
});
test("async persistence callbacks are refused before effects and Promise-returning callbacks cannot claim commitment",()=>{
  assert.throws(()=>new MaintenanceAttempt(token,"m",{},null,{beginMutationWithOrigin:async()=>true,finishMutation:()=>{}} as unknown as MaintenanceMutationFence,render),/synchronous/);
  const fence={beginMutationWithOrigin:()=>Promise.resolve(true),finishMutation:()=>{}} as unknown as MaintenanceMutationFence,a=new MaintenanceAttempt(token,"m",{},null,fence,render);assert.throws(()=>a.begin("w"),/synchronously/);const error=new Error("blocked");assert.equal(!a.finish({ok:false,error,phase:"NotStarted"}).ok,true);
});
