import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {existsSync} from 'node:fs';
import {storeFixture} from '../helpers/store-fixture.ts';import {openInitialized} from '../../src/store/owned-driver.ts';
import {admitPromptIntakeExisting as admit,canonicalizePromptIntakeTargetExisting as canonical,PromptIntakeIdentityConflictError,InvalidPromptIntakeIdentityError,type NewPromptIntake} from '../../src/store/prompt-intake-write.ts';
import {getPromptIntakeExisting as get} from '../../src/store/prompt-intake.ts';import {ensureForkHandoffTable} from '../../src/store/fork-handoff-admission.ts';import {ForkHandoffCycleError} from '../../src/store/fork-canonical-target.ts';import {DeadGenerationTargetHeldError} from '../../src/store/fork-completed-target.ts';import {SystemTimeError} from '../../src/store/queue-mark-running.ts';
const input=(patch:Partial<NewPromptIntake>={}):NewPromptIntake=>({jobId:'job',targetThreadId:'source',channelId:1n,ownerUserId:2n,discordMessageId:3n,rawPrompt:'raw',autoQueueWhenBusy:true,requireCurrentMirror:false,createdAt:1,...patch});
async function init(path:string){const db=await openInitialized(path);db.close();}
function edit<T>(path:string,fn:(db:DatabaseSync)=>T):T{const db=new DatabaseSync(path);try{return fn(db);}finally{db.close();}}
function fork(db:DatabaseSync,source:string,target:string){ensureForkHandoffTable(db);db.prepare(`INSERT INTO codex_thread_fork_handoffs(handoff_id,source_thread_id,expected_generation,discord_channel_id,discord_thread_id,quarantine_reason,observed_target_thread_id,target_thread_id,completed_generation,created_at,completed_at) VALUES(?,?,1,1,2,'reason',?,?,2,0,1)`).run(source,source,target,target);}
test('existing admission preserves message dedupe and refuses crossed job/message identities',async()=>storeFixture(async path=>{
 await init(path);const first=admit(path,input());assert.equal(first.created,true);assert.equal(admit(path,input()).created,false);const duplicate=admit(path,input({jobId:'other',rawPrompt:'ignored',ownerUserId:9n,createdAt:99}));assert.equal(duplicate.created,false);assert.deepEqual(duplicate.intake,first.intake);assert.equal(get(path,'other'),null);
 admit(path,input({jobId:'second',discordMessageId:4n}));assert.throws(()=>admit(path,input({discordMessageId:4n})),PromptIntakeIdentityConflictError);assert.deepEqual(get(path,'job'),first.intake);
}));
test('invalid identities and passive fields fail before missing-file creation',async()=>storeFixture(async path=>{
 for(const patch of [{jobId:''},{targetThreadId:' source'},{jobId:'\u0085job'}])assert.throws(()=>admit(path,input(patch)),InvalidPromptIntakeIdentityError);let hooks=0;const value=Object.defineProperty(input(),'rawPrompt',{get(){hooks++;return 'bad';}});assert.throws(()=>admit(path,value),TypeError);assert.equal(hooks,0);assert.equal(existsSync(path),false);assert.throws(()=>admit(path,input()));assert.throws(()=>canonical(path,'job'));assert.equal(existsSync(path),false);
}));
test('existing admission retains original fork auxiliary creation and canonical target traversal',async()=>storeFixture(async path=>{
 await init(path);edit(path,db=>db.exec('DROP TABLE IF EXISTS codex_thread_fork_handoffs'));assert.equal(admit(path,input()).intake.targetThreadId,'source');assert.ok(edit(path,db=>db.prepare("SELECT name FROM sqlite_schema WHERE name='codex_thread_fork_handoffs'").get()));
 edit(path,db=>{fork(db,'source','middle');fork(db,'middle','final');});const row=admit(path,input({jobId:'next',discordMessageId:4n}));assert.equal(row.intake.targetThreadId,'final');assert.equal(canonical(path,'job')?.targetThreadId,'final');
}));
test('retired routing checks original target, while live fork traversal detects intermediate holds and cycles',async()=>storeFixture(async path=>{
 await init(path);edit(path,db=>{fork(db,'source','middle');db.exec("INSERT INTO codex_dead_generation_holds VALUES('middle','runtime',1,0)");});assert.throws(()=>admit(path,input()),DeadGenerationTargetHeldError);assert.equal(get(path,'job'),null);
 edit(path,db=>db.exec('CREATE TABLE codex_exact_thread_routing(enabled INTEGER)'));assert.equal(admit(path,input()).intake.targetThreadId,'source');edit(path,db=>{db.exec('DROP TABLE codex_exact_thread_routing;DELETE FROM codex_dead_generation_holds');fork(db,'middle','source');});assert.throws(()=>canonical(path,'job'),ForkHandoffCycleError);assert.equal(get(path,'job')?.targetThreadId,'source');
}));
test('canonicalization samples clock only on changed target and rolls back negative clock',async t=>storeFixture(async path=>{
 await init(path);admit(path,input());let calls=0,clock=-1;t.mock.method(Date,'now',()=>{calls++;return clock;});assert.equal(canonical(path,'missing'),null);assert.equal(canonical(path,'job')?.updatedAt,1);assert.equal(calls,0);edit(path,db=>fork(db,'source','new'));assert.throws(()=>canonical(path,'job'),SystemTimeError);assert.equal(calls,1);assert.equal(get(path,'job')?.targetThreadId,'source');
 clock=1234.5;assert.equal(canonical(path,'job')?.updatedAt,1.2345);assert.equal(calls,2);assert.equal(canonical(path,'job')?.updatedAt,1.2345);assert.equal(calls,2);
}));
test('post-update corrupt decode rolls back canonical movement and original row bytes',async()=>storeFixture(async path=>{
 await init(path);admit(path,input());edit(path,db=>{fork(db,'source','new');db.exec("CREATE TRIGGER poison AFTER UPDATE OF target_thread_id ON codex_prompt_intakes BEGIN UPDATE codex_prompt_intakes SET raw_prompt=CAST(X'80' AS TEXT) WHERE job_id=NEW.job_id;END");});assert.throws(()=>canonical(path,'job'),/Invalid text encoding/);const row=get(path,'job');assert.equal(row?.targetThreadId,'source');assert.equal(row?.rawPrompt,'raw');assert.equal(row?.updatedAt,1);
}));
test('stop-held or mismatched original ingress cannot acquire prompt ownership',async()=>storeFixture(async path=>{
 await init(path);edit(path,db=>db.exec(`INSERT INTO discord_ingress_journal(ingress_id,kind,event_id,channel_id,owner_user_id,payload_json,state,phase,target_thread_id,outcome_json,created_at,updated_at) VALUES('i','action',3,1,2,'{}','executing','processing','source','{"stop_hold":null}',0,0)`));assert.throws(()=>admit(path,input()));assert.equal(get(path,'job'),null);assert.equal(edit(path,db=>db.prepare("SELECT owner_id FROM discord_ingress_journal WHERE ingress_id='i'").get()?.owner_id),null);
 edit(path,db=>db.exec("UPDATE discord_ingress_journal SET outcome_json=NULL,owner_user_id=9"));assert.throws(()=>admit(path,input()),/handoff identity changed/);assert.equal(get(path,'job'),null);
}));
test('missing required catalog fails without schema repair or intake mutation',async()=>storeFixture(async path=>{
 await init(path);edit(path,db=>db.exec('DROP INDEX codex_prompt_intakes_message_id'));assert.throws(()=>admit(path,input()));assert.throws(()=>canonical(path,'job'));assert.equal(edit(path,db=>db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='codex_prompt_intakes_message_id'").get()?.n),0);assert.equal(edit(path,db=>db.prepare('SELECT count(*) AS n FROM codex_prompt_intakes').get()?.n),0);
}));
