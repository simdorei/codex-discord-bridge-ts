import test from 'node:test';import assert from 'node:assert/strict';import {existsSync,readFileSync} from 'node:fs';
import {storeFixture} from '../../helpers/store-fixture.ts';import {queueJob} from '../../helpers/queue-job.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';import {enqueue} from '../../../src/store/queue-enqueue.ts';
import {userOriginMarker} from '../../../src/store/mirror-origin.ts';import {collectSessionItems} from '../../../src/runtime/session-mirror/collect.ts';
import {MirrorOwnershipPendingError} from '../../../src/runtime/session-mirror/ownership.ts';
import {observeCurrentMirrorOwner as read,mirrorOwnershipReaderBusy,MirrorOwnershipReadError} from '../../../src/runtime/session-mirror/ownership-reader.ts';
import {OwnedWorkerBusyError} from '../../../src/runtime/owned-worker-slot.ts';
const limits={maxJobs:32n,maxValueBytes:1048576n,timeoutMs:5000};
const item=(turn:string|null='turn',kind='agent_message',text='prompt')=>collectSessionItems('target',[{type:'event_msg',payload:{type:kind,message:text}}],'Send',turn).items[0]!;
async function edit(path:string,sql:string){const db=await openInitialized(path);try{db.exec(sql)}finally{db.close()}}
test('native ownership refresh observes updates without changing store bytes',async()=>storeFixture(async path=>{
 await enqueue(path,queueJob());const before=readFileSync(path);
 assert.equal(await read(path,'target',item(),limits),false);assert.deepEqual(readFileSync(path),before);
 await edit(path,"UPDATE codex_turn_queue SET state='running',turn_id='turn'");
 assert.equal(await read(path,'target',item(),limits),true);assert.equal(await read(path,'other',item(),limits),false);
}));
test('Starting, observed completion and goal-waiting retain the cursor',async()=>storeFixture(async path=>{
 await enqueue(path,queueJob());await edit(path,"UPDATE codex_turn_queue SET state='starting'");
 await assert.rejects(read(path,'target',item('other'),limits),MirrorOwnershipPendingError);
 await edit(path,"UPDATE codex_turn_queue SET state='running',turn_id='turn',goal_waiting=1");
 await assert.rejects(read(path,'target',item('other'),limits),MirrorOwnershipPendingError);
 await edit(path,"UPDATE codex_turn_queue SET goal_waiting=0; INSERT INTO codex_observed_completions(thread_id,turn_id,generation,payload) VALUES('target','turn',1,'{}')");
 await assert.rejects(read(path,'target',item('other'),limits),MirrorOwnershipPendingError);
 await edit(path,"DELETE FROM codex_observed_completions");assert.equal(await read(path,'target',item('other'),limits),false);
}));
test('durable user marker remains exact thread turn and text scoped',async()=>storeFixture(async path=>{
 const db=await openInitialized(path);try{db.prepare('INSERT INTO codex_session_mirror_events VALUES(?,?,1)').run(userOriginMarker('target','turn','prompt'),'target')}finally{db.close()}
 assert.equal(await read(path,'target',item('turn','user_message'),limits),true);
 assert.equal(await read(path,'target',item('other','user_message'),limits),false);
 assert.equal(await read(path,'target',item(null,'user_message'),limits),false);
}));
test('only selected target consumes queue budget or decodes corrupt queue JSON',async()=>storeFixture(async path=>{
 await enqueue(path,queueJob({jobId:'other',targetThreadId:'foreign',prompt:'x'.repeat(20000)}));
 await edit(path,"UPDATE codex_turn_queue SET baseline_turn_ids='not json'");
 assert.equal(await read(path,'target',item(),{...limits,maxValueBytes:100n}),false);
 await assert.rejects(read(path,'foreign',item(),limits),MirrorOwnershipReadError);
}));
test('complete selected target over budget fails without returning a prefix',async()=>storeFixture(async path=>{
 await enqueue(path,queueJob());await enqueue(path,queueJob({jobId:'second',discordMessageId:null}));
 await assert.rejects(read(path,'target',item(),{...limits,maxJobs:1n}),/budget/);
 await assert.rejects(read(path,'target',item(),{...limits,maxValueBytes:1n}),/budget/);
}));
test('one native owner refuses overlap and abort waits for actual exit',async()=>storeFixture(async path=>{
 await enqueue(path,queueJob());const controller=new AbortController(),reason=Error('cancel');
 const pending=read(path,'target',item(),limits,controller.signal);
 assert.equal(mirrorOwnershipReaderBusy(),true);
 await assert.rejects(read(path,'target',item(),limits),OwnedWorkerBusyError);
 controller.abort(reason);await assert.rejects(pending,e=>e===reason);assert.equal(mirrorOwnershipReaderBusy(),false);
 assert.equal(await read(path,'target',item(),limits),false);
}));
test('missing store is not created; pre-abort and input getters start no worker',async()=>storeFixture(async path=>{
 let calls=0;const controller=new AbortController(),reason=Error('pre');controller.abort(reason);
 await assert.rejects(read(path,'target',item(),limits,controller.signal),e=>e===reason);
 await assert.rejects(read(path,'target',{...item(),get text(){calls++;return 'x'}},limits),TypeError);
 await assert.rejects(read(path,'target',item(),limits),MirrorOwnershipReadError);
 assert.equal(existsSync(path),false);assert.equal(calls,0);assert.equal(mirrorOwnershipReaderBusy(),false);
}));
test('locked native SQLite read is joined before a cancelled slot can be reused',async()=>storeFixture(async path=>{
 await enqueue(path,queueJob());const db=await openInitialized(path);
 try{
  db.exec('PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE');
  await assert.rejects(read(path,'target',item(),{...limits,timeoutMs:1}));
  assert.equal(mirrorOwnershipReaderBusy(),false);
 }finally{if(db.isTransaction)db.exec('ROLLBACK');db.close()}
 assert.equal(await read(path,'target',item(),limits),false);
}));
test('worker input snapshot cannot be retargeted by mutation after submission',async()=>storeFixture(async path=>{
 await enqueue(path,queueJob());await edit(path,"UPDATE codex_turn_queue SET state='running',turn_id='turn'");
 assert.equal(await read(path,'target',item(),limits),true);
 const value={...item('other')},options={...limits};const pending=read(path,'target',value,options);
 value.turnId='turn';options.maxJobs=0n;assert.equal(await pending,false);
}));
test('observed-running query failure precedes later Starting hold as in source',async()=>storeFixture(async path=>{
 await enqueue(path,queueJob({state:'Running',turnId:'turn'}));await enqueue(path,queueJob({jobId:'starting',state:'Starting',discordMessageId:null}));
 await edit(path,"UPDATE codex_turn_queue SET state='running',turn_id='turn' WHERE job_id='saved'; UPDATE codex_turn_queue SET state='starting' WHERE job_id='starting'; DROP TABLE codex_observed_completions");
 await assert.rejects(read(path,'target',item('other'),limits),e=>e instanceof MirrorOwnershipReadError&&e.message.includes('codex_observed_completions'));
}));
