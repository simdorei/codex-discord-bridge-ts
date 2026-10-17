import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,writeFile,appendFile,rm,rename,truncate,readFile,copyFile,open} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NativeMirrorStartupIntentStore as Store,MirrorStartupIntentStoreReadError as ReadError,MirrorStartupIntentContextObservation as Observation} from '../../../src/runtime/session-mirror/startup-intent-store.ts';
import {captureMirrorStartupCutoff as capture,readMirrorStartupContext as readContext,type MirrorStartupCutoff} from '../../../src/runtime/session-mirror/startup-context-reader.ts';
import {MirrorStartupContextHeldError,snapshotMirrorStartupContextResult,type MirrorStartupContextLimits,type MirrorStartupContextHold} from '../../../src/runtime/session-mirror/startup-context-limits.ts';
import {recoverMirrorStartupContextNative,verifyMirrorStartupRecoveryNative} from '../../../src/runtime/session-mirror/startup-intent-recovery-native.ts';
import {initializeMirrorCursorJournal} from '../../../src/store/mirror-cursor-journal.ts';
import {parseSerdeValue} from '../../../src/core/serde-json-parse.ts';
import {serializeSerdeValue} from '../../../src/core/serde-json.ts';
import {OwnedWorkerBusyError,OwnedWorkerSlot,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
const TABLE='cdr_ts_mirror_startup_intents_v1';
const limits:MirrorStartupContextLimits={maxBytes:1048576,maxRecords:10000,maxRecordBytes:262144,maxWindowBytes:65536,maxTurnBytes:16384,timeoutMs:5000};
const line=(turn:string)=>JSON.stringify({type:'turn_context',payload:{turn_id:turn}})+'\n';
const held=(reason:MirrorStartupContextHold)=>(error:unknown)=>error instanceof MirrorStartupContextHeldError&&error.reason===reason;
function sql(path:string,command:string):void {const db=new DatabaseSync(path);try{db.exec(command);}finally{db.close();}}
function seed(path:string):void {const db=new DatabaseSync(path);try{db.exec('CREATE TABLE codex_session_mirror_offsets(codex_thread_id TEXT PRIMARY KEY,rollout_path TEXT,cursor INTEGER,updated_at REAL,turn_context TEXT)');initializeMirrorCursorJournal(db);}finally{db.close();}}
async function fixture(run:(store:Store,path:string,file:string,dir:string)=>Promise<void>,text=line('original')):Promise<void>{
 const dir=await mkdtemp(join(tmpdir(),'startup-recovery-')),path=join(dir,'fake.db'),file=join(dir,'rollout.jsonl');let store:Store|undefined;
 try{await writeFile(file,text);seed(path);store=new Store(path);await store.initializeSchema();await store.retain('thread',await capture(file),1.25,'op');await run(store,path,file,dir);}finally{await store?.close();await rm(dir,{recursive:true,force:true});}
}

test('reopened DB owner recovers only persisted N after append without any DB writes',()=>fixture(async(store,path,file)=>{
 const original=await store.read('thread');await store.close();await appendFile(file,line('too-late'));const reopened=new Store(path),before=await readFile(path);
 try{const recovered=await reopened.recoverContext('thread','op',limits);
  assert.deepEqual(recovered.pending,original);assert.equal(recovered.databasePath,path);assert.equal(recovered.cutoff.offset,BigInt(Buffer.byteLength(line('original'))));assert.equal(recovered.context.currentTurn,'original');assert.equal(recovered.context.scannedRecords,1);assert.equal(recovered.context.scannedBytes,recovered.cutoff.offset);assert.equal(recovered.context.continuity,'SameIdentityGrowthAndAnchors');assert.equal(recovered.historyIntegrityVerified,false);assert.equal(recovered.atomicCommitVerified,false);
  assert.ok(Object.isFrozen(recovered)&&Object.isFrozen(recovered.cutoff.stamp)&&Object.isFrozen(recovered.context.anchor.stamp));await reopened.verifyRecoveredContext(recovered);
  assert.deepEqual(await readFile(path),before);assert.deepEqual(await reopened.read('thread'),original);
  const db=new DatabaseSync(path,{readOnly:true});try{assert.equal(db.prepare('SELECT count(*) AS n FROM codex_session_mirror_offsets').get()!.n,0);assert.equal(db.prepare('SELECT count(*) AS n FROM cdr_ts_mirror_cursor_anchors_v1').get()!.n,0);}finally{db.close();}
 }finally{await reopened.close();}assert.equal(ownedWorkerUsage().Background,0);
}));

test('empty persisted EOF stays zero after append and only successful scan yields null',()=>fixture(async(store,_path,file)=>{
 await appendFile(file,line('new'));const result=await store.recoverContext('thread','op',limits);assert.equal(result.cutoff.offset,0n);assert.equal(result.context.currentTurn,null);assert.equal(result.context.scannedRecords,0);assert.equal(result.context.scannedBytes,0n);
},''));

test('held non-LF packet remains held after reopen and later newline with unchanged N',()=>fixture(async(store,path,file)=>{
 const pending=await store.read('thread');await assert.rejects(store.recoverContext('thread','op',limits),held('IncompleteBoundary'));await store.close();await appendFile(file,'\n'+line('later'));const reopened=new Store(path);
 try{await assert.rejects(reopened.recoverContext('thread','op',limits),held('IncompleteBoundary'));assert.deepEqual(await reopened.read('thread'),pending);assert.equal(pending!.cutoff.anchor,null);}finally{await reopened.close();}
},line('original').slice(0,-1)));

test('wrong operation or absent thread holds without empty fallback or pending mutation',()=>fixture(async(store,path)=>{
 const before=await readFile(path);await assert.rejects(store.recoverContext('thread','foreign',limits),ReadError);await assert.rejects(store.recoverContext('absent','op',limits),ReadError);assert.deepEqual(await readFile(path),before);
}));

test('structural pending or recovered packets, proxies and foreign owners cannot supply recovery authority',()=>fixture(async(store,path,_file,dir)=>{
 const result=await store.recoverContext('thread','op',limits),pending=await store.read('thread');let getters=0;
 for(const forged of [pending,result.captured(),{...result},Object.create(result),new Proxy(result,{get(){getters++;throw Error('trap');}}),{captured(){getters++;return result.captured();}}])await assert.rejects(store.verifyRecoveredContext(forged as Observation),TypeError);
 assert.equal(getters,0);assert.throws(()=>new Observation(Symbol(),path,result.captured()),TypeError);assert.throws(()=>Observation.prototype.captured.call(Object.create(result)),TypeError);
 await assert.rejects(readContext(result.cutoff as unknown as MirrorStartupCutoff,limits),TypeError);
 const otherPath=join(dir,'other.db');await copyFile(path,otherPath);const foreign=new Store(otherPath),samePath=new Store(path);
 try{await assert.rejects(foreign.verifyRecoveredContext(result),TypeError);await assert.rejects(samePath.verifyRecoveredContext(result),TypeError);const independent=await foreign.recoverContext('thread','op',limits);await assert.rejects(store.verifyRecoveredContext(independent),TypeError);}finally{await foreign.close();await samePath.close();}
 assert.equal(store.busy,false);
}));

test('recovery bypasses overridden descriptive read and private brands reject fake owner receivers',()=>fixture(async(store,path)=>{
 let calls=0;class Pretend extends Store {override async read():Promise<never>{calls++;throw Error('untrusted override');}}
 const owner=new Pretend(path);try{const result=await Store.prototype.recoverContext.call(owner,'thread','op',limits);await Store.prototype.verifyRecoveredContext.call(owner,result);assert.equal(calls,0);
  for(const forged of [Object.create(store),new Proxy(store,{get(){calls++;throw Error('trap');}})])await assert.rejects(Store.prototype.recoverContext.call(forged,'thread','op',limits),TypeError);assert.equal(calls,0);
 }finally{await owner.close();}
}));

test('verification rejects every changed pending field and missing row',async()=>{
 for(const change of ["operation_id='changed'","created_at=created_at+1"]){
  await fixture(async(store,path)=>{const result=await store.recoverContext('thread','op',limits);sql(path,`UPDATE ${TABLE} SET ${change}`);await assert.rejects(store.verifyRecoveredContext(result),ReadError);});
 }
 await fixture(async(store,path,file)=>{const result=await store.recoverContext('thread','op',limits);sql(path,`DELETE FROM ${TABLE}`);await assert.rejects(store.verifyRecoveredContext(result),ReadError);await appendFile(file,line('later'));await store.retain('thread',await capture(file),1.25,'op');await assert.rejects(store.verifyRecoveredContext(result),ReadError);});
 await fixture(async(store,path)=>{const result=await store.recoverContext('thread','op',limits),db=new DatabaseSync(path);try{
  const row=db.prepare(`SELECT cutoff_json FROM ${TABLE}`).get()!,data=parseSerdeValue<unknown[]>(row.cutoff_json as string);data[9]=null;db.prepare(`UPDATE ${TABLE} SET cutoff_json=?`).run(serializeSerdeValue(data));
 }finally{db.close();}await assert.rejects(store.verifyRecoveredContext(result),ReadError);await assert.rejects(store.recoverContext('thread','op',limits),held('IncompleteBoundary'));});
});

test('database file replacement is rejected even when its pending packet is byte-identical',()=>fixture(async(store,path,_file,dir)=>{
 const result=await store.recoverContext('thread','op',limits),copy=join(dir,'replacement.db');await copyFile(path,copy);await rename(path,path+'.old');await rename(copy,path);await assert.rejects(store.verifyRecoveredContext(result),ReadError);
}));

test('replacement shrink same-size rewrite and changed sampled bytes plus append hold recovery',async()=>{
 for(const change of ['replace','shrink','rewrite','append-rewrite'])await fixture(async(store,_path,file)=>{
  if(change==='replace'){await rename(file,file+'.old');await writeFile(file,line('original'));}
  else if(change==='shrink')await truncate(file,0);
  else if(change==='rewrite')await writeFile(file,line('modified'));
  else{const fd=await open(file,'r+');try{await fd.write(' ',0,'utf8');}finally{await fd.close();}await appendFile(file,line('new'));}
  await assert.rejects(store.recoverContext('thread','op',limits),held('ChangedFile'));
 });
});

test('later append makes old observation stale; recovery retry still scans original N',()=>fixture(async(store,_path,file)=>{
 const result=await store.recoverContext('thread','op',limits);await appendFile(file,line('later'));await assert.rejects(store.verifyRecoveredContext(result),held('ChangedFile'));const retry=await store.recoverContext('thread','op',limits);assert.equal(retry.context.currentTurn,'original');assert.equal(retry.cutoff.offset,result.cutoff.offset);await store.verifyRecoveredContext(retry);
}));

test('malformed stored rows and cursor conflicts hold without repairing or materializing large values',async()=>{
 for(const statement of ["cutoff_json='{}'","cutoff_json=CAST(x'ff' AS TEXT)","cutoff_json=' '||cutoff_json","operation_id=CAST(x'ff' AS TEXT)","created_at=zeroblob(4194304)","created_at=-1"]){
  await fixture(async(store,path)=>{sql(path,`UPDATE ${TABLE} SET ${statement}`);const before=await readFile(path);await assert.rejects(store.recoverContext('thread','op',limits),ReadError);assert.deepEqual(await readFile(path),before);});
 }
 await fixture(async(store,path)=>{sql(path,"INSERT INTO codex_session_mirror_offsets VALUES('thread','legacy',0,0,'')");await assert.rejects(store.recoverContext('thread','op',limits),ReadError);});
});

test('missing database or required schemas are not created by recovery',()=>fixture(async(store,path,_file,dir)=>{
 const missing=join(dir,'missing.db'),owner=new Store(missing);try{await assert.rejects(owner.recoverContext('thread','op',limits),ReadError);assert.equal(existsSync(missing),false);}finally{await owner.close();}
 for(const table of [TABLE,'cdr_ts_mirror_cursor_anchors_v1']){sql(path,`DROP TABLE ${table}`);await assert.rejects(store.recoverContext('thread','op',limits),ReadError);const db=new DatabaseSync(path,{readOnly:true});try{assert.equal(db.prepare('SELECT 1 FROM sqlite_schema WHERE name=?').get(table),undefined);}finally{db.close();}}
}));

test('strict context budgets are retained and a held attempt does not sample later EOF',()=>fixture(async(store,_path,file)=>{
 await assert.rejects(store.recoverContext('thread','op',{...limits,maxBytes:1}),held('ByteBudget'));await appendFile(file,line('new'));const result=await store.recoverContext('thread','op',limits);assert.equal(result.context.currentTurn,'original');
 await assert.rejects(store.recoverContext('thread','op',{...limits,maxRecordBytes:4}),held('RecordBytes'));await assert.rejects(store.recoverContext('thread','op',{...limits,maxTurnBytes:1}),held('TurnBudget'));
 let getters=0;await assert.rejects(store.recoverContext('thread','op',{...limits,get maxBytes(){getters++;return 1;}}),TypeError);assert.equal(getters,0);assert.equal(store.busy,false);
}));

test('pre/post-submit cancellation, overlap, close and deadlines join native ownership',()=>fixture(async(store,path)=>{
 const before=await readFile(path),pre=new AbortController(),post=new AbortController(),reason={cancel:true};pre.abort(reason);
 await assert.rejects(store.recoverContext('thread','op',limits,pre.signal),e=>e===reason);assert.equal(store.busy,false);
 const task=store.recoverContext('thread','op',limits,post.signal),rejection=assert.rejects(task,e=>e===reason);assert.equal(store.busy,true);await assert.rejects(store.read('thread'),OwnedWorkerBusyError);post.abort(reason);await rejection;assert.equal(store.busy,false);assert.equal(ownedWorkerUsage().Background,0);
 await assert.rejects(store.recoverContext('thread','op',{...limits,timeoutMs:1}),held('Deadline'));assert.equal(store.busy,false);assert.equal(ownedWorkerUsage().Background,0);assert.deepEqual(await readFile(path),before);
 const recovered=await store.recoverContext('thread','op',limits),verifyAbort=new AbortController();const verify=store.verifyRecoveredContext(recovered,verifyAbort.signal);verifyAbort.abort(reason);await assert.rejects(verify,e=>e===reason);assert.equal(store.busy,false);
 const closing=store.recoverContext('thread','op',limits),closed=assert.rejects(closing,/closed/);await store.close();await closed;assert.equal(store.busy,false);assert.equal(ownedWorkerUsage().Background,0);await assert.rejects(store.recoverContext('thread','op',limits),/closed/);assert.deepEqual(await readFile(path),before);
}));

test('recovery native entry points cannot run on main thread',()=>fixture(async(store,path)=>{
 const recovered=await store.recoverContext('thread','op',limits);await assert.rejects(recoverMirrorStartupContextNative(path,'thread','op',limits,()=>{}),TypeError);await assert.rejects(verifyMirrorStartupRecoveryNative(path,recovered.captured(),()=>{}),TypeError);
}));

async function race(request:object):Promise<{ok:boolean;checks:number;name?:string}>{
 const slot=new OwnedWorkerSlot(),pending=slot.run(new URL('./startup-intent-recovery-race-worker.ts',import.meta.url),request,5000),exited=slot.join();try{return await pending as {ok:boolean;checks:number;name?:string};}finally{await exited;}
}
test('separate post-read DB snapshot detects exact pending changes during recovery and verification',async()=>{
 for(const kind of ['RecoverContext','VerifyContext'])for(const change of ['Pending','Database'])await fixture(async(store,path,file)=>{
  const evidence=(await store.recoverContext('thread','op',limits)).captured(),request={path,file,thread:'thread',operationId:'op',limits,kind,evidence};
  const baseline=await race(request);assert.equal(baseline.ok,true);
  // The penultimate callback precedes the second independent DB read, so a held
  // SQLite snapshot would incorrectly miss this newly committed change.
  const result=await race({...request,change,changeAt:baseline.checks-1,sql:`UPDATE ${TABLE} SET created_at=created_at+1`});assert.equal(result.ok,false);assert.equal(result.name,'MirrorStartupIntentConflictError');
 });
});

test('append observed during recovery scan refuses all context',()=>fixture(async(_store,path,file)=>{
 const result=await race({path,file,thread:'thread',operationId:'op',limits,change:'File',changeAt:7});assert.equal(result.ok,false);assert.equal(result.name,'MirrorFileChangedError');
}));

test('unexpected native exit rejects the owning read, joins its slot, and leaves pending unchanged',()=>fixture(async(store,path)=>{
 const before=await readFile(path),run=OwnedWorkerSlot.prototype.run;
 const replacement=mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,url:URL,input:unknown,timeout:number,signal?:AbortSignal){
  return run.call(this,new URL('./startup-intent-recovery-race-worker.ts',import.meta.url),{...input as object,change:'Exit',changeAt:2},timeout,signal);
 });
 try{await assert.rejects(store.recoverContext('thread','op',limits),/exited 23/);assert.equal(store.busy,false);assert.equal(ownedWorkerUsage().Background,0);assert.deepEqual(await readFile(path),before);}finally{replacement.mock.restore();}
 assert.equal((await store.recoverContext('thread','op',limits)).context.currentTurn,'original');
}));

