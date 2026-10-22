import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,appendFile,unlink} from 'node:fs/promises';
import {writeFileSync,unlinkSync} from 'node:fs';
import {legacyDeferralFixture} from '../helpers/legacy-deferral-fixture.ts';
import {adminDatabase} from '../../src/cli/admin.ts';
import {legacyMirrorRows,inspectLegacyMirrorRow} from '../../src/cli/legacy-mirror-inspection.ts';
import {deferLegacyMirrorRow} from '../../src/cli/legacy-mirror-deferral.ts';
import {inspectLegacyCompressed} from '../../src/cli/legacy-mirror-source.ts';
import {initializeMirrorDeferrals,readMirrorDeferralIn,requireNoMirrorDeferralIn} from '../../src/store/mirror-deferral.ts';
import {initializeMirrorStartupIntentJournal} from '../../src/store/mirror-startup-intent-schema.ts';
import {rehearseMirrorMigration} from '../../src/cli/mirror-rehearsal.ts';
import {Worker} from 'node:worker_threads';
import {once} from 'node:events';
import {executeCutover,type CutoverState} from '../../src/cli/cutover.ts';

const anchors=(f:Parameters<Parameters<typeof legacyDeferralFixture>[0]>[0])=>f.db.prepare('SELECT * FROM cdr_ts_mirror_cursor_anchors_v1 ORDER BY thread_id').all();
const run=(f:Parameters<Parameters<typeof legacyDeferralFixture>[0]>[0])=>adminDatabase({path:f.path,statePath:f.statePath,policy:'rust-preserve'},undefined,true);
test('compressed, relocated, baseline conflict and ordinary legacy cases have complete isolated coverage',()=>legacyDeferralFixture(async f=>{
 const before=legacyMirrorRows(f.db),prior=anchors(f);
 assert.equal((await rehearseMirrorMigration(f.path,f.statePath)).ready,false);
 const preview=await rehearseMirrorMigration(f.path,f.statePath,undefined,undefined,'rust-preserve');
 assert.equal(preview.ready,true);assert.equal(preview.migration.inactivePreserved.length,2);assert.equal(preview.migration.deferred.length,7);assert.deepEqual(preview.migration.migrated,['good']);
 assert.deepEqual(legacyMirrorRows(f.db),before);assert.deepEqual(anchors(f),prior);
 assert.equal(f.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='cdr_ts_mirror_deferrals_v1'").get(),undefined);
 const result=await run(f);assert.deepEqual(result.held,[]);assert.equal(result.deferred.length,7);
 assert.deepEqual(legacyMirrorRows(f.db),before);assert.deepEqual(anchors(f).filter(x=>x.thread_id!=='good'),prior);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM cdr_ts_mirror_deferrals_v1').get()!.n,7);
 assert.equal(result.inactivePreserved.find((x:any)=>x.thread==='archived').classification,'ArchivedRelocatedCompressedCandidate');
 for(const row of result.deferred.filter((x:any)=>x.evidence.compressed!==null)){assert.equal(row.evidence.compressed.bytesRead,4);assert.equal(row.evidence.compressed.contentsVerified,false);}
}));
test('materialization, source progress and retry never release or overwrite original hold evidence',()=>legacyDeferralFixture(async f=>{
 await run(f);const holds=f.db.prepare('SELECT * FROM cdr_ts_mirror_deferrals_v1 ORDER BY thread_id').all(),prior=anchors(f);
 for(const id of f.bound)await writeFile(f.files[id]!,f.body+'{}\n');
 await appendFile(f.files.drift!,'{}\n');f.db.prepare("UPDATE codex_session_mirror_offsets SET cursor=cursor+3,turn_context='new',updated_at=999 WHERE codex_thread_id='drift'").run();
 const rows=legacyMirrorRows(f.db),result=await run(f);assert.deepEqual(result.held,[]);assert.equal(result.deferred.length,7);
 assert.deepEqual(legacyMirrorRows(f.db),rows);assert.deepEqual(anchors(f),prior);assert.deepEqual(f.db.prepare('SELECT * FROM cdr_ts_mirror_deferrals_v1 ORDER BY thread_id').all(),holds);
 for(const id of [...f.bound,'drift','unbound','archived'])assert.throws(()=>requireNoMirrorDeferralIn(f.db,id),/durably deferred/);
}));
for(const change of ['cursor','context','time','anchor','mapping','state','work','file','intent','timeout'])test('durable deferral rechecks '+change+' before committing',()=>legacyDeferralFixture(async f=>{
 initializeMirrorDeferrals(f.db);const id='bound0',row=legacyMirrorRows(f.db,id)[0]!,expected=inspectLegacyMirrorRow(f.db,f.state,row,'rust-preserve',()=>{});let check=()=>{};
 if(change==='cursor')f.db.prepare('UPDATE codex_session_mirror_offsets SET cursor=cursor+1 WHERE codex_thread_id=?').run(id);
 if(change==='context')f.db.prepare("UPDATE codex_session_mirror_offsets SET turn_context='changed' WHERE codex_thread_id=?").run(id);
 if(change==='time')f.db.prepare('UPDATE codex_session_mirror_offsets SET updated_at=456 WHERE codex_thread_id=?').run(id);
 if(change==='anchor')f.db.prepare("UPDATE cdr_ts_mirror_cursor_anchors_v1 SET operation_id='changed' WHERE thread_id=?").run(id);
 if(change==='mapping')f.db.prepare('UPDATE mirror_threads SET discord_thread_id=999 WHERE codex_thread_id=?').run(id);
 if(change==='state')f.state.prepare('UPDATE threads SET archived=1 WHERE id=?').run(id);
 if(change==='work')f.db.prepare('INSERT INTO codex_goal_progress(thread,turn,channel,content,last_error,job_id)VALUES(?,?,?,?,?,?)').run(id,'t',1,'pending','','job');
 if(change==='file')await writeFile(f.files[id]!,f.body);
 if(change==='intent'){initializeMirrorStartupIntentJournal(f.db);f.db.prepare('INSERT INTO cdr_ts_mirror_startup_intents_v1 VALUES(?,?,?,?)').run(id,'{}','pending',1);}
 if(change==='timeout')check=()=>{throw Error('deadline');};
 const rows=legacyMirrorRows(f.db),prior=anchors(f);assert.throws(()=>deferLegacyMirrorRow(f.db,f.state,row,expected,check));
 assert.equal(f.db.isTransaction,false);assert.deepEqual(legacyMirrorRows(f.db),rows);assert.deepEqual(anchors(f),prior);assert.equal(readMirrorDeferralIn(f.db,id),null);
}));
for(const sql of ["SELECT RAISE(ABORT,'injected')","DELETE FROM cdr_ts_mirror_cursor_anchors_v1 WHERE thread_id='bound0'","UPDATE codex_session_mirror_offsets SET cursor=0 WHERE codex_thread_id='unbound'"])
 test('hold insert failure or trigger effects roll back atomically: '+sql.slice(0,24),()=>legacyDeferralFixture(async f=>{
  initializeMirrorDeferrals(f.db);const row=legacyMirrorRows(f.db,'bound0')[0]!,expected=inspectLegacyMirrorRow(f.db,f.state,row,'rust-preserve',()=>{}),prior=anchors(f),rows=legacyMirrorRows(f.db);
  f.db.exec('CREATE TRIGGER injected AFTER INSERT ON cdr_ts_mirror_deferrals_v1 BEGIN '+sql+'; END');
  assert.throws(()=>deferLegacyMirrorRow(f.db,f.state,row,expected,()=>{}));assert.deepEqual(anchors(f),prior);assert.deepEqual(legacyMirrorRows(f.db),rows);assert.equal(readMirrorDeferralIn(f.db,'bound0'),null);
 }));
test('counterpart errors never become absence or valid history, and a plain source always wins',()=>legacyDeferralFixture(async f=>{
 const file=f.files.bound0!;await writeFile(file+'.zst',Buffer.from('28b5','hex'));
 let row=legacyMirrorRows(f.db,'bound0')[0]!;assert.equal(inspectLegacyMirrorRow(f.db,f.state,row,'rust-preserve',()=>{}).disposition,'Held');
 await writeFile(file,f.body);assert.equal(inspectLegacyMirrorRow(f.db,f.state,row,'rust-preserve',()=>{}).classification,'LFAligned');
 await unlink(file);await writeFile(file+'.zst',Buffer.from('28b52ffd','hex'));
 for(const change of ['replace','remove','plain']){let calls=0;
  assert.throws(()=>inspectLegacyCompressed(file,()=>{if(++calls===2){if(change==='replace')writeFileSync(file+'.zst',Buffer.from('28b52ffd0000','hex'));if(change==='remove')unlinkSync(file+'.zst');if(change==='plain')writeFileSync(file,f.body);}}));
  if(change==='plain')await unlink(file);await writeFile(file+'.zst',Buffer.from('28b52ffd','hex'));
 }
}));
test('inactive work, unknown optional schemas and unsafe baseline conflicts stay fatal',()=>legacyDeferralFixture(async f=>{
 f.db.prepare('INSERT INTO codex_goal_progress(thread,turn,channel,content,last_error,job_id)VALUES(?,?,?,?,?,?)').run('archived','t',1,'pending','','job');
 assert.equal(inspectLegacyMirrorRow(f.db,f.state,legacyMirrorRows(f.db,'archived')[0]!,'rust-preserve',()=>{}).disposition,'Held');
 f.db.prepare("UPDATE cdr_ts_mirror_cursor_anchors_v1 SET revision=2 WHERE thread_id='drift'").run();
 const result=await run(f);assert.ok(result.held.some((x:any)=>x.thread==='drift'));assert.ok(result.held.some((x:any)=>x.thread==='archived'));
 f.db.exec('CREATE TABLE cdr_ts_mirror_startup_intents_v1(broken TEXT)');
 assert.throws(()=>inspectLegacyMirrorRow(f.db,f.state,legacyMirrorRows(f.db,'bound0')[0]!,'rust-preserve',()=>{}));
}));
for(const sql of ["UPDATE codex_session_mirror_offsets SET updated_at=555 WHERE codex_thread_id='bound0'","UPDATE mirror_threads SET discord_thread_id=555 WHERE codex_thread_id='bound0'"])
 test('a competing commit while waiting for the write lock is rechecked',()=>legacyDeferralFixture(async f=>{
  initializeMirrorDeferrals(f.db);assert.equal(f.db.prepare('PRAGMA journal_mode=WAL').get()!.journal_mode,'wal');f.db.exec('PRAGMA busy_timeout=2000');const row=legacyMirrorRows(f.db,'bound0')[0]!,expected=inspectLegacyMirrorRow(f.db,f.state,row,'rust-preserve',()=>{});
  const workerUrl=new URL('../helpers/deferral-lock-race-worker.ts',import.meta.url);if(import.meta.url.endsWith('.js'))workerUrl.pathname=workerUrl.pathname.replace(/\.ts$/,'.js');
  const worker=new Worker(workerUrl,{workerData:{path:f.path,sql}}),exit=once(worker,'exit');
  try{
   const [message]=await once(worker,'message');assert.equal(message,'locked');let caught:unknown;
   try{deferLegacyMirrorRow(f.db,f.state,row,expected,()=>{});}catch(error){caught=error;}
   await exit;assert.match(String(caught),/changed/,JSON.stringify({sql,row,current:legacyMirrorRows(f.db,'bound0')[0],mapping:f.db.prepare("SELECT discord_thread_id FROM mirror_threads WHERE codex_thread_id='bound0'").get()},(_,v)=>typeof v==='bigint'?v.toString():v));
   assert.equal(readMirrorDeferralIn(f.db,'bound0'),null);
  }finally{await worker.terminate();}
 }));
test('registration failure, Rust progress and a second failed registration preserve holds and every current cursor',()=>legacyDeferralFixture(async f=>{
 let originalHolds:unknown;const prior=anchors(f);
 for(let attempt=0;attempt<2;attempt++){
  const cutover:CutoverState={version:1,operation:'fixture-'+attempt,phase:'inventoried',root:'fixture',entry:'fixture',node:'fixture',binary:'fixture',env:'fixture',taskName:'fixture',taskArguments:'',disableText:'fixture',stopText:'fixture',inventory:null,backup:null,target:null,legacyMirrorPolicy:'rust-preserve'};
  await assert.rejects(executeCutover(cutover,{save:async()=>{},perform:async action=>{
   if(action==='rehearse-store')return rehearseMirrorMigration(f.path,f.statePath,undefined,undefined,'rust-preserve');
   if(action==='migrate-store')return run(f);
   if(action==='install-target')throw Error('injected registration failure');
   if(action==='restore-legacy'){await appendFile(f.files.drift!,'{}\n');f.db.prepare("UPDATE codex_session_mirror_offsets SET cursor=cursor+3,updated_at=updated_at+1 WHERE codex_thread_id='drift'").run();}
   return null;
  }}),/source configuration was restored/);
  assert.equal(cutover.phase,'rolled_back');assert.equal(cutover.failurePhase,'installing_target');
  const saved=f.db.prepare('SELECT * FROM cdr_ts_mirror_deferrals_v1 ORDER BY thread_id').all();if(attempt===0)originalHolds=saved;else assert.deepEqual(saved,originalHolds);
  assert.deepEqual(anchors(f).filter(x=>x.thread_id!=='good'),prior);
 }
}));
