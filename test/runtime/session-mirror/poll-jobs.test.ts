import test from 'node:test';import assert from 'node:assert/strict';import {join,dirname} from 'node:path';
import {storeFixture} from '../../helpers/store-fixture.ts';import {openInitialized} from '../../../src/store/owned-driver.ts';import {enqueue} from '../../../src/store/queue-enqueue.ts';import {queueJob} from '../../helpers/queue-job.ts';
import {discoverMirrorStore,captureMirrorPollJobs} from '../../../src/runtime/session-mirror/store-discovery.ts';
const limits={maxTargets:32n,maxJobs:32n,maxValueBytes:1048576n,maxOutputBytes:1048576,timeoutMs:5000};
test('native poll projection is target-scoped and cannot be changed by later DB writes',async()=>storeFixture(async path=>{
 await enqueue(path,queueJob());await enqueue(path,queueJob({jobId:'other',targetThreadId:'other',discordMessageId:2n}));
 const snapshot=await discoverMirrorStore(path,limits),target=captureMirrorPollJobs(path,'target',snapshot.jobs);assert.equal(target.length,1);assert.equal(target[0]!.jobId,'saved');assert.ok(Object.isFrozen(target));assert.ok(Object.isFrozen(target[0]));assert.ok(Object.isFrozen(target[0]!.baselineTurnIds));
 const db=await openInitialized(path);try{db.exec('DELETE FROM codex_turn_queue')}finally{db.close()}assert.equal(captureMirrorPollJobs(path,'target',snapshot.jobs).length,1);assert.equal(captureMirrorPollJobs(path,'missing',snapshot.jobs).length,0);
}));
test('copied, projected, forged and proxied jobs cannot impersonate a discovery snapshot',async()=>storeFixture(async path=>{
 const db=await openInitialized(path);db.close();const snapshot=await discoverMirrorStore(path,limits);let calls=0;
 for(const jobs of [[...snapshot.jobs],captureMirrorPollJobs(path,'target',snapshot.jobs),new Proxy(snapshot.jobs,{get(){calls++;throw Error('hook')}})])assert.throws(()=>captureMirrorPollJobs(path,'target',jobs),TypeError);
 assert.equal(calls,0);assert.deepEqual(captureMirrorPollJobs(path,'target',snapshot.jobs),[]);
}));
test('native poll jobs cannot cross database paths even if both stores look identical',async()=>storeFixture(async path=>{
 const db=await openInitialized(path);db.close();const snapshot=await discoverMirrorStore(path,limits);
 assert.throws(()=>captureMirrorPollJobs(join(dirname(path),'other.sqlite'),'target',snapshot.jobs),/different database/);
 assert.throws(()=>captureMirrorPollJobs(path,'x'.repeat(16385),snapshot.jobs),RangeError);
}));
test('failed bounded discovery cannot mint a partial queue snapshot',async()=>storeFixture(async path=>{
 await enqueue(path,queueJob());await enqueue(path,queueJob({jobId:'second',discordMessageId:2n}));await assert.rejects(discoverMirrorStore(path,{...limits,maxJobs:1n}));
 assert.throws(()=>captureMirrorPollJobs(path,'target',[]),TypeError);const snapshot=await discoverMirrorStore(path,limits);assert.equal(captureMirrorPollJobs(path,'target',snapshot.jobs).length,2);
}));
