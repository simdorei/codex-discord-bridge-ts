import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {resolve} from 'node:path';
import {requireExactMirrorChannelIn as guard,MirrorCursorMappingChangedError} from '../../src/store/mirror-cursor-mapping.ts';
import {initializeMirrorCursorJournal,initializeFreshMirrorCursor,readBoundMirrorCursor,advanceMappedMirrorCursor} from '../../src/store/mirror-cursor-journal.ts';
import {NativeMirrorCursorStore,MirrorCursorWriteUnconfirmedError} from '../../src/runtime/session-mirror/cursor-store.ts';
import {openInitialized} from '../../src/store/owned-driver.ts';import {storeFixture} from '../helpers/store-fixture.ts';import type {MirrorCursorAnchor} from '../../src/core/mirror-cursor-anchor.ts';
const hash='a'.repeat(64),receipts=[{key:'receipt',contentHash:hash}];
const anchor=(offset=0n):MirrorCursorAnchor=>({version:1,path:resolve('rollout.jsonl'),offset,stamp:{dev:1n,ino:2n,birthtimeNs:3n,mtimeNs:4n,ctimeNs:5n,size:100n},prefixHash:hash,tailHash:hash});
function map(db:DatabaseSync,thread='thread',channel=42n){db.prepare('INSERT INTO mirror_threads(codex_thread_id,project_key,thread_title,discord_channel_id,discord_thread_id,updated_at) VALUES(?,?,?,?,?,?)').run(thread,'project','title',1n,channel,1);}
async function fixture(run:(db:DatabaseSync,path:string)=>void|Promise<void>){await storeFixture(async path=>{const db=await openInitialized(path);try{initializeMirrorCursorJournal(db);map(db);db.prepare('INSERT INTO codex_delivery_receipts(receipt_key,content_hash,message_id) VALUES(?,?,?)').run('receipt',hash,'10');await run(db,path)}finally{db.close()}});}
test('exact mapping and confirmed receipts commit both cursor records together',async()=>fixture(db=>{
 const old=initializeFreshMirrorCursor(db,'thread',anchor(),'turn',1,'init'),next=advanceMappedMirrorCursor(db,old,anchor(20n),'turn',2,'advance',receipts,42n);
 assert.equal(next.revision,2n);assert.deepEqual(readBoundMirrorCursor(db,'thread'),next);
 assert.deepEqual(advanceMappedMirrorCursor(db,old,anchor(20n),'turn',2,'advance',receipts,42n),next);
}));
test('changed, missing and shared channel mapping preserve old cursor despite confirmed receipts',async()=>fixture(db=>{
 const old=initializeFreshMirrorCursor(db,'thread',anchor(),'turn',1,'init');
 db.prepare('UPDATE mirror_threads SET discord_thread_id=43 WHERE codex_thread_id=?').run('thread');
 assert.throws(()=>advanceMappedMirrorCursor(db,old,anchor(20n),'turn',2,'advance',receipts,42n),MirrorCursorMappingChangedError);
 db.prepare('UPDATE mirror_threads SET discord_thread_id=42 WHERE codex_thread_id=?').run('thread');map(db,'foreign');
 assert.throws(()=>advanceMappedMirrorCursor(db,old,anchor(20n),'turn',2,'advance',receipts,42n),MirrorCursorMappingChangedError);
 db.exec('DELETE FROM mirror_threads');
 assert.throws(()=>advanceMappedMirrorCursor(db,old,anchor(20n),'turn',2,'advance',receipts,42n),MirrorCursorMappingChangedError);
 assert.deepEqual(readBoundMirrorCursor(db,'thread'),old);
}));
test('mapping mutated by a cursor update trigger is detected before commit and fully rolled back',async()=>fixture(db=>{
 const old=initializeFreshMirrorCursor(db,'thread',anchor(),'turn',1,'init');
 db.exec("CREATE TRIGGER move_mapping AFTER UPDATE ON codex_session_mirror_offsets BEGIN UPDATE mirror_threads SET discord_thread_id=43 WHERE codex_thread_id='thread'; END");
 assert.throws(()=>advanceMappedMirrorCursor(db,old,anchor(20n),'turn',2,'advance',receipts,42n),MirrorCursorMappingChangedError);
 assert.deepEqual(readBoundMirrorCursor(db,'thread'),old);assert.equal(db.prepare('SELECT discord_thread_id AS id FROM mirror_threads').get()!.id,42);
}));
test('committed operation with later changed mapping is held while read reconciliation remains available',async()=>fixture(db=>{
 const old=initializeFreshMirrorCursor(db,'thread',anchor(),'turn',1,'init'),next=advanceMappedMirrorCursor(db,old,anchor(20n),'turn',2,'advance',receipts,42n);
 db.exec('UPDATE mirror_threads SET discord_thread_id=43');
 assert.throws(()=>advanceMappedMirrorCursor(db,old,anchor(20n),'turn',2,'advance',receipts,42n),MirrorCursorMappingChangedError);
 assert.deepEqual(readBoundMirrorCursor(db,'thread'),next);
}));
test('guard requires caller transaction and never takes ownership of it',async()=>fixture(db=>{
 assert.throws(()=>guard(db,'thread',42n),/active transaction/);db.exec('BEGIN');
 guard(db,'thread',42n);assert.equal(db.isTransaction,true);
 assert.throws(()=>guard(db,'thread',0n),RangeError);assert.equal(db.isTransaction,true);db.exec('ROLLBACK');
}));
test('NOCASE aliases, duplicate exact rows and malformed channel scalar cannot authorize cursor',()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec('CREATE TABLE mirror_threads(codex_thread_id TEXT COLLATE NOCASE,discord_thread_id);BEGIN');
  const put=db.prepare('INSERT INTO mirror_threads VALUES(?,?)');put.run('THREAD',42n);
  assert.throws(()=>guard(db,'thread',42n),MirrorCursorMappingChangedError);db.exec('DELETE FROM mirror_threads');
  put.run('thread',42n);put.run('thread',42n);assert.throws(()=>guard(db,'thread',42n),MirrorCursorMappingChangedError);
  db.exec('DELETE FROM mirror_threads');put.run('thread','42');assert.throws(()=>guard(db,'thread',42n));
  db.exec('DELETE FROM mirror_threads');put.run('thread',42n);put.run(null,42n);assert.throws(()=>guard(db,'thread',42n),MirrorCursorMappingChangedError);
 }finally{db.close()}
});
test('native mapped writer holds stale snapshot channel and later accepts exact current mapping',async()=>fixture(async(db,path)=>{
 const old=initializeFreshMirrorCursor(db,'thread',anchor(),'turn',1,'init');const store=new NativeMirrorCursorStore(path);
 try{
  db.exec('UPDATE mirror_threads SET discord_thread_id=43');
  await assert.rejects(store.advanceMapped(old,anchor(20n),'turn',2,'advance',receipts,42n),e=>e instanceof MirrorCursorWriteUnconfirmedError&&e.operation==='MappedAdvance');
  assert.deepEqual(await store.read('thread'),old);db.exec('UPDATE mirror_threads SET discord_thread_id=42');
  const next=await store.advanceMapped(old,anchor(20n),'turn',2,'advance',receipts,42n);assert.equal(next.revision,2n);
 }finally{await store.close()}
}));
