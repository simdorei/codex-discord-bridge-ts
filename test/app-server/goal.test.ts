import assert from "node:assert/strict";
import {test} from "node:test";
import {parseThreadGoalStatus,parseThreadGoalUpdate,isTerminalGoalStatus,GoalParseError,type GoalParseErrorKind,type ThreadGoalStatus} from "../../src/app-server/goal.ts";
const kind=(expected:GoalParseErrorKind)=>(e:unknown)=>e instanceof GoalParseError&&e.kind===expected;
test("all goal statuses map exactly and only Blocked/Complete are terminal",()=>{
  const cases:readonly [string,ThreadGoalStatus][]=[["active","Active"],["paused","Paused"],["blocked","Blocked"],["usageLimited","UsageLimited"],["budgetLimited","BudgetLimited"],["complete","Complete"]];
  for(const [raw,expected]of cases){assert.equal(parseThreadGoalStatus({goal:{threadId:"t",status:raw}},"t"),expected);assert.equal(isTerminalGoalStatus(expected),expected==="Blocked"||expected==="Complete");}
});
test("missing/null goal is absent but wrong shape and wrong thread refuse",()=>{
  for(const result of [{},{goal:null},null,[]])assert.equal(parseThreadGoalStatus(result,"t"),null);
  assert.throws(()=>parseThreadGoalStatus({goal:[]},"t"),kind("InvalidGoal"));assert.throws(()=>parseThreadGoalStatus({goal:{threadId:"other"}},"t"),kind("DifferentThread"));
});
test("goal/get exact identity differs intentionally from trimmed goal/update",()=>{
  const goal={threadId:" t ",status:"active"};assert.throws(()=>parseThreadGoalStatus({goal},"t"),kind("DifferentThread"));
  assert.deepEqual(parseThreadGoalUpdate({threadId:"\u0085 t ",turnId:" u ",goal}),{threadId:"t",turnId:"u",status:"Active"});
});
test("update validates outer thread then goal then matching thread then exact status",()=>{
  assert.throws(()=>parseThreadGoalUpdate({}),kind("MissingThreadId"));assert.throws(()=>parseThreadGoalUpdate({threadId:"t",goal:null}),kind("InvalidGoal"));
  assert.throws(()=>parseThreadGoalUpdate({threadId:"t",goal:{}}),kind("UpdateDifferentThread"));assert.throws(()=>parseThreadGoalUpdate({threadId:"t",goal:{threadId:"t"}}),kind("InvalidStatus"));
  for(const raw of [" active ","Active","usage-limited"]){assert.throws(()=>parseThreadGoalUpdate({threadId:"t",goal:{threadId:"t",status:raw}}),kind("UnknownStatus"));}
});
test("empty or nonstring turn is None; BOM is retained under Rust whitespace",()=>{
  for(const turnId of [undefined,null,7," \u0085"]){assert.equal(parseThreadGoalUpdate({threadId:"t",turnId,goal:{threadId:"t",status:"paused"}}).turnId,null);}
  assert.equal(parseThreadGoalUpdate({threadId:"t",turnId:"\uFEFF",goal:{threadId:"t",status:"paused"}}).turnId,"\uFEFF");
});
