import assert from 'node:assert/strict';
import {test} from 'node:test';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {NewThreadJournal} from '../../../src/runtime/action-executor/new-journal.ts';
import {NewFirstReply} from '../../../src/runtime/action-executor/new-first-reply.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {serializeSerdeValue as json} from '../../../src/core/serde-json.ts';
const input=()=>({jobId:'job',targetThreadId:'target',channelId:99n,ownerUserId:20n,discordMessageId:30n,rawPrompt:'raw',autoQueueWhenBusy:true,requireCurrentMirror:false,createdAt:5});
async function original(path:string){const journal=new NewThreadJournal(path,()=>1),record=await journal.admit({channelId:99n,userId:20n,discordMessageId:30n,autoQueueWhenBusy:true},'raw');await state.beginIngressThreadStart(path,record.ingressId,7n,2);await state.recordIngressNewCreation(path,record.ingressId,7n,null,99n,3);await state.recordIngressCreatedThread(path,record.ingressId,7n,'target',4);return {journal,record};}
test('headless first prompt atomically owns original ingress without reply seed',async()=>storeFixture(async path=>{
 const {journal,record}=await original(path),reply=new NewFirstReply(path,'/state.db',journal,false,()=>assert.fail('no notify'));const admitted=await reply.admit(input(),record,7n);assert.equal(admitted.intake.jobId,'job');const saved=await state.getIngress(path,record.ingressId);assert.equal(saved?.ownerId,'job');assert.equal((saved?.outcome as {new_reply_seed?:unknown}).new_reply_seed,undefined);
 assert.deepEqual(await reply.finish(record,{text:'accepted',waitsForFinal:true,ui:null}),{text:'accepted',waitsForFinal:true,ui:null});
}));
test('mirrored first prompt saves exact acknowledgement and valid Unicode state path atomically',async()=>storeFixture(async path=>{
 const {journal,record}=await original(path),reply=new NewFirstReply(path,'/한글/😀/state.db',journal,true,()=>{});await reply.admit(input(),record,7n);const saved=await state.getIngress(path,record.ingressId);assert.deepEqual((saved?.outcome as {new_reply_seed:unknown}).new_reply_seed,{acknowledgement:'In progress\nmessage: raw\n새 대화: <#99>',state_db:'/한글/😀/state.db'});
}));
test('wrong original prompt cannot acquire first-prompt custody or seed',async()=>storeFixture(async path=>{
 const {journal,record}=await original(path),reply=new NewFirstReply(path,'/state.db',journal,true,()=>{});await assert.rejects(reply.admit({...input(),rawPrompt:'changed'},record,7n),/prompt identity changed/);assert.equal(await state.getPromptIntake(path,'job'),null);assert.equal((await state.getIngress(path,record.ingressId))?.ownerId,null);
}));
test('missing first-reply intent cannot report acceptance or notify',async()=>storeFixture(async path=>{
 const {journal,record}=await original(path),reply=new NewFirstReply(path,'/state.db',journal,true,()=>assert.fail('no notify'));await assert.rejects(reply.finish(record,{text:'result',waitsForFinal:true,ui:null}),/no durable first-reply intent/);await state.validateNewReplyCurrent(path,'missing');
}));
test('original reply identity and accepted turn are both required before delivery notification',async()=>storeFixture(async path=>{
 const {journal,record}=await original(path);let notified=0;const reply=new NewFirstReply(path,'/state.db',journal,true,()=>{notified++;});await reply.admit(input(),record,7n);
 // This fixture supplies the independently verified first-turn record; this test does not claim scan/promotion integration.
 const identity={ingress_id:record.ingressId,job_id:'job',thread_id:'target',cwd:'/work',state_db:'/state.db',channel_id:100n,origin_channel_id:99n,event_id:30n,kind:'action',creation_generation:7n,prompt_sha256:'a'.repeat(64),acknowledgement:'accepted'};
 const db=await openInitialized(path);try{db.prepare("UPDATE discord_ingress_journal SET outcome_json=? WHERE ingress_id=?").run(json({new_creation:{version:1n,cwd:'/work'},new_verification:{thread_id:'target',channel_id:100n,prompt_sha256:'a'.repeat(64)}}),record.ingressId);db.exec("INSERT INTO mirror_threads VALUES ('target','/work','title',99,100,1)");db.prepare("INSERT INTO codex_new_first_replies(job_id,ingress_id,identity_json,turn_id,state) VALUES ('job',?,?,NULL,'verified')").run(record.ingressId,json(identity));}finally{db.close();}
 await assert.rejects(reply.finish(record,{text:'queued',waitsForFinal:true,ui:null}),/first turn acceptance is not confirmed/);assert.equal(notified,0);
 const edit=await openInitialized(path);try{edit.exec("UPDATE codex_new_first_replies SET turn_id='turn'");}finally{edit.close();}
 assert.deepEqual(await reply.finish(record,{text:'ordinary',waitsForFinal:false,ui:null}),{text:'accepted',waitsForFinal:true,ui:null});assert.equal(notified,1);
 const drift=await openInitialized(path);try{drift.exec('DELETE FROM mirror_threads');}finally{drift.close();}
 await assert.rejects(reply.finish(record,{text:'ordinary',waitsForFinal:false,ui:null}),/evidence or original room mapping changed/);assert.equal(notified,1);
}));
