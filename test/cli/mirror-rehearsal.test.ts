import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {dirname,join} from 'node:path';
import {readFile,writeFile,readdir,copyFile} from 'node:fs/promises';
import {storeFixture} from '../helpers/store-fixture.ts';
import {openInitialized} from '../../src/store/owned-driver.ts';
import {rehearseMirrorMigration,type RehearsalPorts} from '../../src/cli/mirror-rehearsal.ts';

async function setup(path:string){
 const log=join(dirname(path),'events.jsonl'),statePath=join(dirname(path),'state.sqlite');
 const prefix=JSON.stringify({type:'turn_context',payload:{turn_id:'before'}})+'\n';await writeFile(log,prefix);
 const source=await openInitialized(path);source.exec('PRAGMA journal_mode=WAL');source.prepare('INSERT INTO codex_session_mirror_offsets VALUES(?,?,?,?,?)').run('thread',log,Buffer.byteLength(prefix),123,null);
 const state=new DatabaseSync(statePath);state.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,archived INTEGER)');state.prepare('INSERT INTO threads VALUES(?,?,0)').run('thread',log);state.close();return {source,log,statePath};
}
test('real rehearsal includes live WAL, changes only isolated copy and retains immutable backup',()=>storeFixture(async path=>{
 const f=await setup(path);try{
  const before=await readFile(path),report=await rehearseMirrorMigration(path,f.statePath);
  assert.equal(report.ready,true);assert.equal(report.sourceMutated,false);assert.deepEqual(report.migration.migrated,['thread']);
  assert.equal(report.diagnostics.details[0].classification,'LFAligned');assert.deepEqual(await readFile(path),before);
  assert.equal(f.source.prepare('SELECT turn_context FROM codex_session_mirror_offsets').get()!.turn_context,null);
  const preserved=new DatabaseSync(report.backup,{readOnly:true});try{assert.equal(preserved.prepare('SELECT turn_context FROM codex_session_mirror_offsets').get()!.turn_context,null);assert.equal(preserved.prepare("SELECT count(*) n FROM sqlite_master WHERE name='cdr_ts_mirror_cursor_anchors_v1'").get()!.n,0);}finally{preserved.close();}
  assert.ok(!(await readdir(dirname(report.backup))).some(n=>n.startsWith('rehearsal-')));
 }finally{f.source.close();}
}));
test('archive relocation, absent state and nonLF remain held without cursor retargeting',()=>storeFixture(async path=>{
 const f=await setup(path);try{
  const archived=join(dirname(path),'archived.jsonl');await writeFile(archived,'{}\n');
  const state=new DatabaseSync(f.statePath);state.prepare('INSERT INTO threads VALUES(?,?,1)').run('archived',archived);state.close();
  f.source.prepare('UPDATE codex_session_mirror_offsets SET cursor=3').run();
  for(const id of ['archived','orphan'])f.source.prepare('INSERT INTO codex_session_mirror_offsets VALUES(?,?,?,?,?)').run(id,join(dirname(path),id+'-missing.jsonl'),3,123,null);
  const report=await rehearseMirrorMigration(path,f.statePath);assert.equal(report.ready,false);assert.equal(report.migration.held.length,3);
  const kinds=Object.fromEntries(report.diagnostics.details.map((r:any)=>[r.thread,r.classification]));
  assert.deepEqual(kinds,{archived:'ArchivedRelocatedCandidate',orphan:'MissingState',thread:'NonRecordBoundary'});
  assert.ok(report.diagnostics.details.every((r:any)=>r.retargetAuthorized===false));
  assert.equal(f.source.prepare('SELECT cursor FROM codex_session_mirror_offsets WHERE codex_thread_id=?').get('thread')!.cursor,3);
 }finally{f.source.close();}
}));
test('state unavailable is an error with retained evidence, never MissingState or Ready',()=>storeFixture(async path=>{
 const f=await setup(path);try{await assert.rejects(rehearseMirrorMigration(path,join(dirname(path),'absent.sqlite')),e=>{assert.match((e as Error).message,/retained/);assert.match(String((e as Error).cause),/Reconciliation unavailable/);return true;});
  assert.equal(f.source.prepare('SELECT turn_context FROM codex_session_mirror_offsets').get()!.turn_context,null);
 }finally{f.source.close();}
}));
test('a migratable LF cursor with no state thread still blocks cutover',()=>storeFixture(async path=>{
 const f=await setup(path);try{const state=new DatabaseSync(f.statePath);state.exec('DELETE FROM threads');state.close();
  const report=await rehearseMirrorMigration(path,f.statePath);assert.equal(report.ready,false);assert.deepEqual(report.migration.held,[]);assert.deepEqual(report.metadataHolds,[{thread:'thread',reason:'MissingState'}]);
 }finally{f.source.close();}
}));
test('state path changes never authorize an otherwise migratable cursor',()=>storeFixture(async path=>{
 const f=await setup(path);try{const state=new DatabaseSync(f.statePath);state.prepare('UPDATE threads SET rollout_path=?').run(f.log+'.different');state.close();
  const report=await rehearseMirrorMigration(path,f.statePath);assert.equal(report.ready,false);assert.equal(report.metadataHolds[0].reason,'StatePathMismatch');
 }finally{f.source.close();}
}));
test('oversize state metadata fails explicitly rather than being classified as absent',()=>storeFixture(async path=>{
 const f=await setup(path);try{const state=new DatabaseSync(f.statePath);state.prepare('UPDATE threads SET rollout_path=?').run('x'.repeat(32769));state.close();
  await assert.rejects(rehearseMirrorMigration(path,f.statePath),e=>String((e as Error).cause).includes('state metadata invalid'));
 }finally{f.source.close();}
}));
for(const failure of ['worker error','timeout','cleanup failure'])test(failure+' is not promoted to readiness',()=>storeFixture(async path=>{
 await writeFile(path,'source');let cleanupCalls=0;
 const ports:RehearsalPorts={snapshot:async p=>{const b=p+'.backup';await copyFile(p,b);return b;},worker:async kind=>{
  if(failure!=='cleanup failure')throw new Error(failure);
  return kind==='reconcile'?{details:[]}:{held:[],migrated:[],already:[]};
 },cleanup:async()=>{cleanupCalls++;throw new Error(failure);}};
 await assert.rejects(rehearseMirrorMigration(path,'unused',undefined,ports),/retained/);assert.equal(cleanupCalls,failure==='cleanup failure'?1:0);assert.equal(await readFile(path,'utf8'),'source');
}));
test('incomplete migration response cannot pass',()=>storeFixture(async path=>{
 await writeFile(path,'source');const ports:RehearsalPorts={snapshot:async p=>{const b=p+'.backup';await copyFile(p,b);return b;},worker:async kind=>kind==='reconcile'?{details:[{thread:'missing'}]}:{held:[],migrated:[],already:[]},cleanup:async()=>{throw Error('must not clean unknown output');}};
 await assert.rejects(rehearseMirrorMigration(path,'unused',undefined,ports),e=>String((e as Error).cause).includes('Incomplete rehearsal coverage'));
}));
