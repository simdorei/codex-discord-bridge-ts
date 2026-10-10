import assert from "node:assert/strict";
import {test} from "node:test";
import {extractTurnText,extractTurnFinalText,extractCompletedFinalAnswer,isAsyncAgentMessage,TurnOutcomeError} from "../../src/app-server/outcomes.ts";
const history=(items:unknown[])=>({thread:{id:" t ",turns:[{id:" u ",items}]}});
const agent=(text:string,phase="commentary")=>({type:"agentMessage",text,phase});
test("explicit final survives later weaker commentary and last explicit final wins",()=>{
  assert.deepEqual(extractTurnText(history([agent("first","final_answer"),agent("later")]),"t","u"),{text:"first",explicitFinal:true});
  assert.deepEqual(extractTurnText(history([agent("first","final_answer"),agent("second","final_answer")]),"t","u"),{text:"second",explicitFinal:true});
});
test("legacy fallback is last visible agent text but remains explicitly weak",()=>{
  assert.deepEqual(extractTurnText(history([agent("a"),agent("b"),agent(" ")]),"t","u"),{text:"b",explicitFinal:false});
  assert.deepEqual(extractTurnText(history([]),"t","u"),{text:"",explicitFinal:false});assert.equal(extractTurnFinalText(history([agent("b")]),"t","u"),"b");
});
test("async metadata never becomes Final even with malformed choices",()=>{
  for(const type of ["agentMessage","agent_message"]){const item={type,delivery:"async",phase:"final_answer",text:"question",questions:"malformed"};assert.equal(isAsyncAgentMessage(item),true);assert.deepEqual(extractTurnText(history([item]),"t","u"),{text:"",explicitFinal:false});assert.equal(extractCompletedFinalAnswer({threadId:"t",turnId:"u",item}),null);}
  assert.equal(isAsyncAgentMessage({type:"tool",delivery:"async"}),false);
});
test("direct nonempty text wins; supported content blocks concatenate before outer trim",()=>{
  const item={type:"agent_message",text:" \u0085",content:[{type:"output_text",text:" a "},{type:"image",text:"ignore"},{type:"text",text:" b "},{type:"text",text:9}],phase:"final_answer"};
  assert.deepEqual(extractTurnText(history([item]),"t","u"),{text:"a \n b",explicitFinal:true});
  assert.equal(extractTurnText(history([{...item,text:" direct "}]),"t","u").text,"direct");
  assert.equal(extractTurnText(history([{...item,text:"\uFEFF"}]),"t","u").text,"\uFEFF");
});
test("completed item requires exact phase, nonempty original IDs and visible text",()=>{
  const item=agent(" answer ","final_answer");assert.deepEqual(extractCompletedFinalAnswer({threadId:" t ",turnId:" u ",item}),{threadId:"t",turnId:"u",text:"answer"});
  for(const params of [{threadId:"",turnId:"u",item},{threadId:"t",item},{threadId:"t",turnId:"u",item:agent("x","final")},{threadId:"t",turnId:"u",item:agent(" ","final_answer")}])assert.equal(extractCompletedFinalAnswer(params),null);
});
test("history chooses first matching turn and rejects malformed items without searching later duplicates",()=>{
  const value={thread:{id:"t",turns:[{id:"u",items:null},{id:"u",items:[agent("later","final_answer")]}]}};
  assert.throws(()=>extractTurnText(value,"t","u"),e=>e instanceof TurnOutcomeError&&e.kind==="InvalidItems");
  assert.throws(()=>extractTurnText(history([]),"other","u"),e=>e instanceof TurnOutcomeError&&e.kind==="DifferentThread");
  assert.throws(()=>extractTurnText(history([]),"t","missing"),e=>e instanceof TurnOutcomeError&&e.kind==="TurnNotFound");
});
