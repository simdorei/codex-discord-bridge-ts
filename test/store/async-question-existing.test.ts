import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {getAsyncQuestionExisting,requireCurrentAsyncQuestionMappingExisting} from '../../src/store/async-question-delivery-state.ts';
import {beginAsyncQuestionDispatchExisting,confirmAsyncQuestionDispatchExisting,rejectDefiniteAsyncQuestionExisting,rejectUsageLimitAsyncQuestionExisting,recordAsyncQuestionErrorExisting} from '../../src/store/async-question-dispatch.ts';
import {validateAsyncDispatchGuardsExisting} from '../../src/store/async-question-guard.ts';
import {nativeAsyncFixture,questionId,edit,row} from '../helpers/native-async-choice-fixture.ts';
const claim=(q:ReturnType<typeof getAsyncQuestionExisting>,mode:'Start'|'Steer'='Steer')=>({id:q.id,runtime_id:q.runtimeId,generation:q.generation,channel:q.channelId,actor:q.ownerUserId,message:'9',option:0n,mode,baseline_turn_ids:mode==='Start'?['v']:[],prompt:'answer 😀',now:10});
test('existing-only Begin seal failure rolls back both Start reservation and dispatching row',async()=>nativeAsyncFixture({},async f=>{
 const q=getAsyncQuestionExisting(f.database,questionId);edit(f.database,"CREATE TRIGGER refuse_seal BEFORE UPDATE OF preparation_json ON cdr_async_questions BEGIN SELECT RAISE(ABORT,'seal refusal'); END");assert.throws(()=>beginAsyncQuestionDispatchExisting(f.database,claim(q,'Start'),q));assert.equal(row(f.database)!.state,'open');assert.equal(row(f.database)!.chosen,null);assert.equal(row(f.database,'SELECT COUNT(*) AS n FROM codex_turn_queue')!.n,0);
}));
test('existing-only occurrence check is inside Begin transaction; current row never replaces captured authority',async()=>nativeAsyncFixture({active:'v'},async f=>{
 const q=getAsyncQuestionExisting(f.database,questionId);edit(f.database,"UPDATE cdr_async_questions SET item_id='different'");assert.throws(()=>beginAsyncQuestionDispatchExisting(f.database,claim(q),q),/occurrence changed/);assert.equal(row(f.database)!.state,'open');
}));
test('existing guard rolls back read transaction and confirmed accepted turn must match original sealed identity',async()=>nativeAsyncFixture({active:'v'},async f=>{
 const q=getAsyncQuestionExisting(f.database,questionId);requireCurrentAsyncQuestionMappingExisting(f.database,q);beginAsyncQuestionDispatchExisting(f.database,claim(q),q);validateAsyncDispatchGuardsExisting(f.database,'t');assert.throws(()=>confirmAsyncQuestionDispatchExisting(f.database,questionId,'wrong',q),/different turn/);assert.equal(row(f.database)!.state,'dispatching');confirmAsyncQuestionDispatchExisting(f.database,questionId,'v',q);assert.equal(row(f.database)!.state,'submitted');assert.equal(row(f.database)!.accepted_turn_id,'v');const db=new DatabaseSync(f.database);try{db.exec('BEGIN IMMEDIATE');db.exec('ROLLBACK');}finally{db.close();}
}));
test('existing definite usage rejection is exact alias, deletes only reserved Start job and never Reserve',async()=>nativeAsyncFixture({},async f=>{
 assert.strictEqual(rejectUsageLimitAsyncQuestionExisting,rejectDefiniteAsyncQuestionExisting);const q=getAsyncQuestionExisting(f.database,questionId);beginAsyncQuestionDispatchExisting(f.database,claim(q,'Start'),q);rejectUsageLimitAsyncQuestionExisting(f.database,questionId,'rejected',q);assert.equal(row(f.database)!.state,'rejected');assert.equal(row(f.database,'SELECT COUNT(*) AS n FROM codex_turn_queue')!.n,0);
}));
test('existing Error keeps source scalar autocommit and bounds Unicode scalar length at 1000',async()=>nativeAsyncFixture({active:'v'},async f=>{
 recordAsyncQuestionErrorExisting(f.database,questionId,'😀'.repeat(1001));assert.equal(String(row(f.database)!.error),'😀'.repeat(1000));assert.equal(row(f.database)!.state,'open');
}));
