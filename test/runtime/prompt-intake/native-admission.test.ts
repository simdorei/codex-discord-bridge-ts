import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {storeFixture} from '../../helpers/store-fixture.ts';import {openInitialized} from '../../../src/store/owned-driver.ts';import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {createNativePromptIntakeState,NativePromptIntakeUnavailableError} from '../../../src/runtime/prompt-intake/native-state.ts';import {OwnedWorkerSlot,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
import {DeadGenerationTargetHeldError} from '../../../src/store/fork-completed-target.ts';import {ensureForkHandoffTable} from '../../../src/store/fork-handoff-admission.ts';import {intakeToWire} from '../../../src/runtime/prompt-intake/native-wire.ts';
const input=()=>({jobId:'job',targetThreadId:'source',channelId:1n,ownerUserId:2n,discordMessageId:3n,rawPrompt:'raw',autoQueueWhenBusy:true,requireCurrentMirror:false,createdAt:1});
async function init(path:string){const db=await openInitialized(path);db.close();}
function edit<T>(path:string,fn:(db:DatabaseSync)=>T):T{const db=new DatabaseSync(path);try{return fn(db);}finally{db.close();}}
function fork(db:DatabaseSync,source:string,target:string){ensureForkHandoffTable(db);db.prepare(`INSERT INTO codex_thread_fork_handoffs(handoff_id,source_thread_id,expected_generation,discord_channel_id,discord_thread_id,quarantine_reason,observed_target_thread_id,target_thread_id,completed_generation,created_at,completed_at) VALUES(?,?,1,1,2,'reason',?,?,2,0,1)`).run(source,source,target,target);}
test('native admission snapshots request and preserves older duplicate-message row',async()=>storeFixture(async path=>{
 await init(path);const native=createNativePromptIntakeState(path),request=input(),pending=native.admitPromptIntake(path,request);request.rawPrompt='changed';request.jobId='changed';const first=await pending;assert.equal(first.created,true);assert.equal(first.intake.jobId,'job');assert.equal(first.intake.rawPrompt,'raw');
 const old=await native.admitPromptIntake(path,{...input(),jobId:'other',rawPrompt:'ignored',ownerUserId:9n});assert.equal(old.created,false);assert.deepEqual(old.intake,first.intake);assert.equal(await state.getPromptIntake(path,'other'),null);assert.equal(ownedWorkerUsage().Control,0);
}));
test('native canonicalization follows original fork and preserves a moved manual-hold refusal',async()=>storeFixture(async path=>{
 await init(path);const native=createNativePromptIntakeState(path);await native.admitPromptIntake(path,input());edit(path,db=>{fork(db,'source','middle');db.exec("INSERT INTO codex_dead_generation_holds VALUES('middle','runtime',1,0)");});
 await assert.rejects(native.canonicalizePromptIntakeTarget(path,'job'),error=>error instanceof DeadGenerationTargetHeldError&&error.targetThreadId==='middle');assert.equal((await state.getPromptIntake(path,'job'))?.targetThreadId,'source');
 await assert.rejects(native.admitPromptIntake(path,{...input(),jobId:'next',discordMessageId:4n}),DeadGenerationTargetHeldError);assert.equal(await state.getPromptIntake(path,'next'),null);edit(path,db=>db.exec('DELETE FROM codex_dead_generation_holds'));assert.equal((await native.canonicalizePromptIntakeTarget(path,'job'))?.targetThreadId,'middle');assert.equal(await native.canonicalizePromptIntakeTarget(path,'absent'),null);
}));
for(const operation of ['admit','canonical'])test(`late native ${operation} cannot acknowledge a committed mutation`,async()=>storeFixture(async path=>{
 await init(path);if(operation==='canonical'){await state.admitPromptIntake(path,input());edit(path,db=>fork(db,'source','new'));}
 const db=new DatabaseSync(path);db.exec('PRAGMA journal_mode=DELETE;BEGIN EXCLUSIVE');const native=createNativePromptIntakeState(path,30),pending=operation==='admit'?native.admitPromptIntake(path,input()):native.canonicalizePromptIntakeTarget(path,'job'),rejected=assert.rejects(pending,NativePromptIntakeUnavailableError);let finished=false;void pending.then(()=>finished=true,()=>finished=true);
 try{await new Promise(r=>setTimeout(r,200));assert.equal(finished,false);assert.equal(ownedWorkerUsage().Control,1);db.exec('ROLLBACK');await rejected;assert.equal(ownedWorkerUsage().Control,0);const row=await state.getPromptIntake(path,'job');assert.equal(row?.targetThreadId,operation==='admit'?'source':'new');}finally{if(db.isTransaction)db.exec('ROLLBACK');await pending.catch(()=>{});db.close();}
}));
test('native admission preserves numeric semantics and fails malformed or unbound responses',async t=>storeFixture(async path=>{
 await init(path);const native=createNativePromptIntakeState(path);const result=await native.admitPromptIntake(path,{...input(),createdAt:Infinity});assert.equal(result.intake.createdAt,Infinity);let raw:unknown;t.mock.method(OwnedWorkerSlot.prototype,'run',async()=>raw);
 raw={ok:true,operation:'Admit',value:{created:true,intake:intakeToWire({...result.intake,ownerUserId:9n})}};await assert.rejects(native.admitPromptIntake(path,input()),NativePromptIntakeUnavailableError);
 raw={ok:true,operation:'Canonicalize',value:intakeToWire({...result.intake,jobId:'other'})};await assert.rejects(native.canonicalizePromptIntakeTarget(path,'job'),NativePromptIntakeUnavailableError);
 raw={ok:false,operation:'Canonicalize',kind:'DeadTargetHeld',id:'other',target:'held'};await assert.rejects(native.canonicalizePromptIntakeTarget(path,'job'),NativePromptIntakeUnavailableError);
}));
test('native admission rejects passive accessors and missing current catalog without creating custody',async()=>storeFixture(async path=>{
 await init(path);const native=createNativePromptIntakeState(path);let hooks=0;const request=Object.defineProperty(input(),'rawPrompt',{get(){hooks++;return 'bad';}});await assert.rejects(native.admitPromptIntake(path,request),TypeError);assert.equal(hooks,0);
 edit(path,db=>db.exec('DROP INDEX codex_prompt_intakes_message_id'));await assert.rejects(native.admitPromptIntake(path,input()),NativePromptIntakeUnavailableError);assert.equal(edit(path,db=>db.prepare('SELECT count(*) AS n FROM codex_prompt_intakes').get()?.n),0);
}));
