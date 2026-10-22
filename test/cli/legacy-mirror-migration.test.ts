import {initializeMirrorStartupIntentJournal} from '../../src/store/mirror-startup-intent-schema.ts';
import {writeFileSync} from 'node:fs';
import {Worker} from 'node:worker_threads';
import {once} from 'node:events';
import {migrateMirrorRow} from '../../src/cli/mirror-migration-row.ts';
import {MigrationBudget} from '../../src/cli/legacy-mirror-turn.ts';
import {initializeMirrorCursorJournal} from '../../src/store/mirror-cursor-journal.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {storeFixture} from '../helpers/store-fixture.ts';
import {openInitialized} from '../../src/store/owned-driver.ts';
import {adminDatabase} from '../../src/cli/admin.ts';
import {readBoundMirrorCursor} from '../../src/store/mirror-cursor-journal.ts';

test('NULL legacy context recovers only the last turn before the saved cursor without replay',()=>storeFixture(async path=>{
 const log=join(dirname(path),'rollout.jsonl');
 const prefix=JSON.stringify({type:'turn_context',payload:{turn_id:'old'}})+'\n'+JSON.stringify({type:'event_msg',payload:{type:'task_started',turn_id:'한글-turn'}})+'\n';
 await writeFile(log,prefix+JSON.stringify({type:'turn_context',payload:{turn_id:'after-cursor'}})+'\n');
 const db=await openInitialized(path);db.prepare('INSERT INTO codex_session_mirror_offsets VALUES(?,?,?,?,?)').run('thread',log,Buffer.byteLength(prefix),123,null);db.close();
 const result=await adminDatabase({path},undefined,true);
 assert.deepEqual(result.held,[]);assert.deepEqual(result.migrated,['thread']);assert.equal(result.replayAuthorized,false);
 const check=new DatabaseSync(path);try{const row=readBoundMirrorCursor(check,'thread')!;assert.equal(row.turn,'한글-turn');assert.equal(row.anchor.offset,BigInt(Buffer.byteLength(prefix)));assert.equal(row.updatedAt,123);}finally{check.close();}
 const again=await adminDatabase({path},undefined,true);assert.deepEqual(again.already,['thread']);assert.deepEqual(again.held,[]);
}));

async function fixture(run:(db:DatabaseSync,log:string,path:string)=>Promise<void>,context:string|null=null){
 return storeFixture(async path=>{const log=join(dirname(path),'events.jsonl');await writeFile(log,JSON.stringify({type:'turn_context',payload:{turn_id:'turn'}})+'\n');const db=await openInitialized(path);
 db.prepare('INSERT INTO codex_session_mirror_offsets VALUES(?,?,?,?,?)').run('thread',log,Buffer.byteLength(await readFile(log)),123,context);initializeMirrorCursorJournal(db);
 try{await run(db,log,path);}finally{db.close();}});
}
function row(db:DatabaseSync){const q=db.prepare('SELECT * FROM codex_session_mirror_offsets');q.setReadBigInts(true);return q.get()!;}
function unchanged(db:DatabaseSync){assert.equal(row(db).turn_context,null);assert.equal(db.prepare('SELECT count(*) n FROM cdr_ts_mirror_cursor_anchors_v1').get()!.n,0);}
for(const context of ['', 'existing-turn'])test('preserves non-null context '+JSON.stringify(context),()=>fixture(async(db)=>{
 assert.equal(await migrateMirrorRow(db,row(db),new MigrationBudget()),'migrated');assert.equal(readBoundMirrorCursor(db,'thread')!.turn,context);
},context));

