import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {storeFixture} from '../../helpers/store-fixture.ts';import {queueJob} from '../../helpers/queue-job.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';import {enqueue} from '../../../src/store/queue-enqueue.ts';
import {turnOriginMarker} from '../../../src/store/mirror-event-read.ts';
import {currentMirrorDispositionIn,MirrorOwnershipPendingError} from '../../../src/runtime/session-mirror/ownership.ts';
import {observeCurrentMirrorDisposition as read,observeCurrentMirrorOwner,MirrorOwnershipReadError,mirrorOwnershipReaderBusy} from '../../../src/runtime/session-mirror/ownership-reader.ts';
import {collectSessionItems} from '../../../src/runtime/session-mirror/collect.ts';import {OwnedWorkerBusyError} from '../../../src/runtime/owned-worker-slot.ts';
const limits={maxJobs:32n,maxValueBytes:1048576n,timeoutMs:5000};
const item=(kind='agent_message',turn:string|null='turn')=>collectSessionItems('target',[{type:'event_msg',payload:{type:kind,message:'hello'}}],'Send',turn).items[0]!;
async function edit(path:string,sql:string){const db=await openInitialized(path);try{db.exec(sql)}finally{db.close()}}
test('fresh durable turn marker precedes exact event and remains thread/turn scoped',async()=>storeFixture(async path=>{
 const value=item(),db=await openInitialized(path);try{const insert=db.prepare('INSERT INTO codex_session_mirror_events VALUES(?,?,1)');insert.run(turnOriginMarker('target','turn'),'target');insert.run(value.digest,'target')}finally{db.close()}
 const bytes=readFileSync(path);assert.equal(await read(path,'target',value,limits),'TurnOrigin');assert.deepEqual(readFileSync(path),bytes);
 assert.equal(await read(path,'other',value,limits),'Unclaimed');assert.equal(await read(path,'target',item('agent_message','other'),limits),'Unclaimed');
}));
test('user item does not borrow assistant turn-origin marker but exact recorded event still matches',async()=>storeFixture(async path=>{
 const value=item('user_message'),db=await openInitialized(path);try{db.prepare('INSERT INTO codex_session_mirror_events VALUES(?,?,1)').run(turnOriginMarker('target','turn'),'target')}finally{db.close()}
 assert.equal(await read(path,'target',value,limits),'Unclaimed');
 const next=await openInitialized(path);try{next.prepare('INSERT INTO codex_session_mirror_events VALUES(?,?,1)').run(value.digest,'target')}finally{next.close()}
 assert.equal(await read(path,'target',value,limits),'RecordedEvent');
}));
test('fresh current owner short-circuits missing durable marker table',async()=>storeFixture(async path=>{
 await enqueue(path,queueJob());await edit(path,"UPDATE codex_turn_queue SET state='running',turn_id='turn';DROP TABLE codex_session_mirror_events");
 assert.equal(await read(path,'target',item(),limits),'CurrentOwner');
 await assert.rejects(read(path,'target',item('agent_message','other'),limits),MirrorOwnershipReadError);
}));
test('unresolved ownership masks durable marker success and malformed marker schema',async()=>storeFixture(async path=>{
 await enqueue(path,queueJob());await edit(path,"UPDATE codex_turn_queue SET state='starting';DROP TABLE codex_session_mirror_events;CREATE TABLE codex_session_mirror_events(wrong TEXT)");
 await assert.rejects(read(path,'target',item(),limits),MirrorOwnershipPendingError);
}));
test('borrowed observation preserves caller transaction and sees rollback of marker',async()=>storeFixture(async path=>{
 const db=await openInitialized(path),value=item();try{
  db.exec('BEGIN');db.prepare('INSERT INTO codex_session_mirror_events VALUES(?,?,1)').run(value.digest,'target');
  assert.equal(currentMirrorDispositionIn(db,'target',value,32n,1048576n),'RecordedEvent');assert.equal(db.isTransaction,true);db.exec('ROLLBACK');
  assert.equal(currentMirrorDispositionIn(db,'target',value,32n,1048576n),'Unclaimed');
 }finally{db.close()}
}));
test('new and old observation share one native slot and aborted work joins before reuse',async()=>storeFixture(async path=>{
 const db=await openInitialized(path);db.close();const controller=new AbortController(),reason=Error('cancel'),pending=read(path,'target',item(),limits,controller.signal);
 await assert.rejects(observeCurrentMirrorOwner(path,'target',item(),limits),OwnedWorkerBusyError);
 controller.abort(reason);await assert.rejects(pending,e=>e===reason);assert.equal(mirrorOwnershipReaderBusy(),false);
 assert.equal(await read(path,'target',item(),limits),'Unclaimed');
}));
test('new digest fields are own-data bounded and old boolean API does not acquire that requirement',async()=>storeFixture(async path=>{
 const db=await openInitialized(path);db.close();let calls=0;const value={...item(),get digest():string{calls++;throw Error('hook')}};
 await assert.rejects(read(path,'target',value,limits),TypeError);assert.equal(calls,0);
 assert.equal(await observeCurrentMirrorOwner(path,'target',value,limits),false);assert.equal(calls,0);
 await assert.rejects(read(path,'target',{...item(),digest:'x'.repeat(1025)},limits),RangeError);
}));
