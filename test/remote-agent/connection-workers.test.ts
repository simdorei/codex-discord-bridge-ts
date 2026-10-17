import {it} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as tick} from 'node:timers/promises';
import {RemoteConnectionWorkers,RemoteConnectionClosedError} from '../../src/remote-agent/connection-workers.ts';
import {RemoteWorkerCapacityError,RemoteWorkerJoinBusyError} from '../../src/remote-agent/bounded-workers.ts';
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}

it('disconnect cancels before draining but retains all accepted work until actual completion',async()=>{
 const workers=new RemoteConnectionWorkers<number>(18446744073709551615n,1,3,30),gate=deferred<number>();
 const observations:Array<{generation:bigint;aborted:boolean}>=[];
 workers.submit((generation,signal)=>{observations.push({generation,aborted:signal.aborted});return gate.promise;},10);
 workers.submit(async(generation,signal)=>{observations.push({generation,aborted:signal.aborted});return 2;},10);
 await tick();let finished=false;const closing=workers.close().then(x=>{finished=true;return x;});await tick();
 assert.equal(finished,false);assert.equal(workers.snapshot().pending,2);assert.equal(workers.snapshot().retainedBytes,20);
 assert.throws(()=>workers.submit(async()=>3,0),RemoteConnectionClosedError);
 gate.resolve(1);assert.deepEqual(await closing,{ok:true});
 assert.deepEqual(observations,[{generation:18446744073709551615n,aborted:false},{generation:18446744073709551615n,aborted:true}]);
 assert.equal(workers.snapshot().pending,0);assert.equal(workers.snapshot().retainedBytes,0);
});
it('a pending result collector is joined before draining all remaining results',async()=>{
 const workers=new RemoteConnectionWorkers<number>(1n,2,4),a=deferred<number>(),b=deferred<number>();
 workers.submit(()=>a.promise,1);workers.submit(()=>b.promise,1);
 const collecting=workers.joinNext();await assert.rejects(workers.joinNext(),RemoteWorkerJoinBusyError);
 const closing=workers.close();await assert.rejects(workers.joinNext(),RemoteConnectionClosedError);
 a.resolve(1);assert.deepEqual(await collecting,{ok:true,value:1});let done=false;void closing.then(()=>{done=true;});await tick();assert.equal(done,false);
 b.resolve(2);assert.deepEqual(await closing,{ok:true});assert.equal(workers.snapshot().pending,0);
});
it('first worker failure wins after clean shutdown while original connection failure takes precedence',async()=>{
 const first=new Error('first'),second=new Error('second'),original=new Error('socket');
 for(const prior of [false,true]){
  const workers=new RemoteConnectionWorkers<number>(2n,1,3);
  workers.submit(async()=>{throw first;},1);workers.submit(async()=>{throw second;},1);
  const result=await(prior?workers.close(original):workers.close());
  assert.equal(result.ok,false);if(!result.ok)assert.equal(result.error,prior?original:first);
  assert.equal(workers.snapshot().pending,0);
 }
});
it('failed in-flight collection is not silently discarded during disconnect',async()=>{
 const workers=new RemoteConnectionWorkers<number>(3n),gate=deferred<number>(),sentinel=Object.freeze({failure:'worker'});
 workers.submit(async()=>{await gate.promise;throw sentinel;},1);
 const collecting=workers.joinNext(),closing=workers.close();gate.resolve(1);
 assert.deepEqual(await collecting,{ok:false,error:sentinel});const result=await closing;assert.equal(result.ok,false);if(!result.ok)assert.equal(result.error,sentinel);
});
it('reentrant and repeated close share one outcome and preserve explicit undefined failure',async()=>{
 const workers=new RemoteConnectionWorkers<number>(0n),gate=deferred<number>();let nested:Promise<unknown>|undefined;
 workers.submit(async(_generation,signal)=>{signal.addEventListener('abort',()=>{nested=workers.close(new Error('late'));},{once:true});return gate.promise;},1);
 await tick();const first=workers.close(undefined);assert.equal(first,nested);assert.equal(first,workers.close());gate.resolve(1);
 assert.deepEqual(await first,{ok:false,error:undefined});assert.equal(Object.isFrozen(await first),true);
});
it('different connection generations and cancellation remain isolated and capacity refusal has no effect',async()=>{
 const a=new RemoteConnectionWorkers<number>(4n,1,1,1),b=new RemoteConnectionWorkers<number>(5n,1,1,1),gate=deferred<number>();let invoked=0;
 a.submit(()=>gate.promise,1);assert.throws(()=>a.submit(async()=>{invoked++;return 0;},0),RemoteWorkerCapacityError);
 const closing=a.close();b.submit(async(g,s)=>{assert.equal(g,5n);assert.equal(s.aborted,false);return 5;},1);
 assert.deepEqual(await b.joinNext(),{ok:true,value:5});assert.deepEqual(await b.close(),{ok:true});gate.resolve(4);await closing;assert.equal(invoked,0);
});
it('invalid generation and proxy operation are rejected without invoking hooks',async()=>{
 for(const value of [-1n,18446744073709551616n,1 as unknown as bigint])assert.throws(()=>new RemoteConnectionWorkers(value),RangeError);
 let hooks=0;const workers=new RemoteConnectionWorkers<number>(1n),proxy=new Proxy(async()=>1,{apply(){hooks++;return Promise.resolve(1);}});
 assert.throws(()=>workers.submit(proxy,1),TypeError);assert.equal(hooks,0);assert.equal(workers.snapshot().pending,0);assert.deepEqual(await workers.close(),{ok:true});
});
