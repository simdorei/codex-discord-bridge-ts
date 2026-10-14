import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,writeFile,appendFile,rm,rename,readFile,copyFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as sleep} from 'node:timers/promises';
import {NativeMirrorStartupIntentStore as Store,MirrorStartupIntentContextObservation as Observation,MirrorStartupIntentWriteUnconfirmedError as Unconfirmed} from '../../../src/runtime/session-mirror/startup-intent-store.ts';
import {captureMirrorStartupCutoff as capture} from '../../../src/runtime/session-mirror/startup-context-reader.ts';
import {completeMirrorStartupRecoveryNative} from '../../../src/runtime/session-mirror/startup-intent-recovery-native.ts';
import {initializeMirrorCursorJournal,readBoundMirrorCursor} from '../../../src/store/mirror-cursor-journal.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
const PENDING='cdr_ts_mirror_startup_intents_v1',BOUND='cdr_ts_mirror_cursor_anchors_v1',LEGACY='codex_session_mirror_offsets';
const limits={maxBytes:1048576,maxRecords:10000,maxRecordBytes:262144,maxWindowBytes:65536,maxTurnBytes:16384,timeoutMs:5000};
const line=(turn:string)=>JSON.stringify({type:'turn_context',payload:{turn_id:turn}})+'\n';
function sql(path:string,command:string):void {const db=new DatabaseSync(path);try{db.exec(command);}finally{db.close();}}
function cursor(path:string){const db=new DatabaseSync(path,{readOnly:true});try{return readBoundMirrorCursor(db,'thread');}finally{db.close();}}
async function fixture(run:(store:Store,path:string,file:string,dir:string)=>Promise<void>,content=line('original')):Promise<void>{
 const dir=await mkdtemp(join(tmpdir(),'startup-completion-')),path=join(dir,'fake.db'),file=join(dir,'rollout.jsonl');let store:Store|undefined;
 try{await writeFile(file,content);const db=new DatabaseSync(path);try{db.exec(`CREATE TABLE ${LEGACY}(codex_thread_id TEXT PRIMARY KEY,rollout_path TEXT,cursor INTEGER,updated_at REAL,turn_context TEXT)`);initializeMirrorCursorJournal(db);}finally{db.close();}
  store=new Store(path);await store.initializeSchema();await store.retain('thread',await capture(file),1.25,'op');await run(store,path,file,dir);
 }finally{await store?.close();await rm(dir,{recursive:true,force:true});}
}
function substitute(options:object,timeoutOverride?:number){
 const original=OwnedWorkerSlot.prototype.run;
 return mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,url:URL,input:unknown,timeout:number,signal?:AbortSignal){
  return original.call(this,new URL('./startup-intent-completion-worker.ts',import.meta.url),{...input as object,...options},timeoutOverride??timeout,signal);
 });
}
async function reached(stage:Int32Array):Promise<void>{for(let i=0;i<500;i++){if(Atomics.load(stage,0)===1)return;await sleep(10);}throw Error('Test worker did not reach committed state');}

test('explicit same-owner completion atomically installs original N/turn and exact retry reconciles without a later EOF',()=>fixture(async(store,path,file)=>{
 const pending=await store.read('thread');await appendFile(file,line('too-late'));const observed=await store.recoverContext('thread','op',limits);
 const first=await store.completeRecoveredContext(observed);assert.equal(first.kind,'Completed');assert.equal(first.cursor.anchor.offset,pending!.cutoff.offset);assert.equal(first.cursor.turn,'original');assert.equal(first.cursor.updatedAt,1.25);assert.equal(first.cursor.operationId,'op');assert.equal(first.cursor.revision,1n);assert.equal(first.cursor.receiptSetHash,'4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945');assert.equal(await store.read('thread'),null);assert.deepEqual(cursor(path),first.cursor);
 const before=await readFile(path);await rm(file);const retry=await store.completeRecoveredContext(observed);assert.equal(retry.kind,'Reconciled');assert.deepEqual(retry.cursor,first.cursor);assert.deepEqual(await readFile(path),before);assert.equal(observed.atomicCommitVerified,false);assert.equal(observed.historyIntegrityVerified,false);assert.equal(ownedWorkerUsage().Background,0);
}));

