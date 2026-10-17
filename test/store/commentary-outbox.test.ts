import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {test} from "node:test";
import type {DatabaseSync} from "node:sqlite";
import {storeFixture} from "../helpers/store-fixture.ts";
import {queueJob} from "../helpers/queue-job.ts";
import {StateAccessFacade as state} from "../../src/store/state-access-facade.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {hasPendingCommentaryIn} from "../../src/store/commentary-outbox.ts";
async function edit<T>(path:string,run:(db:DatabaseSync)=>T):Promise<T>{const db=await openInitialized(path);try{return run(db);}finally{db.close();}}
async function running(path:string):Promise<void>{await state.enqueue(path,queueJob());const claim=(await state.tryBeginAttempt(path,"saved",[],1n))!;assert.ok(claim);assert.ok(await state.markRunningIfClaimed(path,claim,"turn"));}
test("stage requires running matching thread and turn before dead hold lookup",async()=>storeFixture(async path=>{
  await state.enqueue(path,queueJob());await edit(path,db=>db.exec("INSERT INTO codex_dead_generation_holds VALUES ('target','runtime',1,0)"));
  assert.equal(await state.stageCommentary(path,"target","turn","progress"),null);assert.deepEqual(await state.pendingCommentary(path),[]);
}));
test("stage persists trimmed text and exact Serde tuple digest then deduplicates",async()=>storeFixture(async path=>{
  await running(path);const first=await state.stageCommentary(path,"target","turn","\u0085 progress 🦊 \u0085");assert.ok(first);
  assert.deepEqual(first,{sequence:1n,jobId:"saved",threadId:"target",turnId:"turn",channelId:1n,text:"progress 🦊"});
  assert.deepEqual(await state.stageCommentary(path,"target","turn","progress 🦊"),first);
  const hash=createHash("sha256").update('["target","turn","progress 🦊"]').digest("hex");
  await edit(path,db=>assert.equal(db.prepare("SELECT delivery_key FROM codex_commentary_outbox").get()?.delivery_key,hash));
  const bom=await state.stageCommentary(path,"target","turn","\uFEFFprogress 🦊");assert.notEqual(bom?.sequence,first.sequence);assert.equal(bom?.text,"\uFEFFprogress 🦊");
}));
test("duplicate immutable saved owner/channel survives running job metadata changes",async()=>storeFixture(async path=>{
  await running(path);const first=await state.stageCommentary(path,"target","turn","same");
  await edit(path,db=>db.exec("UPDATE codex_turn_queue SET channel_id=99"));assert.deepEqual(await state.stageCommentary(path,"target","turn","same"),first);
}));
test("pending ordering and strict before bound are job scoped",async()=>storeFixture(async path=>{
  await running(path);const a=(await state.stageCommentary(path,"target","turn","a"))!,b=(await state.stageCommentary(path,"target","turn","b"))!;
  assert.deepEqual((await state.pendingCommentary(path)).map(x=>x.text),["a","b"]);
  assert.equal(await state.hasPendingCommentary(path,"saved",a.sequence),false);assert.equal(await state.hasPendingCommentary(path,"saved",b.sequence),true);
  assert.equal(await state.hasPendingCommentary(path,"other",null),false);
  await state.completeCommentary(path,a.sequence);assert.equal(await state.hasPendingCommentary(path,"saved",b.sequence),false);
  await state.completeCommentary(path,b.sequence);await state.completeCommentary(path,b.sequence);assert.equal(await state.hasPendingCommentary(path,"saved"),false);
}));
test("dead target blocks even duplicate staging without deleting saved evidence",async()=>storeFixture(async path=>{
  await running(path);await state.stageCommentary(path,"target","turn","saved");await edit(path,db=>db.exec("INSERT INTO codex_dead_generation_holds VALUES ('target','runtime',1,0)"));
  await assert.rejects(state.stageCommentary(path,"target","turn","saved"),/manual review/);assert.equal((await state.pendingCommentary(path)).length,1);
}));
test("failed read after ignored insert rolls back and leaves no partial commentary",async()=>storeFixture(async path=>{
  await running(path);await edit(path,db=>db.exec("CREATE TRIGGER ignore_stage BEFORE INSERT ON codex_commentary_outbox BEGIN SELECT RAISE(IGNORE); END"));
  await assert.rejects(state.stageCommentary(path,"target","turn","new"),/Missing staged commentary/);assert.deepEqual(await state.pendingCommentary(path),[]);
}));
test("borrowed pending predicate preserves caller transaction and errors are not absence",async()=>storeFixture(async path=>{
  await running(path);await state.stageCommentary(path,"target","turn","x");await edit(path,db=>{
    db.exec("BEGIN");assert.equal(hasPendingCommentaryIn(db,"saved"),true);assert.equal(db.isTransaction,true);db.exec("ROLLBACK");
    db.exec("DROP TABLE codex_commentary_outbox");assert.throws(()=>hasPendingCommentaryIn(db,"saved"),/no such table/);
  });
}));
test("empty content is retained by source; input text and sequence checks are lossless",async()=>storeFixture(async path=>{
  await running(path);assert.equal((await state.stageCommentary(path,"target","turn"," \u0085"))?.text,"");
  await assert.rejects(state.stageCommentary(path,"target","turn","\uD800"),TypeError);
  await assert.rejects(state.hasPendingCommentary(path,"saved",1 as unknown as bigint),TypeError);
  await assert.rejects(state.completeCommentary(path,1n<<63n),TypeError);
}));