test('invalid UTF8 and record-count budget through recovery never produce partial or empty success',async()=>{
 await fixture(async(store,path,file)=>{
  sql(path,`DELETE FROM ${TABLE}`);await writeFile(file,Buffer.concat([Buffer.from(line('prior')),Buffer.from([255,10])]));await store.retain('thread',await capture(file),1.25,'op');await assert.rejects(store.recoverContext('thread','op',limits),held('InvalidUtf8'));
 });
 await fixture(async(store)=>{await assert.rejects(store.recoverContext('thread','op',{...limits,maxRecords:1}),held('RecordBudget'));},line('first')+line('second'));
});

test('shared result validation refuses malformed success packets without granting evidence authority',()=>fixture(async(store)=>{
 const result=await store.recoverContext('thread','op',limits),data=result.cutoff,context=result.context;let getters=0;
 for(const bad of [{...context,currentTurn:''},{...context,currentTurn:'x'.repeat(16385)},{...context,scannedBytes:data.offset+1n},{...context,scannedRecords:0},{...context,scannedRecords:1.5},{...context,continuity:'invented'},{...context,anchor:{...context.anchor,prefixHash:'0'.repeat(64)}},{...context,anchor:{...context.anchor,stamp:{...context.anchor.stamp,mtimeNs:context.anchor.stamp.mtimeNs+1n}}},{...context,get currentTurn(){getters++;return 'trap';}},new Proxy(context,{get(){getters++;throw Error('trap');}})])assert.throws(()=>snapshotMirrorStartupContextResult(data,limits,bad),TypeError);
 assert.throws(()=>snapshotMirrorStartupContextResult(data,{...limits,maxBytes:1},context),TypeError);assert.equal(getters,0);
 await assert.rejects(store.verifyRecoveredContext(snapshotMirrorStartupContextResult(data,limits,context) as unknown as Observation),TypeError);
}));
