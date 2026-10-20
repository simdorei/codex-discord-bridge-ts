import {it} from 'node:test';import assert from 'node:assert/strict';import {setImmediate as tick} from 'node:timers/promises';
import {BoundedRemoteWorkers,RemoteWorkerCapacityError,RemoteWorkerJoinBusyError} from '../../src/remote-agent/bounded-workers.ts';
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}
it('active cap and pending cap include queued and completed-uncollected tasks',async()=>{
 const p=new BoundedRemoteWorkers<number>(2,3,30),a=deferred<number>(),b=deferred<number>(),c=deferred<number>();let started=0,extra=0;
 p.submit(()=>{started++;return a.promise;},10);p.submit(()=>{started++;return b.promise;},10);p.submit(()=>{started++;return c.promise;},10);await tick();assert.equal(started,2);
 assert.throws(()=>p.submit(async()=>{extra++;return 4;},0),RemoteWorkerCapacityError);
 a.resolve(1);await tick();assert.equal(started,3);assert.deepEqual(p.snapshot(),{active:2,waiting:0,completed:1,pending:3,retainedBytes:30});
 assert.throws(()=>p.submit(async()=>4,0),RemoteWorkerCapacityError);assert.deepEqual(await p.joinNext(),{ok:true,value:1});assert.equal(p.snapshot().pending,2);
 b.resolve(2);c.resolve(3);assert.deepEqual(await p.joinNext(),{ok:true,value:2});assert.deepEqual(await p.joinNext(),{ok:true,value:3});
 assert.equal(await p.joinNext(),null);assert.equal(p.isEmpty(),true);assert.equal(extra,0);assert.equal(p.snapshot().retainedBytes,0);
});
it('declared byte budget remains held until result collection and refusal never executes input',async()=>{
 const p=new BoundedRemoteWorkers<number>(1,3,10);p.submit(async()=>1,8);await tick();assert.throws(()=>p.submit(async()=>2,3),RemoteWorkerCapacityError);assert.equal(p.snapshot().retainedBytes,8);
 await p.joinNext();p.submit(async()=>2,10);assert.deepEqual(await p.joinNext(),{ok:true,value:2});
});
it('completion order follows actual results and raw error identity survives',async()=>{
 const p=new BoundedRemoteWorkers<number>(2,4,100),a=deferred<number>(),error=new Error('original');p.submit(()=>a.promise,1);p.submit(async()=>{throw error;},1);
 assert.deepEqual(await p.joinNext(),{ok:false,error});a.resolve(7);assert.deepEqual(await p.joinNext(),{ok:true,value:7});
});
it('cancelled result wait retains accepted work and a later waiter collects it once',async()=>{
 const p=new BoundedRemoteWorkers<number>(1,1,10),d=deferred<number>(),c=new AbortController(),reason=new Error('stop waiting');p.submit(()=>d.promise,10);
 const pending=p.joinNext(c.signal);await assert.rejects(p.joinNext(),RemoteWorkerJoinBusyError);c.abort(reason);await assert.rejects(pending,e=>e===reason);
 assert.equal(p.snapshot().pending,1);assert.throws(()=>p.submit(async()=>2,0),RemoteWorkerCapacityError);d.resolve(9);assert.deepEqual(await p.joinNext(),{ok:true,value:9});assert.equal(await p.joinNext(),null);
});
it('invalid inputs execute no getter/proxy and synchronous throw is a retained result',async()=>{
 assert.throws(()=>new BoundedRemoteWorkers(0),RangeError);assert.throws(()=>new BoundedRemoteWorkers(4,3),RangeError);
 const p=new BoundedRemoteWorkers<number>();let hooks=0;const proxy=new Proxy(async()=>1,{apply(){hooks++;return Promise.resolve(1);}});
 assert.throws(()=>p.submit(proxy,0),TypeError);assert.throws(()=>p.submit(async()=>1,-1),RangeError);assert.equal(hooks,0);
 const error=new Error('poll failed');p.submit(()=>{throw error;},1);assert.deepEqual(await p.joinNext(),{ok:false,error});
});