test('NULL with existing anchor is held without repairing either side',()=>fixture(async db=>{
 await migrateMirrorRow(db,row(db),new MigrationBudget());const before=db.prepare('SELECT * FROM cdr_ts_mirror_cursor_anchors_v1').get();db.exec('UPDATE codex_session_mirror_offsets SET turn_context=NULL');
 await assert.rejects(migrateMirrorRow(db,row(db),new MigrationBudget()),/NULL context conflicts/);assert.equal(row(db).turn_context,null);assert.deepEqual(db.prepare('SELECT * FROM cdr_ts_mirror_cursor_anchors_v1').get(),before);
}));
for(const assignment of ["cursor=0","turn_context='other'","updated_at=456","rollout_path='different'"])test('stale original row rejected: '+assignment,()=>fixture(async db=>{
 const original=row(db);db.exec('UPDATE codex_session_mirror_offsets SET '+assignment);const current=row(db);
 await assert.rejects(migrateMirrorRow(db,original,new MigrationBudget()),/changed/);assert.deepEqual(row(db),current);assert.equal(db.prepare('SELECT count(*) n FROM cdr_ts_mirror_cursor_anchors_v1').get()!.n,0);
}));
for(const stage of ['legacy','anchor'])test('failure after '+stage+' write rolls back both records',()=>fixture(async db=>{
 const table=stage==='legacy'?'codex_session_mirror_offsets':'cdr_ts_mirror_cursor_anchors_v1';const event=stage==='legacy'?'UPDATE':'INSERT';
 db.exec(`CREATE TRIGGER abort_test AFTER ${event} ON ${table} BEGIN SELECT RAISE(ABORT,'injected failure'); END`);
 await assert.rejects(migrateMirrorRow(db,row(db),new MigrationBudget()),/injected failure/);unchanged(db);
}));
test('file change after writes before commit is held and DB writes roll back',()=>fixture(async(db,log)=>{
 db.function('change_source',()=>{writeFileSync(log,'changed\n');return 1;});
 db.exec('CREATE TRIGGER change_test AFTER INSERT ON cdr_ts_mirror_cursor_anchors_v1 BEGIN SELECT change_source(); END');
 await assert.rejects(migrateMirrorRow(db,row(db),new MigrationBudget()),/changed/);unchanged(db);
}));
for(const size of [16384,16385])test('real runtime reader turn byte boundary '+size,()=>fixture(async(db,log)=>{
 const content=JSON.stringify({type:'turn_context',payload:{turn_id:'x'.repeat(size)}})+'\n';await writeFile(log,content);db.prepare('UPDATE codex_session_mirror_offsets SET cursor=?').run(Buffer.byteLength(content));
 if(size===16384){await migrateMirrorRow(db,row(db),new MigrationBudget());assert.equal(readBoundMirrorCursor(db,'thread')!.turn.length,size);}
 else{await assert.rejects(migrateMirrorRow(db,row(db),new MigrationBudget()),/Invalid bounded/);unchanged(db);}
}));
test('invalid preserved timestamp is held rather than committed',()=>fixture(async db=>{
 db.exec('UPDATE codex_session_mirror_offsets SET updated_at=-1');await assert.rejects(migrateMirrorRow(db,row(db),new MigrationBudget()));unchanged(db);assert.equal(row(db).updated_at,-1);
}));
test('missing source remains held without guessing context',()=>fixture(async(db)=>{
 db.prepare('UPDATE codex_session_mirror_offsets SET rollout_path=?').run('C:/missing-legacy-source-test.jsonl');await assert.rejects(migrateMirrorRow(db,row(db),new MigrationBudget()));unchanged(db);
}));
test('expired deadline and cancellation never initialize context',()=>fixture(async db=>{
 await assert.rejects(migrateMirrorRow(db,row(db),new MigrationBudget(-1)),/deadline/);unchanged(db);
 const controller=new AbortController();controller.abort(Error('cancelled migration'));await assert.rejects(migrateMirrorRow(db,row(db),new MigrationBudget(25000,controller.signal)),/cancelled/);unchanged(db);
}));
test('file changed by another writer during SQLite lock wait is rejected after lock acquisition',()=>fixture(async(db,log,path)=>{
 const original=row(db);db.exec('PRAGMA busy_timeout=3000');
 // Hold the DB lock from an independent native worker. Mutate the source before
 // releasing it; migration must not trust its pre-lock observation at commit.
 const worker=new Worker(`const {parentPort,workerData}=require('node:worker_threads');const {DatabaseSync}=require('node:sqlite');const {writeFileSync}=require('node:fs');const db=new DatabaseSync(workerData.path);db.exec('BEGIN IMMEDIATE');parentPort.postMessage('locked');setTimeout(()=>{writeFileSync(workerData.log,'changed during wait\\n');db.exec('COMMIT');db.close();parentPort.close();},500);`,{eval:true,workerData:{path,log}});
 const exited=once(worker,'exit');await once(worker,'message');
 try{await assert.rejects(migrateMirrorRow(db,original,new MigrationBudget()),/changed/);unchanged(db);}finally{await exited;}
}));

test('cancellation after anchor insert rolls back both writes',()=>fixture(async db=>{
 const controller=new AbortController();db.function('cancel_migration',()=>{controller.abort(Error('cancel during commit'));return 1;});
 db.exec('CREATE TRIGGER cancel_test AFTER INSERT ON cdr_ts_mirror_cursor_anchors_v1 BEGIN SELECT cancel_migration(); END');
 await assert.rejects(migrateMirrorRow(db,row(db),new MigrationBudget(25000,controller.signal)),/cancel during commit/);unchanged(db);
}));
test('deadline reached after final write cannot commit',()=>fixture(async db=>{
 db.function('delay_migration',()=>{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,200);return 1;});
 db.exec('CREATE TRIGGER delay_test AFTER INSERT ON cdr_ts_mirror_cursor_anchors_v1 BEGIN SELECT delay_migration(); END');
 await assert.rejects(migrateMirrorRow(db,row(db),new MigrationBudget(150)),/deadline/);unchanged(db);
}));
test('complete no-turn prefix migrates to initialized empty context',()=>fixture(async(db,log)=>{
 await writeFile(log,'{}\n');db.exec('UPDATE codex_session_mirror_offsets SET cursor=3');
 await migrateMirrorRow(db,row(db),new MigrationBudget());assert.equal(readBoundMirrorCursor(db,'thread')!.turn,'');
}));

test('pending startup intent prevents legacy adoption',()=>fixture(async db=>{
 initializeMirrorStartupIntentJournal(db);db.prepare('INSERT INTO cdr_ts_mirror_startup_intents_v1 VALUES(?,?,?,?)').run('thread','{}','pending-operation',1);
 await assert.rejects(migrateMirrorRow(db,row(db),new MigrationBudget()),/startup intent conflicts/);unchanged(db);
}));

test('legacy offset inside a record is explicitly held with original row preserved',()=>fixture(async db=>{
 db.exec('UPDATE codex_session_mirror_offsets SET cursor=2');await assert.rejects(migrateMirrorRow(db,row(db),new MigrationBudget()),/LF record boundary/);unchanged(db);assert.equal(row(db).cursor,2n);
}));
