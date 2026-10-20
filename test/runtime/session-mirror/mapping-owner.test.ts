import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as sleep} from 'node:timers/promises';
import {TargetLocks} from '../../../src/core/keyed-locks.ts';
import {QueueStartCoordinator} from '../../../src/runtime/queue-runner/start-coordinator.ts';
import {captureMirrorMappingLocks,withMirrorMappingLocks} from '../../../src/runtime/session-mirror/mapping-owner.ts';
import {mirrorQueueFixture} from '../../helpers/mirror-queue-fixture.ts';
import {pinNativeRuntimePath} from '../../../src/runtime/runtime-paths/path-text.ts';

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};}
async function until(condition:()=>boolean){const end=performance.now()+3000;while(!condition()){assert.ok(performance.now()<end,'Expected lock state was not reached');await sleep(1);}}
const path=pinNativeRuntimePath('/synthetic/mirror.sqlite'),global='mirror-sync-operation';

test('mapping capture requires the real queue, original authentic registry, and exact pinned database',()=>{
 const queue=mirrorQueueFixture(path);assert.equal(captureMirrorMappingLocks(queue,path),queue.locks);
 assert.throws(()=>captureMirrorMappingLocks(queue,path+'.other'),/database differs/);
 let hooks=0;const locks=queue.locks,foreign=new TargetLocks();
 for(const candidate of [{locks,dbPath:path,requireTargetLocks(){hooks++;}},Object.create(queue),new Proxy(queue,{get(){hooks++;throw Error('trap');},getOwnPropertyDescriptor(){hooks++;throw Error('trap');}})])assert.throws(()=>captureMirrorMappingLocks(candidate as QueueStartCoordinator,path),TypeError);
 Object.assign(queue,{locks:foreign});assert.throws(()=>captureMirrorMappingLocks(queue,path),/registry differs/);assert.equal(locks.activeTargetCount,0);assert.equal(foreign.activeTargetCount,0);
 const fakeLocks=Object.create(TargetLocks.prototype);const original=mirrorQueueFixture(path),fakeQueue=new QueueStartCoordinator(path,{generation:()=>1n,residentInstanceId:()=>null,activeTurnId:async()=>null,resumeThread:async()=>{},readTurns:async()=>[],startClaimedTurn:async()=>''},{locks:fakeLocks});
 assert.throws(()=>captureMirrorMappingLocks(fakeQueue,path),TypeError);assert.equal(hooks,0);assert.equal(original.locks.activeTargetCount,0);
});

test('target is acquired before global mapping key; waiting cancellation removes only its own leases',async()=>{
 const queue=mirrorQueueFixture(path),locks=captureMirrorMappingLocks(queue,path),target=await locks.acquire('thread'),stop=new AbortController();let calls=0;
 const running=withMirrorMappingLocks(locks,'thread',stop.signal,async()=>{calls++;});const checked=assert.rejects(running,e=>e==='cancel');
 const mapping=locks.tryAcquire(global);assert.ok(mapping,'Waiting target must not hold the global key');
 try{
  target.release();await until(()=>locks.activeTargetCount===2);await sleep(5);assert.equal(calls,0);stop.abort('cancel');await checked;
  assert.equal(locks.activeTargetCount,1);assert.equal(locks.tryAcquire(global),undefined,'Cancellation must not release the existing global owner');
  const after=locks.tryAcquire('thread');assert.ok(after);after.release();assert.equal(calls,0);
 }finally{stop.abort('cancel');mapping.release();target.release();await checked;}
 assert.equal(locks.activeTargetCount,0);
});

