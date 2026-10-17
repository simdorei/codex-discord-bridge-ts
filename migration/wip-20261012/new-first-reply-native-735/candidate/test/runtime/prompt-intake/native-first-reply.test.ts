import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {existsSync} from 'node:fs';
import {storeFixture} from '../../helpers/store-fixture.ts';import {CheckedRead,openInitialized} from '../../../src/store/owned-driver.ts';import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {getNewFirstReplyFinish,getNewFirstReplyFinishExisting} from '../../../src/store/new-reply-finish.ts';
import {NewThreadJournal} from '../../../src/runtime/action-executor/new-journal.ts';import {NewFirstReply} from '../../../src/runtime/action-executor/new-first-reply.ts';
import {createNativePromptIntakeState,NativePromptIntakeUnavailableError} from '../../../src/runtime/prompt-intake/native-state.ts';
import {OwnedWorkerSlot,OwnedWorkerBudgetError,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';import {serializeSerdeValue as json} from '../../../src/core/serde-json.ts';
function edit<T>(p:string,f:(db:DatabaseSync)=>T):T{const db=new DatabaseSync(p);try{return f(db);}finally{db.close();}}
async function seed(path:string){const journal=new NewThreadJournal(path,()=>1),record=await journal.admit({channelId:99n,userId:20n,discordMessageId:30n,autoQueueWhenBusy:true},'raw');const identity={ingress_id:record.ingressId,job_id:'job',thread_id:'target',cwd:'/work',state_db:'/state.db',channel_id:100n,origin_channel_id:99n,event_id:30n,kind:'action',creation_generation:7n,prompt_sha256:'a'.repeat(64),acknowledgement:'accepted 한국어😀'};
 edit(path,db=>{db.prepare("UPDATE discord_ingress_journal SET owner_kind='prompt',owner_id='job',target_thread_id='target',outcome_json=? WHERE ingress_id=?").run(json({new_creation:{version:1n,cwd:'/work'},new_verification:{thread_id:'target',channel_id:100n,prompt_sha256:'a'.repeat(64)}}),record.ingressId);db.exec("INSERT INTO mirror_threads VALUES('target','/work','title',99,100,1)");db.prepare("INSERT INTO codex_new_first_replies(job_id,ingress_id,identity_json,turn_id,state) VALUES('job',?,?,'turn','verified')").run(record.ingressId,json(identity));});return {journal,record};}
test('finish projection never creates a missing store and missing intent remains null only after successful read',async()=>storeFixture(async path=>{
 const native=createNativePromptIntakeState(path);assert.throws(()=>getNewFirstReplyFinishExisting(path,'i'));await assert.rejects(native.getNewFirstReplyFinish(path,'i'),NativePromptIntakeUnavailableError);assert.equal(existsSync(path),false);const db=await openInitialized(path);db.close();assert.equal(await native.getNewFirstReplyFinish(path,'i'),null);
}));
test('original and existing finish projections fully decode before returning the original accepted acknowledgement',async()=>storeFixture(async path=>{
 const {record}=await seed(path),expected={jobId:'job',turnId:'turn',acknowledgement:'accepted 한국어😀'};assert.deepEqual(await getNewFirstReplyFinish(path,record.ingressId),expected);assert.deepEqual(getNewFirstReplyFinishExisting(path,record.ingressId),expected);assert.deepEqual(await createNativePromptIntakeState(path).getNewFirstReplyFinish(path,record.ingressId),expected);
 edit(path,db=>db.exec("UPDATE codex_new_first_replies SET accepted_at=1e999,scan_json='{\"n\":18446744073709551615}'"));assert.deepEqual(await createNativePromptIntakeState(path).getNewFirstReplyFinish(path,record.ingressId),expected);
}));
test('projection cannot skip malformed unused scan or identity decoding',async()=>{
 for(const column of ['scan_json','identity_json'])await storeFixture(async path=>{const {record}=await seed(path);edit(path,db=>db.exec(`UPDATE codex_new_first_replies SET ${column}='{'`));await assert.rejects(getNewFirstReplyFinish(path,record.ingressId));assert.throws(()=>getNewFirstReplyFinishExisting(path,record.ingressId));await assert.rejects(createNativePromptIntakeState(path).getNewFirstReplyFinish(path,record.ingressId),NativePromptIntakeUnavailableError);});
});
test('second read remains separate and preserves validate_current absent-record semantics',async t=>storeFixture(async path=>{
 const {record}=await seed(path),original=CheckedRead.open;let calls=0;t.mock.method(CheckedRead,'open',function(path:string){calls++;if(calls===2)edit(path,db=>db.exec('DELETE FROM codex_new_first_replies;DELETE FROM mirror_threads'));return original(path);});
 assert.deepEqual(getNewFirstReplyFinishExisting(path,record.ingressId),{jobId:'job',turnId:'turn',acknowledgement:'accepted 한국어😀'});assert.equal(calls,2);
}));
test('actual first-reply finish uses native evidence and never notifies on missing turn or mapping drift',async()=>storeFixture(async path=>{
 const {journal,record}=await seed(path),native=createNativePromptIntakeState(path);let notices=0;const reply=new NewFirstReply(path,'/state.db',journal,true,()=>{notices++;},native.admitPromptIntakeWithIngress,native.getNewFirstReplyFinish),result={text:'ordinary',waitsForFinal:false,ui:null};
 edit(path,db=>db.exec('UPDATE codex_new_first_replies SET turn_id=NULL'));await assert.rejects(reply.finish(record,result),/first turn acceptance is not confirmed/);assert.equal(notices,0);
 edit(path,db=>db.exec("UPDATE codex_new_first_replies SET turn_id='turn'"));assert.deepEqual(await reply.finish(record,result),{text:'accepted 한국어😀',waitsForFinal:true,ui:null});assert.equal(notices,1);
 edit(path,db=>db.exec('DELETE FROM mirror_threads;UPDATE codex_new_first_replies SET turn_id=NULL'));await assert.rejects(reply.finish(record,result),NativePromptIntakeUnavailableError);assert.equal(notices,1);assert.equal(ownedWorkerUsage().Control,0);
}));
test('unmirrored first-reply finish does not invoke a reader',async()=>storeFixture(async path=>{
 const journal=new NewThreadJournal(path,()=>1),record=await journal.admit({channelId:1n,userId:2n,discordMessageId:null,autoQueueWhenBusy:false},'raw');let reads=0;const reply=new NewFirstReply(path,'/state.db',journal,false,()=>assert.fail('no notify'),undefined,async()=>{reads++;throw new Error('not called');});const result={text:'saved',waitsForFinal:false,ui:null};assert.deepEqual(await reply.finish(record,result),result);assert.equal(reads,0);
}));
test('invalid input and crossed projection cannot impersonate the requested first reply',async t=>storeFixture(async path=>{
 assert.throws(()=>getNewFirstReplyFinishExisting(path,'\ud800'),/malformed Unicode/);assert.equal(existsSync(path),false);let raw:unknown;t.mock.method(OwnedWorkerSlot.prototype,'run',async()=>raw);const native=createNativePromptIntakeState(path);
 for(raw of [{ok:true,operation:'FirstReplyFinish',value:{ingress:'other',record:null}},{ok:true,operation:'MirrorTarget',value:{ingress:'i',record:null}},{ok:true,operation:'FirstReplyFinish',value:{ingress:'i',record:{jobId:'job',turnId:0,acknowledgement:'ack'}}},{ok:false}])await assert.rejects(native.getNewFirstReplyFinish(path,'i'),NativePromptIntakeUnavailableError);
}));
test('late first-reply observation joins actual native exit and never authorizes a notification',async()=>storeFixture(async path=>{
 const {record}=await seed(path),db=new DatabaseSync(path);db.exec('PRAGMA journal_mode=DELETE;BEGIN EXCLUSIVE');const native=createNativePromptIntakeState(path,10),pending=native.getNewFirstReplyFinish(path,record.ingressId),rejected=assert.rejects(pending,NativePromptIntakeUnavailableError);let ended=false;void pending.then(()=>{ended=true;},()=>{ended=true;});
 try{await new Promise(r=>setTimeout(r,100));assert.equal(ended,false);assert.equal(ownedWorkerUsage().Control,1);await assert.rejects(native.getPromptIntake(path,'x'),OwnedWorkerBudgetError);db.exec('ROLLBACK');await rejected;assert.equal(ownedWorkerUsage().Control,0);}finally{if(db.isTransaction)db.exec('ROLLBACK');await pending.catch(()=>{});db.close();}
}));