test('empty original N commits empty turn despite later appended context',()=>fixture(async(store,_path,file)=>{
 await appendFile(file,line('later'));const observed=await store.recoverContext('thread','op',limits),result=await store.completeRecoveredContext(observed);assert.equal(result.cursor.anchor.offset,0n);assert.equal(result.cursor.turn,'');
},''));

test('structural/copied/proxy and foreign owner observations never submit a completion',()=>fixture(async(store,path,_file,dir)=>{
 const observed=await store.recoverContext('thread','op',limits);let calls=0;
 for(const forged of [observed.captured(),{...observed},Object.create(observed),new Proxy(observed,{get(){calls++;throw Error('trap');}}),{captured(){calls++;return observed.captured();}}])await assert.rejects(store.completeRecoveredContext(forged as Observation),TypeError);
 const other=new Store(path),copy=join(dir,'copy.db');await copyFile(path,copy);const foreign=new Store(copy);
 try{await assert.rejects(other.completeRecoveredContext(observed),TypeError);await assert.rejects(foreign.completeRecoveredContext(observed),TypeError);const otherEvidence=await other.recoverContext('thread','op',limits);await assert.rejects(store.completeRecoveredContext(otherEvidence),TypeError);}finally{await other.close();await foreign.close();}
 assert.equal(calls,0);assert.equal(store.busy,false);assert.equal((await store.read('thread'))!.operationId,'op');
}));

test('overridden public read or verify method cannot replace native completion checks',()=>fixture(async(store,path)=>{
 let calls=0;class Pretend extends Store {override async read():Promise<never>{calls++;throw Error('override');}override async verifyRecoveredContext():Promise<void>{calls++;}}
 const owner=new Pretend(path);try{const evidence=await owner.recoverContext('thread','op',limits);assert.equal((await Store.prototype.completeRecoveredContext.call(owner,evidence)).kind,'Completed');assert.equal(calls,0);
  for(const fake of [Object.create(owner),new Proxy(owner,{get(){calls++;throw Error('trap');}})])await assert.rejects(Store.prototype.completeRecoveredContext.call(fake,evidence),TypeError);assert.equal(calls,0);
 }finally{await owner.close();}
}));

test('changed pending, missing pending and preexisting cursors hold without replacement',async()=>{
 for(const command of [`UPDATE ${PENDING} SET operation_id='foreign'`,`UPDATE ${PENDING} SET created_at=2`,`UPDATE ${PENDING} SET cutoff_json='{}'`,`DELETE FROM ${PENDING}`,`INSERT INTO ${LEGACY} VALUES('thread','foreign',0,0,'')`])await fixture(async(store,path)=>{
  const observed=await store.recoverContext('thread','op',limits);sql(path,command);const before=await readFile(path);await assert.rejects(store.completeRecoveredContext(observed),Unconfirmed);assert.deepEqual(await readFile(path),before);
 });
});

test('changed file and database identity hold before any retirement, including byte-identical replacement',async()=>{
 for(const change of ['append','replace-file','rewrite','replace-db'])await fixture(async(store,path,file,dir)=>{
  const evidence=await store.recoverContext('thread','op',limits);
  if(change==='append')await appendFile(file,line('later'));
  else if(change==='rewrite')await writeFile(file,line('modified'));
  else if(change==='replace-file'){await rename(file,file+'.old');await writeFile(file,line('original'));}
  else{const copy=join(dir,'copy.db');await copyFile(path,copy);await rename(path,path+'.old');await rename(copy,path);}
  const before=await readFile(path);await assert.rejects(store.completeRecoveredContext(evidence),Unconfirmed);assert.deepEqual(await readFile(path),before);assert.equal((await store.read('thread'))!.operationId,'op');
 });
});

