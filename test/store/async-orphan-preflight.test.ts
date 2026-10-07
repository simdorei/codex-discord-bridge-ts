import assert from "node:assert/strict";
import {test} from "node:test";
import type {DatabaseSync} from "node:sqlite";
import {storeFixture} from "../helpers/store-fixture.ts";
import {historicalQuestionFixture} from "../helpers/async-history-fixture.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {unprovableAsyncOrphansIn} from "../../src/store/async-orphan-preflight.ts";
import {originalHistoricalQuestion,historicalQuestionDecodeFailure} from "../../src/store/async-history-question.ts";
async function fixture(run:(db:DatabaseSync)=>void){await storeFixture(async path=>{const db=await openInitialized(path);try{db.exec("BEGIN");run(db);assert.equal(db.isTransaction,true);db.exec("ROLLBACK");}finally{db.close();}});}
function row(db:DatabaseSync,id="q",thread="target",claim:string|Uint8Array="{}",seal:string|null=null,error=""){db.prepare("INSERT INTO cdr_async_execution_obligations(question_id,thread_id,origin_job_id,turn_id,channel_id,format_version,revision,answer_state,execution_state,admission_state,policy,claim_json,original_seal,original_error,created_at,updated_at) VALUES (?,?,'job','turn',1,1,7,'unresolved','unresolved','held','ordinary',?,?,?,0,0)").run(id,thread,claim,seal,error);}
test("preflight returns only refused input positions and never mutates evidence",async()=>fixture(db=>{
  const valid=historicalQuestionFixture().row;row(db,"q","target",valid.claim,valid.original_seal);row(db,"bad","bad");
  const before=db.prepare("SELECT * FROM cdr_async_execution_obligations ORDER BY question_id").all();
  assert.deepEqual(unprovableAsyncOrphansIn(db,["missing","target","bad"]),[2]);assert.deepEqual(db.prepare("SELECT * FROM cdr_async_execution_obligations ORDER BY question_id").all(),before);
}));
test("known JSON decode failures are negative, including numeric range errors",async()=>fixture(db=>{
  row(db,"a","syntax","not json");row(db,"b","range",'{"n":1e9999}');assert.deepEqual(unprovableAsyncOrphansIn(db,["syntax","range"]),[0,1]);
}));
test("unexpected SQLite text and query errors propagate rather than becoming negative",async()=>fixture(db=>{
  row(db,"q","target",new Uint8Array([255]));assert.throws(()=>unprovableAsyncOrphansIn(db,["target"]),/Expected SQLite TEXT/);
  db.exec("DROP VIEW cdr_async_unsettled_obligations");assert.throws(()=>unprovableAsyncOrphansIn(db,["target"]),/no such table/);
}));
test("129-row overflow probe does not materialize malformed evidence or later targets",async()=>fixture(db=>{
  for(let i=0;i<129;i++)row(db,`q${i}`,"many",new Uint8Array([255]));row(db,"later","later");
  assert.deepEqual(unprovableAsyncOrphansIn(db,["many","later"]),[]);
}));
test("exact 128 rows consume the round budget after one negative target",async()=>fixture(db=>{
  for(let i=0;i<128;i++)row(db,`q${i}`,"many");row(db,"later","later");assert.deepEqual(unprovableAsyncOrphansIn(db,["many","later"]),[0]);
}));
test("over-byte target is skipped before materialization while smaller later target is checked",async()=>fixture(db=>{
  row(db,"huge","huge",new Uint8Array([255]),null,"x".repeat(2*1024*1024));row(db,"later","later");
  assert.deepEqual(unprovableAsyncOrphansIn(db,["huge","later"]),[1]);
}));
test("byte budget is cumulative across materialized targets",async()=>fixture(db=>{
  row(db,"first","first","{}",null,"x".repeat(1100000));row(db,"second","second",new Uint8Array([255]),null,"x".repeat(1100000));
  assert.deepEqual(unprovableAsyncOrphansIn(db,["first","second"]),[0]);
}));
test("JSON classification tracks exact decode origin without changing the thrown error",()=>{
  const valid=historicalQuestionFixture().row;let error:unknown;try{originalHistoricalQuestion({...valid,claim:"bad json"});}catch(e){error=e;}
  assert.ok(error instanceof SyntaxError);assert.equal(historicalQuestionDecodeFailure(error),true);assert.equal(historicalQuestionDecodeFailure(new SyntaxError("fake")),false);
  const external=new SyntaxError("external getter");Object.defineProperty(valid,"claim",{get(){throw external;}});assert.throws(()=>originalHistoricalQuestion(valid),e=>e===external);assert.equal(historicalQuestionDecodeFailure(external),false);
});
