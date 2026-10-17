import assert from "node:assert/strict";
import {test} from "node:test";
import {idempotentMessageRequest,IdempotentMessageContentError} from "../../src/discord/idempotent-message.ts";
import {parseSerdeValue} from "../../src/core/serde-json-parse.ts";
const request=(text:string)=>idempotentMessageRequest(42n,text,"session-mirror/assistant-text/v1","thread-1:abc",0);
test("no-components request matches frozen Rust golden nonce and exact four-field payload",()=>{
  const r=request("hello @everyone");assert.equal(r.method,"POST");assert.equal(r.path,"channels/42/messages");assert.equal(Object.isFrozen(r),true);
  assert.equal(r.body,'{"content":"hello @everyone","allowed_mentions":{"parse":[]},"nonce":2340874901045434203,"enforce_nonce":true}');
  const body=parseSerdeValue<Record<string,unknown>>(r.body);assert.deepEqual(body.allowed_mentions,{parse:[]});assert.equal(body.enforce_nonce,true);assert.equal(body.nonce,2340874901045434203n);assert.equal(Object.keys(body).length,4);assert.equal(Object.hasOwn(body,"components"),false);
});
test("content validation counts Unicode scalars without trimming saved content",()=>{
  assert.equal(parseSerdeValue<Record<string,unknown>>(request("  hello\n").body).content,"  hello\n");assert.ok(request("😀".repeat(1900)));
  assert.throws(()=>request("😀".repeat(1901)),error=>{assert.ok(error instanceof IdempotentMessageContentError);assert.deepEqual(error.failure,{kind:"ContentTooLong",actual:1901,maximum:1900});return true;});
});
test("empty and Rust-whitespace-only content reject while BOM is preserved",()=>{
  for(const text of ["","  ","\u0085\t\r\n"])assert.throws(()=>request(text),error=>error instanceof IdempotentMessageContentError&&error.kind==="ContentEmpty");
  assert.equal(parseSerdeValue<Record<string,unknown>>(request("\ufeff").body).content,"\ufeff");assert.throws(()=>request("\ud800"),TypeError);
});
test("wire escaping cannot inject a field or change mentions and large channel IDs remain exact",()=>{
  const text='"},"allowed_mentions":{"parse":["everyone"]},"x":"\n\\\u0000';const r=idempotentMessageRequest((1n<<64n)-1n,text,"completion/v1","key",0n),body=parseSerdeValue<Record<string,unknown>>(r.body);
  assert.equal(r.path,"channels/18446744073709551615/messages");assert.equal(body.content,text);assert.deepEqual(body.allowed_mentions,{parse:[]});assert.equal(Object.keys(body).length,4);
});
test("identical retries rebuild identical immutable request bytes",()=>{assert.deepEqual(request("same"),request("same"));assert.notEqual(idempotentMessageRequest(42n,"same","completion/v1","key",0).body,idempotentMessageRequest(42n,"same","completion/v1","key",1).body);});
