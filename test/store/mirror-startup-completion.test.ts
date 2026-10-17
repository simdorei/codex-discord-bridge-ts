import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {encodeMirrorCursorAnchor} from '../../src/core/mirror-cursor-anchor.ts';
import {
 initializeMirrorCursorJournal,readBoundMirrorCursor,type BoundMirrorCursor,
} from '../../src/store/mirror-cursor-journal.ts';
import {
 initializeMirrorStartupIntentJournal,prepareMirrorStartupIntent,retainPreparedMirrorStartupIntent,
 readPendingMirrorStartupIntent,prepareMirrorStartupIntentCompletion as prepare,
 readPreparedMirrorStartupCompletion as read,completePreparedMirrorStartupIntent as complete,
 MirrorStartupIntentConflictError as Conflict,type PendingMirrorStartupIntent,
 type PreparedMirrorStartupCompletion,
} from '../../src/store/mirror-startup-intent.ts';
import {StateAccessFacade as facade} from '../../src/store/state-access-facade.ts';
import type {MirrorStartupCutoffData,MirrorStartupContextResult} from '../../src/runtime/session-mirror/startup-context-limits.ts';

const PENDING='cdr_ts_mirror_startup_intents_v1',BOUND='cdr_ts_mirror_cursor_anchors_v1',LEGACY='codex_session_mirror_offsets';
const HASH='a'.repeat(64),EMPTY_HASH=createHash('sha256').update('[]').digest('hex');
function cutoff(offset=10n):MirrorStartupCutoffData {
 const path=resolve('synthetic-startup-completion.jsonl');
 const stamp={dev:1n,ino:2n,birthtimeNs:3n,mtimeNs:4n,ctimeNs:5n,size:offset};
 return {path,offset,stamp,anchor:{version:1,path,offset,stamp,prefixHash:HASH,tailHash:HASH}};
}
function context(data=cutoff(),turn:string|null='original-turn',growth=false):MirrorStartupContextResult {
 const anchor=data.anchor!;
 return {anchor:growth?{...anchor,stamp:{...anchor.stamp,size:anchor.stamp.size+20n,mtimeNs:8n,ctimeNs:9n}}:anchor,
  continuity:growth?'SameIdentityGrowthAndAnchors':'UnchangedMetadataAndAnchors',currentTurn:turn,scannedRecords:data.offset===0n?0:1,scannedBytes:data.offset};
}
function packet(data=cutoff(),thread='thread',operationId='original-op',createdAt=1.25):PendingMirrorStartupIntent {
 return {thread,cutoff:data,operationId,createdAt};
}
function retain(db:DatabaseSync,pending=packet()):PendingMirrorStartupIntent {
 return retainPreparedMirrorStartupIntent(db,prepareMirrorStartupIntent(pending.thread,pending.cutoff,pending.createdAt,pending.operationId));
}
function seed(db:DatabaseSync,growth=false):{pending:PendingMirrorStartupIntent;plan:PreparedMirrorStartupCompletion;context:MirrorStartupContextResult} {
 const pending=retain(db),captured=context(pending.cutoff,'original-turn',growth);
 return {pending,context:captured,plan:prepare(pending,captured)};
}
function run(fn:(db:DatabaseSync)=>void):void {
 const db=new DatabaseSync(':memory:');
 try {
  db.exec(`CREATE TABLE ${LEGACY}(codex_thread_id TEXT PRIMARY KEY,rollout_path TEXT NOT NULL,cursor INTEGER NOT NULL,updated_at REAL NOT NULL,turn_context TEXT);
   CREATE TABLE audit(note TEXT); INSERT INTO audit VALUES('before');`);
  initializeMirrorCursorJournal(db);initializeMirrorStartupIntentJournal(db);fn(db);
 } finally {db.close();}
}
function rows(db:DatabaseSync,sql:string):Record<string,unknown>[] {
 const statement=db.prepare(sql);statement.setReadBigInts(true);return statement.all().map(row=>({...row}));
}
function snapshot(db:DatabaseSync):unknown {
 const schema=rows(db,"SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name");
 return {schema,data:schema.filter(row=>row.type==='table'&&!(row.name as string).startsWith('sqlite_')).map(row=>[row.name,rows(db,`SELECT * FROM "${row.name as string}" ORDER BY rowid`)])};
}
function unchangedFailure(db:DatabaseSync,plan:PreparedMirrorStartupCompletion):void {
 const before=snapshot(db);
 assert.throws(()=>read(db,plan));assert.deepEqual(snapshot(db),before);assert.equal(db.isTransaction,false);
 assert.throws(()=>complete(db,plan));assert.deepEqual(snapshot(db),before);assert.equal(db.isTransaction,false);assert.equal(db.isOpen,true);
}
function rawCursor(db:DatabaseSync,which:'legacy'|'bound'|'both',pending=packet(),captured=context(pending.cutoff)):void {
 if(which!=='bound')db.prepare(`INSERT INTO ${LEGACY} VALUES(?,?,?,?,?)`).run(pending.thread,captured.anchor.path,captured.anchor.offset,pending.createdAt,captured.currentTurn??'');
 if(which!=='legacy')db.prepare(`INSERT INTO ${BOUND} VALUES(?,?,?,?,?,?,?)`).run(pending.thread,encodeMirrorCursorAnchor(captured.anchor),captured.currentTurn??'',pending.createdAt,1n,pending.operationId,EMPTY_HASH);
}

