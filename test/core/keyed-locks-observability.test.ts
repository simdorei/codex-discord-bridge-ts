import assert from 'node:assert/strict';
import test from 'node:test';
import {TargetLocks} from '../../src/core/keyed-locks.ts';
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}
const empty={activeTargetCount:0,queuedWaiterCount:0,heldLeaseReferenceCount:0};
test('snapshots are fresh frozen numeric observations isolated by registry',async()=>{
 const locks=new TargetLocks(),other=new TargetLocks(),before=locks.snapshotRetainedWork();
 assert.ok(Object.isFrozen(before));assert.notEqual(before,locks.snapshotRetainedWork());
 assert.deepEqual(Object.values(before),[0,0,0]);assert.throws(()=>Object.assign(before,{activeTargetCount:9}),TypeError);
 const a=locks.tryAcquire('a')!,b=locks.tryAcquire('b')!;
 assert.equal(locks.tryAcquire('a'),undefined);
 assert.deepEqual(locks.snapshotRetainedWork(),{activeTargetCount:2,queuedWaiterCount:0,heldLeaseReferenceCount:2});
 assert.deepEqual(before,empty);assert.deepEqual(other.snapshotRetainedWork(),empty);
 a.release();a.release();b.release();assert.deepEqual(locks.snapshotRetainedWork(),empty);
});
test('actual queued waiter count follows cancellation and FIFO grants exactly',async()=>{
 const locks=new TargetLocks(),first=await locks.acquire('a'),abort=new AbortController(),reason={cancel:true},order:number[]=[];
 const second=locks.acquire('a').then(lease=>{order.push(2);return lease;});
 const cancelled=locks.acquire('a',abort.signal),rejected=assert.rejects(cancelled,e=>e===reason);
 const fourth=locks.acquire('a').then(lease=>{order.push(4);return lease;});
 assert.equal(locks.snapshotRetainedWork().queuedWaiterCount,3);abort.abort(reason);
 assert.deepEqual(locks.snapshotRetainedWork(),{activeTargetCount:1,queuedWaiterCount:2,heldLeaseReferenceCount:1});
 await rejected;first.release();
 assert.deepEqual(locks.snapshotRetainedWork(),{activeTargetCount:1,queuedWaiterCount:1,heldLeaseReferenceCount:1});
 (await second).release();(await fourth).release();assert.deepEqual(order,[2,4]);assert.deepEqual(locks.snapshotRetainedWork(),empty);
 await assert.rejects(locks.acquire('a',abort.signal),e=>e===reason);assert.deepEqual(locks.snapshotRetainedWork(),empty);
});
test('nested pins count unreleased handles and preserve ownership after original release',async()=>{
 const locks=new TargetLocks(),owner=await locks.acquire('a'),gate=deferred(),entered=deferred();
 const pinned=locks.runUnderLease(owner,async borrowed=>{
  assert.equal(locks.snapshotRetainedWork().heldLeaseReferenceCount,2);
  await locks.runUnderLease(borrowed,async nested=>{
   assert.equal(locks.snapshotRetainedWork().heldLeaseReferenceCount,3);owner.release();owner.release();
   assert.equal(locks.snapshotRetainedWork().heldLeaseReferenceCount,2);entered.resolve();await gate.promise;
   nested.requireTarget('a');
  });
  assert.equal(locks.snapshotRetainedWork().heldLeaseReferenceCount,1);
 });
 await entered.promise;const queued=locks.acquire('a');assert.equal(locks.snapshotRetainedWork().queuedWaiterCount,1);
 assert.equal(locks.tryAcquire('a'),undefined);gate.resolve();await pinned;const next=await queued;
 assert.deepEqual(locks.snapshotRetainedWork(),{activeTargetCount:1,queuedWaiterCount:0,heldLeaseReferenceCount:1});
 next.release();assert.deepEqual(locks.snapshotRetainedWork(),empty);
});
for(const cancelledIndex of [0,2])test(`cancelling queued position ${cancelledIndex} preserves surviving FIFO`,async()=>{
 const locks=new TargetLocks(),owner=await locks.acquire('a'),controller=new AbortController(),reason={},order:number[]=[];
 const tasks=[0,1,2].map(index=>locks.acquire('a',index===cancelledIndex?controller.signal:undefined).then(lease=>{order.push(index);lease.release();}));
 const rejected=assert.rejects(tasks[cancelledIndex]!,e=>e===reason);assert.equal(locks.snapshotRetainedWork().queuedWaiterCount,3);
 controller.abort(reason);assert.equal(locks.snapshotRetainedWork().queuedWaiterCount,2);owner.release();
 await rejected;await Promise.all(tasks.filter((_,index)=>index!==cancelledIndex));assert.deepEqual(order,[0,1,2].filter(index=>index!==cancelledIndex));assert.deepEqual(locks.snapshotRetainedWork(),empty);
});
