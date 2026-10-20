import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {existsSync} from 'node:fs';
import {storeFixture} from '../helpers/store-fixture.ts';import {openInitialized} from '../../src/store/owned-driver.ts';
import {getPromptIntakeExisting as get,listPromptIntakesExisting as list,promptIntakeHasDurableOwnerExisting as owner,tryClaimPromptIntakeExisting as claim,renewPromptIntakeClaimExisting as renew,listPromptIntakes,InvalidPromptIntakeLeaseError} from '../../src/store/prompt-intake.ts';
async function seed(path:string,extra=''){const db=await openInitialized(path);try{db.exec("INSERT INTO codex_prompt_intakes(job_id,target_thread_id,channel_id,raw_prompt,auto_queue_when_busy,require_current_mirror,created_at,updated_at) VALUES ('id','target',9007199254740993,'한국어😀',0,0,1,1)");if(extra)db.exec(extra);}finally{db.close();}}
function edit<T>(path:string,run:(db:DatabaseSync)=>T):T{const db=new DatabaseSync(path);try{return run(db);}finally{db.close();}}
test('existing intake reads and leases never create a missing database',async()=>storeFixture(async path=>{
 for(const run of [()=>get(path,'id'),()=>list(path),()=>owner(path,'id'),()=>claim(path,'id',1,2),()=>renew(path,'id','token',1,2)]){assert.throws(run);assert.equal(existsSync(path),false);}
}));
test('existing intake catalog refusal does not repair missing index or mutate lease',async()=>storeFixture(async path=>{
 await seed(path,"DROP INDEX codex_prompt_intakes_target_ready");
 for(const run of [()=>get(path,'id'),()=>list(path),()=>owner(path,'id'),()=>claim(path,'id',1,2),()=>renew(path,'id','token',1,2)])assert.throws(run);
 edit(path,db=>{assert.equal(db.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='codex_prompt_intakes_target_ready'").get()!.n,0);assert.equal(db.prepare('SELECT claim_token FROM codex_prompt_intakes').get()!.claim_token,null);db.exec('BEGIN IMMEDIATE;ROLLBACK');});
}));
test('claim and renewal rollback their entire mutation when stored row decode fails',async()=>{
 for(const mode of ['claim','renew'])await storeFixture(async path=>{await seed(path);const first=mode==='renew'?claim(path,'id',1,10):null;edit(path,db=>db.exec("CREATE TRIGGER corrupt_lease AFTER UPDATE OF claim_expires_at ON codex_prompt_intakes BEGIN UPDATE codex_prompt_intakes SET raw_prompt=CAST(X'80' AS TEXT) WHERE job_id=NEW.job_id; END"));assert.throws(()=>mode==='claim'?claim(path,'id',1,10):renew(path,'id',first!.claimToken,2,20));edit(path,db=>{const row=db.prepare('SELECT raw_prompt,claim_token,claim_expires_at FROM codex_prompt_intakes').get()!;assert.equal(row.raw_prompt,'한국어😀');assert.equal(row.claim_token,first?.claimToken??null);assert.equal(row.claim_expires_at,first?10:0);db.exec('BEGIN IMMEDIATE;ROLLBACK');});});
});
test('existing leases preserve dead-target hold, exact expiry and token/extension comparison',async()=>storeFixture(async path=>{
 await seed(path,"INSERT INTO codex_dead_generation_holds VALUES ('target','runtime',1,0)");assert.equal(claim(path,'id',1,10),null);edit(path,db=>db.exec('DELETE FROM codex_dead_generation_holds'));const first=claim(path,'id',1,10)!;assert.ok(first);assert.equal(renew(path,'id','wrong',2,20),null);assert.equal(renew(path,'id',first.claimToken,2,10),null);assert.equal(renew(path,'id',first.claimToken,10,20),null);const next=claim(path,'id',10,20)!;assert.notEqual(next.claimToken,first.claimToken);assert.equal(renew(path,'id',first.claimToken,11,30),null);assert.equal(renew(path,'id',next.claimToken,11,30)?.intake.claimExpiresAt,30);
}));
test('existing readiness preserves original nonfinite numeric query semantics and equal-time ordering',async()=>storeFixture(async path=>{
 await seed(path,"INSERT INTO codex_prompt_intakes(job_id,target_thread_id,channel_id,raw_prompt,auto_queue_when_busy,require_current_mirror,created_at,updated_at,retry_after,claim_expires_at) VALUES ('a','other',2,'second',0,0,1,1,2,3)");
 assert.deepEqual(list(path).map(x=>x.jobId),['a','id']);for(const now of [NaN,Infinity,-Infinity,0,2,3])assert.deepEqual(list(path,now),await listPromptIntakes(path,now));assert.equal(get(path,'id')?.channelId,9007199254740993n);
}));
test('input validation is prior to missing-file access and does not impose nonempty IDs',async()=>storeFixture(async path=>{
 for(const text of ['\ud800','\udfff']){assert.throws(()=>get(path,text),TypeError);assert.throws(()=>owner(path,text),TypeError);assert.throws(()=>claim(path,text,1,2),TypeError);assert.throws(()=>renew(path,'id',text,1,2),TypeError);}for(const [now,end]of [[1,1],[NaN,2],[1,Infinity]]){assert.throws(()=>claim(path,'id',now!,end!),InvalidPromptIntakeLeaseError);assert.throws(()=>renew(path,'id','token',now!,end!),InvalidPromptIntakeLeaseError);}assert.equal(existsSync(path),false);await seed(path);assert.equal(get(path,''),null);assert.equal(claim(path,'',1,2),null);assert.equal(renew(path,'','',1,2),null);
}));
