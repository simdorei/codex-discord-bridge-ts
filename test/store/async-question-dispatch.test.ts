import assert from "node:assert/strict";
import {test} from "node:test";
import {storeFixture} from "../helpers/store-fixture.ts";
import {queueJob} from "../helpers/queue-job.ts";
import {usingInitializedStore} from "../../src/store/owned-scope.ts";
import {StateAccessFacade as state} from "../../src/store/state-access-facade.ts";
import {selectJob} from "../../src/store/queue-read.ts";
import type {AsyncQuestionDispatchClaim} from "../../src/store/async-question-dispatch.ts";
const claim=(extra:Partial<AsyncQuestionDispatchClaim>={}):AsyncQuestionDispatchClaim=>({id:"q",runtime_id:"runtime",generation:1n,channel:1n,actor:2n,message:"message",option:0n,mode:"Steer",baseline_turn_ids:[],prompt:"answer",now:10,...extra});
async function seed(path:string,running=true){
 if(running){await state.enqueue(path,queueJob({ownerUserId:2n}));const c=(await state.tryBeginAttempt(path,"saved",[],1n))!;await state.markRunningIfClaimed(path,c,"turn");}
 await usingInitializedStore(path,db=>{db.exec("INSERT INTO mirror_threads(codex_thread_id,project_key,thread_title,discord_channel_id,discord_thread_id,updated_at) VALUES('target','project','title',10,1,0)");db.prepare("INSERT INTO cdr_async_questions(id,runtime_id,generation,thread_id,turn_id,item_id,origin_job_id,channel_id,owner_user_id,body,state,message_id,owner_confirmed,created_at,updated_at) VALUES('q','runtime',1,'target','turn','item','saved',1,2,?,'open','message',1,0,0)").run('{"index":0,"title":"title","options":["yes","no"]}');});
}
const exec=(path:string,sql:string)=>usingInitializedStore(path,db=>{db.exec(sql);});
const job=(path:string,id:string)=>usingInitializedStore(path,db=>selectJob(db,id));
test("steer claim seals original ownership, confirms exact turn once, and cannot be replayed",async()=>storeFixture(async path=>{
 await seed(path);const q=await state.beginAsyncQuestionDispatch(path,claim());assert.equal(q.state,'dispatching');assert.equal(q.replyJobId,null);assert.equal(q.chosen,0n);
 await assert.rejects(state.beginAsyncQuestionDispatch(path,claim()),/no new answer sent/);await state.confirmAsyncQuestionDispatch(path,'q','turn');assert.equal((await state.getAsyncQuestion(path,'q')).state,'submitted');await assert.rejects(state.confirmAsyncQuestionDispatch(path,'q','turn'),/not awaiting confirmation/);
}));
test("actor/message/channel/generation/option mismatch and closed question never claim",async()=>{
 for(const delta of [{actor:3n},{channel:3n},{generation:2n},{runtime_id:'other'},{message:'other'},{option:2n}])await storeFixture(async path=>{await seed(path);await assert.rejects(state.beginAsyncQuestionDispatch(path,claim(delta)),/does not match/);assert.equal((await state.getAsyncQuestion(path,'q')).state,'open');});
});
test("start reserves an exact quarantined reply job until a different accepted turn is confirmed",async()=>storeFixture(async path=>{
 await seed(path,false);const q=await state.beginAsyncQuestionDispatch(path,claim({mode:'Start',baseline_turn_ids:['turn','older']}));assert.equal(q.replyJobId,'async-question:q');const reserved=await job(path,q.replyJobId!);assert.equal(reserved.state,'Quarantined');assert.deepEqual(reserved.baselineTurnIds,['turn','older']);assert.equal(reserved.queued,false);assert.equal(reserved.ackSent,true);
 await assert.rejects(state.confirmAsyncQuestionDispatch(path,'q','turn'),/original turn identity/);assert.equal((await job(path,q.replyJobId!)).state,'Quarantined');await state.confirmAsyncQuestionDispatch(path,'q','next');assert.equal((await job(path,q.replyJobId!)).turnId,'next');assert.equal((await job(path,q.replyJobId!)).state,'Running');assert.equal((await state.getAsyncQuestion(path,'q')).state,'submitted');
}));
test("start rejects incomplete/duplicate/blank baseline and any pending original work",async()=>{
 for(const baseline of [[],['other'],['turn','turn'],['turn','\u0085']])await storeFixture(async path=>{await seed(path,false);await assert.rejects(state.beginAsyncQuestionDispatch(path,claim({mode:'Start',baseline_turn_ids:baseline})),/complete, unique/);assert.equal((await state.getAsyncQuestion(path,'q')).state,'open');});
 await storeFixture(async path=>{await seed(path,false);await state.enqueue(path,queueJob({ownerUserId:2n}));await assert.rejects(state.beginAsyncQuestionDispatch(path,claim({mode:'Start',baseline_turn_ids:['turn']})),/still pending/);});
});
test("steer allows later pending work but not a different original owner or turn",async()=>storeFixture(async path=>{
 await seed(path);await state.enqueue(path,queueJob({jobId:'pending',ownerUserId:2n}));await exec(path,"UPDATE codex_turn_queue SET turn_id='other' WHERE job_id='saved'");await assert.rejects(state.beginAsyncQuestionDispatch(path,claim()),/exact original running job/);await exec(path,"UPDATE codex_turn_queue SET turn_id='turn' WHERE job_id='saved'");await state.beginAsyncQuestionDispatch(path,claim());assert.equal((await state.getAsyncQuestion(path,'q')).state,'dispatching');
}));
test("all durable jobs decode before target filter; unrelated malformed row blocks claim",async()=>storeFixture(async path=>{
 await seed(path);await state.enqueue(path,queueJob({jobId:'unrelated',targetThreadId:'elsewhere'}));await exec(path,"UPDATE codex_turn_queue SET state='quarantined' WHERE job_id='unrelated'");await assert.rejects(state.beginAsyncQuestionDispatch(path,claim()),/invalid durable queue state/);assert.equal((await state.getAsyncQuestion(path,'q')).state,'open');
}));
test("failed sealing rolls back both new reply reservation and dispatching state",async()=>storeFixture(async path=>{
 await seed(path,false);await exec(path,"CREATE TRIGGER no_seal BEFORE UPDATE OF preparation_json ON cdr_async_questions BEGIN SELECT RAISE(ABORT,'seal denied'); END");await assert.rejects(state.beginAsyncQuestionDispatch(path,claim({mode:'Start',baseline_turn_ids:['turn']})),/seal denied/);assert.equal((await state.getAsyncQuestion(path,'q')).state,'open');await assert.rejects(job(path,'async-question:q'),/not found/);
}));
test("post-claim custody drift refuses confirmation and definite rejection without deleting reservation",async()=>storeFixture(async path=>{
 await seed(path,false);await state.beginAsyncQuestionDispatch(path,claim({mode:'Start',baseline_turn_ids:['turn']}));await exec(path,"UPDATE codex_turn_queue SET prompt='changed'");await assert.rejects(state.confirmAsyncQuestionDispatch(path,'q','next'),/identity changed/);await assert.rejects(state.rejectDefiniteAsyncQuestion(path,'q','rejected'),/identity changed/);assert.equal((await job(path,'async-question:q')).state,'Quarantined');assert.equal((await state.getAsyncQuestion(path,'q')).state,'dispatching');
}));
test("unknown-error recording retains dispatching and quarantine; definite rejection removes only exact reservation",async()=>storeFixture(async path=>{
 await seed(path,false);await state.beginAsyncQuestionDispatch(path,claim({mode:'Start',baseline_turn_ids:['turn']}));await state.recordAsyncQuestionError(path,'q','😀'.repeat(1001));let q=await state.getAsyncQuestion(path,'q');assert.equal(q.state,'dispatching');assert.equal(Array.from(q.error).length,1000);assert.equal((await job(path,'async-question:q')).state,'Quarantined');
 await state.rejectDefiniteAsyncQuestion(path,'q','authoritative rejection');q=await state.getAsyncQuestion(path,'q');assert.equal(q.state,'rejected');await assert.rejects(job(path,'async-question:q'),/not found/);await assert.rejects(state.beginAsyncQuestionDispatch(path,claim()),/no new answer sent/);
}));
test("usage-limit rejection preserves original steer job and does not create policy or Reserve",async()=>storeFixture(async path=>{
 await seed(path);await state.beginAsyncQuestionDispatch(path,claim());await state.rejectUsageLimitAsyncQuestion(path,'q','limit');assert.equal((await job(path,'saved')).state,'Running');assert.equal((await state.getAsyncQuestion(path,'q')).state,'rejected');await usingInitializedStore(path,db=>{assert.equal(db.prepare('SELECT count(*) AS n FROM cdr_async_recovery_policies').get()?.n,0);});
}));
test("steer different/blank turn refuses without settling original and error storage handles absent ID",async()=>storeFixture(async path=>{
 await seed(path);await state.beginAsyncQuestionDispatch(path,claim());await assert.rejects(state.confirmAsyncQuestionDispatch(path,'q','other'),/different turn/);await assert.rejects(state.confirmAsyncQuestionDispatch(path,'q','\u0085'),/not awaiting confirmation/);assert.equal((await state.getAsyncQuestion(path,'q')).state,'dispatching');await state.recordAsyncQuestionError(path,'missing','ignored');
}));
test("claim input captured before open; mapped archive fence rejects before queue mutation",async()=>storeFixture(async path=>{
 await seed(path);await exec(path,"INSERT INTO codex_archive_fences(target_thread_id,operation_id,phase) VALUES('target','archive','attempted')");await assert.rejects(state.beginAsyncQuestionDispatch(path,claim()),/fenced/);await exec(path,'DELETE FROM codex_archive_fences');const c=claim();const pending=state.beginAsyncQuestionDispatch(path,c);(c as {actor:bigint}).actor=999n;const q=await pending;assert.equal(q.ownerUserId,2n);
}));
