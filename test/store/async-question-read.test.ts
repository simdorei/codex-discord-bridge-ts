import assert from "node:assert/strict";
import {test} from "node:test";
import type {DatabaseSync} from "node:sqlite";
import {storeFixture} from "../helpers/store-fixture.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {readAsyncQuestionIn} from "../../src/store/async-question-read.ts";
async function fixture(run:(db:DatabaseSync)=>void){await storeFixture(async path=>{const db=await openInitialized(path);try{
  db.prepare("INSERT INTO cdr_async_questions(id,runtime_id,generation,thread_id,turn_id,item_id,origin_job_id,channel_id,owner_user_id,body,created_at,updated_at) VALUES ('q','runtime',9007199254740993,'thread','turn','item','job',1,2,?,0,0)").run('{"index":18446744073709551615,"title":"title","options":["yes"]}');run(db);
}finally{db.close();}});}
test("question read preserves large integers, optional nulls and body defaults",async()=>fixture(db=>{
  assert.deepEqual(readAsyncQuestionIn(db,"q"),{id:"q",runtimeId:"runtime",generation:9007199254740993n,threadId:"thread",turnId:"turn",itemId:"item",originJobId:"job",channelId:1n,ownerUserId:2n,body:{index:18446744073709551615n,source_text:"",title:"title",options:["yes"]},state:"observed",messageId:null,chosen:null,replyJobId:null,error:""});
}));
test("chosen uses exact Rust optional u16 boundary",async()=>fixture(db=>{
  for(const chosen of [0,65535]){db.prepare("UPDATE cdr_async_questions SET chosen=?").run(chosen);assert.equal(readAsyncQuestionIn(db,"q").chosen,BigInt(chosen));}
  for(const chosen of [-1,65536]){db.prepare("UPDATE cdr_async_questions SET chosen=?").run(chosen);assert.throws(()=>readAsyncQuestionIn(db,"q"),/u16 range/);}
}));
test("later scalar error wins over earlier body JSON parse and row is not repaired",async()=>fixture(db=>{
  db.exec("UPDATE cdr_async_questions SET body='bad json',chosen=-1");assert.throws(()=>readAsyncQuestionIn(db,"q"),/u16 range/);
  db.exec("UPDATE cdr_async_questions SET chosen=NULL");assert.throws(()=>readAsyncQuestionIn(db,"q"),SyntaxError);assert.equal(db.prepare("SELECT body FROM cdr_async_questions").get()?.body,"bad json");
}));
test("strict Serde body parsing rejects duplicate fields while optional strings stay exact",async()=>fixture(db=>{
  db.exec("UPDATE cdr_async_questions SET message_id='001',reply_job_id='',error='detail'");assert.equal(readAsyncQuestionIn(db,"q").messageId,"001");assert.equal(readAsyncQuestionIn(db,"q").replyJobId,"");
  db.prepare("UPDATE cdr_async_questions SET body=?").run('{"index":0,"index":1,"title":"x","options":[]}');assert.throws(()=>readAsyncQuestionIn(db,"q"),/Duplicate Serde field/);
}));
test("borrowed read leaves transaction unchanged and rejects BLOB text or absence",async()=>fixture(db=>{
  db.exec("BEGIN");readAsyncQuestionIn(db,"q");assert.equal(db.isTransaction,true);db.exec("ROLLBACK");
  db.exec("UPDATE cdr_async_questions SET runtime_id=x'FF'");assert.throws(()=>readAsyncQuestionIn(db,"q"),/Expected string/);assert.throws(()=>readAsyncQuestionIn(db,"missing"),/row not found/);
}));