test('completion atomically installs both exact cursors at original N and removes only its pending operation',()=>run(db=>{
 const {pending,plan,context:captured}=seed(db,true),other=retain(db,packet(cutoff(12n),'unrelated','unrelated-op',8.5));
 const before=snapshot(db);assert.equal(read(db,plan),null);assert.deepEqual(snapshot(db),before);
 const result=complete(db,plan);
 assert.equal(result.kind,'Completed');
 const expected:BoundMirrorCursor={thread:'thread',anchor:captured.anchor,turn:'original-turn',updatedAt:1.25,revision:1n,operationId:'original-op',receiptSetHash:EMPTY_HASH};
 assert.deepEqual(result.cursor,expected);assert.equal(result.cursor.anchor.offset,pending.cutoff.offset);assert.equal(result.cursor.anchor.stamp.size,30n);
 assert.deepEqual(rows(db,`SELECT * FROM ${LEGACY}`),[{codex_thread_id:'thread',rollout_path:pending.cutoff.path,cursor:10n,updated_at:1.25,turn_context:'original-turn'}]);
 assert.equal(rows(db,`SELECT * FROM ${BOUND}`).length,1);assert.equal(readPendingMirrorStartupIntent(db,'thread'),null);
 assert.deepEqual(readBoundMirrorCursor(db,'thread'),expected);assert.deepEqual(readPendingMirrorStartupIntent(db,'unrelated'),other);
 assert.ok(Object.isFrozen(result)&&Object.isFrozen(result.cursor)&&Object.isFrozen(result.cursor.anchor)&&Object.isFrozen(result.cursor.anchor.stamp));
 assert.equal(db.isTransaction,false);assert.equal(db.isOpen,true);
 assert.equal(facade.prepareMirrorStartupIntentCompletion,prepare);assert.equal(facade.readPreparedMirrorStartupCompletion,read);assert.equal(facade.completePreparedMirrorStartupIntent,complete);
}));

test('exact retry and independently prepared exact packet reconcile without new writes or revision changes',()=>run(db=>{
 const {pending,plan,context:captured}=seed(db),first=complete(db,plan);
 for(const table of [PENDING,BOUND,LEGACY])for(const event of ['INSERT','UPDATE','DELETE'])
  db.exec(`CREATE TRIGGER no_replay_${table}_${event} BEFORE ${event} ON ${table} BEGIN SELECT RAISE(ABORT,'reconciliation must not write'); END`);
 const before=snapshot(db);
 for(const retry of [plan,prepare(pending,captured)]) {
  assert.deepEqual(read(db,retry),first.cursor);assert.deepEqual(complete(db,retry),{kind:'Reconciled',cursor:first.cursor});assert.deepEqual(snapshot(db),before);
 }
 assert.equal(db.isTransaction,false);
}));

