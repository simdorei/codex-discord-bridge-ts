import test from 'node:test';import assert from 'node:assert/strict';
import {NativeCompletionDiscoveryReader} from '../../src/runtime/completion/native-discovery.ts';
import {CompletionDiscovery} from '../../src/runtime/completion/scheduler/discovery.ts';import {CompletionReady} from '../../src/runtime/completion/scheduler/ready.ts';
import {nativeCompletionCursorRestore,nativeCompletionCursorWire,initialCompletionCursor,type CompletionEntry} from '../../src/store/completion-metadata.ts';
import {OwnedWorkerSlot,ownedWorkerUsage} from '../../src/runtime/owned-worker-slot.ts';import {openInitialized} from '../../src/store/owned-driver.ts';import {storeFixture} from '../helpers/store-fixture.ts';
const hint:CompletionEntry={source:'AsyncOrphan',id:'q',target:'orphan',turn:'turn',channel:1n,bytes:0n,position:{stamp:0,ordinal:0n,id:''}};
test('native cursors cannot be forged, imported across owners or restored on the main runtime',async()=>storeFixture(async path=>{
 const a=new NativeCompletionDiscoveryReader(path),b=new NativeCompletionDiscoveryReader(path);const call=(cursor:any)=>a.discover('runtime',1n,{rotation:0,scans:[{source:'Final',cursor,next:0,wake:false,pending:[]}]},[],[],new Set(),[0]);
 try{assert.throws(()=>call({finished:false}),/owned native cursor/);assert.throws(()=>call(b.initialCursor()),/owned native cursor/);assert.throws(()=>call(initialCompletionCursor()),/owned native cursor/);assert.throws(()=>nativeCompletionCursorWire(initialCompletionCursor()),/worker-only/);assert.throws(()=>nativeCompletionCursorRestore({after:null,upper:null,finished:false}),/worker-only/);assert.throws(()=>CompletionDiscovery.restoreNative({rotation:0,scans:[]},()=>0),/worker-only/);assert.equal(ownedWorkerUsage().Discovery,0);}finally{await a.close();await b.close();}
}));
test('invalid generation, cancellation and closed reader do not allocate discovery worker',async()=>storeFixture(async path=>{
 const a=new NativeCompletionDiscoveryReader(path),snapshot={rotation:0,scans:[{source:'Final' as const,cursor:a.initialCursor(),next:0,wake:false,pending:[]}]};
 const call=(g:bigint,signal?:AbortSignal)=>a.discover('runtime',g,snapshot,[],[],new Set(),[0],signal);
 assert.throws(()=>call(1n<<63n),/i64/);const cancel=new AbortController(),reason=new Error('cancelled before submit');cancel.abort(reason);assert.throws(()=>call(1n,cancel.signal),e=>e===reason);await a.close();assert.throws(()=>call(1n),/unavailable/);assert.equal(ownedWorkerUsage().Discovery,0);
}));
test('invalid native sidecar cannot remove an unrelated hint or commit scan state',async()=>storeFixture(async path=>{
 const a=new NativeCompletionDiscoveryReader(path),d=new CompletionDiscovery(['AsyncOrphan'],()=>0,a),q=new CompletionReady<null>(),run=OwnedWorkerSlot.prototype.run;
 const before=d.snapshot();OwnedWorkerSlot.prototype.run=async()=>({ok:true,state:[hint],http:[],scans:[{source:'AsyncOrphan',cursor:{after:null,upper:null,finished:true},next:30000,wake:false,pending:[]}],reports:[{source:'AsyncOrphan',ok:true,metadata:{oversizedIdentity:false,heldReceiptHeads:0n,deferred:[{index:0,entry:{...hint,target:'different'}}]}}]});
 try{await assert.rejects(d.readAsync('runtime',1n,q,new Set()),/unavailable/);assert.equal(q.length,0);assert.deepEqual(d.snapshot(),before);assert.equal(d.rotation,0);}finally{OwnedWorkerSlot.prototype.run=run;await a.close();q.dispose();}
}));
test('autonomous and synchronous rounds retain all eight source report ordering on actual SQLite',async()=>storeFixture(async path=>{
 const db=await openInitialized(path);db.exec("INSERT INTO codex_goal_progress(thread,turn,channel,content,job_id) VALUES ('goal','turn',1,'body','job')");db.close();const a=new NativeCompletionDiscoveryReader(path),native=new CompletionDiscovery(undefined,()=>0,a),sync=new CompletionDiscovery(undefined,()=>0),x=new CompletionReady<null>(),y=new CompletionReady<null>();
 try{const expected=sync.read(path,'runtime',1n,x,new Set()),actual=await native.readAsync('runtime',1n,y,new Set());assert.deepEqual(actual,expected);assert.deepEqual(x.httpSnapshot(),y.httpSnapshot());assert.deepEqual(x.stateSnapshot(),y.stateSnapshot());assert.equal(native.rotation,sync.rotation);assert.deepEqual(native.snapshot().map(s=>({source:s.source,finished:s.cursor.finished,wake:s.wake,pending:s.pending})),sync.snapshot().map(s=>({source:s.source,finished:s.cursor.finished,wake:s.wake,pending:s.pending})));}finally{await a.close();x.dispose();y.dispose();}
}));
