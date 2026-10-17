import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {resolve,join} from 'node:path';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';
import {initializeMirrorCursorJournal as cursorSchema,initializeFreshMirrorCursor as fresh,readBoundMirrorCursor as cursor} from '../../src/store/mirror-cursor-journal.ts';
import {initializeMirrorStartupIntentJournal as schema,readPendingMirrorStartupIntent as read,verifyPendingMirrorStartupIntent as verify,prepareMirrorStartupIntent as prepare,retainPreparedMirrorStartupIntent as retain,MirrorStartupIntentConflictError as Conflict,MirrorStartupIntentSchemaError as SchemaError,type PreparedMirrorStartupIntent} from '../../src/store/mirror-startup-intent.ts';
import {StateAccessFacade as facade} from '../../src/store/state-access-facade.ts';
import type {MirrorStartupCutoffData} from '../../src/runtime/session-mirror/startup-context-limits.ts';
const TABLE='cdr_ts_mirror_startup_intents_v1',hash='a'.repeat(64);
function cutoff(offset=10n,held=false):MirrorStartupCutoffData {const path=resolve('original-rollout.jsonl'),stamp={dev:1n,ino:2n,birthtimeNs:3n,mtimeNs:4n,ctimeNs:5n,size:offset};return {path,offset,stamp,anchor:held?null:{version:1,path,offset,stamp,prefixHash:hash,tailHash:hash}};}
function legacy(db:DatabaseSync):void {db.exec('CREATE TABLE codex_session_mirror_offsets(codex_thread_id TEXT PRIMARY KEY,rollout_path TEXT NOT NULL,cursor INTEGER NOT NULL,updated_at REAL NOT NULL,turn_context TEXT)');}
function run(fn:(db:DatabaseSync)=>void):void {const db=new DatabaseSync(':memory:');try{legacy(db);cursorSchema(db);schema(db);fn(db);}finally{db.close();}}
function count(db:DatabaseSync,table=TABLE):number {return db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n as number;}
const plan=(input=cutoff(),thread='thread',at=1.25,operation='original')=>prepare(thread,input,at,operation);
function old(db:DatabaseSync):void {db.prepare('INSERT INTO codex_session_mirror_offsets VALUES(?,?,?,?,?)').run('thread',cutoff().path,10n,1.25,'turn');}