test('empty reconstructed turn and zero cutoff remain exact empty startup state',()=>run(db=>{
 const pending=retain(db,packet(cutoff(0n))),plan=prepare(pending,context(pending.cutoff,null));
 const result=complete(db,plan);assert.equal(result.cursor.turn,'');assert.equal(result.cursor.anchor.offset,0n);assert.equal(result.cursor.revision,1n);
 assert.deepEqual(read(db,plan),result.cursor);assert.equal(rows(db,`SELECT turn_context FROM ${LEGACY}`)[0]!.turn_context,'');
}));

test('preparation snapshots pending and reconstructed data before a caller can mutate them',()=>run(db=>{
 const pending=packet(),captured=context(pending.cutoff),plan=prepare(pending,captured);retain(db,pending);
 Object.assign(pending,{operationId:'changed',createdAt:50});Object.assign(pending.cutoff,{offset:50n});
 Object.assign(captured,{currentTurn:'changed'});Object.assign(captured.anchor.stamp,{size:50n});
 const result=complete(db,plan);assert.equal(result.cursor.anchor.offset,10n);assert.equal(result.cursor.anchor.stamp.size,10n);
 assert.equal(result.cursor.turn,'original-turn');assert.equal(result.cursor.operationId,'original-op');assert.equal(result.cursor.updatedAt,1.25);
}));

test('changed expected thread, operation, cutoff or original time cannot retire the pending packet',()=>run(db=>{
 const {pending}=seed(db),changed=cutoff(11n),path=resolve('different-synthetic.jsonl');
 const changedPath={...pending.cutoff,path,anchor:{...pending.cutoff.anchor!,path}};
 const changedStamp={...pending.cutoff.stamp,mtimeNs:99n},changedMetadata={...pending.cutoff,stamp:changedStamp,anchor:{...pending.cutoff.anchor!,stamp:changedStamp}};
 for(const expected of [{...pending,thread:'other'},{...pending,operationId:'different'},{...pending,createdAt:2.5},{...pending,cutoff:changed},{...pending,cutoff:changedPath},{...pending,cutoff:changedMetadata}])
  unchangedFailure(db,prepare(expected,context(expected.cutoff)));
 assert.deepEqual(readPendingMirrorStartupIntent(db,'thread'),pending);
}));

test('changed persisted pending fields or missing packet hold without repair',()=>{
 for(const sql of [`UPDATE ${PENDING} SET operation_id='different'`,`UPDATE ${PENDING} SET created_at=2.5`,`UPDATE ${PENDING} SET cutoff_json='{}'`,`UPDATE ${PENDING} SET thread_id='moved'`,`DELETE FROM ${PENDING}`])run(db=>{
  const {plan}=seed(db);db.exec(sql);unchangedFailure(db,plan);
 });
});

test('any legacy, bound or paired cursor already present alongside pending is a conflict',()=>{
 for(const which of ['legacy','bound','both'] as const)run(db=>{const {plan}=seed(db);rawCursor(db,which);unchangedFailure(db,plan);});
});

test('ABORT and IGNORE on either cursor insertion or pending deletion roll back all SQL',()=>{
 for(const [table,event] of [[LEGACY,'INSERT'],[BOUND,'INSERT'],[PENDING,'DELETE']] as const)
  for(const mode of ['ABORT','IGNORE'])run(db=>{
   const {plan,pending}=seed(db),other=retain(db,packet(cutoff(12n),'unrelated','other-op',8));
   db.exec(`CREATE TRIGGER reject_completion BEFORE ${event} ON ${table} BEGIN INSERT INTO audit VALUES('during'); SELECT RAISE(${mode}${mode==='ABORT'?",'injected failure'":''}); END`);
   const before=snapshot(db);assert.throws(()=>complete(db,plan));assert.deepEqual(snapshot(db),before);assert.equal(db.isTransaction,false);
   assert.deepEqual(readPendingMirrorStartupIntent(db,'thread'),pending);assert.deepEqual(readPendingMirrorStartupIntent(db,'unrelated'),other);
  });
});

