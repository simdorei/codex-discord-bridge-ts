import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {storeFixture} from '../helpers/store-fixture.ts';
import {queueJob} from '../helpers/queue-job.ts';
import {StateAccessFacade as state} from '../../src/store/state-access-facade.ts';
import {usingInitializedStore} from '../../src/store/owned-scope.ts';
import * as claims from '../../src/store/queue-claims.ts';
import * as preflight from '../../src/store/queue-preflight-failure.ts';
import {EXECUTION_HOLD_PREFIX} from '../../src/store/execution-hold.ts';
async function seed(path:string){await state.enqueue(path,queueJob({ownerUserId:2n}));}
async function pair(run:(a:string,b:string)=>Promise<void>){await storeFixture(async a=>storeFixture(async b=>{await seed(a);await seed(b);await run(a,b);}));}
async function rows(path:string){return state.listFiltered(path,null,null);}
test('existing attempt claim preserves exact Pending CAS, baseline order and saturated counter',async t=>pair(async(a,b)=>{
 for(const path of [a,b])await usingInitializedStore(path,db=>db.exec('UPDATE codex_turn_queue SET attempt_count=9223372036854775807'));
 t.mock.method(Date,'now',()=>1234000);const one=await claims.tryBeginAttempt(a,'saved',['z','a','z'],1n),two=claims.tryBeginAttemptExisting(b,'saved',['z','a','z'],1n);assert.deepEqual(two,one);assert.equal(two?.attemptCount,9223372036854775807n);assert.deepEqual(two?.baselineTurnIds,['z','a','z']);assert.equal(two?.state,'Starting');assert.equal(claims.tryBeginAttemptExisting(b,'saved',[],1n),null);assert.deepEqual(await rows(b),await rows(a));
}));
test('existing failure preserves ambiguity, trim scalar bound and original raw prefix hold/notice decision',async t=>{
 for(const ambiguous of [false,true])for(const error of [EXECUTION_HOLD_PREFIX+'held','\u0085'+EXECUTION_HOLD_PREFIX+'held','😀'.repeat(1001)])await pair(async(a,b)=>{
  t.mock.method(Date,'now',()=>1234000);const ca=(await claims.tryBeginAttempt(a,'saved',[],1n))!,cb=claims.tryBeginAttemptExisting(b,'saved',[],1n)!;assert.deepEqual(claims.recordStartFailureIfClaimedExisting(b,cb,error,ambiguous),await claims.recordStartFailureIfClaimed(a,ca,error,ambiguous));assert.deepEqual(await state.pendingStartNotices(b),await state.pendingStartNotices(a));assert.equal(await state.executionHoldReason(b,'saved'),await state.executionHoldReason(a,'saved'));assert.deepEqual(await rows(b),await rows(a));
 });
});
test('existing Running transition preserves full claim and optional resident path',async t=>{
 for(const resident of [null,'resident-a'])await pair(async(a,b)=>{
  t.mock.method(Date,'now',()=>1234000);const ca=(await claims.tryBeginAttempt(a,'saved',['old'],1n))!,cb=claims.tryBeginAttemptExisting(b,'saved',['old'],1n)!;assert.deepEqual(claims.markRunningWithResidentIfClaimedExisting(b,cb,'turn',resident),await claims.markRunningWithResidentIfClaimed(a,ca,'turn',resident));assert.deepEqual(await rows(b),await rows(a));assert.equal(claims.markRunningWithResidentIfClaimedExisting(b,cb,'another',resident),null);
 });
});
test('existing start failure and Running both refuse a stale baseline claim without mutation',async t=>pair(async(a,b)=>{
 t.mock.method(Date,'now',()=>1234000);const ca=(await claims.tryBeginAttempt(a,'saved',['old'],1n))!,cb=claims.tryBeginAttemptExisting(b,'saved',['old'],1n)!;for(const path of [a,b])await usingInitializedStore(path,db=>db.exec("UPDATE codex_turn_queue SET baseline_turn_ids='[\"changed\"]'"));const before=await rows(b);assert.equal(await claims.recordStartFailureIfClaimed(a,ca,'fail',false),null);assert.equal(claims.recordStartFailureIfClaimedExisting(b,cb,'fail',false),null);assert.equal(await claims.markRunningWithResidentIfClaimed(a,ca,'turn',null),null);assert.equal(claims.markRunningWithResidentIfClaimedExisting(b,cb,'turn',null),null);assert.deepEqual(await rows(b),before);
}));
test('existing claim rolls back an update when the full returned row fails strict decoding',async()=>storeFixture(async path=>{
 await seed(path);const before=await rows(path);await usingInitializedStore(path,db=>db.exec("CREATE TRIGGER corrupt_claim AFTER UPDATE ON codex_turn_queue WHEN NEW.state='starting' BEGIN UPDATE codex_turn_queue SET baseline_turn_ids='invalid-json' WHERE job_id=NEW.job_id; END"));assert.throws(()=>claims.tryBeginAttemptExisting(path,'saved',[],1n));assert.deepEqual(await rows(path),before);
}));
test('existing preflight counter and trim then scalar1000 match initialized original including no-match null',async t=>pair(async(a,b)=>{
 t.mock.method(Date,'now',()=>1234000);const error='\u0085'+'😀'.repeat(1000)+' trailing\u0085';assert.deepEqual(preflight.recordPreflightFailureExisting(b,'saved',1n,error),await preflight.recordPreflightFailure(a,'saved',1n,error));assert.equal((await rows(b))[0]!.lastError,'😀'.repeat(1000));assert.equal(preflight.recordPreflightFailureExisting(b,'saved',-1n,'wrong-generation'),null);assert.deepEqual(await rows(b),await rows(a));
}));
test('existing preflight decode failure rolls back counter/error while keeping original row',async()=>storeFixture(async path=>{
 await seed(path);const before=await rows(path);await usingInitializedStore(path,db=>db.exec("CREATE TRIGGER corrupt_preflight AFTER UPDATE ON codex_turn_queue BEGIN UPDATE codex_turn_queue SET baseline_turn_ids='invalid-json' WHERE job_id=NEW.job_id; END"));assert.throws(()=>preflight.recordPreflightFailureExisting(path,'saved',1n,'new'));assert.deepEqual(await rows(path),before);
}));
test('all existing attempt writers refuse missing store without creating one',async()=>storeFixture(async path=>{
 const claim=queueJob({state:'Starting'});for(const call of [()=>claims.tryBeginAttemptExisting(path,'saved',[],1n),()=>claims.recordStartFailureIfClaimedExisting(path,claim,'error',false),()=>claims.markRunningWithResidentIfClaimedExisting(path,claim,'turn',null),()=>preflight.recordPreflightFailureExisting(path,'saved',1n,'error')]){assert.throws(call);assert.equal(existsSync(path),false);}
}));
