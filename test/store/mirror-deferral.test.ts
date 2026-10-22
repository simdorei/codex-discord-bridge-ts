import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {resolve} from 'node:path';import {createHash} from 'node:crypto';
import {initializeMirrorDeferrals,insertMirrorDeferralIn,readMirrorDeferralIn,requireNoMirrorDeferralIn,MirrorDeferredError} from '../../src/store/mirror-deferral.ts';
import {initializeMirrorCursorJournal,initializeFreshMirrorCursor,readBoundMirrorCursor,advanceBoundMirrorCursor} from '../../src/store/mirror-cursor-journal.ts';
import {initializeMirrorStartupIntentJournal,prepareMirrorStartupIntent,retainPreparedMirrorStartupIntent,readPendingMirrorStartupIntent,readMirrorStartupTarget,verifyPendingMirrorStartupIntent,prepareMirrorStartupIntentCompletion,completePreparedMirrorStartupIntent,readPreparedMirrorStartupCompletion} from '../../src/store/mirror-startup-intent.ts';

const stamp={dev:1n,ino:2n,birthtimeNs:3n,mtimeNs:4n,ctimeNs:5n,size:0n},anchor={version:3 as const,path:resolve('held.jsonl'),offset:0n,stamp,prefixHash:'a'.repeat(64),tailHash:'a'.repeat(64),historyHash:'a'.repeat(64)};
function packet(thread:string){const evidenceJson=JSON.stringify({version:1,thread,policy:'rust-preserve'});return {thread,reason:'CompressedSource' as const,operationId:'hold-'+thread,createdAt:1,evidenceJson,evidenceSha256:createHash('sha256').update(evidenceJson).digest('hex')};}
function run(fn:(db:DatabaseSync)=>void){const db=new DatabaseSync(':memory:');try{db.exec('CREATE TABLE codex_session_mirror_offsets(codex_thread_id TEXT PRIMARY KEY,rollout_path TEXT,cursor INTEGER,updated_at REAL,turn_context TEXT);CREATE TABLE mirror_threads(codex_thread_id TEXT,discord_thread_id INTEGER)');initializeMirrorCursorJournal(db);initializeMirrorStartupIntentJournal(db);fn(db);}finally{if(db.isTransaction)db.exec('ROLLBACK');db.close();}}
function hold(db:DatabaseSync,thread:string){initializeMirrorDeferrals(db);db.exec('BEGIN IMMEDIATE');insertMirrorDeferralIn(db,packet(thread));db.exec('COMMIT');}
test('optional deferral schema is compatible when absent, rejects malformed presence and never initializes on reads',()=>run(db=>{
 requireNoMirrorDeferralIn(db,'t');assert.equal(readMirrorDeferralIn(db,'t'),null);assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='cdr_ts_mirror_deferrals_v1'").get(),undefined);
 db.exec('CREATE TABLE cdr_ts_mirror_deferrals_v1(wrong TEXT)');assert.throws(()=>requireNoMirrorDeferralIn(db,'t'),/schema/);assert.throws(()=>initializeMirrorDeferrals(db),/schema/);
}));
test('hold is insert-only, bounded and exact; polls block without loading the audit packet',()=>run(db=>{
 hold(db,'t');const before=readMirrorDeferralIn(db,'t');assert.deepEqual(before,packet('t'));
 db.exec('BEGIN');insertMirrorDeferralIn(db,packet('t'));assert.throws(()=>insertMirrorDeferralIn(db,{...packet('t'),operationId:'changed'}),/differs/);db.exec('ROLLBACK');
 assert.deepEqual(readMirrorDeferralIn(db,'t'),before);assert.throws(()=>requireNoMirrorDeferralIn(db,'t'),MirrorDeferredError);
 db.exec("UPDATE cdr_ts_mirror_deferrals_v1 SET evidence_json='corrupt'");assert.throws(()=>readMirrorDeferralIn(db,'t'));assert.throws(()=>requireNoMirrorDeferralIn(db,'t'),MirrorDeferredError);
 const huge=packet('huge');huge.evidenceJson='x'.repeat(262145);db.exec('BEGIN');assert.throws(()=>insertMirrorDeferralIn(db,huge));db.exec('ROLLBACK');
}));
test('cursor read, initialization and direct advance cannot bypass a hold',()=>run(db=>{
 const old=initializeFreshMirrorCursor(db,'t',anchor,'turn',1,'init'),rows=db.prepare('SELECT * FROM codex_session_mirror_offsets').all(),prior=db.prepare('SELECT * FROM cdr_ts_mirror_cursor_anchors_v1').all();
 hold(db,'t');assert.throws(()=>readBoundMirrorCursor(db,'t'),MirrorDeferredError);
 assert.throws(()=>initializeFreshMirrorCursor(db,'t',anchor,'turn',1,'init'),MirrorDeferredError);
 assert.throws(()=>advanceBoundMirrorCursor(db,old,anchor,'turn',2,'advance',[]),MirrorDeferredError);
 assert.deepEqual(db.prepare('SELECT * FROM codex_session_mirror_offsets').all(),rows);assert.deepEqual(db.prepare('SELECT * FROM cdr_ts_mirror_cursor_anchors_v1').all(),prior);
}));
test('pending, target, retain, verify and completion paths all reject before recovery history access',()=>run(db=>{
 const cutoff={path:anchor.path,offset:0n,stamp,anchor},prepared=prepareMirrorStartupIntent('t',cutoff,1,'startup'),pending=retainPreparedMirrorStartupIntent(db,prepared);
 const completed=prepareMirrorStartupIntentCompletion(pending,{anchor,continuity:'UnchangedMetadataAndAnchors',currentTurn:null,scannedBytes:0n,scannedRecords:0});
 db.prepare('INSERT INTO mirror_threads VALUES(?,?)').run('t',42);hold(db,'t');
 for(const call of [()=>readPendingMirrorStartupIntent(db,'t'),()=>readMirrorStartupTarget(db,'t',42n),()=>retainPreparedMirrorStartupIntent(db,prepared),()=>verifyPendingMirrorStartupIntent(db,pending),()=>completePreparedMirrorStartupIntent(db,completed),()=>readPreparedMirrorStartupCompletion(db,completed)])assert.throws(call,MirrorDeferredError);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM cdr_ts_mirror_startup_intents_v1').get()!.n,1);assert.equal(db.prepare('SELECT COUNT(*) n FROM codex_session_mirror_offsets').get()!.n,0);
}));
