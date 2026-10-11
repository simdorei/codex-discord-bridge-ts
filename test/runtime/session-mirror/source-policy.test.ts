import test from 'node:test';import assert from 'node:assert/strict';
import {storeFixture} from '../../helpers/store-fixture.ts';import {openInitialized} from '../../../src/store/owned-driver.ts';import {enqueue} from '../../../src/store/queue-enqueue.ts';import {queueJob} from '../../helpers/queue-job.ts';
import {discoverMirrorStore} from '../../../src/runtime/session-mirror/store-discovery.ts';
import {observeSourceMirrorDisposition as observe} from '../../../src/runtime/session-mirror/ownership-reader.ts';import {MirrorOwnershipPendingError} from '../../../src/runtime/session-mirror/ownership.ts';
import {collectSessionItems} from '../../../src/runtime/session-mirror/collect.ts';import {turnOriginMarker} from '../../../src/store/mirror-event-read.ts';
const discovery={maxTargets:32n,maxJobs:32n,maxValueBytes:1048576n,maxOutputBytes:1048576,timeoutMs:5000},limits={maxJobs:32n,maxValueBytes:1048576n,timeoutMs:5000};
const item=(kind='agent_message',text='hello')=>collectSessionItems('target',[{type:'event_msg',payload:{type:kind,message:text}}],'Send','turn').items[0]!;
async function edit(path:string,sql:string){const db=await openInitialized(path);try{db.exec(sql)}finally{db.close()}}
test('fresh native ownership precedes historical snapshot and returns current owner',async()=>storeFixture(async path=>{
 await enqueue(path,queueJob());const snapshot=await discoverMirrorStore(path,discovery);await edit(path,"UPDATE codex_turn_queue SET state='running',turn_id='turn';DROP TABLE codex_session_mirror_events");
 assert.equal(await observe(path,'target',item(),limits,snapshot.jobs),'CurrentOwner');
}));
test('historical active owner suppresses marker reads but cannot be mistaken for current owner',async()=>storeFixture(async path=>{
 await enqueue(path,queueJob());await edit(path,"UPDATE codex_turn_queue SET state='running',turn_id='turn'");const snapshot=await discoverMirrorStore(path,discovery);await edit(path,'DELETE FROM codex_turn_queue;DROP TABLE codex_session_mirror_events');
 assert.equal(await observe(path,'target',item(),limits,snapshot.jobs),'HistoricalOwner');
}));
test('fresh pending state masks historical ownership and durable marker eligibility',async()=>storeFixture(async path=>{
 await enqueue(path,queueJob());await edit(path,"UPDATE codex_turn_queue SET state='running',turn_id='turn'");const snapshot=await discoverMirrorStore(path,discovery);await edit(path,"UPDATE codex_turn_queue SET state='starting';DROP TABLE codex_session_mirror_events");
 await assert.rejects(observe(path,'target',item(),limits,snapshot.jobs),MirrorOwnershipPendingError);
}));
test('historical prompt match and durable marker tail preserve source order',async()=>storeFixture(async path=>{
 await enqueue(path,queueJob({prompt:'hello'}));await edit(path,"UPDATE codex_turn_queue SET turn_id='turn'");const snapshot=await discoverMirrorStore(path,discovery);await edit(path,'DELETE FROM codex_turn_queue');
 assert.equal(await observe(path,'target',item('user_message'),limits,snapshot.jobs),'HistoricalOwner');
 const db=await openInitialized(path);try{db.prepare('INSERT INTO codex_session_mirror_events VALUES(?,?,1)').run(turnOriginMarker('target','turn'),'target')}finally{db.close()}
 assert.equal(await observe(path,'target',item(),limits,snapshot.jobs),'TurnOrigin');
}));
test('copied historical jobs are refused before native submission and absence stays unclaimed',async()=>storeFixture(async path=>{
 const db=await openInitialized(path);db.close();const snapshot=await discoverMirrorStore(path,discovery);
 await assert.rejects(observe(path,'target',item(),limits,[...snapshot.jobs]),TypeError);assert.equal(await observe(path,'target',item(),limits,snapshot.jobs),'Unclaimed');
}));
