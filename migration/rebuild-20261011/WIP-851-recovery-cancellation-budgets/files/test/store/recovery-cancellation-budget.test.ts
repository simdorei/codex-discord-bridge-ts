import test from 'node:test';
import assert from 'node:assert/strict';
import type {DatabaseSync} from 'node:sqlite';
import {storeFixture} from '../helpers/store-fixture.ts';
import {queueJob} from '../helpers/queue-job.ts';
import {openInitialized} from '../../src/store/owned-driver.ts';
import {StateAccessFacade as state} from '../../src/store/state-access-facade.ts';
import {currentStopRevisionIn} from '../../src/store/stop-revision-read.ts';
async function edit(path:string,body:(db:DatabaseSync)=>void){const db=await openInitialized(path);try{body(db);}finally{db.close();}}
const cancel=(path:string)=>state.cancelForRecoveryExisting(path,'target',1n,2n,10,()=>undefined);
async function unchanged(path:string){await edit(path,db=>{assert.equal(db.prepare('SELECT count(*) AS n FROM codex_request_cancellations').get()?.n,0);assert.equal(db.prepare('SELECT count(*) AS n FROM cdr_execution_holds').get()?.n,0);assert.equal(currentStopRevisionIn(db),0n);});}
for(const field of ['prompt','last_error','baseline_turn_ids'])test('queue '+field+' oversized evidence refuses without cancellation',()=>storeFixture(async path=>{
 await state.enqueue(path,queueJob({jobId:'job',ownerUserId:2n,createdAt:1}));
 await edit(path,db=>db.prepare('UPDATE codex_turn_queue SET '+field+'=?').run(field==='baseline_turn_ids'?JSON.stringify(['x'.repeat(1048576)]):'x'.repeat(1048577)));
 assert.throws(()=>cancel(path),/byte budget/);await unchanged(path);
}));
test('malformed numeric BLOB refuses before eager conversion',()=>storeFixture(async path=>{
 await state.enqueue(path,queueJob({jobId:'job',ownerUserId:2n,createdAt:1}));
 await edit(path,db=>db.prepare('UPDATE codex_turn_queue SET attempt_count=?').run(new Uint8Array(1048577)));
 assert.throws(()=>cancel(path),/byte budget/);await unchanged(path);
}));
test('intake prompt rejects oversized evidence',()=>storeFixture(async path=>{
 await edit(path,db=>db.prepare("INSERT INTO codex_prompt_intakes(job_id,target_thread_id,channel_id,owner_user_id,raw_prompt,auto_queue_when_busy,require_current_mirror,created_at,updated_at) VALUES ('intake','target',1,2,?,1,0,1,1)").run('x'.repeat(1048577)));
 assert.throws(()=>cancel(path),/byte budget/);await unchanged(path);
}));
test('cumulative evidence budget refuses many individually bounded requests',()=>storeFixture(async path=>{
 await edit(path,db=>{const q=db.prepare("INSERT INTO codex_prompt_intakes(job_id,target_thread_id,channel_id,owner_user_id,raw_prompt,auto_queue_when_busy,require_current_mirror,created_at,updated_at) VALUES (?,'target',1,2,?,1,0,1,1)");for(let i=0;i<10;i++)q.run('intake-'+i,'x'.repeat(900000));});
 assert.throws(()=>cancel(path),/byte budget/);await unchanged(path);
}));
test('unowned ingress oversized prompt refuses before original parsing',()=>storeFixture(async path=>{
 await state.admitIngress(path,{ingressId:'original',kind:'message',eventId:3n,applicationId:null,channelId:1n,ownerUserId:2n,sourceMessageId:null,payload:{version:1n,plan:{Execute:{Ask:{prompt:'hello'}}}},targetThreadId:'target',canonicalOwner:null,now:1});
 await edit(path,db=>db.prepare("UPDATE discord_ingress_journal SET payload_json=?").run(JSON.stringify({version:1,plan:{Execute:{Ask:{prompt:'x'.repeat(1048577)}}}})));
 assert.throws(()=>cancel(path),/byte budget/);await unchanged(path);
}));
test('small evidence remains cancellable and large unrelated target is not inspected',()=>storeFixture(async path=>{
 await state.enqueue(path,queueJob({jobId:'job',ownerUserId:2n,createdAt:1}));
 await edit(path,db=>db.prepare("INSERT INTO codex_prompt_intakes(job_id,target_thread_id,channel_id,owner_user_id,raw_prompt,auto_queue_when_busy,require_current_mirror,created_at,updated_at) VALUES ('foreign','elsewhere',1,2,?,1,0,1,1)").run('x'.repeat(1048577)));
 assert.deepEqual(cancel(path),{jobs:['job'],startedOrUncertain:0});
 await edit(path,db=>assert.equal(db.prepare("SELECT count(*) AS n FROM codex_prompt_intakes WHERE job_id='foreign'").get()?.n,1));
}));
test('oversized owned ingress evidence is bounded before owner decoding',()=>storeFixture(async path=>{
 await state.enqueue(path,queueJob({jobId:'job',ownerUserId:2n,createdAt:1}));
 await state.admitIngress(path,{ingressId:'original',kind:'message',eventId:3n,applicationId:null,channelId:1n,ownerUserId:2n,sourceMessageId:null,payload:{version:1n},targetThreadId:'target',canonicalOwner:null,now:1});
 await edit(path,db=>db.prepare("UPDATE discord_ingress_journal SET state='owned',owner_kind='prompt',owner_id='job',payload_json=?").run(JSON.stringify({version:1,padding:'x'.repeat(1048577)})));
 assert.throws(()=>cancel(path),/byte budget/);await unchanged(path);
}));
test('trigger enlarging the next request is rechecked and all earlier writes roll back',()=>storeFixture(async path=>{
 await state.enqueue(path,queueJob({jobId:'job',ownerUserId:2n,createdAt:1}));
 await edit(path,db=>db.exec("INSERT INTO codex_prompt_intakes(job_id,target_thread_id,channel_id,owner_user_id,raw_prompt,auto_queue_when_busy,require_current_mirror,created_at,updated_at) VALUES ('intake','target',1,2,'small',1,0,1,1); CREATE TRIGGER enlarge_next AFTER INSERT ON cdr_execution_holds BEGIN UPDATE codex_prompt_intakes SET raw_prompt=CAST(zeroblob(1048577) AS TEXT); END"));
 assert.throws(()=>cancel(path),/byte budget/);await unchanged(path);
 await edit(path,db=>{assert.equal(db.prepare("SELECT raw_prompt FROM codex_prompt_intakes").get()?.raw_prompt,'small');assert.equal(db.prepare('SELECT count(*) AS n FROM codex_turn_queue').get()?.n,1);});
}));
