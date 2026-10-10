import assert from "node:assert/strict";
import {test} from "node:test";
import {readableCompletionError,commentaryMessage,completionMessage,type CompletionGoalStatus} from "../../../src/runtime/completion/message.ts";
test("all completion headings and exact-empty distinctions",()=>{
  assert.equal(completionMessage("Completed","","답변"),"Final\n답변");
  assert.equal(completionMessage("Completed","",""),"Final\nCompleted (no visible reply)");
  assert.equal(completionMessage("Completed",""," \n"),"Final\n \n");
  assert.equal(completionMessage("Interrupted","ignored","ignored"),"Interrupted\nCodex turn was interrupted.");
  assert.equal(completionMessage("Failed","","ignored"),"Failed\nCodex turn failed without an error message.");
  assert.equal(completionMessage("Failed","   ",""),"Failed\n");
  assert.equal(completionMessage("InProgress","",""),"In progress\nmessage: Codex turn is still running.");
  assert.equal(commentaryMessage("실제 진행 내용"),"In progress\n실제 진행 내용");
});
test("Goal prefix excludes Complete and null, all other statuses explicit",()=>{
  const cases:readonly [CompletionGoalStatus,string][]=[["Active","active"],["Paused","paused"],["Blocked","blocked"],["UsageLimited","usage-limited"],["BudgetLimited","budget-limited"]];
  for(const [status,name]of cases)assert.equal(completionMessage("Completed","","x",status),`[Goal status: ${name}]\nFinal\nx`);
  assert.equal(completionMessage("Completed","","x","Complete"),"Final\nx");
});
test("known error envelopes prefer present nested value even if unusable",()=>{
  assert.equal(readableCompletionError('{"error":{"message":"inner"},"message":"outer"}'),"inner");
  for(const bad of [null,7,false,[],{}]){const raw=JSON.stringify({error:{message:bad},message:"outer"});assert.equal(readableCompletionError(raw),raw);}
  assert.equal(readableCompletionError('{"error":{},"message":"outer"}'),"outer");
  const empty='{"message":"  "}';assert.equal(readableCompletionError(empty),empty);
  assert.equal(readableCompletionError('{"message":"  kept  "}'),"  kept  ");
});
test("four peel bound, Rust whitespace, invalid JSON and Serde range",()=>{
  let raw="plain";for(let i=0;i<5;i++)raw=JSON.stringify(raw);
  assert.equal(readableCompletionError(raw),JSON.stringify("plain"));
  assert.equal(readableCompletionError("\u0085plain\u0085"),"plain");
  assert.equal(readableCompletionError("\uFEFFplain\uFEFF"),"\uFEFFplain\uFEFF");
  for(const raw of ['{"message":"x"', '{"message":"x","huge":1e9999}','{"message":"\\ud800"}'])assert.equal(readableCompletionError(raw),raw);
});
test("JSON fields are own-only and duplicate known keys use Serde Value last wins",()=>{
  assert.equal(readableCompletionError('{"message":"first","message":"last"}'),"last");
  const raw='{"__proto__":{"message":"not an envelope"}}';assert.equal(readableCompletionError(raw),raw);
  assert.equal(readableCompletionError('[{"message":"x"}]'),'[{"message":"x"}]');
});
