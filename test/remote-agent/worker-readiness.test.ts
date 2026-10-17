import {it} from 'node:test';import assert from 'node:assert/strict';import {setImmediate as tick} from 'node:timers/promises';
import {BoundedRemoteWorkers,RemoteWorkerCapacityError,RemoteWorkerJoinBusyError} from '../../src/remote-agent/bounded-workers.ts';
import {RemoteConnectionWorkers,RemoteConnectionClosedError} from '../../src/remote-agent/connection-workers.ts';
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}
it('ready observation retains both result and byte capacity until the owning branch takes it',async()=>{
 const pool=new BoundedRemoteWorkers<number>(1,1,10);pool.submit(async()=>7,10);assert.equal(await pool.waitReady(),true);
 assert.deepEqual(pool.snapshot(),{active:0,waiting:0,completed:1,pending:1,retainedBytes:10});assert.throws(()=>pool.submit(async()=>8,0),RemoteWorkerCapacityError);
 assert.equal(await pool.waitReady(),true);assert.deepEqual(pool.takeReady(),{ok:true,value:7});assert.equal(pool.takeReady(),null);assert.equal(await pool.waitReady(),false);assert.equal(pool.snapshot().retainedBytes,0);
});
it('unselected failed result survives a competing EOF branch and becomes drain failure',async()=>{
 const workers=new RemoteConnectionWorkers<number>(1n),sentinel=new Error('unselected failed worker');workers.submit(async()=>{throw sentinel;},4);
 assert.equal(await workers.waitReady(),true);await tick();assert.equal(workers.snapshot().pending,1);
 const outcome=await workers.close();assert.equal(outcome.ok,false);if(!outcome.ok)assert.equal(outcome.error,sentinel);assert.equal(workers.snapshot().pending,0);
});
it('close joins a pending readiness observer before collecting accepted operations',async()=>{
 const workers=new RemoteConnectionWorkers<number>(1n),gate=deferred<number>();workers.submit(()=>gate.promise,4);const ready=workers.waitReady(),closing=workers.close();let closed=false;void closing.then(()=>{closed=true;});await tick();assert.equal(closed,false);gate.resolve(5);assert.equal(await ready,true);assert.deepEqual(await closing,{ok:true});assert.equal(workers.snapshot().pending,0);
 await assert.rejects(workers.waitReady(),RemoteConnectionClosedError);assert.throws(()=>workers.takeReady(),RemoteConnectionClosedError);
});
it('cancelled readiness wait does not release work and the original reason is preserved',async()=>{
 const pool=new BoundedRemoteWorkers<number>(1,1,1),gate=deferred<number>(),controller=new AbortController(),reason=new Error('stop observing');pool.submit(()=>gate.promise,1);
 const ready=pool.waitReady(controller.signal);controller.abort(reason);await assert.rejects(ready,e=>e===reason);assert.equal(pool.snapshot().pending,1);gate.resolve(9);assert.equal(await pool.waitReady(),true);assert.deepEqual(pool.takeReady(),{ok:true,value:9});
});
it('concurrent observers and consuming collectors cannot operate while one wait is active',async()=>{
 const workers=new RemoteConnectionWorkers<number>(1n),gate=deferred<number>();workers.submit(()=>gate.promise,1);const ready=workers.waitReady();
 await assert.rejects(workers.waitReady(),RemoteWorkerJoinBusyError);await assert.rejects(workers.joinNext(),RemoteWorkerJoinBusyError);assert.throws(()=>workers.takeReady(),RemoteWorkerJoinBusyError);
 gate.resolve(1);await ready;assert.deepEqual(workers.takeReady(),{ok:true,value:1});assert.deepEqual(await workers.close(),{ok:true});
});
it('original connection error still wins over an unselected ready worker failure',async()=>{
 const workers=new RemoteConnectionWorkers<number>(1n),job=new Error('job'),connection=new Error('connection');workers.submit(async()=>{throw job;},1);await workers.waitReady();const out=await workers.close(connection);assert.equal(out.ok,false);if(!out.ok)assert.equal(out.error,connection);
});
it('taking one selected result preserves every remaining ready result without phantom accounting release',async()=>{
 const pool=new BoundedRemoteWorkers<number>(2,3,9);pool.submit(async()=>1,3);pool.submit(async()=>2,3);pool.submit(async()=>3,3);await tick();assert.equal(await pool.waitReady(),true);assert.deepEqual(pool.takeReady(),{ok:true,value:1});assert.equal(pool.snapshot().pending,2);assert.equal(pool.snapshot().retainedBytes,6);assert.deepEqual(await pool.joinNext(),{ok:true,value:2});assert.deepEqual(pool.takeReady(),{ok:true,value:3});assert.equal(pool.isEmpty(),true);
});
