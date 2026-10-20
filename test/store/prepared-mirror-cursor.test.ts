import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {resolve} from 'node:path';
import {initializeMirrorCursorJournal,initializeFreshMirrorCursor,readBoundMirrorCursor,prepareMappedMirrorCursorAdvance as prepare,advancePreparedMappedMirrorCursorInTransaction as apply} from '../../src/store/mirror-cursor-journal.ts';
import {MirrorCursorMappingChangedError} from '../../src/store/mirror-cursor-mapping.ts';
import {withStoreTransaction,commitStore} from '../../src/store/owned-scope.ts';
import type {MirrorCursorAnchor} from '../../src/core/mirror-cursor-anchor.ts';
const hash='a'.repeat(64),receipts=[{key:'receipt',contentHash:hash}];
const anchor=(offset=0n):MirrorCursorAnchor=>({version:1,path:resolve('rollout.jsonl'),offset,stamp:{dev:1n,ino:2n,birthtimeNs:3n,mtimeNs:4n,ctimeNs:5n,size:100n},prefixHash:hash,tailHash:hash});
function fixture(run:(db:DatabaseSync)=>void){const db=new DatabaseSync(':memory:');try{
 db.exec('CREATE TABLE codex_session_mirror_offsets(codex_thread_id TEXT PRIMARY KEY,rollout_path TEXT NOT NULL,cursor INTEGER NOT NULL,updated_at REAL NOT NULL,turn_context TEXT);CREATE TABLE codex_delivery_receipts(receipt_key TEXT PRIMARY KEY,content_hash TEXT,message_id TEXT);CREATE TABLE mirror_threads(codex_thread_id TEXT PRIMARY KEY,discord_thread_id INTEGER);INSERT INTO mirror_threads VALUES(\'thread\',42)');
 initializeMirrorCursorJournal(db);db.prepare('INSERT INTO codex_delivery_receipts VALUES(?,?,?)').run('receipt',hash,'10');run(db);
 }finally{db.close()}}
