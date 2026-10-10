import assert from "node:assert/strict";
import {test} from "node:test";
import {decodeQuestionBody,answerPrompt,ANSWER_PREFIX} from "../../src/store/async-question-body.ts";
import {originalHistoricalQuestion} from "../../src/store/async-history-question.ts";
import {serializeSerdeValue} from "../../src/core/serde-json.ts";
import type {AsyncObligation} from "../../src/store/async-resolution-records.ts";
import {historicalQuestionFixture as fixture} from "../helpers/async-history-fixture.ts";

test("question body defaults source text, preserves usize64 and rejects typed duplicate/type errors",()=>{
  assert.deepEqual(decodeQuestionBody('{"index":18446744073709551615,"title":"q","options":["a"]}'),
    {index:18446744073709551615n,source_text:"",title:"q",options:["a"]});
  assert.deepEqual(decodeQuestionBody('[0,"source","q",["a"]]'),{index:0n,source_text:"source",title:"q",options:["a"]});
  for(const raw of ['{"index":0,"index":0,"title":"q","options":[]}','{"index":1.0,"title":"q","options":[]}',
    '{"index":0,"source_text":null,"title":"q","options":[]}','{"index":0,"title":"q","options":[1]}']) assert.throws(()=>decodeQuestionBody(raw));
});
test("original history seal validates exact question and emits the literal answer prompt",()=>{
  const {row}=fixture();const q=originalHistoricalQuestion(row);
  assert.equal(answerPrompt(q,q.chosen),ANSWER_PREFIX+'\n{"original_turn_id":"turn","question_index":3,"question_item_id":"item","question_title":"Question","selected_option":"no","selected_option_index":1,"thread_id":"target"}');
  assert.throws(()=>answerPrompt(q,2n),/invalid sealed answer option/);
});
test("changed original row, chosen value, missing seal and wrong dispatch mode reject",()=>{
  const {row,claim}=fixture();
  for(const change of [{version:2n},{revision:-1n},{original_seal:null},{question_id:"other"},{turn_id:"other"}]) assert.throws(()=>originalHistoricalQuestion({...row,...change}));
  for(const change of [{chosen:0n},{chosen:1},{dispatch_mode:"start"},{generation:-1n},{owner_user_id:0n},{message_id:null}])
    assert.throws(()=>originalHistoricalQuestion({...row,claim:serializeSerdeValue({...claim,...change})}));
});
test("unknown body fields are ignored but seal identity cannot contain extra fields",()=>{
  const {row,claim,seal}=fixture();
  assert.doesNotThrow(()=>originalHistoricalQuestion({...row,claim:serializeSerdeValue({...claim,body:claim.body.replace('{','{"unknown":1e999,')})}));
  assert.throws(()=>originalHistoricalQuestion({...row,original_seal:serializeSerdeValue({identity:{...seal.identity,extra:true}})}));
});
test("answer byte limit rejects a complete but oversized original seal",()=>{
  const {row,claim,seal,body}=fixture();const large={...body,options:["yes","한".repeat(22000)]};
  assert.throws(()=>originalHistoricalQuestion({...row,claim:serializeSerdeValue({...claim,body:serializeSerdeValue(large)}),
    original_seal:serializeSerdeValue({identity:{...seal.identity,body:large}})}),/complete immutable original question seal/);
});
