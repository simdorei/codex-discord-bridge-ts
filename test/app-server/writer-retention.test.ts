import assert from 'node:assert/strict';
import test from 'node:test';
import {AppServerWriter,type OwnedAppServerInput} from '../../src/app-server/writer.ts';
function deferred<T=void>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
function closer(){let closed=false;return {get closed(){return closed;},async markClosed(){closed=true;}};}
const plain={check:()=>undefined,dispose:()=>{}};
const emptyLock={activeTargetCount:0,queuedWaiterCount:0,heldLeaseReferenceCount:0};
const empty={retainedWriteOperationCount:0,retainedEncodedBufferBytes:0,stdinLock:emptyLock};
const bytes=(value:unknown)=>Buffer.byteLength(JSON.stringify(value)+'\n','utf8');
function occupied(writer:AppServerWriter,count:number,size:number,queued=0){assert.deepEqual(writer.snapshotRetainedWork(),{retainedWriteOperationCount:count,retainedEncodedBufferBytes:size,stdinLock:{activeTargetCount:1,queuedWaiterCount:queued,heldLeaseReferenceCount:1}});}
test('UTF-8 newline bytes, immutable snapshots, FIFO and adapter alias are accounted once',async()=>{
 const entered=deferred(),gate=deferred(),aliases:Uint8Array[]=[],values=['é😀','second','三'],order:number[]=[];
 const writer=new AppServerWriter({async writeAll(data){aliases.push(data);if(aliases.length===1){entered.resolve();await gate.promise;}},async flush(){}},closer());
 const initial=writer.snapshotRetainedWork(),other=new AppServerWriter(null,closer());
 assert.ok(Object.isFrozen(initial));assert.ok(Object.isFrozen(initial.stdinLock));assert.notEqual(initial,writer.snapshotRetainedWork());assert.notEqual(initial.stdinLock,writer.snapshotRetainedWork().stdinLock);
 assert.throws(()=>Object.assign(initial,{retainedWriteOperationCount:8}),TypeError);assert.throws(()=>Object.assign(initial.stdinLock,{activeTargetCount:8}),TypeError);
 const tasks=[writer.write(values[0],plain,()=>{order.push(0);})];await entered.promise;
 tasks.push(writer.write(values[1],plain,()=>{order.push(1);}),writer.write(values[2],plain,()=>{order.push(2);}));
 occupied(writer,3,values.reduce((n,v)=>n+bytes(v),0),2);assert.deepEqual(other.snapshotRetainedWork(),empty);assert.deepEqual(initial,empty);
 assert.ok(Buffer.isBuffer(aliases[0]));assert.equal(aliases[0]!.byteLength,bytes(values[0]));const shared=aliases[0];
 gate.resolve();await Promise.all(tasks);assert.deepEqual(order,[0,1,2]);assert.deepEqual(writer.snapshotRetainedWork(),empty);
 assert.equal(Buffer.from(shared!).toString(),JSON.stringify(values[0])+'\n');
});
for(const cancellation of ['abort','timeout'] as const)test(`queued ${cancellation} removes waiter before releasing encoded ownership`,async()=>{
 const gate=deferred(),entered=deferred(),writer=new AppServerWriter({async writeAll(){entered.resolve();await gate.promise;},async flush(){}},closer());
 const first=writer.write('first',plain,()=>{});await entered.promise;const controller=new AbortController(),reason={cancel:true};
 const signal=cancellation==='abort'?controller.signal:AbortSignal.timeout(10);
 const second=writer.write('é',plain,()=>{throw Error('cancelled write started');},signal),rejected=assert.rejects(second,e=>e===signal.reason);
 occupied(writer,2,bytes('first')+bytes('é'),1);
 const observed=deferred();signal.addEventListener('abort',()=>{occupied(writer,2,bytes('first')+bytes('é'),0);observed.resolve();},{once:true});
 if(cancellation==='abort')controller.abort(reason);else await new Promise(resolve=>setTimeout(resolve,20));
 await observed.promise;await rejected;occupied(writer,1,bytes('first'));gate.resolve();await first;assert.deepEqual(writer.snapshotRetainedWork(),empty);
});
for(const cancellation of ['abort','timeout'] as const)test(`active ${cancellation} retains bytes until adapter and close joins`,async()=>{
 const entered=deferred(),adapter=deferred(),closeJoin=deferred(),controller=new AbortController();let closed=false;
 const signal=cancellation==='abort'?controller.signal:AbortSignal.timeout(10);
 const writer=new AppServerWriter({async writeAll(_data,s){entered.resolve();await adapter.promise;s?.throwIfAborted();},async flush(){throw Error('unexpected flush');}},{get closed(){return closed;},async markClosed(){closed=true;await closeJoin.promise;}});
 const task=writer.write('é',plain,()=>{},signal),rejected=assert.rejects(task,e=>e===signal.reason);await entered.promise;
 if(cancellation==='abort')controller.abort({cancel:true});else await new Promise(resolve=>setTimeout(resolve,20));
 assert.equal(closed,true);occupied(writer,1,bytes('é'));adapter.resolve();await new Promise<void>(resolve=>setImmediate(resolve));occupied(writer,1,bytes('é'));
 closeJoin.resolve();await rejected;assert.deepEqual(writer.snapshotRetainedWork(),empty);
});
for(const cancellation of ['abort','timeout'] as const)test(`native ${cancellation} retains bytes through late settlement and joined disposer`,async()=>{
 const entered=deferred(),native=deferred<object>(),disposeEntered=deferred(),cleanup=deferred(),controller=new AbortController(),token={};let writes=0;
 const signal=cancellation==='abort'?controller.signal:AbortSignal.timeout(10);
 const writer=new AppServerWriter({async writeAll(){writes++;},async flush(){}},closer());
 const task=writer.writeWithOwnedPreflight('native',{check(){entered.resolve();return native.promise;},validate(){throw Error('unexpected validate');},async dispose(value){assert.equal(value,token);disposeEntered.resolve();await cleanup.promise;}},()=>{},signal),rejected=assert.rejects(task,e=>e===signal.reason);await entered.promise;
 const next=writer.write('next',plain,()=>{});occupied(writer,2,bytes('native')+bytes('next'),1);
 if(cancellation==='abort')controller.abort({cancel:true});else await new Promise(resolve=>setTimeout(resolve,20));
 occupied(writer,2,bytes('native')+bytes('next'),1);native.resolve(token);await disposeEntered.promise;occupied(writer,2,bytes('native')+bytes('next'),1);
 cleanup.resolve();await rejected;await next;assert.equal(writes,1);assert.deepEqual(writer.snapshotRetainedWork(),empty);
});
test('serialization, pre-aborted and closed admission never own an encoded buffer',async()=>{
 const close=closer(),writer=new AppServerWriter(null,close),controller=new AbortController();controller.abort({cancel:true});
 for(const [value,signal] of [[{bad:undefined},undefined],[{},controller.signal]] as const){const task=writer.write(value,plain,()=>{},signal);assert.deepEqual(writer.snapshotRetainedWork(),empty);await assert.rejects(task);}
 await close.markClosed();const task=writer.write({},plain,()=>{});assert.deepEqual(writer.snapshotRetainedWork(),empty);await assert.rejects(task,/closed/);
});
test('preflight errors and missing input release ownership and preserve exact errors/tokens',async()=>{
 const reason={},token={};
 for(const mode of ['check','native','validate','missing'] as const){let disposed=0;const writer=new AppServerWriter(null,closer());
  const task=mode==='check'||mode==='missing'?writer.write({}, {check(){if(mode==='check')throw reason;return token;},dispose(value){assert.equal(value,token);disposed++;}},()=>{}):writer.writeWithOwnedPreflight({}, {async check(){if(mode==='native')throw reason;return token;},validate(){throw reason;},async dispose(value){assert.equal(value,token);disposed++;}},()=>{});
  await assert.rejects(task,e=>mode==='missing'?e instanceof Error&&/closed/.test(e.message):e===reason);assert.equal(disposed,mode==='missing'||mode==='validate'?1:0);assert.deepEqual(writer.snapshotRetainedWork(),empty);
 }
});
test('hook/write/flush failure retains AggregateError ordering and releases all accounting',async()=>{
 for(const mode of ['hook','write','flush'] as const){const primary={},closeError={},disposeError={};
  const input:OwnedAppServerInput={async writeAll(){if(mode==='write')throw primary;},async flush(){if(mode==='flush')throw primary;}};
  const writer=new AppServerWriter(input,{closed:false,async markClosed(){throw closeError;}});
  await assert.rejects(writer.write({}, {check:()=>1,dispose(){throw disposeError;}},()=>{if(mode==='hook')throw primary;}),error=>{assert.ok(error instanceof AggregateError);assert.deepEqual(error.errors,[primary,closeError,disposeError]);return true;});
  assert.deepEqual(writer.snapshotRetainedWork(),empty);
 }
});
test('shutdown queues and owns only lock accounting, including failing shutdown',async()=>{
 const native=deferred<object>(),entered=deferred(),shutdownEntered=deferred(),shutdownJoin=deferred(),reason={};
 const writer=new AppServerWriter({async writeAll(){},async flush(){}},closer());
 const task=writer.writeWithOwnedPreflight({}, {check(){entered.resolve();return native.promise;},validate(){},async dispose(){}},()=>{});await entered.promise;
 const shutdown=writer.shutdownInput(async()=>{shutdownEntered.resolve();await shutdownJoin.promise;throw reason;}),rejected=assert.rejects(shutdown,e=>e===reason);
 occupied(writer,1,bytes({}),1);native.resolve({});await task;await shutdownEntered.promise;occupied(writer,0,0);
 shutdownJoin.resolve();await rejected;assert.deepEqual(writer.snapshotRetainedWork(),empty);
});