test('cursor insert triggers changing or deleting pending before retirement roll back both cursor rows',()=>{
 for(const table of [LEGACY,BOUND])for(const mutation of [
  `UPDATE ${PENDING} SET operation_id='changed' WHERE thread_id='thread'`,
  `UPDATE ${PENDING} SET created_at=9 WHERE thread_id='thread'`,
  `UPDATE ${PENDING} SET cutoff_json='{}' WHERE thread_id='thread'`,
  `UPDATE ${PENDING} SET thread_id='moved' WHERE thread_id='thread'`,
  `DELETE FROM ${PENDING} WHERE thread_id='thread'`,
 ])run(db=>{
  const {plan,pending}=seed(db);retain(db,packet(cutoff(12n),'unrelated','other-op',8));
  db.exec(`CREATE TRIGGER corrupt_pending AFTER INSERT ON ${table} BEGIN INSERT INTO audit VALUES('during'); ${mutation}; END`);
  const before=snapshot(db);assert.throws(()=>complete(db,plan));assert.deepEqual(snapshot(db),before);assert.equal(db.isTransaction,false);
  assert.deepEqual(readPendingMirrorStartupIntent(db,'thread'),pending);
 });
});

test('post-delete recreation of the same thread or movement of the same operation cannot commit',()=>{
 for(const [thread,operation] of [["OLD.thread_id","OLD.operation_id"],["OLD.thread_id","'replacement-op'"],["'moved-thread'","OLD.operation_id"]])run(db=>{
  const {plan,pending}=seed(db);retain(db,packet(cutoff(12n),'unrelated','other-op',8));
  db.exec(`CREATE TRIGGER resurrect_pending AFTER DELETE ON ${PENDING} WHEN OLD.thread_id='thread' BEGIN
   INSERT INTO audit VALUES('during'); INSERT INTO ${PENDING}(thread_id,cutoff_json,operation_id,created_at) VALUES(${thread},OLD.cutoff_json,${operation},OLD.created_at); END`);
  const before=snapshot(db);assert.throws(()=>complete(db,plan),Conflict);assert.deepEqual(snapshot(db),before);assert.equal(db.isTransaction,false);
  assert.deepEqual(readPendingMirrorStartupIntent(db,'thread'),pending);
 });
});

test('BEFORE DELETE packet changes cannot hide behind the subsequent successful row deletion',()=>{
 for(const mutation of [
  `UPDATE ${PENDING} SET operation_id='changed' WHERE thread_id=OLD.thread_id`,
  `UPDATE ${PENDING} SET created_at=9 WHERE thread_id=OLD.thread_id`,
  `UPDATE ${PENDING} SET cutoff_json='{}' WHERE thread_id=OLD.thread_id`,
  `UPDATE ${PENDING} SET thread_id='moved' WHERE thread_id=OLD.thread_id`,
  `DELETE FROM ${PENDING} WHERE thread_id=OLD.thread_id; INSERT INTO ${PENDING} VALUES(OLD.thread_id,OLD.cutoff_json,OLD.operation_id,OLD.created_at)`,
  `UPDATE ${PENDING} SET created_at=9 WHERE thread_id=OLD.thread_id; UPDATE ${PENDING} SET created_at=OLD.created_at WHERE thread_id=OLD.thread_id`,
 ])run(db=>{
  const {plan,pending}=seed(db);
  db.exec(`CREATE TRIGGER change_before_retirement BEFORE DELETE ON ${PENDING} WHEN OLD.thread_id='thread' BEGIN ${mutation}; END`);
  const before=snapshot(db);assert.throws(()=>complete(db,plan));assert.deepEqual(snapshot(db),before);assert.equal(db.isTransaction,false);
  assert.deepEqual(readPendingMirrorStartupIntent(db,'thread'),pending);
 });
});

