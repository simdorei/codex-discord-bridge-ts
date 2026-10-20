import test,{mock} from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {mkdtemp,writeFile,appendFile,rm} from 'node:fs/promises';import {existsSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {setTimeout as sleep} from 'node:timers/promises';
import {NativeMirrorStartupIntentStore as Store,MirrorStartupIntentStoreReadError as ReadError,MirrorStartupIntentWriteUnconfirmedError as Unconfirmed} from '../../../src/runtime/session-mirror/startup-intent-store.ts';
import {captureMirrorStartupCutoff as capture,type MirrorStartupCutoff} from '../../../src/runtime/session-mirror/startup-context-reader.ts';
import {initializeMirrorCursorJournal} from '../../../src/store/mirror-cursor-journal.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
// Preserve the post-commit assertions explicitly. Cancellation before native
// operation entry now prevents the write and cannot imply a committed packet.
function committedRetain(stage:Int32Array,delayMs:number){const original=OwnedWorkerSlot.prototype.run;return mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,url:URL,value:unknown,timeout:number,signal?:AbortSignal){const q=value as {kind:string};return original.call(this,q.kind==='Retain'?new URL('./bootstrap-fault-worker.ts',import.meta.url):url,q.kind==='Retain'?{...q,stage:stage.buffer,delayMs}:value,timeout,signal);});}
async function reached(stage:Int32Array):Promise<void>{for(let n=0;n<500;n++){if(Atomics.load(stage,0)===1)return;await sleep(10);}throw Error('Retain never committed');}
async function fixture(fn:(path:string,file:string)=>Promise<void>):Promise<void>{const dir=await mkdtemp(join(tmpdir(),'startup-intent-native-'));try{const path=join(dir,'fake.db'),file=join(dir,'rollout.jsonl');await writeFile(file,'{}\n');await fn(path,file);}finally{await rm(dir,{recursive:true,force:true});}}
function seed(path:string):void {const db=new DatabaseSync(path);try{db.exec('CREATE TABLE codex_session_mirror_offsets(codex_thread_id TEXT PRIMARY KEY,rollout_path TEXT,cursor INTEGER,updated_at REAL,turn_context TEXT)');initializeMirrorCursorJournal(db);}finally{db.close();}}
async function setup(path:string):Promise<Store>{seed(path);const store=new Store(path);await store.initializeSchema();return store;}
test('native retain accepts authentic EOF before reconstruction and reopens original after append',()=>fixture(async(path,file)=>{
 const store=await setup(path),cutoff=await capture(file);let retained;
 try{retained=await store.retain('thread',cutoff,1.25,'startup');await appendFile(file,'{}\n');assert.deepEqual(await store.retain('thread',cutoff,1.25,'startup'),retained);assert.equal(retained.cutoff.offset,3n);}finally{await store.close();}
 const reopened=new Store(path);try{assert.deepEqual(await reopened.read('thread'),retained);await assert.rejects(reopened.retain('thread',await capture(file),1.25,'startup'),Unconfirmed);assert.deepEqual(await reopened.read('thread'),retained);}finally{await reopened.close();}assert.equal(ownedWorkerUsage().Background,0);
}));
test('incomplete native EOF is durable and remains held after newline append',()=>fixture(async(path,file)=>{
 await writeFile(file,'{');const cutoff=await capture(file),store=await setup(path);
 try{const first=await store.retain('thread',cutoff,1,'held');assert.equal(first.cutoff.anchor,null);await appendFile(file,'}\n');assert.equal((await store.read('thread'))!.cutoff.offset,1n);await assert.rejects(store.retain('thread',await capture(file),1,'held'),Unconfirmed);assert.deepEqual(await store.read('thread'),first);}finally{await store.close();}
}));
test('missing schema and missing DB never initialize from read or retain',()=>fixture(async(path,file)=>{
 const cutoff=await capture(file),store=new Store(path);try{
  await assert.rejects(store.read('thread'),ReadError);await assert.rejects(store.retain('thread',cutoff,1,'op'),Unconfirmed);assert.equal(existsSync(path),false);await assert.rejects(store.initializeSchema(),Unconfirmed);assert.equal(existsSync(path),false);
  seed(path);await assert.rejects(store.read('thread'),ReadError);await assert.rejects(store.retain('thread',cutoff,1,'op'),Unconfirmed);const db=new DatabaseSync(path);try{assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='cdr_ts_mirror_startup_intents_v1'").get(),undefined);}finally{db.close();}
 }finally{await store.close();}
}));
test('structural copied proxy and prototype-forged cutoff cannot supply native evidence',()=>fixture(async(path,file)=>{
 const genuine=await capture(file),store=new Store(path);let calls=0;
 try{for(const value of [{...genuine},{captured(){calls++;return genuine.captured();}},Object.create(genuine),new Proxy(genuine,{get(){calls++;throw Error('trap');}})])await assert.rejects(store.retain('thread',value as MirrorStartupCutoff,1,'op'),TypeError);assert.equal(calls,0);assert.equal(store.busy,false);assert.equal(existsSync(path),false);}finally{await store.close();}
}));
test('pre-abort does not submit; post-submit cancellation joins and preserves committed pending intent',()=>fixture(async(path,file)=>{
 const cutoff=await capture(file),store=await setup(path),pre=new AbortController(),after=new AbortController(),reason=Error('cancel'),stage=new Int32Array(new SharedArrayBuffer(4)),patch=committedRetain(stage,250);pre.abort(reason);
 try{await assert.rejects(store.retain('thread',cutoff,1,'op',pre.signal),e=>e===reason);assert.equal(await store.read('thread'),null);
  const pending=store.retain('thread',cutoff,1,'op',after.signal),failed=assert.rejects(pending,e=>e instanceof Unconfirmed&&e.cause===reason&&e.operationId==='op');await reached(stage);after.abort(reason);await failed;assert.equal(store.busy,false);assert.equal((await store.read('thread'))!.operationId,'op');
 }finally{await store.close();patch.mock.restore();}assert.equal(ownedWorkerUsage().Background,0);
}));
test('deadline reports unconfirmed after native exit; later reader reconciles original intent',()=>fixture(async(path,file)=>{
 const init=await setup(path);await init.close();const cutoff=await capture(file),short=new Store(path,1000),stage=new Int32Array(new SharedArrayBuffer(8)),patch=committedRetain(stage,1400);
 try{await assert.rejects(short.retain('thread',cutoff,1,'op'),Unconfirmed);assert.equal(Atomics.load(stage,0),1);assert.equal(Atomics.load(stage,1),0);assert.equal(short.busy,false);assert.equal(ownedWorkerUsage().Background,0);}finally{await short.close();patch.mock.restore();}
 const read=new Store(path);try{assert.equal((await read.read('thread'))!.cutoff.offset,3n);}finally{await read.close();}
}));
test('overlap is refused, close joins owner, and closed owner never admits a retry',()=>fixture(async(path,file)=>{
 const store=await setup(path),cutoff=await capture(file),pending=store.retain('thread',cutoff,1,'op'),failed=assert.rejects(pending,Unconfirmed);
 await assert.rejects(store.read('thread'),OwnedWorkerBusyError);await store.close();await failed;assert.equal(store.busy,false);assert.equal(ownedWorkerUsage().Background,0);await assert.rejects(store.read('thread'),/closed/);
}));
test('concurrent different startup packets retain exactly one original operation',()=>fixture(async(path,file)=>{
 const first=await setup(path),second=new Store(path),a=await capture(file);await appendFile(file,'{}\n');const b=await capture(file);
 try{const results=await Promise.allSettled([first.retain('thread',a,1,'a'),second.retain('thread',b,2,'b')]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);const retained=(await first.read('thread'))!;assert.ok(retained.operationId==='a'?retained.cutoff.offset===3n:retained.operationId==='b'&&retained.cutoff.offset===6n);}finally{await first.close();await second.close();}
}));
