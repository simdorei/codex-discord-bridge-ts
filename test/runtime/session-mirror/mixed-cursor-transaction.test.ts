import test from 'node:test';import assert from 'node:assert/strict';import type {DatabaseSync} from 'node:sqlite';import {resolve} from 'node:path';
import {storeFixture} from '../../helpers/store-fixture.ts';import {openInitialized} from '../../../src/store/owned-driver.ts';
import {initializeMirrorCursorJournal,initializeFreshMirrorCursor,readBoundMirrorCursor,type BoundMirrorCursor} from '../../../src/store/mirror-cursor-journal.ts';
import {advanceMirrorCursorWithSkips as advance} from '../../../src/runtime/session-mirror/mixed-cursor-transaction.ts';
import {MirrorSkipUnprovenError} from '../../../src/runtime/session-mirror/ownership.ts';
import {collectSessionItems} from '../../../src/runtime/session-mirror/collect.ts';import type {MirrorCursorAnchor} from '../../../src/core/mirror-cursor-anchor.ts';
const hash='a'.repeat(64),receipts=[{key:'receipt',contentHash:hash}];
const anchor=(offset=0n):MirrorCursorAnchor=>({version:1,path:resolve('rollout.jsonl'),offset,stamp:{dev:1n,ino:2n,birthtimeNs:3n,mtimeNs:4n,ctimeNs:5n,size:100n},prefixHash:hash,tailHash:hash});
const item=collectSessionItems('thread',[{type:'event_msg',payload:{type:'agent_message',message:'already handled'}}],'Send','turn').items[0]!;
async function fixture(run:(db:DatabaseSync,old:BoundMirrorCursor)=>void){await storeFixture(async path=>{const db=await openInitialized(path);try{
 initializeMirrorCursorJournal(db);db.prepare('INSERT INTO mirror_threads VALUES(?,?,?,?,?,?)').run('thread','project','title',1n,42n,1);
 db.prepare('INSERT INTO codex_delivery_receipts(receipt_key,content_hash,message_id) VALUES(?,?,?)').run('receipt',hash,'10');db.prepare('INSERT INTO codex_session_mirror_events VALUES(?,?,1)').run(item.digest,'thread');
 run(db,initializeFreshMirrorCursor(db,'thread',anchor(),'turn',1,'init'));
 }finally{db.close()}})}
const go=(db:DatabaseSync,old:BoundMirrorCursor)=>advance(db,old,anchor(20n),'turn',2,'advance',receipts,42n,[item],32n,1048576n);
test('confirmed delivered receipt plus current durable skip proof commit both cursor rows together',async()=>fixture((db,old)=>{
 const next=go(db,old);assert.equal(next.revision,2n);assert.deepEqual(readBoundMirrorCursor(db,'thread'),next);assert.equal(db.isTransaction,false);assert.deepEqual(go(db,old),next);
}));
test('missing skipped proof prevents cursor advance even when every supplied receipt is confirmed',async()=>fixture((db,old)=>{
 db.exec('DELETE FROM codex_session_mirror_events');assert.throws(()=>go(db,old),MirrorSkipUnprovenError);assert.deepEqual(readBoundMirrorCursor(db,'thread'),old);assert.equal(db.isTransaction,false);
}));
test('cursor trigger removing skip marker rolls back offset, sidecar and marker together',async()=>fixture((db,old)=>{
 db.exec('CREATE TRIGGER remove_skip AFTER UPDATE ON codex_session_mirror_offsets BEGIN DELETE FROM codex_session_mirror_events;END');
 assert.throws(()=>go(db,old),MirrorSkipUnprovenError);assert.deepEqual(readBoundMirrorCursor(db,'thread'),old);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM codex_session_mirror_events').get()!.n,1);assert.equal(db.isTransaction,false);
}));
test('changed channel and missing delivered receipt cannot borrow valid skipped proof',async()=>fixture((db,old)=>{
 db.exec('UPDATE mirror_threads SET discord_thread_id=43');assert.throws(()=>go(db,old));assert.deepEqual(readBoundMirrorCursor(db,'thread'),old);
 db.exec('UPDATE mirror_threads SET discord_thread_id=42;DELETE FROM codex_delivery_receipts');assert.throws(()=>go(db,old));assert.deepEqual(readBoundMirrorCursor(db,'thread'),old);
}));
test('late committed packet whose skip marker changed remains readable but is not replayed',async()=>fixture((db,old)=>{
 const next=go(db,old);db.exec('DELETE FROM codex_session_mirror_events');assert.throws(()=>go(db,old),MirrorSkipUnprovenError);assert.deepEqual(readBoundMirrorCursor(db,'thread'),next);
}));
test('existing caller transaction is refused without consuming its writes',async()=>fixture((db,old)=>{
 db.exec('BEGIN;DELETE FROM codex_session_mirror_events');assert.throws(()=>go(db,old));assert.equal(db.isTransaction,true);db.exec('ROLLBACK');assert.deepEqual(readBoundMirrorCursor(db,'thread'),old);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM codex_session_mirror_events').get()!.n,1);
}));
test('unknown input getters are refused without invoking them or beginning a transaction',async()=>fixture((db,old)=>{
 let calls=0;const bad={...old,get thread():string{calls++;throw Error('hook')}};
 assert.throws(()=>go(db,bad),TypeError);assert.equal(calls,0);assert.equal(db.isTransaction,false);assert.deepEqual(readBoundMirrorCursor(db,'thread'),old);
}));
