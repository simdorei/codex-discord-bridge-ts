import assert from "node:assert/strict";
import {test} from "node:test";
import {threadFingerprint,requestFingerprint,parseComponentId,persistentClaimKey,busyButtonRow,approvalButtonRow,boundApprovalButtonRow,inputButtonRow,boundInputButtonRow,asyncChoiceRows,publicationDecisionRows,abandonmentDecisionRows,serializeDiscordComponent,ComponentError,formatInputChoice,deferredUpdate,type DiscordComponent} from "../../src/discord/components.ts";
import {idempotentMessageRequestWithComponents} from "../../src/discord/idempotent-message.ts";
import {parseSerdeValue} from "../../src/core/serde-json-parse.ts";
const occurrence=new Uint8Array(16).fill(0x11),thread="60e9aec437d0f0f6",request="a9ea4a6523caf6d7ac871ed0d5496a87";
test("thread and typed request fingerprints match all frozen Rust goldens",()=>{
  assert.equal(threadFingerprint("thread-a"),thread);assert.equal(threadFingerprint(" \u0085thread-a\n"),thread);
  assert.equal(requestFingerprint(1n,occurrence,7n),request);assert.equal(requestFingerprint(1n,occurrence,"42"),"5e6e7f5c227ef203a644f42457b5127e");assert.equal(requestFingerprint(1n,occurrence,42n),"573643854409d20702cda663174076ab");
  assert.notEqual(requestFingerprint(2n,occurrence,7n),request);assert.notEqual(requestFingerprint(1n,new Uint8Array(16).fill(0x22),7n),request);
});
test("bound approval and input rows emit exact canonical IDs and parsed variants",()=>{
  const row=boundApprovalButtonRow("thread-a",1n,occurrence,7n);assert.equal(row.components[0]?.custom_id,`codex_approval:v2:${thread}:${request}:1`);
  assert.deepEqual(parseComponentId(row.components[1]!.custom_id),{BoundApproval:{thread_fingerprint:thread,request_fingerprint:request,answer:"ApproveSession"}});
  const input=boundInputButtonRow("thread-a",1n,occurrence,7n,[["2","Fast"]]);assert.equal(input.components[0]?.custom_id,`codex_input:v2:${thread}:${request}:2`);assert.deepEqual(parseComponentId(input.components[0]!.custom_id),{BoundInput:{thread_fingerprint:thread,request_fingerprint:request,value:"2"}});
});
test("request occurrence and typed ID separate reused requests without unbounded custom IDs",()=>{
  const a=boundApprovalButtonRow("thread".repeat(1000),1n,occurrence,"request".repeat(1000));assert.ok(a.components.every(c=>[...c.custom_id].length<=100));
  assert.notEqual(requestFingerprint(1n,occurrence,"7"),requestFingerprint(1n,occurrence,7n));assert.throws(()=>requestFingerprint(1n,new Uint8Array(15),1n),TypeError);assert.throws(()=>requestFingerprint(1n,occurrence,1n<<63n),RangeError);
});
test("claim key binds message/thread/request but intentionally ignores the answer",()=>{
  const first=`codex_approval:v2:${thread}:${request}:1`,other=`codex_approval:v2:${thread}:${request}:3`,next=`codex_approval:v2:${thread}:${"b".repeat(32)}:1`;
  assert.equal(persistentClaimKey(91n,first),persistentClaimKey(91n,other));assert.notEqual(persistentClaimKey(91n,first),persistentClaimKey(92n,first));assert.notEqual(persistentClaimKey(91n,first),persistentClaimKey(91n,next));
  const input=`codex_input:v2:${thread}:${request}:1`;assert.notEqual(persistentClaimKey(91n,first),persistentClaimKey(91n,input));assert.equal(persistentClaimKey(91n,input),persistentClaimKey(91n,`codex_input:v2:${thread}:${request}:2`));
});
test("legacy claims remain per message/domain and async claims per question, with busy/recovery excluded",()=>{
  assert.equal(persistentClaimKey(91n,"codex_approval:a:1"),persistentClaimKey(91n,"codex_approval:b:3"));assert.notEqual(persistentClaimKey(91n,"codex_approval:a:1"),persistentClaimKey(91n,"codex_input:a:1"));
  const id="a".repeat(64);assert.equal(persistentClaimKey(91n,`codex_async:${id}:0`),`async-question:91:${id}`);assert.equal(persistentClaimKey(91n,`codex_async:${id}:0`),persistentClaimKey(91n,`codex_async:${id}:24`));
  for(const value of [`codex_busy:${"a".repeat(24)}:queue`,`codex_pub:v1:${"a".repeat(32)}:1:a`,`codex_discard:v1:${"a".repeat(32)}:1:h`])assert.equal(persistentClaimKey(91n,value),null);
});
test("legacy whitespace normalization is not accepted by strict bound IDs",()=>{
  assert.deepEqual(parseComponentId("codex_approval: \u0085target : 1 "),{Approval:{thread_id:"target",answer:"Approve"}});assert.deepEqual(parseComponentId("codex_input: target : value "),{Input:{thread_id:"target",value:"value"}});
  assert.equal(parseComponentId(`codex_approval:v2:${thread}:${request}: 1`),null);assert.equal(parseComponentId(`codex_input:v2:${thread}:${request}: value`),null);assert.equal(parseComponentId(`codex_approval:v2:${thread.toUpperCase()}:${request}:1`),null);
});
test("custom ID parser rejects shape, fingerprint, length, index and revision aliases",()=>{
  const id="a".repeat(32),question="a".repeat(64);
  for(const value of [`codex_busy:${"a".repeat(23)}\n:queue`,`codex_busy:${"A".repeat(24)}:queue`,`codex_busy:${"a".repeat(24)}:other`,`codex_approval:t:toString`,`codex_input:t:a:b`,`codex_approval:${"😀".repeat(100)}:1`])assert.equal(parseComponentId(value),null);
  for(const rev of ["0","-1","+1","01","1.0","1\n","9223372036854775808"])assert.equal(parseComponentId(`codex_pub:v1:${id}:${rev}:a`),null);
  for(const option of ["25","-1","+0","00","0.0","0\n"])assert.equal(parseComponentId(`codex_async:${question}:${option}`),null);
});
test("busy buttons preserve enabled Steer-check display and immutable exact component wire shape",()=>{
  const row=busyButtonRow("a".repeat(24),false);assert.equal(row.components[0]?.label,"Steer (check)");assert.deepEqual(row.components.map(c=>c.style),[1,2,4,2]);assert.ok(Object.isFrozen(row));assert.ok(Object.isFrozen(row.components));assert.ok(Object.isFrozen(row.components[0]));
  const encoded=JSON.parse(serializeDiscordComponent(row));assert.equal(encoded.type,1);assert.deepEqual(Object.keys(encoded.components[0]),["type","custom_id","label","style"]);assert.equal(Object.hasOwn(encoded.components[0],"disabled"),false);assert.equal(busyButtonRow("a".repeat(24),true).components[0]?.label,"Steer now");
});
test("legacy input/approval rows preserve limits, scalar labels and first-five selection",()=>{
  const input=inputButtonRow(" t ",Array.from({length:7},(_,i)=>[`${i}`,"😀".repeat(90)] as const));assert.equal(input.components.length,5);assert.equal([...input.components[0]!.label].length,80);assert.equal(input.components[0]?.custom_id,"codex_input:t:0");
  assert.equal(approvalButtonRow(" t ").components[0]?.custom_id,"codex_approval:t:1");assert.throws(()=>approvalButtonRow("x".repeat(100)),ComponentError);assert.throws(()=>inputButtonRow("t",[]),ComponentError);assert.throws(()=>formatInputChoice("t","unsafe value"),ComponentError);
  assert.ok(parseComponentId(approvalButtonRow("😀".repeat(70)).components[0]!.custom_id));
});
test("async choices group at most five buttons per row and distinguish truncated duplicate labels",()=>{
  const id="a".repeat(64),rows=asyncChoiceRows(id,Array.from({length:25},()=>"😀".repeat(100)));assert.equal(rows.length,5);assert.ok(rows.every(r=>r.components.length===5));
  const buttons=rows.flatMap(r=>r.components);assert.equal(new Set(buttons.map(b=>b.custom_id)).size,25);assert.ok(buttons.every(b=>[...b.label].length===80&&b.label.endsWith("…")));assert.deepEqual(parseComponentId(buttons[24]!.custom_id),{AsyncChoice:{question_id:id,option:24n}});
  assert.throws(()=>asyncChoiceRows(id,Array(26).fill("x")),ComponentError);assert.throws(()=>asyncChoiceRows(id,["\u0085"]),ComponentError);
});
test("publication and abandonment decisions encode exact positive revision and distinct intent only",()=>{
  const id="b".repeat(32),revision=(1n<<63n)-1n,pub=publicationDecisionRows(id,revision)[0]!,abandon=abandonmentDecisionRows(id,revision)[0]!;
  assert.deepEqual(parseComponentId(pub.components[0]!.custom_id),{RecoveryPublicationDecision:{proposal_id:id,revision,decision:"ApproveExact"}});assert.deepEqual(parseComponentId(abandon.components[0]!.custom_id),{RecoveryAbandonDecision:{proposal_id:id,revision,decision:"AbandonOnly"}});
  assert.equal(pub.components[0]?.style,1);assert.equal(abandon.components[0]?.style,4);assert.throws(()=>publicationDecisionRows(id,0n),ComponentError);assert.deepEqual(deferredUpdate(),{type:6});
});
test("request retains generated components and default mention suppression without losing nonce precision",()=>{
  const row=busyButtonRow("a".repeat(24),true),r=idempotentMessageRequestWithComponents(42n,"Choose an action",[row],"message/reply/v1","source-message:99",0),body=parseSerdeValue<Record<string,unknown>>(r.body);
  assert.equal(Object.keys(body).length,5);assert.deepEqual(body.allowed_mentions,{parse:[]});assert.equal(body.enforce_nonce,true);assert.equal(typeof body.nonce,"bigint");assert.deepEqual(body.components,parseSerdeValue(`[${serializeDiscordComponent(row)}]`));
});
test("unknown or cloned component objects cannot inject extra wire fields or execute their getters",()=>{
  let calls=0;const fake={get type(){calls++;return 1;}} as DiscordComponent;assert.throws(()=>serializeDiscordComponent(fake),ComponentError);assert.equal(calls,0);
  const row=busyButtonRow("a".repeat(24),false);assert.throws(()=>serializeDiscordComponent({...row}),ComponentError);assert.throws(()=>idempotentMessageRequestWithComponents(42n,"hello",[fake],"x","y",0),ComponentError);assert.equal(calls,0);
});
