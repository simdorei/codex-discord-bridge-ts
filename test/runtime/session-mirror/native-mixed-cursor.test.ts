import test from 'node:test';import assert from 'node:assert/strict';import type {DatabaseSync} from 'node:sqlite';import {resolve} from 'node:path';
import {storeFixture} from '../../helpers/store-fixture.ts';import {openInitialized} from '../../../src/store/owned-driver.ts';
import {initializeMirrorCursorJournal,initializeFreshMirrorCursor,type BoundMirrorCursor} from '../../../src/store/mirror-cursor-journal.ts';
import {NativeMirrorCursorStore,MirrorCursorWriteUnconfirmedError} from '../../../src/runtime/session-mirror/cursor-store.ts';
import {collectSessionItems} from '../../../src/runtime/session-mirror/collect.ts';import type {MirrorCursorAnchor} from '../../../src/core/mirror-cursor-anchor.ts';
const hash='a'.repeat(64),receipts=[{key:'receipt',contentHash:hash}],limits={maxJobs:32n,maxValueBytes:1048576n};
const anchor=(offset=0n):MirrorCursorAnchor=>({version:1,path:resolve('rollout.jsonl'),offset,stamp:{dev:1n,ino:2n,birthtimeNs:3n,mtimeNs:4n,ctimeNs:5n,size:100n},prefixHash:hash,tailHash:hash});
const item=collectSessionItems('thread',[{type:'event_msg',payload:{type:'agent_message',message:'handled'}}],'Send','turn').items[0]!;
async function fixture(run:(db:DatabaseSync,old:BoundMirrorCursor,store:NativeMirrorCursorStore)=>Promise<void>){await storeFixture(async path=>{const db=await openInitialized(path),store=new NativeMirrorCursorStore(path);try{
 initializeMirrorCursorJournal(db);db.prepare('INSERT INTO mirror_threads VALUES(?,?,?,?,?,?)').run('thread','project','title',1n,42n,1);
 db.prepare('INSERT INTO codex_delivery_receipts(receipt_key,content_hash,message_id) VALUES(?,?,?)').run('receipt',hash,'10');db.prepare('INSERT INTO codex_session_mirror_events VALUES(?,?,1)').run(item.digest,'thread');
 await run(db,initializeFreshMirrorCursor(db,'thread',anchor(),'turn',1,'init'),store);
 }finally{await store.close();db.close()}})}
const go=(store:NativeMirrorCursorStore,old:BoundMirrorCursor,signal?:AbortSignal)=>store.advanceWithSkips(old,anchor(20n),'turn',2,'advance',receipts,42n,[item],limits,signal);
test('fixed native mixed writer commits delivered and skipped proof atomically',async()=>fixture(async(_db,old,store)=>{
 const next=await go(store,old);assert.equal(next.revision,2n);assert.deepEqual(await store.read('thread'),next);assert.equal(store.busy,false);
}));
test('native post-write skip revocation rolls back marker and both cursors',async()=>fixture(async(db,old,store)=>{
 db.exec('CREATE TRIGGER remove_skip AFTER UPDATE ON codex_session_mirror_offsets BEGIN DELETE FROM codex_session_mirror_events;END');
 await assert.rejects(go(store,old),e=>e instanceof MirrorCursorWriteUnconfirmedError&&e.operation==='MixedAdvance'&&e.operationId==='advance');
 assert.equal(store.busy,false);assert.deepEqual(await store.read('thread'),old);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM codex_session_mirror_events').get()!.n,1);
}));
test('native skip request snapshot cannot be mutated after submission',async()=>fixture(async(_db,old,store)=>{
 const mutable={...item},items=[mutable],bounds={...limits};const pending=store.advanceWithSkips(old,anchor(20n),'turn',2,'advance',receipts,42n,items,bounds);
 mutable.digest='wrong';items.length=0;bounds.maxJobs=0n;const next=await pending;assert.equal(next.revision,2n);
}));
test('pre-abort and invalid bounded request start no native cursor work',async()=>fixture(async(_db,old,store)=>{
 const controller=new AbortController(),reason=Error('stop');controller.abort(reason);await assert.rejects(go(store,old,controller.signal),e=>e===reason);assert.equal(store.busy,false);
 await assert.rejects(store.advanceWithSkips(old,anchor(20n),'turn',2,'advance',receipts,42n,[item],{...limits,maxJobs:0n}),RangeError);assert.deepEqual(await store.read('thread'),old);
 let calls=0;const bad={get maxJobs():bigint{calls++;throw Error('hook')},maxValueBytes:1048576n};await assert.rejects(store.advanceWithSkips(old,anchor(20n),'turn',2,'advance',receipts,42n,[item],bad),TypeError);assert.equal(calls,0);
}));