test('already-completed retry rejects next revision, altered result, reused operation, and database replacement',async()=>{
 for(const change of ['revision','turn','legacy','operation','database'])await fixture(async(store,path,_file,dir)=>{
  const evidence=await store.recoverContext('thread','op',limits);await store.completeRecoveredContext(evidence);
  if(change==='database'){const copy=join(dir,'copy.db');await copyFile(path,copy);await rename(path,path+'.old');await rename(copy,path);}
  else sql(path,change==='revision'?`UPDATE ${BOUND} SET revision=2`:change==='turn'?`UPDATE ${BOUND} SET turn_context='other'`:change==='legacy'?`UPDATE ${LEGACY} SET cursor=0`:`INSERT INTO ${PENDING} VALUES('other','{}','op',1)`);
  const before=await readFile(path);await assert.rejects(store.completeRecoveredContext(evidence),Unconfirmed);assert.deepEqual(await readFile(path),before);
 });
});

test('concurrent independent same-operation recoveries commit once and reconcile exactly once',()=>fixture(async(first,path)=>{
 const second=new Store(path);try{const [a,b]=await Promise.all([first.recoverContext('thread','op',limits),second.recoverContext('thread','op',limits)]);
  const results=await Promise.all([first.completeRecoveredContext(a),second.completeRecoveredContext(b)]);assert.deepEqual(results.map(r=>r.kind).sort(),['Completed','Reconciled']);assert.deepEqual(results[0]!.cursor,results[1]!.cursor);assert.equal(await first.read('thread'),null);
 }finally{await second.close();}assert.equal(ownedWorkerUsage().Background,0);
}));

test('actual SQL trigger failure rolls back both inserted cursor rows and exact pending retirement',()=>fixture(async(store,path)=>{
 const evidence=await store.recoverContext('thread','op',limits),original=await store.read('thread');sql(path,`CREATE TRIGGER fail_delete BEFORE DELETE ON ${PENDING} BEGIN SELECT RAISE(ABORT,'injected'); END`);
 await assert.rejects(store.completeRecoveredContext(evidence),Unconfirmed);assert.deepEqual(await store.read('thread'),original);const db=new DatabaseSync(path);try{assert.equal(db.prepare(`SELECT count(*) AS n FROM ${BOUND}`).get()!.n,0);assert.equal(db.prepare(`SELECT count(*) AS n FROM ${LEGACY}`).get()!.n,0);}finally{db.close();}
 sql(path,'DROP TRIGGER fail_delete');assert.equal((await store.completeRecoveredContext(evidence)).kind,'Completed');
}));

test('lost native reply after actual commit is unconfirmed and exact retained evidence reconciles',()=>fixture(async(store,path)=>{
 const evidence=await store.recoverContext('thread','op',limits),replacement=substitute({exitAfterCommit:true});
 try{await assert.rejects(store.completeRecoveredContext(evidence),e=>e instanceof Unconfirmed&&e.operation==='CompleteContext'&&e.operationId==='op'&&e.thread==='thread');assert.equal(store.busy,false);assert.equal(ownedWorkerUsage().Background,0);}finally{replacement.mock.restore();}
 assert.equal(cursor(path)!.operationId,'op');assert.equal((await store.completeRecoveredContext(evidence)).kind,'Reconciled');
}));

test('malformed committed native reply is unconfirmed, never returned as completion authority',()=>fixture(async(store)=>{
 const evidence=await store.recoverContext('thread','op',limits),replacement=substitute({badReply:true});try{await assert.rejects(store.completeRecoveredContext(evidence),Unconfirmed);assert.equal(store.busy,false);}finally{replacement.mock.restore();}
 assert.equal((await store.completeRecoveredContext(evidence)).kind,'Reconciled');
}));

