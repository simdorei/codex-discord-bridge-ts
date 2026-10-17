import assert from "node:assert/strict";
import {test} from "node:test";
import {storeFixture} from "../helpers/store-fixture.ts";
import {usingInitializedStore} from "../../src/store/owned-scope.ts";
import {StateAccessFacade as state} from "../../src/store/state-access-facade.ts";
const body='{"index":0,"source_text":"context","title":"question","options":["yes"]}';
const tombstone='{"index":0,"title":"","options":[]}';
async function seed(path:string){await usingInitializedStore(path,db=>{
  const insert=db.prepare("INSERT INTO cdr_async_questions(id,runtime_id,generation,thread_id,turn_id,item_id,origin_job_id,channel_id,owner_user_id,body,state,created_at,updated_at) VALUES(?,'old',1,'thread','turn',?,'job',1,2,?,?,0,0)");
  for(const phase of ['observed','open','dispatching','submitted','rejected','closed_unknown','unsupported','expired'])insert.run(phase,phase,body,phase);
  db.prepare("INSERT INTO cdr_async_question_inbox(id,runtime_id,generation,thread_id,turn_id,item_id,candidate_job_id,candidate_channel_id,candidate_owner_id,body,state,created_at) VALUES('inbox','old',1,'thread','turn','item','job',1,2,?,'waiting',0)").run(body);
});}
const rows=(path:string)=>usingInitializedStore(path,db=>db.prepare('SELECT id,state,body,error,updated_at FROM cdr_async_questions ORDER BY id').all());
test("owner change expires only observed/open and waiting inbox, never dispatched or terminal identity",async()=>storeFixture(async path=>{
  await seed(path);assert.equal(await state.retireOldAsyncQuestionOwner(path,'new',2n),2n);
  for(const r of await rows(path)){assert.equal(r.state,['observed','open'].includes(String(r.id))?'expired':r.id);assert.equal(r.body,body);}
  await usingInitializedStore(path,db=>{assert.equal(db.prepare('SELECT state FROM cdr_async_question_inbox').get()?.state,'expired');});
  assert.equal(await state.retireOldAsyncQuestionOwner(path,'new',2n),0n);
}));
test("same owner/generation is stable and either changed dimension expires selectable state",async()=>{
  for(const [runtime,gen,expected] of [['old',1n,0n],['old',2n,2n],['new',1n,2n]] as const)await storeFixture(async path=>{await seed(path);assert.equal(await state.retireOldAsyncQuestionOwner(path,runtime,gen),expected);});
});
test("supersede is exact runtime/generation/thread scope and excludes current turn",async()=>storeFixture(async path=>{
  await seed(path);for(const args of [['old',1n,'thread','turn'],['new',1n,'thread','next'],['old',2n,'thread','next'],['old',1n,'other','next']] as const)assert.equal(await state.supersedeAsyncQuestions(path,args[0],args[1],args[2],args[3]),0n);
  assert.equal(await state.supersedeAsyncQuestions(path,'old',1n,'thread','next'),2n);
  assert.equal((await rows(path)).find(r=>r.id==='dispatching')!.state,'dispatching');
}));
test("terminal compaction uses strict cutoff, retains IDs and excludes all unresolved states",async()=>storeFixture(async path=>{
  await seed(path);await usingInitializedStore(path,db=>{db.exec("UPDATE cdr_async_question_inbox SET state='expired'");});
  assert.equal(await state.compactTerminalAsyncQuestions(path,30*86400),0n);
  assert.equal(await state.compactTerminalAsyncQuestions(path,30*86400+1),5n);
  for(const r of await rows(path))assert.equal(r.body,['submitted','rejected','closed_unknown','unsupported','expired'].includes(String(r.id))?tombstone:body);
  assert.equal(await state.compactTerminalAsyncQuestions(path,30*86400+1),0n);
  await usingInitializedStore(path,db=>{assert.equal(db.prepare('SELECT body FROM cdr_async_question_inbox').get()?.body,tombstone);assert.equal(db.prepare('SELECT count(*) AS n FROM cdr_async_questions').get()?.n,8);});
}));
test("first retention update remains committed if the separately opened second update fails",async()=>storeFixture(async path=>{
  await seed(path);await usingInitializedStore(path,db=>{db.exec("CREATE TRIGGER fail_retire BEFORE UPDATE ON cdr_async_questions BEGIN SELECT RAISE(ABORT,'retain failure'); END");});
  await assert.rejects(state.retireOldAsyncQuestionOwner(path,'new',2n),/retain failure/);
  await usingInitializedStore(path,db=>{assert.equal(db.prepare('SELECT state FROM cdr_async_question_inbox').get()?.state,'expired');});
  assert.equal((await rows(path)).find(r=>r.id==='open')!.state,'open');
}));
test("compaction also preserves first update on second failure and rejects invalid clock before opening",async()=>storeFixture(async path=>{
  await seed(path);await usingInitializedStore(path,db=>{db.exec("UPDATE cdr_async_question_inbox SET state='expired';CREATE TRIGGER fail_compact BEFORE UPDATE ON cdr_async_questions BEGIN SELECT RAISE(ABORT,'compact failure'); END");});
  await assert.rejects(state.compactTerminalAsyncQuestions(path,30*86400+1),/compact failure/);
  await usingInitializedStore(path,db=>{assert.equal(db.prepare('SELECT body FROM cdr_async_question_inbox').get()?.body,tombstone);});
  for(const value of [NaN,Infinity,-Infinity])await assert.rejects(state.compactTerminalAsyncQuestions(path,value),/invalid retention clock/);
}));