test('cancellation while waiting for a fork-owned target leaves its ordered pair intact',async()=>{
 const locks=mirrorQueueFixture(path).locks,entered=deferred(),finish=deferred(),stop=new AbortController();
 const fork=locks.runPair('source','thread',async()=>{entered.resolve();await finish.promise;});await entered.promise;
 let calls=0;const poll=withMirrorMappingLocks(locks,'thread',stop.signal,async()=>{calls++;});const checked=assert.rejects(poll,e=>e==='cancel');
 const mapping=locks.tryAcquire(global);assert.ok(mapping);mapping.release();stop.abort('cancel');await checked;
 assert.equal(calls,0);assert.equal(locks.tryAcquire('source'),undefined);assert.equal(locks.tryAcquire('thread'),undefined);assert.equal(locks.activeTargetCount,2);
 finish.resolve();await fork;assert.equal(locks.activeTargetCount,0);
});

test('joined active work retains both locks after abort and releases them only after cleanup',async()=>{
 const locks=mirrorQueueFixture(path).locks,stop=new AbortController(),entered=deferred(),finish=deferred(),cleanup=deferred();let cleaned=false,settled=false;
 const running=withMirrorMappingLocks(locks,'thread',stop.signal,async()=>{entered.resolve();try{await finish.promise;stop.signal.throwIfAborted();}finally{await cleanup.promise;cleaned=true;}});
 const checked=assert.rejects(running,e=>e==='cancel').then(()=>{settled=true;});await entered.promise;stop.abort('cancel');finish.resolve();await sleep(10);
 assert.equal(cleaned,false);assert.equal(settled,false);assert.equal(locks.tryAcquire('thread'),undefined);assert.equal(locks.tryAcquire(global),undefined);
 cleanup.resolve();await checked;assert.equal(cleaned,true);assert.equal(locks.activeTargetCount,0);
});

test('fork pair and global-only mapping owner can finish ahead of a waiting mirror without inverted lock order',async()=>{
 const locks=mirrorQueueFixture(path).locks,forkEntered=deferred(),finishFork=deferred(),pollEntered=deferred(),finishPoll=deferred(),stop=new AbortController();
 const fork=locks.runPair('source','thread',async()=>{forkEntered.resolve();await finishFork.promise;});await forkEntered.promise;
 const mirror=withMirrorMappingLocks(locks,'thread',stop.signal,async()=>{pollEntered.resolve();await finishPoll.promise;});
 // New/sync/inspection only need this key and can finish while the fork owns its pair.
 let mappingDone=false;await locks.run(global,async()=>{mappingDone=true;});assert.equal(mappingDone,true);
 finishFork.resolve();await fork;await pollEntered.promise;
 const another=locks.runPair('source','thread',async()=>{});let nextDone=false;void another.then(()=>{nextDone=true;});await sleep(5);assert.equal(nextDone,false);
 finishPoll.resolve();await mirror;await another;assert.equal(locks.activeTargetCount,0);
});

test('reserved global key is rejected as a mirror target before any acquisition',async()=>{
 const locks=mirrorQueueFixture(path).locks,stop=new AbortController();let calls=0;
 await assert.rejects(withMirrorMappingLocks(locks,global,stop.signal,async()=>{calls++;}),/Reserved mirror mapping lock key/);
 assert.equal(calls,0);assert.equal(locks.activeTargetCount,0);
});


test('authentic registry subclass cannot replace acquisition with a fabricated lease',async()=>{
 let overrides=0;class ShadowLocks extends TargetLocks{
  override tryAcquire():never{overrides++;throw Error('Virtual tryAcquire must not run');}
  override acquire():never{overrides++;throw Error('Virtual acquire must not run');}
 }
 const locks=new ShadowLocks(),queue=new QueueStartCoordinator(path,{generation:()=>1n,residentInstanceId:()=>null,activeTurnId:async()=>null,resumeThread:async()=>{},readTurns:async()=>[],startClaimedTurn:async()=>''},{locks});
 assert.equal(captureMirrorMappingLocks(queue,path),locks);
 await withMirrorMappingLocks(locks,'thread',new AbortController().signal,async()=>{
  assert.equal(locks.activeTargetCount,2);assert.equal(TargetLocks.prototype.tryAcquire.call(locks,'thread'),undefined);assert.equal(TargetLocks.prototype.tryAcquire.call(locks,global),undefined);
 });assert.equal(overrides,0);assert.equal(locks.activeTargetCount,0);
});
