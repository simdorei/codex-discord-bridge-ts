import assert from "node:assert/strict";
import {test} from "node:test";
import {parseSerdeValue as parse} from "../../src/core/serde-json-parse.ts";
import {serializeSerdeValue as json} from "../../src/core/serde-json.ts";
import {parseTurnCompletion,parseThreadTurnStates,completionJournalPayload,isUsageLimitError,TurnOutcomeError,type OutcomeErrorKind} from "../../src/app-server/outcomes.ts";
const input=(status="completed",extra:Record<string,unknown>={})=>({threadId:" t ",turn:{id:" u ",status,...extra}});
const kind=(expected:OutcomeErrorKind)=>(e:unknown)=>e instanceof TurnOutcomeError&&e.kind===expected;
test("terminal outcomes trim IDs, preserve exact status and interruption origin",()=>{
  assert.deepEqual(parseTurnCompletion(input(),false),{threadId:"t",turnId:"u",status:"Completed",errorMessage:"",interruptOrigin:null,durationMs:null,usageLimit:false});
  assert.equal(parseTurnCompletion(input("interrupted"),true).interruptOrigin,"RemoteUserIntent");assert.equal(parseTurnCompletion(input("interrupted"),false).interruptOrigin,"ExternalOrUnknown");
  assert.throws(()=>parseTurnCompletion(input("inProgress"),false),kind("InProgressCompletion"));assert.throws(()=>parseTurnCompletion(input("Completed"),false),kind("UnknownStatus"));
});
test("validation order matches invalid turn then thread then turn ID then status",()=>{
  assert.throws(()=>parseTurnCompletion({},false),kind("InvalidTurn"));assert.throws(()=>parseTurnCompletion({turn:{}},false),kind("MissingThreadId"));
  assert.throws(()=>parseTurnCompletion({threadId:"t",turn:{}},false),kind("MissingTurnId"));assert.throws(()=>parseTurnCompletion({threadId:"t",turn:{id:"u"}},false),kind("MissingStatus"));
});
test("errors validate for every status but only Failed retains text and usage",()=>{
  for(const status of ["completed","interrupted","failed"]){assert.throws(()=>parseTurnCompletion(input(status,{error:"bad"}),false),kind("InvalidError"));assert.throws(()=>parseTurnCompletion(input(status,{error:{}}),false),kind("MissingErrorMessage"));}
  const error={message:" \u0085"+"🦊".repeat(1100)+" ",codexErrorInfo:"usageLimitExceeded"};
  const failed=parseTurnCompletion(input("failed",{error}),false);assert.equal(Array.from(failed.errorMessage).length,1000);assert.equal(failed.usageLimit,true);
  assert.equal(parseTurnCompletion(input("completed",{error}),false).errorMessage,"");assert.equal(parseTurnCompletion(input("completed",{error}),false).usageLimit,false);
});
test("duration uses lossless Serde i64 integer classification, including negative values",()=>{
  for(const [raw,expected]of [["9007199254740993",9007199254740993n],["-1",-1n],["9223372036854775808",null],["1.0",null],["1e0",null],["-0",null]] as const){const value=parse(`{"threadId":"t","turn":{"id":"u","status":"completed","durationMs":${raw}}}`);assert.equal(parseTurnCompletion(value,false).durationMs,expected);}
});
test("structured usage detector suppresses incidental fallback when typed info is present",()=>{
  for(const code of ["usageLimitExceeded","UsageLimitExceeded","usage_limit_exceeded","usage_limit_reached","usage_limit"])assert.equal(isUsageLimitError({data:{reason:code}}),true);
  for(const value of [429,"HTTP 429 usage_limit",["usage_limit"],{message:"usage_limit"},{code:"usage_limit",codexErrorInfo:"rateLimitExceeded"},{code:"usage_limit",codexErrorInfo:[]}])assert.equal(isUsageLimitError(value),false);
  assert.equal(isUsageLimitError({code:"usage_limit",codexErrorInfo:null}),true);
});
test("usage depth boundary is four and own fields cannot be inherited or execute getters",()=>{
  let value:unknown="usage_limit";for(let i=0;i<4;i++)value={data:value};assert.equal(isUsageLimitError(value),true);assert.equal(isUsageLimitError({data:value}),false);
  assert.equal(isUsageLimitError(Object.create({code:"usage_limit"})),false);let calls=0;assert.equal(isUsageLimitError({get codexErrorInfo(){calls++;return "usage_limit";}}),false);assert.equal(calls,0);
});
test("history supports InProgress, duplicate last-wins and Rust UTF8 key ordering",()=>{
  const states=parseThreadTurnStates({thread:{id:"t",turns:[{id:"🦊",status:"failed"},{id:"a",status:"completed"},{id:"a",status:"inProgress"},{id:"한",status:"interrupted"}]}},"t");
  assert.deepEqual([...states.keys()],["a","한","🦊"]);assert.equal(states.get("a")?.status,"InProgress");assert.equal(states.get("한")?.interruptOrigin,"ExternalOrUnknown");
  assert.throws(()=>parseThreadTurnStates({thread:{id:"other",turns:[]}},"t"),kind("DifferentThread"));assert.throws(()=>parseThreadTurnStates({thread:{id:"t",turns:[null]}},"t"),kind("InvalidTurn"));
});
test("bounded journal strips details and roundtrips Failed usage and duration",()=>{
  const original=parseTurnCompletion(input("failed",{durationMs:99n,error:{message:"x",codexErrorInfo:"usageLimitExceeded",additionalDetails:"secret"}}),false);
  const payload=completionJournalPayload(original);assert.equal(json(payload).includes("secret"),false);assert.deepEqual(parseTurnCompletion(parse(json(payload)),false),original);
});