test('prepared mapped apply requires active caller transaction and caller rollback restores both rows',()=>fixture(db=>{
 const old=initializeFreshMirrorCursor(db,'thread',anchor(),'turn',1,'init'),plan=prepare(old,anchor(20n),'next',2,'op',receipts,42n);
 assert.throws(()=>apply(db,plan),/active caller transaction/);assert.deepEqual(readBoundMirrorCursor(db,'thread'),old);
 db.exec('BEGIN');const changed=apply(db,plan);assert.equal(changed.anchor.offset,20n);assert.equal(db.isTransaction,true);db.exec('ROLLBACK');assert.deepEqual(readBoundMirrorCursor(db,'thread'),old);
 db.exec('BEGIN');apply(db,plan);db.exec('COMMIT');assert.deepEqual(readBoundMirrorCursor(db,'thread'),changed);
}));
test('prepared immutable snapshot cannot be retargeted or change expected receipt hash after preparation',()=>fixture(db=>{
 const old=initializeFreshMirrorCursor(db,'thread',anchor(),'turn',1,'init'),next=anchor(20n),mutable=[{...receipts[0]!}],plan=prepare(old,next,'next',2,'op',mutable,42n);
 (next as {offset:bigint}).offset=80n;mutable[0]!.contentHash='b'.repeat(64);mutable.length=0;
 const result=withStoreTransaction(db,'IMMEDIATE',()=>commitStore(apply(db,plan)));assert.equal(result.anchor.offset,20n);assert.equal(result.receiptSetHash.length,64);
}));
test('forged and proxy prepared plans cannot invoke hooks or substitute an empty receipt set',()=>fixture(db=>{
 const old=initializeFreshMirrorCursor(db,'thread',anchor(),'turn',1,'init'),plan=prepare(old,anchor(20n),'next',2,'op',receipts,42n);let calls=0;
 db.exec('BEGIN');assert.throws(()=>apply(db,{...plan}),TypeError);assert.throws(()=>apply(db,new Proxy(plan,{get(){calls++;throw Error('hook')}})),TypeError);assert.equal(calls,0);assert.equal(db.isTransaction,true);db.exec('ROLLBACK');assert.deepEqual(readBoundMirrorCursor(db,'thread'),old);
}));
test('same prepared commit is idempotent without consuming later caller-owned writes',()=>fixture(db=>{
 const old=initializeFreshMirrorCursor(db,'thread',anchor(),'turn',1,'init'),plan=prepare(old,anchor(20n),'next',2,'op',receipts,42n);
 const once=withStoreTransaction(db,'IMMEDIATE',()=>commitStore(apply(db,plan)));
 db.exec('CREATE TABLE caller(value);BEGIN;INSERT INTO caller VALUES(1)');assert.deepEqual(apply(db,plan),once);assert.equal(db.isTransaction,true);db.exec('COMMIT');assert.equal(db.prepare('SELECT value FROM caller').get()!.value,1);
}));
test('mapping postcondition failure leaves rollback to caller and enclosing owned scope restores everything',()=>fixture(db=>{
 const old=initializeFreshMirrorCursor(db,'thread',anchor(),'turn',1,'init'),plan=prepare(old,anchor(20n),'next',2,'op',receipts,42n);
 db.exec("CREATE TRIGGER move AFTER UPDATE ON codex_session_mirror_offsets BEGIN UPDATE mirror_threads SET discord_thread_id=43;END");
 db.exec('BEGIN');assert.throws(()=>apply(db,plan),MirrorCursorMappingChangedError);assert.equal(db.isTransaction,true);db.exec('ROLLBACK');assert.deepEqual(readBoundMirrorCursor(db,'thread'),old);
 assert.throws(()=>withStoreTransaction(db,'IMMEDIATE',()=>commitStore(apply(db,plan))),MirrorCursorMappingChangedError);assert.equal(db.isTransaction,false);assert.deepEqual(readBoundMirrorCursor(db,'thread'),old);assert.equal(db.prepare('SELECT discord_thread_id AS id FROM mirror_threads').get()!.id,42);
}));
test('caller additional postcondition can reject and roll back an otherwise valid cursor advance',()=>fixture(db=>{
 const old=initializeFreshMirrorCursor(db,'thread',anchor(),'turn',1,'init'),plan=prepare(old,anchor(20n),'next',2,'op',receipts,42n),failure=Error('skip evidence changed');
 assert.throws(()=>withStoreTransaction(db,'IMMEDIATE',()=>{apply(db,plan);throw failure}),e=>e===failure);assert.deepEqual(readBoundMirrorCursor(db,'thread'),old);assert.equal(db.isTransaction,false);
}));
test('receipt removed between preparation and transaction cannot authorize advancement',()=>fixture(db=>{
 const old=initializeFreshMirrorCursor(db,'thread',anchor(),'turn',1,'init'),plan=prepare(old,anchor(20n),'next',2,'op',receipts,42n);db.exec('DELETE FROM codex_delivery_receipts');
 assert.throws(()=>withStoreTransaction(db,'IMMEDIATE',()=>commitStore(apply(db,plan))));assert.deepEqual(readBoundMirrorCursor(db,'thread'),old);
}));

test('receipt erased by cursor trigger cannot leave advanced cursor without its durable proof',()=>fixture(db=>{
 const old=initializeFreshMirrorCursor(db,'thread',anchor(),'turn',1,'init'),plan=prepare(old,anchor(20n),'next',2,'op',receipts,42n);
 db.exec('CREATE TRIGGER erase_receipt AFTER UPDATE ON codex_session_mirror_offsets BEGIN DELETE FROM codex_delivery_receipts;END');
 assert.throws(()=>withStoreTransaction(db,'IMMEDIATE',()=>commitStore(apply(db,plan))));
 assert.deepEqual(readBoundMirrorCursor(db,'thread'),old);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM codex_delivery_receipts').get()!.n,1);
}));