test('trigger writes to unrelated pending packets cannot be committed with an otherwise exact completion',()=>{
 for(const [table,event,condition] of [[BOUND,'INSERT',"NEW.thread_id='thread'"],[PENDING,'DELETE',"OLD.thread_id='thread'"]] as const)
  for(const mutation of [
   `UPDATE ${PENDING} SET operation_id='changed-other' WHERE thread_id='unrelated'`,
   `UPDATE ${PENDING} SET created_at=9 WHERE thread_id='unrelated'`,
   `UPDATE ${PENDING} SET cutoff_json='{}' WHERE thread_id='unrelated'`,
   `DELETE FROM ${PENDING} WHERE thread_id='unrelated'`,
   `UPDATE ${PENDING} SET created_at=9 WHERE thread_id='unrelated'; UPDATE ${PENDING} SET created_at=8 WHERE thread_id='unrelated'`,
  ])run(db=>{
   const {plan,pending}=seed(db),other=retain(db,packet(cutoff(12n),'unrelated','other-op',8));
   db.exec(`CREATE TRIGGER change_unrelated AFTER ${event} ON ${table} WHEN ${condition} BEGIN ${mutation}; END`);
   const before=snapshot(db);assert.throws(()=>complete(db,plan));assert.deepEqual(snapshot(db),before);assert.equal(db.isTransaction,false);
   assert.deepEqual(readPendingMirrorStartupIntent(db,'thread'),pending);assert.deepEqual(readPendingMirrorStartupIntent(db,'unrelated'),other);
  });
});

test('read-only triggers do not obstruct an exact three-row completion',()=>run(db=>{
 const {plan}=seed(db);
 for(const [table,event] of [[LEGACY,'INSERT'],[BOUND,'INSERT'],[PENDING,'DELETE']] as const)
  db.exec(`CREATE TRIGGER inspect_${table} BEFORE ${event} ON ${table} BEGIN SELECT count(*) FROM audit; END`);
 assert.equal(complete(db,plan).kind,'Completed');assert.equal(complete(db,plan).kind,'Reconciled');assert.equal(db.isTransaction,false);
}));

test('post-delete corruption or deletion of either resulting cursor rolls back the entire transition',()=>{
 for(const mutation of [
  `UPDATE ${LEGACY} SET cursor=11`,`UPDATE ${LEGACY} SET rollout_path='/different'`,
  `UPDATE ${LEGACY} SET turn_context='wrong'`,`UPDATE ${LEGACY} SET updated_at=9`,`DELETE FROM ${LEGACY}`,
  `UPDATE ${BOUND} SET revision=2`,`UPDATE ${BOUND} SET operation_id='wrong'`,
  `UPDATE ${BOUND} SET receipt_set_hash='${'b'.repeat(64)}'`,`UPDATE ${BOUND} SET anchor_json='{}'`,
  `UPDATE ${BOUND} SET turn_context='wrong'`,`UPDATE ${BOUND} SET updated_at=9`,`DELETE FROM ${BOUND}`,
  `UPDATE ${LEGACY} SET turn_context='wrong'; UPDATE ${BOUND} SET turn_context='wrong'`,
  `UPDATE ${LEGACY} SET updated_at=9; UPDATE ${BOUND} SET updated_at=9`,
 ])run(db=>{
  const {plan,pending}=seed(db);
  db.exec(`CREATE TRIGGER corrupt_result AFTER DELETE ON ${PENDING} BEGIN INSERT INTO audit VALUES('during'); ${mutation}; END`);
  const before=snapshot(db);assert.throws(()=>complete(db,plan));assert.deepEqual(snapshot(db),before);assert.equal(db.isTransaction,false);
  assert.deepEqual(readPendingMirrorStartupIntent(db,'thread'),pending);
 });
});

test('exact completion preserves unrelated pending packets even through later read-only reconciliation',()=>run(db=>{
 const {plan}=seed(db),other=retain(db,packet(cutoff(12n),'unrelated','other-op',8));
 complete(db,plan);const before=snapshot(db);read(db,plan);assert.equal(complete(db,plan).kind,'Reconciled');assert.deepEqual(snapshot(db),before);
 assert.deepEqual(readPendingMirrorStartupIntent(db,'unrelated'),other);
}));

test('completed cursor cannot reconcile if a new pending row reuses its thread or operation',()=>{
 for(const [thread,operation] of [['thread','replacement-op'],['other-thread','original-op']] as const)run(db=>{
  const {plan}=seed(db),saved=db.prepare(`SELECT cutoff_json FROM ${PENDING}`).get()!.cutoff_json!;complete(db,plan);
  db.prepare(`INSERT INTO ${PENDING} VALUES(?,?,?,?)`).run(thread,saved,operation,4);unchangedFailure(db,plan);
 });
});

