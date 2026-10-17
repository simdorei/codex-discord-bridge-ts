import assert from "node:assert/strict";
import {test} from "node:test";
import * as r from "../../src/app-server/requests.ts";
import {ClientLifecycle} from "../../src/app-server/client-lifecycle.ts";
import {PendingResponses,PendingReceiverClosedError} from "../../src/app-server/pending-responses.ts";
test("only nine exact methods are observational, not suffixes, tools, case variants or whitespace",()=>{
  const known=["account/rateLimits/read","account/usage/read","model/list","thread/list","thread/loaded/list","thread/read","thread/turns/list","thread/goal/get","mcpServerStatus/list"];
  for(const method of known){assert.equal(r.isObservationalRequest(method),true);assert.equal(r.isObservationalRequest(method+" "),false);assert.equal(r.isObservationalRequest(method.toUpperCase()),false);}
  for(const method of ["tools/call","thread/resume","turn/start","thread/unsubscribe","unknown/read","initialize",""])assert.equal(r.isObservationalRequest(method),false);
});
test("thread read/resume/fork/start builders preserve exact fields and timeout defaults",()=>{
  assert.deepEqual(r.readThread(" t ",false),{method:"thread/read",params:{threadId:" t ",includeTurns:false},timeoutMs:8000});assert.equal(r.readThreadWithTimeout("t",true,17).timeoutMs,17);
  assert.deepEqual(r.resumeThread("t"),{method:"thread/resume",params:{threadId:"t"},timeoutMs:10000});assert.equal(r.resumeThreadWithTimeout("t",23).timeoutMs,23);
  assert.deepEqual(r.forkThreadPersistent("t",31),{method:"thread/fork",params:{threadId:"t",ephemeral:false},timeoutMs:31});assert.deepEqual(r.startThread().params,{});assert.deepEqual(r.startThread("").params,{cwd:""});
});
test("turn start and steer retain exact prompt, text_elements and expected turn binding",()=>{
  const input=[{type:"text",text:" prompt ",text_elements:[]}];assert.deepEqual(r.startTurn("t"," prompt "),{method:"turn/start",params:{threadId:"t",input},timeoutMs:12000});
  assert.deepEqual(r.steerTurn("t"," prompt ","original"),{method:"turn/steer",params:{threadId:"t",expectedTurnId:"original",input},timeoutMs:10000});assert.deepEqual(r.interruptTurn("t","u").params,{threadId:"t",turnId:"u"});
});
test("settings omitted versus explicit null/empty stays distinct and effort clear takes precedence",()=>{
  assert.deepEqual(r.updateThreadSettings("t").params,{threadId:"t"});assert.deepEqual(r.updateThreadSettings("t",{model:"",effort:"high",effortClear:true,serviceTier:{kind:"Clear"}}).params,{threadId:"t",model:"",effort:null,serviceTier:null});
  assert.deepEqual(r.updateThreadSettings("t",{model:null,effort:"high",effortClear:false,serviceTier:{kind:"Set",value:"fast"}}).params,{threadId:"t",effort:"high",serviceTier:"fast"});
});
test("remaining builders preserve literal methods and timeout budgets",()=>{
  const cases=[r.getGoal("t"),r.listModels(),r.archiveThread("t"),r.cleanBackgroundTerminals("t"),r.unsubscribeThread("t"),r.rateLimits(),r.usage()];
  assert.deepEqual(cases.map(x=>[x.method,x.timeoutMs]),[["thread/goal/get",8000],["model/list",8000],["thread/archive",10000],["thread/backgroundTerminals/clean",10000],["thread/unsubscribe",8000],["account/rateLimits/read",15000],["account/usage/read",15000]]);
});
test("request snapshots are immutable and native timer profile rejects unsupported durations",()=>{
  const input=[{type:"text",text:"original"}],request=r.startTurnWithInput("t",input);input[0]!.text="mutated";assert.deepEqual(request.params,{threadId:"t",input:[{type:"text",text:"original"}]});assert.ok(Object.isFrozen(request));
  for(const n of [-1,0.5,Infinity,2147483648])assert.throws(()=>r.readThreadWithTimeout("t",true,n),RangeError);assert.throws(()=>r.startThread("\uD800"),TypeError);
});
test("method profile controls read cleanup while unknown calls retain pending mutation lease",async()=>{
  const gate=new ClientLifecycle(),pending=new PendingResponses(gate),read=pending.registerForMethod("r",gate.admit(),1000,"thread/read"),tool=pending.registerForMethod("m",gate.admit(),1000,"tools/call");read.dispose();await assert.rejects(read.result,PendingReceiverClosedError);tool.dispose();assert.equal(pending.size,1);assert.equal(gate.snapshot().inFlight,1n);pending.transportClosedAll("closed");assert.equal((await tool.result).kind,"TransportClosed");assert.equal(gate.snapshot().inFlight,0n);
});
