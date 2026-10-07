import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {test} from "node:test";
import {DeliveryFailure} from "../../../src/discord/delivery.ts";
import {outboxIdentity,goalProgressIdentity,commentaryIdentity,deliverIdempotentChunks} from "../../../src/runtime/completion/delivery-identity.ts";
import type {IdempotentChunk} from "../../../src/runtime/completion/receipt-sender.ts";

test("completion logical keys use UTF-8 byte lengths and separated domains",()=>{
  assert.deepEqual(outboxIdentity("job;:🦊"),{domain:"completion/v1",logicalKey:"job;:🦊"});
  assert.deepEqual(goalProgressIdentity("한🦊",":"),{domain:"completion/goal-progress/v1",logicalKey:"7:한🦊;1::;"});
  assert.notDeepEqual(goalProgressIdentity("a;b","c"),goalProgressIdentity("a","b;c"));
  assert.deepEqual(goalProgressIdentity("",""),{domain:"completion/goal-progress/v1",logicalKey:"0:;0:;"});
  assert.ok(Object.isFrozen(outboxIdentity("a")));
});
test("commentary hashes Rust-trimmed bytes plus zero, with thread and turn scope",()=>{
  const digest=createHash("sha256").update(Buffer.from("same update\0")).digest("hex");
  const expected={domain:"completion/commentary/v1",logicalKey:`1:t;1:u;64:${digest};`};
  assert.deepEqual(commentaryIdentity("t","u","\u0085 same update \u0085"),expected);
  assert.notDeepEqual(commentaryIdentity("t","u","\uFEFFsame update"),expected);
  assert.notDeepEqual(commentaryIdentity("t","v","same update"),expected);
  assert.notDeepEqual(commentaryIdentity("v","u","same update"),expected);
  assert.notDeepEqual(commentaryIdentity("t","u","different update"),expected);
});
test("all identity text is well-formed without rejecting empty or astral text",()=>{
  assert.throws(()=>outboxIdentity("\uD800"),TypeError);
  assert.throws(()=>goalProgressIdentity("t","\uDC00"),TypeError);
  assert.throws(()=>commentaryIdentity("t","u","\uD800"),TypeError);
  assert.throws(()=>outboxIdentity(null as unknown as string),TypeError);
  assert.doesNotThrow(()=>commentaryIdentity("","","🦊"));
});
test("retry reuses exact identity/index/content and awaits each chunk",async()=>{
  const seen:IdempotentChunk[]=[];const sleeps:number[]=[];let active=0;
  const count=await deliverIdempotentChunks("x".repeat(2100),{retryDelaysMs:[0],chunkMarkers:true},outboxIdentity("delivery-42"),async chunk=>{
    assert.equal(active++,0);seen.push(chunk);await Promise.resolve();active--;
    if(seen.length===1)throw new Error("temporary");
  },async ms=>{sleeps.push(ms);});
  assert.equal(count,2);assert.deepEqual(sleeps,[0]);assert.equal(seen.length,3);
  assert.deepEqual(seen[0],seen[1]);assert.equal(seen[0]!.domain,"completion/v1");
  assert.equal(seen[0]!.logicalKey,"delivery-42");assert.equal(seen[0]!.chunkIndex,0);
  assert.equal(seen[2]!.chunkIndex,1);assert.notEqual(seen[1]!.content,seen[2]!.content);
  assert.ok(seen.every(Object.isFrozen));
});
test("empty retry policy preserves original failure and stops later chunks",async()=>{
  const sentinel=Object.freeze({reason:"failed"});let calls=0;
  await assert.rejects(deliverIdempotentChunks("x".repeat(5000),{retryDelaysMs:[],chunkMarkers:true},outboxIdentity("d"),async()=>{calls++;throw sentinel;}),error=>{
    assert.ok(error instanceof DeliveryFailure);assert.equal(error.source,sentinel);assert.equal(error.part,1);assert.equal(error.attempts,1);return true;
  });assert.equal(calls,1);
});
test("forged and proxy identities cannot run getters or send",()=>{
  let calls=0;const forged=new Proxy({}, {get(){calls++;throw new Error("trap");}});
  assert.throws(()=>deliverIdempotentChunks("x",{retryDelaysMs:[],chunkMarkers:true},forged as ReturnType<typeof outboxIdentity>,async()=>{calls++;}),TypeError);
  assert.equal(calls,0);
});