test('completed reconciliation rejects changed revision, turn, hash, operation, time, anchor and legacy state',()=>{
 for(const mutation of [
  `UPDATE ${BOUND} SET revision=2`,`UPDATE ${BOUND} SET operation_id='changed'`,
  `UPDATE ${BOUND} SET receipt_set_hash='${'b'.repeat(64)}'`,
  `UPDATE ${BOUND} SET turn_context='changed'; UPDATE ${LEGACY} SET turn_context='changed'`,
  `UPDATE ${BOUND} SET updated_at=9; UPDATE ${LEGACY} SET updated_at=9`,
  `UPDATE ${BOUND} SET anchor_json='{}'`,`UPDATE ${LEGACY} SET cursor=11`,
  `UPDATE ${LEGACY} SET rollout_path='/different'`,`UPDATE ${LEGACY} SET turn_context='changed'`,
  `UPDATE ${LEGACY} SET updated_at=9`,`DELETE FROM ${LEGACY}`,`DELETE FROM ${BOUND}`,
 ])run(db=>{const {plan}=seed(db);complete(db,plan);db.exec(mutation);unchangedFailure(db,plan);});
});

test('completed cursor at the same N with a changed otherwise-valid anchor still cannot reconcile',()=>run(db=>{
 const {plan}=seed(db);complete(db,plan);const anchor={...cutoff().anchor!,tailHash:'b'.repeat(64)};
 db.prepare(`UPDATE ${BOUND} SET anchor_json=?`).run(encodeMirrorCursorAnchor(anchor));unchangedFailure(db,plan);
}));

test('missing startup, bound or legacy schema is never initialized or repaired by completion',()=>{
 for(const missing of [PENDING,BOUND,LEGACY])for(const completed of [false,true])run(db=>{
  const {plan}=seed(db);if(completed)complete(db,plan);db.exec(`DROP TABLE ${missing}`);unchangedFailure(db,plan);
  assert.equal(db.prepare('SELECT 1 FROM sqlite_schema WHERE name=?').get(missing),undefined);
 });
});

test('foreign startup or bound schema is held unchanged',()=>{
 for(const table of [PENDING,BOUND])for(const replacement of [`CREATE TABLE ${table}(foreign_column)`,`CREATE VIEW ${table} AS SELECT 1 AS foreign_column`])run(db=>{
  const {plan}=seed(db);db.exec(`DROP TABLE ${table};${replacement}`);unchangedFailure(db,plan);
 });
});

test('structural, inherited, accessor, proxy and revoked completion plans execute no getters or SQL',()=>run(db=>{
 const {plan}=seed(db);let calls=0,sql=0;const before=snapshot(db),revoked=Proxy.revocable(plan,{});revoked.revoke();
 const originalPrepare=db.prepare,originalExec=db.exec;
 db.prepare=new Proxy(originalPrepare,{apply(target,self,args){sql++;return Reflect.apply(target,self,args);}});
 db.exec=new Proxy(originalExec,{apply(target,self,args){sql++;return Reflect.apply(target,self,args);}});
 for(const fake of [null,undefined,3,'plan',{...plan},Object.create(plan),new Proxy(plan,{get(){calls++;throw Error('get trap');},getOwnPropertyDescriptor(){calls++;throw Error('descriptor trap');}}),revoked.proxy,
  Object.defineProperties({},{thread:{get(){calls++;return 'thread';}},operationId:{get(){calls++;return 'original-op';}}})]) {
  assert.throws(()=>read(db,fake as PreparedMirrorStartupCompletion),TypeError);assert.throws(()=>complete(db,fake as PreparedMirrorStartupCompletion),TypeError);
 }
 assert.equal(calls,0);assert.equal(sql,0);db.prepare=originalPrepare;db.exec=originalExec;assert.deepEqual(snapshot(db),before);
}));

