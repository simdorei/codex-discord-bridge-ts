import test from 'node:test';
import assert from 'node:assert/strict';
import {TargetLocks,MIRROR_SYNC_OPERATION_LOCK} from '../../../src/core/keyed-locks.ts';
import {withMirrorMappingLocks} from '../../../src/runtime/session-mirror/mapping-owner.ts';

const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};

test('a blocked target delivery does not block another target, while mapping writes stay excluded', {timeout:5000},async()=>{
 const locks=new TargetLocks(),entered=deferred(),finish=deferred(),signal=new AbortController().signal;
 const first=withMirrorMappingLocks(locks,'A',signal,async()=>{entered.resolve();await finish.promise;});
 await entered.promise;
 try {
  let delivered=false;
  await withMirrorMappingLocks(locks,'B',signal,async()=>{delivered=true;assert.equal(locks.tryAcquire(MIRROR_SYNC_OPERATION_LOCK),undefined);});
  assert.equal(delivered,true);assert.equal(locks.tryAcquire('A'),undefined);
 }finally{finish.resolve();await first;}
 assert.deepEqual(locks.snapshotRetainedWork(),{activeTargetCount:0,queuedWaiterCount:0,heldLeaseReferenceCount:0});
});

test('queued mapping writer is fair, cancelled readers leave no debt, borrowed readers retain ownership',async()=>{
 const locks=new TargetLocks(),first=await locks.acquireShared('mapping'),borrowed=deferred(),done=deferred(),order:string[]=[];
 const pinned=locks.runUnderLease(first,async()=>{borrowed.resolve();await done.promise;});await borrowed.promise;
 const writer=locks.run('mapping',async()=>{order.push('writer');});
 const cancel=new AbortController(),waiting=locks.acquireShared('mapping',cancel.signal),checked=assert.rejects(waiting,e=>e==='cancel');
 cancel.abort('cancel');await checked;
 const reader=locks.acquireShared('mapping').then(lease=>{order.push('reader');lease.release();});
 first.release();assert.deepEqual(order,[]);assert.equal(locks.tryAcquire('mapping'),undefined);
 done.resolve();await Promise.all([pinned,writer,reader]);assert.deepEqual(order,['writer','reader']);
 assert.deepEqual(locks.snapshotRetainedWork(),{activeTargetCount:0,queuedWaiterCount:0,heldLeaseReferenceCount:0});
});

test('cancelling a mapping writer immediately unblocks independent queued readers',{timeout:5000},async()=>{
 const locks=new TargetLocks(),reader=await locks.acquireShared('mapping'),stop=new AbortController();
 const writer=locks.acquire('mapping',stop.signal),checked=assert.rejects(writer,e=>e==='cancel');
 const other=locks.acquireShared('mapping');stop.abort('cancel');await checked;
 const granted=await other;granted.release();assert.equal(locks.tryAcquire('mapping'),undefined);reader.release();assert.equal(locks.activeTargetCount,0);
});