test('journal schema is separate opt-in, idempotent and leaves legacy SQL/version untouched',()=>run(db=>{
 const sql=db.prepare("SELECT sql FROM sqlite_schema WHERE name='codex_session_mirror_offsets'").get()!.sql;schema(db);assert.equal(read(db,'thread'),null);assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,0);assert.equal(db.prepare("SELECT sql FROM sqlite_schema WHERE name='codex_session_mirror_offsets'").get()!.sql,sql);
 assert.equal(facade.readPendingMirrorStartupIntent,read);assert.equal(facade.prepareMirrorStartupIntent,prepare);assert.equal(facade.retainPreparedMirrorStartupIntent,retain);assert.equal(facade.initializeMirrorStartupIntentJournal,schema);
}));
test('missing pending or bound schema holds reads and creation without implicit repair',()=>{
 for(const missing of [TABLE,'cdr_ts_mirror_cursor_anchors_v1'])run(db=>{db.exec(`DROP TABLE ${missing}`);assert.throws(()=>read(db,'thread'),missing===TABLE?SchemaError:/schema/);assert.throws(()=>retain(db,plan()));assert.equal(db.prepare('SELECT 1 FROM sqlite_schema WHERE name=?').get(missing),undefined);});
});
test('foreign table, view or case-variant schema is held unchanged',()=>{
 for(const ddl of [`CREATE TABLE ${TABLE}(x)`,`CREATE VIEW ${TABLE} AS SELECT 1 AS x`,`CREATE TABLE ${TABLE.toUpperCase()}(x)`])run(db=>{
  db.exec(`DROP TABLE ${TABLE};${ddl}`);const before=db.prepare('SELECT name,type,sql FROM sqlite_schema ORDER BY name').all();assert.throws(()=>schema(db),SchemaError);assert.throws(()=>read(db,'thread'),SchemaError);assert.throws(()=>retain(db,plan()),SchemaError);assert.deepEqual(db.prepare('SELECT name,type,sql FROM sqlite_schema ORDER BY name').all(),before);
 });
});
test('fresh intent stores exact cutoff/time/operation once and does not initialize any cursor',()=>run(db=>{
 const p=plan(),first=retain(db,p);assert.deepEqual(first,{thread:'thread',cutoff:cutoff(),createdAt:1.25,operationId:'original'});assert.deepEqual(read(db,'thread'),first);assert.deepEqual(retain(db,p),first);assert.deepEqual(retain(db,plan()),first);assert.equal(count(db),1);assert.equal(count(db,'codex_session_mirror_offsets'),0);assert.equal(count(db,'cdr_ts_mirror_cursor_anchors_v1'),0);
 assert.ok(Object.isFrozen(first)&&Object.isFrozen(first.cutoff)&&Object.isFrozen(first.cutoff.stamp)&&Object.isFrozen(first.cutoff.anchor));
}));
test('held incomplete EOF remains exact pending data and cannot become a later complete cutoff',()=>run(db=>{
 const first=retain(db,plan(cutoff(10n,true)));assert.equal(first.cutoff.anchor,null);assert.throws(()=>retain(db,plan(cutoff(11n))),Conflict);assert.throws(()=>retain(db,plan(cutoff())),Conflict);assert.deepEqual(read(db,'thread'),first);
}));
test('every changed retry field is rejected without replacing original',()=>run(db=>{
 const first=retain(db,plan()),other=cutoff();
 const changedPath={...other,path:resolve('changed.jsonl'),anchor:{...other.anchor!,path:resolve('changed.jsonl')}};
 const changedStamp={...other.stamp,mtimeNs:99n},changed={...other,stamp:changedStamp,anchor:{...other.anchor!,stamp:changedStamp}};
 for(const p of [plan(cutoff(11n)),plan(changedPath),plan(changed),plan({...other,anchor:{...other.anchor!,tailHash:'b'.repeat(64)}}),plan(other,'thread',2),plan(other,'thread',1.25,'new')])assert.throws(()=>retain(db,p),Conflict);
 assert.deepEqual(read(db,'thread'),first);assert.equal(count(db),1);
}));
test('operation identity cannot be reused for another thread',()=>run(db=>{
 retain(db,plan());assert.throws(()=>retain(db,plan(cutoff(),'other')),Conflict);assert.equal(read(db,'other'),null);assert.equal(count(db),1);
}));
test('existing legacy, bound or orphan bound state never becomes a pending startup',()=>{
 for(const kind of ['legacy','bound','orphan'])run(db=>{
  if(kind==='legacy')old(db);else{fresh(db,'thread',cutoff().anchor!,'turn',1.25,'bound');if(kind==='orphan')db.exec('DELETE FROM codex_session_mirror_offsets');}
  const before=db.prepare('SELECT * FROM codex_session_mirror_offsets').all();assert.equal(read(db,'thread'),null);assert.throws(()=>retain(db,plan()),Conflict);assert.equal(count(db),0);assert.deepEqual(db.prepare('SELECT * FROM codex_session_mirror_offsets').all(),before);
 });
});
test('existing pending prevents fresh/current bound cursor read, initialization or exact retry bypass',()=>run(db=>{
 const p=plan();retain(db,p);assert.throws(()=>fresh(db,'thread',cutoff().anchor!,'turn',1.25,'bound'),Conflict);assert.throws(()=>cursor(db,'thread'),Conflict);old(db);
 assert.throws(()=>retain(db,p),Conflict);assert.throws(()=>read(db,'thread'),Conflict);assert.throws(()=>cursor(db,'thread'),Conflict);assert.equal(count(db),1);assert.equal(count(db,'codex_session_mirror_offsets'),1);
}));
test('pending plus orphan bound row is held on read and exact retry',()=>run(db=>{
 const bound=fresh(db,'thread',cutoff().anchor!,'turn',1.25,'bound'),copy=db.prepare('SELECT * FROM cdr_ts_mirror_cursor_anchors_v1').get()!;
 db.exec('DELETE FROM codex_session_mirror_offsets;DELETE FROM cdr_ts_mirror_cursor_anchors_v1');const p=plan();retain(db,p);
 db.prepare('INSERT INTO cdr_ts_mirror_cursor_anchors_v1 VALUES(?,?,?,?,?,?,?)').run(bound.thread,copy.anchor_json!,bound.turn,bound.updatedAt,bound.revision,bound.operationId,bound.receiptSetHash);
 assert.throws(()=>read(db,'thread'),Conflict);assert.throws(()=>retain(db,p),Conflict);assert.equal(count(db),1);
}));
test('input is captured before apply; copied forged accessor and proxy plans cannot write',()=>run(db=>{
 const input=cutoff(),p=plan(input);Object.assign(input,{offset:999n});Object.assign(input.stamp,{size:999n});assert.equal(retain(db,p).cutoff.offset,10n);
 let calls=0;for(const bad of [{...p},Object.create(p),new Proxy(p,{get(){calls++;throw Error('trap');}}),Object.defineProperty({},'thread',{get(){calls++;return 'thread';}})])assert.throws(()=>retain(db,bad as PreparedMirrorStartupIntent),TypeError);
 assert.equal(calls,0);assert.equal(count(db),1);
}));
test('cutoff accessors/proxies, malformed identity, nonabsolute held paths and invalid seconds fail before write',()=>run(db=>{
 let calls=0;const a=cutoff();
 for(const value of [{...a,get offset(){calls++;return 10n;}},new Proxy(a,{get(){calls++;throw Error('trap');}}),{...a,stamp:{...a.stamp,size:11n}},{...a,anchor:null,path:'relative'},cutoff(0n,true)])assert.throws(()=>plan(value),TypeError);
 for(const at of [NaN,Infinity,-1])assert.throws(()=>plan(cutoff(),'thread',at),TypeError);
 for(const id of ['', 'x'.repeat(129),'\ud800'])assert.throws(()=>plan(cutoff(),'thread',1,id));
 assert.equal(calls,0);assert.equal(count(db),0);
}));
test('ABORT and IGNORE inserts roll back cleanly without orphan or implicit cursor',()=>{
 for(const mode of ['ABORT','IGNORE'])run(db=>{
  db.exec(`CREATE TRIGGER reject_intent BEFORE INSERT ON ${TABLE} BEGIN SELECT RAISE(${mode}${mode==='ABORT'?",'injected'":''}); END`);assert.throws(()=>retain(db,plan()));assert.equal(count(db),0);assert.equal(count(db,'codex_session_mirror_offsets'),0);assert.equal(db.isTransaction,false);
 });
});
test('post-insert corruption or cursor creation is detected and whole transaction rolls back',()=>{
 for(const sql of [`UPDATE ${TABLE} SET operation_id='changed'`,`UPDATE ${TABLE} SET cutoff_json='{}'`,"INSERT INTO codex_session_mirror_offsets VALUES('thread','other',0,0,'')",`DELETE FROM ${TABLE}`])run(db=>{
  db.exec(`CREATE TRIGGER corrupt_intent AFTER INSERT ON ${TABLE} BEGIN ${sql}; END`);assert.throws(()=>retain(db,plan()));assert.equal(count(db),0);assert.equal(count(db,'codex_session_mirror_offsets'),0);assert.equal(db.isTransaction,false);
 });
});
test('malformed, invalid UTF8, noncanonical and oversized stored data hold instead of absent',()=>{
 for(const sql of ["cutoff_json='{}'","cutoff_json=CAST(x'ff' AS TEXT)","cutoff_json=' '||cutoff_json","cutoff_json=CAST(zeroblob(524289) AS TEXT)","operation_id=CAST(x'ff' AS TEXT)","created_at=-1","created_at='invalid'","created_at=zeroblob(4194304)","created_at=CAST(zeroblob(4194304) AS TEXT)"])run(db=>{
  const p=plan();retain(db,p);db.exec(`PRAGMA ignore_check_constraints=ON;UPDATE ${TABLE} SET ${sql}`);assert.throws(()=>read(db,'thread'));assert.throws(()=>retain(db,p));assert.equal(count(db),1);assert.equal(db.isTransaction,false);
 });
});
test('nonnumeric timestamp storage never materializes its large value in JS rows',()=>{
 for(const sql of ['zeroblob(4194304)','CAST(zeroblob(4194304) AS TEXT)'])run(db=>{
  retain(db,plan());db.exec(`UPDATE ${TABLE} SET created_at=${sql}`);let projected=0;
  db.prepare=new Proxy(db.prepare,{apply(target,self,args){const statement=Reflect.apply(target,self,args) as ReturnType<DatabaseSync['prepare']>;
   if(typeof args[0]==='string'&&args[0].includes('SELECT cutoff_json,operation_id,created_at,'))statement.all=new Proxy(statement.all,{apply(query,receiver,parameters){const rows=Reflect.apply(query,receiver,parameters) as Record<string,unknown>[];assert.ok(rows[0]?.created_at===null,'Nonnumeric timestamp escaped bounded SQL projection');projected++;return rows;}});
   return statement;
  }});
  assert.throws(()=>read(db,'thread'));assert.equal(projected,1);
 });
});
test('caller transaction is never rolled back or committed by an owned operation',()=>run(db=>{
 db.exec('BEGIN');for(const fn of [()=>read(db,'thread'),()=>retain(db,plan()),()=>schema(db)]){assert.throws(fn);assert.equal(db.isTransaction,true);assert.equal(db.isOpen,true);}db.exec('ROLLBACK');assert.equal(count(db),0);
}));
test('file-backed reopen retains original cutoff and exact operation without file resampling',()=>{
 const dir=mkdtempSync(join(tmpdir(),'startup-journal-')),path=join(dir,'fake.db');let db=new DatabaseSync(path);
 try{legacy(db);cursorSchema(db);schema(db);const original=retain(db,plan());db.close();db=new DatabaseSync(path);assert.deepEqual(read(db,'thread'),original);assert.deepEqual(retain(db,plan()),original);assert.throws(()=>retain(db,plan(cutoff(50n))),Conflict);}finally{if(db.isOpen)db.close();rmSync(dir,{recursive:true,force:true});}
});
test('UTF16 store preserves exact Unicode, large integers and held EOF',()=>{
 const db=new DatabaseSync(':memory:');try{db.exec("PRAGMA encoding='UTF-16le'");legacy(db);cursorSchema(db);schema(db);const a=cutoff((1n<<63n)-1n,true),path=resolve('한😀');const original=retain(db,plan({...a,path},'스레드',1.125,'동작'));assert.deepEqual(read(db,'스레드'),original);assert.deepEqual(retain(db,plan({...a,path},'스레드',1.125,'동작')),original);schema(db);}finally{db.close();}
});

test('read-only exact-packet verification compares every field and never repairs missing or changed pending state',()=>run(db=>{
 const original=retain(db,plan()),before=db.prepare(`SELECT * FROM ${TABLE}`).all();verify(db,original);assert.equal(facade.verifyPendingMirrorStartupIntent,verify);
 const changedCutoff=cutoff(11n);
 for(const expected of [{...original,thread:'other'},{...original,operationId:'other'},{...original,createdAt:2},{...original,cutoff:changedCutoff},{...original,cutoff:cutoff(10n,true)}])assert.throws(()=>verify(db,expected),Conflict);
 assert.deepEqual(db.prepare(`SELECT * FROM ${TABLE}`).all(),before);assert.equal(db.isTransaction,false);
 db.exec('BEGIN');assert.throws(()=>verify(db,original));assert.equal(db.isTransaction,true);db.exec('ROLLBACK');
 db.exec(`DELETE FROM ${TABLE}`);assert.throws(()=>verify(db,original),Conflict);assert.equal(count(db),0);
}));