test('pending and context accessors or proxies are rejected during preparation without getter invocation',()=>{
 let calls=0;const pending=packet(),captured=context();
 const accessor={...pending,get createdAt(){calls++;return 1.25;}};
 const contextAccessor={...captured,get currentTurn(){calls++;return 'original-turn';}};
 for(const bad of [accessor,new Proxy(pending,{get(){calls++;throw Error('trap');}})])assert.throws(()=>prepare(bad,captured),TypeError);
 for(const bad of [contextAccessor,new Proxy(captured,{get(){calls++;throw Error('trap');}})])assert.throws(()=>prepare(pending,bad),TypeError);
 assert.equal(calls,0);
});

test('completion refuses an active caller transaction without committing, rolling back or changing caller work',()=>{
 for(const completed of [false,true])run(db=>{
  const {plan}=seed(db);if(completed)complete(db,plan);db.exec("BEGIN; INSERT INTO audit VALUES('caller-owned')");
  const before=snapshot(db);assert.throws(()=>read(db,plan));assert.equal(db.isTransaction,true);assert.deepEqual(snapshot(db),before);
  assert.throws(()=>complete(db,plan));assert.equal(db.isTransaction,true);assert.deepEqual(snapshot(db),before);assert.equal(db.isOpen,true);
  db.exec('ROLLBACK');assert.deepEqual(rows(db,'SELECT note FROM audit'),[{note:'before'}]);
 });
});

test('nonnumeric completed cursor fields are CASE-bounded before any large blob or text reaches JS',()=>{
 for(const [table,column,select] of [
  [BOUND,'updated_at','SELECT anchor_json,turn_context,operation_id,receipt_set_hash,updated_at,revision,'],
  [BOUND,'revision','SELECT anchor_json,turn_context,operation_id,receipt_set_hash,updated_at,revision,'],
  [LEGACY,'updated_at','SELECT rollout_path,turn_context,cursor,updated_at,'],
  [LEGACY,'cursor','SELECT rollout_path,turn_context,cursor,updated_at,'],
 ] as const)for(const value of ['zeroblob(4194304)','CAST(zeroblob(4194304) AS TEXT)'])run(db=>{
  const {plan}=seed(db);complete(db,plan);db.exec(`PRAGMA ignore_check_constraints=ON;UPDATE ${table} SET ${column}=${value}`);
  const before=rows(db,`SELECT typeof(${column}) AS type,length(CAST(${column} AS BLOB)) AS bytes FROM ${table}`);let projected=0;
  db.prepare=new Proxy(db.prepare,{apply(target,self,args){
   const statement=Reflect.apply(target,self,args) as ReturnType<DatabaseSync['prepare']>;
   if(typeof args[0]==='string'&&args[0].startsWith(select))statement.all=new Proxy(statement.all,{apply(query,receiver,parameters){
    const result=Reflect.apply(query,receiver,parameters) as Record<string,unknown>[];
    assert.equal(result.length,1);assert.equal(result[0]![column],null,'Nonnumeric cursor field escaped bounded SQL projection');projected++;return result;
   }});
   return statement;
  }});
  assert.throws(()=>read(db,plan));assert.throws(()=>complete(db,plan));assert.equal(projected,2);assert.equal(db.isTransaction,false);
  assert.deepEqual(rows(db,`SELECT typeof(${column}) AS type,length(CAST(${column} AS BLOB)) AS bytes FROM ${table}`),before);
 });
});

test('fractional integer cursor fields and negative or infinite timestamps cannot reconcile',()=>{
 for(const mutation of [`UPDATE ${BOUND} SET revision=1.5`,`UPDATE ${LEGACY} SET cursor=10.5`,
  `UPDATE ${BOUND} SET revision=-1`,`UPDATE ${LEGACY} SET cursor=-1`,
  `UPDATE ${BOUND} SET updated_at=-1`,`UPDATE ${LEGACY} SET updated_at=-1`,
  `UPDATE ${BOUND} SET updated_at=1e999`,`UPDATE ${LEGACY} SET updated_at=1e999`])run(db=>{
  const {plan}=seed(db);complete(db,plan);db.exec(`PRAGMA ignore_check_constraints=ON;${mutation}`);unchangedFailure(db,plan);
 });
});
