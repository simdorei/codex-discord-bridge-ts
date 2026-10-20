import test from 'node:test';import assert from 'node:assert/strict';import {existsSync} from 'node:fs';import {resolve} from 'node:path';
import {NativeMirrorCursorStore,MirrorCursorWriteUnconfirmedError,MirrorCursorStoreReadError} from '../../../src/runtime/session-mirror/cursor-store.ts';
import {OwnedWorkerBusyError,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';import {openExisting} from '../../../src/store/existing-store.ts';
import {storeFixture} from '../../helpers/store-fixture.ts';import type {MirrorCursorAnchor} from '../../../src/core/mirror-cursor-anchor.ts';
const hash='a'.repeat(64),receipts=[{key:'receipt',contentHash:hash}];
const a=(offset=0n):MirrorCursorAnchor=>({version:1,path:resolve('rollout.jsonl'),offset,stamp:{dev:1n,ino:2n,birthtimeNs:3n,mtimeNs:4n,ctimeNs:5n,size:100n},prefixHash:hash,tailHash:hash});
async function setup(path:string){const db=await openInitialized(path);db.close();const store=new NativeMirrorCursorStore(path);await store.initializeSchema();return store;}
test('fixed native writer initializes, reads and advances actual committed receipts',async()=>storeFixture(async path=>{
 const store=await setup(path);try{
  assert.equal(await store.read('thread'),null);const first=await store.initializeFresh('thread',a(),'turn',1,'init');
  const db=await openInitialized(path);try{db.prepare('INSERT INTO codex_delivery_receipts(receipt_key,content_hash,message_id) VALUES(?,?,?)').run('receipt',hash,'10')}finally{db.close()}
  const next=await store.advance(first,a(20n),'next',2,'advance',receipts);assert.equal(next.revision,2n);assert.deepEqual(await store.read('thread'),next);
 }finally{await store.close()}
 assert.equal(ownedWorkerUsage().Background,0);
}));
test('failed submitted write remains unconfirmed and readonly reconciliation sees old cursor',async()=>storeFixture(async path=>{
 const store=await setup(path);try{
  const first=await store.initializeFresh('thread',a(),'turn',1,'init');
  await assert.rejects(store.advance(first,a(20n),'next',2,'missing',receipts),e=>e instanceof MirrorCursorWriteUnconfirmedError&&e.operationId==='missing');
  assert.deepEqual(await store.read('thread'),first);
 }finally{await store.close()}
}));
test('cancellation joins submitted write and does not discard its durable result',async()=>storeFixture(async path=>{
 const store=await setup(path),controller=new AbortController(),reason=Error('cancel');
 try{
  const pending=store.initializeFresh('thread',a(),'turn',1,'init',controller.signal);assert.equal(store.busy,true);controller.abort(reason);
  await assert.rejects(pending,e=>e instanceof MirrorCursorWriteUnconfirmedError&&e.cause===reason&&e.operationId==='init');
  assert.equal(store.busy,false);assert.equal((await store.read('thread'))!.operationId,'init');
 }finally{await store.close()}
}));
test('deadline reports unknown only after native exit and fresh owner can reconcile exact operation',async()=>storeFixture(async path=>{
 const schemaOwner=await setup(path);await schemaOwner.close();const short=new NativeMirrorCursorStore(path,1);
 try{
  await assert.rejects(short.initializeFresh('thread',a(),'turn',1,'init'),MirrorCursorWriteUnconfirmedError);assert.equal(short.busy,false);
 }finally{await short.close()}
 const reader=new NativeMirrorCursorStore(path);try{assert.equal((await reader.read('thread'))!.operationId,'init')}finally{await reader.close()}
}));
test('overlap refuses without queueing and close joins all submitted native work',async()=>storeFixture(async path=>{
 const store=await setup(path);const pending=store.initializeFresh('thread',a(),'turn',1,'init');const checked=assert.rejects(pending,MirrorCursorWriteUnconfirmedError);
 await assert.rejects(store.read('thread'),OwnedWorkerBusyError);await store.close();await checked;
 assert.equal(store.busy,false);assert.equal(ownedWorkerUsage().Background,0);await assert.rejects(store.read('thread'),/closed/);
}));
test('pre-abort and missing existing store never create a database',async()=>storeFixture(async path=>{
 const store=new NativeMirrorCursorStore(path),controller=new AbortController(),reason=Error('pre');controller.abort(reason);
 try{
  await assert.rejects(store.initializeSchema(controller.signal),e=>e===reason);await assert.rejects(store.read('thread'),MirrorCursorStoreReadError);
  await assert.rejects(store.initializeSchema(),MirrorCursorWriteUnconfirmedError);assert.equal(existsSync(path),false);
 }finally{await store.close()}
}));
test('two native writers with one expected revision cannot both advance',async()=>storeFixture(async path=>{
 const firstOwner=await setup(path),other=new NativeMirrorCursorStore(path);
 try{
  const first=await firstOwner.initializeFresh('thread',a(),'turn',1,'init');
  const results=await Promise.allSettled([firstOwner.advance(first,a(10n),'turn',2,'one',[]),other.advance(first,a(20n),'turn',2,'two',[])]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);
  const row=await firstOwner.read('thread');assert.equal(row!.revision,2n);assert.ok(['one','two'].includes(row!.operationId));
 }finally{await firstOwner.close();await other.close()}
}));
test('input getters and unsupported timeout fail before native submission',async()=>storeFixture(async path=>{
 const store=new NativeMirrorCursorStore(path);let calls=0;
 try{await assert.rejects(store.initializeFresh('thread',{...a(),get offset(){calls++;return 0n}},'',1,'init'),TypeError);assert.equal(calls,0);assert.equal(store.busy,false);assert.equal(existsSync(path),false)}finally{await store.close()}
 for(const timeout of [-1,5001,NaN])assert.throws(()=>openExisting(path,timeout),RangeError);assert.equal(existsSync(path),false);
}));
