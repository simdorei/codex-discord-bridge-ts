import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {resolve,join} from 'node:path';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';
import {initializeMirrorCursorJournal as schema,initializeFreshMirrorCursor as fresh,readBoundMirrorCursor as read,advanceBoundMirrorCursor as advance,MirrorCursorConflictError,LegacyMirrorCursorUnboundError} from '../../src/store/mirror-cursor-journal.ts';
import {UnconfirmedReceiptBatchError} from '../../src/store/confirmed-receipt-batch.ts';
import type {MirrorCursorAnchor} from '../../src/core/mirror-cursor-anchor.ts';
const hash='a'.repeat(64),receipts=[{key:'receipt',contentHash:hash}];
const a=(offset=0n):MirrorCursorAnchor=>({version:1,path:resolve('rollout.jsonl'),offset,stamp:{dev:1n,ino:2n,birthtimeNs:3n,mtimeNs:4n,ctimeNs:5n,size:100n},prefixHash:hash,tailHash:hash});
function legacy(db:DatabaseSync){db.exec('CREATE TABLE codex_session_mirror_offsets(codex_thread_id TEXT PRIMARY KEY,rollout_path TEXT NOT NULL,cursor INTEGER NOT NULL,updated_at REAL NOT NULL,turn_context TEXT); CREATE TABLE codex_delivery_receipts(receipt_key TEXT PRIMARY KEY,content_hash TEXT,message_id TEXT)')}
function run(fn:(db:DatabaseSync)=>void){const db=new DatabaseSync(':memory:');try{legacy(db);schema(db);fn(db)}finally{db.close()}}
function receipt(db:DatabaseSync,message:string|null='10',contentHash=hash){db.prepare('INSERT INTO codex_delivery_receipts VALUES(?,?,?)').run('receipt',contentHash,message)}
test('explicit journal schema is idempotent and original mirror table SQL is untouched',()=>run(db=>{
 const before=db.prepare("SELECT sql FROM sqlite_schema WHERE name='codex_session_mirror_offsets'").get()!.sql;schema(db);assert.equal(db.prepare("SELECT sql FROM sqlite_schema WHERE name='codex_session_mirror_offsets'").get()!.sql,before);assert.equal(read(db,'thread'),null);
}));
test('foreign incompatible extension table is held without replacement',()=>{
 const db=new DatabaseSync(':memory:');try{legacy(db);db.exec('CREATE TABLE cdr_ts_mirror_cursor_anchors_v1(x)');assert.throws(()=>schema(db),/Incompatible/);assert.equal(db.prepare('PRAGMA table_info(cdr_ts_mirror_cursor_anchors_v1)').get()!.name,'x')}finally{db.close()}
});
test('fresh binding commits both records and exact retry does not increment revision',()=>run(db=>{
 const first=fresh(db,'thread',a(),'turn',1,'init');assert.equal(first.revision,1n);assert.deepEqual(read(db,'thread'),first);assert.deepEqual(fresh(db,'thread',a(),'turn',1,'init'),first);assert.throws(()=>fresh(db,'thread',a(2n),'turn',1,'init'),MirrorCursorConflictError);assert.equal(db.isTransaction,false);
}));
test('legacy offset is preserved and cannot be automatically adopted',()=>run(db=>{
 db.prepare('INSERT INTO codex_session_mirror_offsets VALUES(?,?,?,?,?)').run('thread',a().path,5n,1,null);
 assert.throws(()=>read(db,'thread'),LegacyMirrorCursorUnboundError);assert.throws(()=>fresh(db,'thread',a(),'turn',1,'init'),LegacyMirrorCursorUnboundError);assert.equal(db.prepare('SELECT cursor FROM codex_session_mirror_offsets').get()!.cursor,5);
}));
test('every exact receipt confirms before atomic cursor and revision advance',()=>run(db=>{
 const first=fresh(db,'thread',a(),'turn',1,'init');receipt(db);const next=advance(db,first,a(20n),'next',2,'op-1',receipts);
 assert.equal(next.revision,2n);assert.equal(next.anchor.offset,20n);assert.deepEqual(read(db,'thread'),next);
}));
test('missing, unknown and wrong-content receipts retain both old records',()=>{
 for(const type of ['missing','unknown','conflict'])run(db=>{
  const first=fresh(db,'thread',a(),'turn',1,'init');if(type!=='missing')receipt(db,type==='unknown'?null:'10',type==='conflict'?'b'.repeat(64):hash);
  assert.throws(()=>advance(db,first,a(20n),'next',2,'op',receipts),UnconfirmedReceiptBatchError);assert.deepEqual(read(db,'thread'),first);assert.equal(db.isTransaction,false);
 });
});
test('lost commit reply reconciles the same complete packet without duplicate advance',()=>run(db=>{
 const first=fresh(db,'thread',a(),'turn',1,'init');receipt(db);const done=advance(db,first,a(20n),'next',2,'op',receipts);
 assert.deepEqual(advance(db,first,a(20n),'next',2,'op',receipts),done);
 assert.throws(()=>advance(db,first,a(20n),'next',2,'op',[]),MirrorCursorConflictError);
 assert.throws(()=>advance(db,first,a(21n),'next',2,'op',receipts),MirrorCursorConflictError);
}));
test('stale expected revision cannot overwrite a later committed operation',()=>run(db=>{
 const first=fresh(db,'thread',a(),'turn',1,'init'),next=advance(db,first,a(1n),'turn',2,'one',[]);
 assert.throws(()=>advance(db,first,a(2n),'turn',3,'two',[]),MirrorCursorConflictError);assert.deepEqual(read(db,'thread'),next);
}));
test('legacy drift and malformed stored anchor never turn into a reset or fresh binding',()=>{
 run(db=>{fresh(db,'thread',a(),'turn',1,'init');db.exec('UPDATE codex_session_mirror_offsets SET cursor=10');assert.throws(()=>read(db,'thread'),MirrorCursorConflictError);assert.equal(db.prepare('SELECT cursor FROM codex_session_mirror_offsets').get()!.cursor,10)});
 run(db=>{fresh(db,'thread',a(),'turn',1,'init');db.exec("UPDATE cdr_ts_mirror_cursor_anchors_v1 SET anchor_json='{}'");assert.throws(()=>read(db,'thread'))});
});
test('late sidecar ABORT and IGNORE roll back the already updated legacy cursor',()=>{
 for(const mode of ['ABORT','IGNORE'])run(db=>{
  const first=fresh(db,'thread',a(),'turn',1,'init');db.exec(`CREATE TRIGGER stop_update BEFORE UPDATE ON cdr_ts_mirror_cursor_anchors_v1 BEGIN SELECT RAISE(${mode}${mode==='ABORT'?",'injected'":''}); END`);
  assert.throws(()=>advance(db,first,a(20n),'next',2,'op',[]));assert.deepEqual(read(db,'thread'),first);
 });
});
test('post-update trigger corruption is detected and the whole transaction rolls back',()=>run(db=>{
 const first=fresh(db,'thread',a(),'turn',1,'init');
 db.exec("CREATE TRIGGER corrupt AFTER UPDATE ON cdr_ts_mirror_cursor_anchors_v1 BEGIN UPDATE codex_session_mirror_offsets SET turn_context='wrong'; END");
 assert.throws(()=>advance(db,first,a(20n),'next',2,'op',[]),MirrorCursorConflictError);assert.deepEqual(read(db,'thread'),first);
}));
test('initial sidecar insert failure leaves no orphan legacy offset',()=>run(db=>{
 db.exec("CREATE TRIGGER fail_insert BEFORE INSERT ON cdr_ts_mirror_cursor_anchors_v1 BEGIN SELECT RAISE(ABORT,'injected'); END");
 assert.throws(()=>fresh(db,'thread',a(),'turn',1,'init'),/injected/);assert.equal(read(db,'thread'),null);
}));
test('caller transactions are never rolled back or closed by a rejected owned operation',()=>run(db=>{
 db.exec('BEGIN');assert.throws(()=>fresh(db,'thread',a(),'turn',1,'init'));assert.equal(db.isTransaction,true);assert.equal(db.isOpen,true);db.exec('ROLLBACK');
}));
test('path, file identity, backward offset and signed cursor overflow are refused',()=>run(db=>{
 const first=fresh(db,'thread',a(10n),'turn',1,'init');
 for(const next of [{...a(20n),path:resolve('other')},{...a(20n),stamp:{...a().stamp,ino:3n}},a(9n)]){
  assert.throws(()=>advance(db,first,next,'turn',2,'op',[]),MirrorCursorConflictError);
 }
 assert.throws(()=>fresh(db,'other',{...a(),offset:1n<<63n,stamp:{...a().stamp,size:1n<<63n}},'',1,'new'),RangeError);
 assert.deepEqual(read(db,'thread'),first);
}));
test('file-backed reopen preserves committed result and exact packet reconciliation',()=>{
 const dir=mkdtempSync(join(tmpdir(),'mirror-journal-')),path=join(dir,'state.db');let db=new DatabaseSync(path);
 try{
  legacy(db);schema(db);const first=fresh(db,'thread',a(),'turn',1,'init');receipt(db);const done=advance(db,first,a(20n),'next',2,'op',receipts);db.close();db=new DatabaseSync(path);
  assert.deepEqual(read(db,'thread'),done);assert.deepEqual(advance(db,first,a(20n),'next',2,'op',receipts),done);
 }finally{if(db.isOpen)db.close();rmSync(dir,{recursive:true,force:true})}
});
test('accessor expected state and invalid clock perform no writes',()=>run(db=>{
 const first=fresh(db,'thread',a(),'turn',1,'init');let calls=0;
 assert.throws(()=>advance(db,{...first,get revision(){calls++;return 1n}},a(20n),'turn',2,'op',[]),TypeError);
 assert.throws(()=>advance(db,first,a(20n),'turn',NaN,'op',[]),TypeError);assert.equal(calls,0);assert.deepEqual(read(db,'thread'),first);
}));
test('orphaned anchor after legacy deletion is a conflict rather than new-target permission',()=>run(db=>{
 fresh(db,'thread',a(),'turn',1,'init');db.exec('DELETE FROM codex_session_mirror_offsets');
 assert.throws(()=>read(db,'thread'),MirrorCursorConflictError);assert.throws(()=>fresh(db,'thread',a(),'turn',1,'again'),MirrorCursorConflictError);
}));
test('UTF16 store retains exact Unicode anchor and positive u64 receipt identity',()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec("PRAGMA encoding='UTF-16le'");legacy(db);schema(db);const first=fresh(db,'스레드',{...a(),path:resolve('한😀')},'턴',1,'init');receipt(db,'18446744073709551615');
  const next=advance(db,first,{...first.anchor,offset:20n},'다음',2,'op',receipts);assert.deepEqual(read(db,'스레드'),next);
 }finally{db.close()}
});
