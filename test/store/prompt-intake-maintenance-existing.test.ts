import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {existsSync} from 'node:fs';
import {storeFixture} from '../helpers/store-fixture.ts';import {StateAccessFacade as state} from '../../src/store/state-access-facade.ts';
import {releaseAllPromptIntakeClaimsExisting as release,recordPromptIntakeFailureExisting as failure,InvalidPromptIntakeRetryError} from '../../src/store/prompt-intake.ts';
import {removePromptIntakeIfQueuedExisting as remove} from '../../src/store/prompt-intake-write.ts';import {SystemTimeError} from '../../src/store/queue-mark-running.ts';
async function seed(path:string){await state.admitPromptIntake(path,{jobId:'id',targetThreadId:'target',channelId:1n,ownerUserId:2n,discordMessageId:3n,rawPrompt:'raw',autoQueueWhenBusy:true,requireCurrentMirror:false,createdAt:1});return (await state.tryClaimPromptIntake(path,'id',10,20))!;}
function edit<T>(path:string,run:(db:DatabaseSync)=>T):T{const db=new DatabaseSync(path);try{return run(db);}finally{db.close();}}
test('existing startup release preserves retry and manual hold, and is exact/idempotent',async()=>storeFixture(async path=>{
 await seed(path);edit(path,db=>db.exec("UPDATE codex_prompt_intakes SET retry_after=999; INSERT INTO cdr_execution_holds VALUES('id','target','manual','{}',1)"));assert.equal(release(path),1n);assert.equal(release(path),0n);const current=await state.getPromptIntake(path,'id');assert.equal(current?.claimToken,null);assert.equal(current?.claimExpiresAt,0);assert.equal(current?.retryAfter,999);assert.equal(await state.executionHoldReason(path,'id'),'manual');
}));
test('failure records matching token even after expiry and preserves original scalar bound and fork prefix',async()=>storeFixture(async path=>{
 const claim=await seed(path);edit(path,db=>db.exec("UPDATE codex_prompt_intakes SET claim_expires_at=0,attempt_count=9223372036854775807,last_error='[cdr-rust:app-server-fork-unresolved:v1] original'"));const row=failure(path,'id',claim.claimToken,'\u0085'+'😀'.repeat(1001)+' ',30);assert.equal(row?.attemptCount,9223372036854775807n);assert.equal(row?.lastError,'[cdr-rust:app-server-fork-unresolved:v1] original');assert.equal(row?.claimToken,null);assert.equal(row?.retryAfter,30);
}));
test('failure samples its clock once before DB entry and keeps exact millisecond conversion',async t=>storeFixture(async path=>{
 const claim=await seed(path);let clocks=0;t.mock.method(Date,'now',()=>{clocks++;return 1234567;});const row=failure(path,'id',claim.claimToken,'\u0085 '+'😀'.repeat(1001)+' ',30);assert.equal(clocks,1);assert.equal(row?.updatedAt,1234.567);assert.equal(row?.lastError,'😀'.repeat(1000));
}));
test('invalid retry and clock fail before opening a missing database',async t=>storeFixture(async path=>{
 assert.throws(()=>failure(path,'id','token','bad',Infinity),InvalidPromptIntakeRetryError);t.mock.method(Date,'now',()=>-1);assert.throws(()=>failure(path,'id','token','bad',0),SystemTimeError);assert.equal(existsSync(path),false);
}));
test('failure decode errors rollback count/token/error, stale token does not decode a corrupt row',async()=>storeFixture(async path=>{
 const claim=await seed(path);edit(path,db=>db.exec("CREATE TRIGGER corrupt_failure AFTER UPDATE OF last_error ON codex_prompt_intakes BEGIN UPDATE codex_prompt_intakes SET raw_prompt=CAST(X'80' AS TEXT) WHERE job_id=NEW.job_id;END"));assert.throws(()=>failure(path,'id',claim.claimToken,'new error',30));const row=await state.getPromptIntake(path,'id');assert.equal(row?.claimToken,claim.claimToken);assert.equal(row?.attemptCount,0n);assert.equal(row?.rawPrompt,'raw');edit(path,db=>db.exec("UPDATE codex_prompt_intakes SET raw_prompt=CAST(X'80' AS TEXT)"));assert.equal(failure(path,'id','stale','ignored',30),null);
}));
test('remove requires an actual queue/outbox owner and preserves current dead-target hold',async()=>storeFixture(async path=>{
 await seed(path);assert.equal(remove(path,'id'),false);edit(path,db=>db.exec("INSERT INTO codex_delivery_outbox(delivery_id,job_id,target_thread_id,turn_id,channel_id,content,created_at,updated_at) VALUES('delivery','id','target','turn',1,'final',0,0); INSERT INTO codex_dead_generation_holds VALUES('target','runtime',1,0)"));assert.equal(remove(path,'id'),false);edit(path,db=>db.exec('DELETE FROM codex_dead_generation_holds'));assert.equal(remove(path,'id'),true);assert.equal(remove(path,'id'),false);assert.equal(await state.getPromptIntake(path,'id'),null);
}));
test('existing maintenance neither creates missing DB nor repairs a missing catalog index',async()=>storeFixture(async path=>{
 for(const run of [()=>release(path),()=>failure(path,'id','token','bad',0),()=>remove(path,'id')]){assert.throws(run);assert.equal(existsSync(path),false);}const claim=await seed(path);edit(path,db=>db.exec('DROP INDEX codex_prompt_intakes_target_ready'));for(const run of [()=>release(path),()=>failure(path,'id',claim.claimToken,'bad',30),()=>remove(path,'id')])assert.throws(run);edit(path,db=>{assert.equal(db.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='codex_prompt_intakes_target_ready'").get()!.n,0);assert.equal(db.prepare('SELECT claim_token FROM codex_prompt_intakes').get()!.claim_token,claim.claimToken);db.exec('BEGIN IMMEDIATE;ROLLBACK');});
}));
