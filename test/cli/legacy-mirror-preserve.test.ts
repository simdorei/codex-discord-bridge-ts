import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {dirname,join} from 'node:path';
import {writeFile,appendFile,unlink} from 'node:fs/promises';
import {storeFixture} from '../helpers/store-fixture.ts';
import {openInitialized} from '../../src/store/owned-driver.ts';
import {adminDatabase} from '../../src/cli/admin.ts';
import {rehearseMirrorMigration} from '../../src/cli/mirror-rehearsal.ts';
import {legacyMirrorPolicy} from '../../src/cli/legacy-mirror-policy.ts';
import {inspectLegacyMirrorRow,preserveLegacyMirrorRow,legacyMirrorRows} from '../../src/cli/legacy-mirror-inspection.ts';
import {initializeMirrorCursorJournal} from '../../src/store/mirror-cursor-journal.ts';
import {initializeMirrorStartupIntentJournal} from '../../src/store/mirror-startup-intent-schema.ts';
import {admitIngress} from '../../src/store/ingress-admission.ts';
import {recoverBoundedPriorRuntimeIngressIn} from '../../src/store/startup-ingress-recovery.ts';

async function fixture(run:(f:{path:string;statePath:string;db:DatabaseSync;state:DatabaseSync;log:string;archived:string})=>Promise<void>){
 await storeFixture(async path=>{
  const log=join(dirname(path),'active.jsonl'),archived=join(dirname(path),'archive.jsonl'),statePath=join(dirname(path),'state.sqlite');
  const text=JSON.stringify({type:'turn_context',payload:{turn_id:'prior-turn'}})+'\n';await writeFile(log,text);await writeFile(archived,text);
  const db=await openInitialized(path),state=new DatabaseSync(statePath);state.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,archived INTEGER)');
  for(const [id,file,cursor] of [['good',log,Buffer.byteLength(text)],['bad',log,2],['archived',archived+'.missing',3],['orphan',log+'.missing',3]] as const){
   db.prepare('INSERT INTO codex_session_mirror_offsets VALUES(?,?,?,?,?)').run(id,file,cursor,123,null);
   if(id!=='orphan')state.prepare('INSERT INTO threads VALUES(?,?,?)').run(id,id==='archived'?archived:log,id==='archived'?1:0);
   if(id==='good'||id==='bad')db.prepare('INSERT INTO mirror_threads VALUES(?,?,?,?,?,?)').run(id,'project','fixture',1,id==='good'?42:43,123);
  }
  try{await run({path,statePath,db,state,log,archived});}finally{if(db.isTransaction)db.exec('ROLLBACK');state.close();db.close();}
 });
}
const selected=(db:DatabaseSync,id:string)=>legacyMirrorRows(db,id)[0]!;
const inspect=(f:Parameters<Parameters<typeof fixture>[0]>[0],id:string)=>inspectLegacyMirrorRow(f.db,f.state,selected(f.db,id),'rust-preserve',()=>{});
test('policy is opt-in and rejects misspelling',()=>{
 assert.equal(legacyMirrorPolicy(undefined),'strict');assert.equal(legacyMirrorPolicy('rust-preserve'),'rust-preserve');
 for(const v of [null,'preserve','',true])assert.throws(()=>legacyMirrorPolicy(v),/Invalid legacy mirror policy/);
});
test('mixed real rehearsal covers every row and preserves production; strict still holds',()=>fixture(async f=>{
 const before=legacyMirrorRows(f.db);
 const strict=await rehearseMirrorMigration(f.path,f.statePath);assert.equal(strict.ready,false);assert.equal(strict.migration.held.length,3);
 const result=await rehearseMirrorMigration(f.path,f.statePath,undefined,undefined,'rust-preserve');
 assert.equal(result.ready,true);assert.equal(result.status,'ReadyWithDeferredMirrors');
 assert.deepEqual(result.migration.migrated,['good']);assert.equal(result.migration.inactivePreserved.length,2);assert.equal(result.migration.deferred.length,1);assert.deepEqual(result.migration.held,[]);
 assert.deepEqual(legacyMirrorRows(f.db),before);assert.equal(f.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='cdr_ts_mirror_cursor_anchors_v1'").get(),undefined);
}));
test('real migration binds only valid row, retains exact inactive/deferred fields, and is repeatable',()=>fixture(async f=>{
 const before=legacyMirrorRows(f.db).filter(r=>r.codex_thread_id!=='good');
 const run=()=>adminDatabase({path:f.path,statePath:f.statePath,policy:'rust-preserve'},undefined,true);
 const result=await run();assert.deepEqual(result.held,[]);assert.deepEqual(result.migrated,['good']);assert.equal(result.historicalDeliveryVerified,false);
 assert.deepEqual(legacyMirrorRows(f.db).filter(r=>r.codex_thread_id!=='good'),before);
 assert.deepEqual(f.db.prepare('SELECT thread_id FROM cdr_ts_mirror_cursor_anchors_v1').all().map(r=>r.thread_id),['good']);
 const again=await run();assert.deepEqual(again.already,['good']);assert.deepEqual(again.held,[]);assert.deepEqual(again.deferred.map((r:any)=>r.thread),['bad']);
}));
test('undelivered outbox without queue is a fatal inactive hold',()=>fixture(async f=>{
 f.db.prepare('INSERT INTO codex_delivery_outbox(delivery_id,job_id,target_thread_id,turn_id,channel_id,content,created_at,updated_at)VALUES(?,?,?,?,?,?,?,?)').run('d','j','archived','turn',1,'fixture',1,1);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM codex_turn_queue').get()!.n,0);
 const value=inspect(f,'archived');assert.equal(value.disposition,'Held');assert.match(value.reason,/undelivered result/);
 const migrated=await adminDatabase({path:f.path,statePath:f.statePath,policy:'rust-preserve'},undefined,true);
 assert.ok(migrated.held.some((r:any)=>r.thread==='archived'));assert.equal(f.db.prepare('SELECT COUNT(*) n FROM codex_delivery_outbox').get()!.n,1);
}));
test('unowned held ingress stays inert through compatibility migration and actual startup recovery',()=>fixture(async f=>{
 await admitIngress(f.path,{ingressId:'held-request',kind:'message',eventId:7n,applicationId:null,channelId:1n,ownerUserId:2n,sourceMessageId:7n,payload:{version:1n},targetThreadId:'archived',canonicalOwner:null,now:1});
 f.db.exec("UPDATE discord_ingress_journal SET state='held',phase='staged',runtime_id='old',notice_staged=1");
 const before=f.db.prepare('SELECT * FROM discord_ingress_journal').all();
 assert.equal(inspect(f,'archived').disposition,'InactivePreserved');assert.equal(inspect(f,'archived').dormantHeld,1);
 const result=await adminDatabase({path:f.path,statePath:f.statePath,policy:'rust-preserve'},undefined,true);assert.equal(result.dormantHeldIngress,1);
 f.db.exec('BEGIN IMMEDIATE');try{assert.equal(recoverBoundedPriorRuntimeIngressIn(f.db,'new',2,{maxRows:128,maxBytes:1048576}),0);f.db.exec('COMMIT');}catch(e){f.db.exec('ROLLBACK');throw e;}
 assert.deepEqual(f.db.prepare('SELECT * FROM discord_ingress_journal').all(),before);
 for(const table of ['codex_turn_queue','codex_delivery_outbox','codex_commentary_outbox'])assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n,0);
 f.db.exec("UPDATE discord_ingress_journal SET state='staged'");assert.equal(inspect(f,'archived').disposition,'Held');
}));
for(const change of ['row','mapping','work','state','file','intent','anchor','timeout'])test('preservation rechecks '+change+' after initial observation',()=>fixture(async f=>{
 const id=change==='file'||change==='anchor'?'bad':'archived',row=selected(f.db,id),observed=inspect(f,id);let check=()=>{};
 if(change==='row')f.db.prepare('UPDATE codex_session_mirror_offsets SET updated_at=456 WHERE codex_thread_id=?').run(id);
 if(change==='mapping')f.db.prepare('INSERT INTO mirror_threads VALUES(?,?,?,?,?,?)').run(id,'p','t',1,99,1);
 if(change==='work')f.db.prepare('INSERT INTO codex_goal_progress(thread,turn,channel,content,last_error,job_id)VALUES(?,?,?,?,?,?)').run(id,'turn',1,'result','','job');
 if(change==='state')f.state.prepare('UPDATE threads SET archived=0 WHERE id=?').run(id);
 if(change==='file')await appendFile(f.log,'{}\n');
 if(change==='intent'){initializeMirrorStartupIntentJournal(f.db);f.db.prepare('INSERT INTO cdr_ts_mirror_startup_intents_v1 VALUES(?,?,?,?)').run(id,'{}','pending',1);}
 if(change==='anchor'){initializeMirrorCursorJournal(f.db);f.db.prepare('INSERT INTO cdr_ts_mirror_cursor_anchors_v1 VALUES(?,?,?,?,?,?,?)').run(id,'{}','',1,1,'old','0'.repeat(64));}
 if(change==='timeout')check=()=>{throw new Error('deadline exceeded');};
 const before=selected(f.db,id);assert.throws(()=>preserveLegacyMirrorRow(f.db,f.state,row,observed,check));assert.equal(f.db.isTransaction,false);assert.deepEqual(selected(f.db,id),before);
}));
test('changed live eligibility after a successful preview is not reused by real migration',()=>fixture(async f=>{
 assert.equal((await rehearseMirrorMigration(f.path,f.statePath,undefined,undefined,'rust-preserve')).ready,true);
 await unlink(f.log);
 const actual=await adminDatabase({path:f.path,statePath:f.statePath,policy:'rust-preserve'},undefined,true);
 assert.ok(actual.held.some((r:any)=>r.thread==='bad'));assert.ok(actual.held.some((r:any)=>r.thread==='good'));assert.equal(actual.deferred.length,0);
}));
for(const kind of ['missing core','malformed state','malformed optional'])test(kind+' is not a preserved legacy exception',()=>fixture(async f=>{
 if(kind==='missing core')f.db.exec('DROP TABLE codex_delivery_outbox');
 if(kind==='malformed state')f.state.exec('DROP TABLE threads');
 if(kind==='malformed optional')f.db.exec('CREATE TABLE cdr_ts_mirror_startup_intents_v1(wrong TEXT)');
 assert.throws(()=>inspect(f,'archived'));
}));
test('an existing TS anchor never becomes a legacy non-LF deferral',()=>fixture(async f=>{
 initializeMirrorCursorJournal(f.db);f.db.prepare('INSERT INTO cdr_ts_mirror_cursor_anchors_v1 VALUES(?,?,?,?,?,?,?)').run('bad','{}','',1,1,'old','0'.repeat(64));
 await assert.rejects(rehearseMirrorMigration(f.path,f.statePath,undefined,undefined,'rust-preserve'),e=>String((e as Error).cause).includes('Existing TS anchor'));
}));