test('pre-abort never submits; post-submit abort is unconfirmed and joins native exit before exact retry',()=>fixture(async(store)=>{
 const evidence=await store.recoverContext('thread','op',limits),pre=new AbortController(),post=new AbortController(),reason={cancel:true};pre.abort(reason);
 await assert.rejects(store.completeRecoveredContext(evidence,pre.signal),e=>e===reason);assert.equal(store.busy,false);
 const task=store.completeRecoveredContext(evidence,post.signal),failed=assert.rejects(task,e=>e instanceof Unconfirmed&&e.cause===reason);await assert.rejects(store.read('thread'),OwnedWorkerBusyError);post.abort(reason);await failed;assert.equal(store.busy,false);assert.equal(ownedWorkerUsage().Background,0);assert.equal((await store.completeRecoveredContext(evidence)).kind,'Completed');
}));

test('post-commit cancellation joins delayed native exit before exposing unconfirmed result',()=>fixture(async(store)=>{
 const evidence=await store.recoverContext('thread','op',limits),stage=new Int32Array(new SharedArrayBuffer(4)),post=new AbortController(),reason=Error('cancel committed operation'),replacement=substitute({stage:stage.buffer,delayAfterMs:200});let settled=false;
 try{const task=store.completeRecoveredContext(evidence,post.signal),failed=assert.rejects(task,e=>e instanceof Unconfirmed&&e.cause===reason).then(()=>{settled=true;});await reached(stage);post.abort(reason);await sleep(20);assert.equal(settled,false);assert.equal(store.busy,true);assert.equal(ownedWorkerUsage().Background,1);await failed;assert.equal(store.busy,false);assert.equal(ownedWorkerUsage().Background,0);}finally{replacement.mock.restore();}
 assert.equal((await store.completeRecoveredContext(evidence)).kind,'Reconciled');
}));

test('post-commit deadline joins native exit, then same operation reconciles without advancing',()=>fixture(async(store)=>{
 const evidence=await store.recoverContext('thread','op',limits),replacement=substitute({delayAfterMs:1400},1000);
 try{await assert.rejects(store.completeRecoveredContext(evidence),Unconfirmed);assert.equal(store.busy,false);assert.equal(ownedWorkerUsage().Background,0);}finally{replacement.mock.restore();}
 assert.equal((await store.completeRecoveredContext(evidence)).kind,'Reconciled');
}));

test('close joins an already committed native owner and disallows further work',()=>fixture(async(store,path)=>{
 const evidence=await store.recoverContext('thread','op',limits),stage=new Int32Array(new SharedArrayBuffer(4)),replacement=substitute({stage:stage.buffer,delayAfterMs:200});
 try{const task=store.completeRecoveredContext(evidence),failed=assert.rejects(task,Unconfirmed);await reached(stage);await store.close();await failed;assert.equal(store.busy,false);assert.equal(ownedWorkerUsage().Background,0);assert.equal(cursor(path)!.operationId,'op');await assert.rejects(store.completeRecoveredContext(evidence),/closed/);}finally{replacement.mock.restore();}
}));

test('native completion refuses main-thread invocation',()=>fixture(async(store,path)=>{
 const evidence=await store.recoverContext('thread','op',limits);await assert.rejects(completeMirrorStartupRecoveryNative(path,evidence.captured(),()=>{}),TypeError);assert.notEqual(await store.read('thread'),null);
}));

async function race(request:object):Promise<{ok:boolean;checks:number;name?:string}>{
 const slot=new OwnedWorkerSlot(),pending=slot.run(new URL('./startup-intent-completion-worker.ts',import.meta.url),request,5000),exited=slot.join();try{return await pending as {ok:boolean;checks:number;name?:string};}finally{await exited;}
}
test('pending, database, and file changes just before native transaction cannot retire stale evidence',async()=>{
 // The last pre-transaction check is immediately followed by identity/file
 // metadata checks and the exact SQLite CAS, with no asynchronous gap.
 for(const change of ['Pending','Database','File'])await fixture(async(store,path)=>{
  const evidence=(await store.recoverContext('thread','op',limits)).captured();
  const result=await race({path,evidence,change,changeAt:5,sql:`UPDATE ${PENDING} SET created_at=created_at+1`});assert.equal(result.ok,false);assert.equal(result.name,change==='File'?'MirrorFileChangedError':'MirrorStartupIntentConflictError');assert.notEqual(await store.read('thread'),null);
 });
});
