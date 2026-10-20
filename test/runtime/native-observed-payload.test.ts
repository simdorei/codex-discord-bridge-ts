import assert from 'node:assert/strict';
import {test} from 'node:test';
import {existsSync} from 'node:fs';
import {storeFixture} from '../helpers/store-fixture.ts';
import {openInitialized} from '../../src/store/owned-driver.ts';
import {StateAccessFacade as state} from '../../src/store/state-access-facade.ts';
import {initialCompletionCursor,type CompletionEntry} from '../../src/store/completion-metadata.ts';
import {NativeObservedPayloadReader,NativeObservedPayloadUnavailable} from '../../src/runtime/completion/native-observed-payload.ts';
import {ownedWorkerUsage,OwnedWorkerBudgetError,OwnedWorkerTimeoutError} from '../../src/runtime/owned-worker-slot.ts';
async function seed(path:string,payload='{}'):Promise<CompletionEntry>{const db=await openInitialized(path);try{db.prepare("INSERT INTO codex_observed_completions(thread_id,turn_id,generation,payload,resident_owner) VALUES ('target','turn',9007199254740993,?,'runtime')").run(payload);}finally{db.close();}return (await state.completionPage(path,'Observed',initialCompletionCursor(),'runtime',1n)).page.entries[0]!;}
const fabricated:CompletionEntry={source:'Observed',id:'turn',target:'target',turn:'turn',channel:0n,bytes:2n,position:{stamp:0,ordinal:0n,id:'turn'}};
test('native Observed result equals initialized loader and retains lossless original evidence generation',async()=>storeFixture(async path=>{
 const e=await seed(path),reader=new NativeObservedPayloadReader(path);try{const expected=await state.loadCompletionPayload(path,e,'runtime',1n),actual=await reader.read(e,'runtime',1n);assert.deepEqual(actual,expected);assert.equal(actual!.generation,9007199254740993n);assert.equal(Object.isFrozen(actual),true);assert.equal(reader.active,0);}finally{await reader.close();}
}));
test('Observed replay spans resident generations; stale metadata holds and equal-byte changes stay readable',async()=>storeFixture(async path=>{
 const e=await seed(path),db=await openInitialized(path),reader=new NativeObservedPayloadReader(path);try{assert.deepEqual(await reader.read(e,'other',2n),await state.loadCompletionPayload(path,e,'other',2n));db.exec("UPDATE codex_observed_completions SET payload='[]'");assert.equal((await reader.read(e,'runtime',1n))!.json,'[]');db.exec("UPDATE codex_observed_completions SET payload='longer'");assert.equal(await reader.read(e,'runtime',1n),null);assert.equal(db.prepare('SELECT payload FROM codex_observed_completions').get()!.payload,'longer');}finally{await reader.close();db.close();}
}));
test('existing-only worker never initializes absent stores or repairs missing tables',async()=>storeFixture(async path=>{
 const reader=new NativeObservedPayloadReader(path);try{await assert.rejects(reader.read(fabricated,'runtime',1n),NativeObservedPayloadUnavailable);assert.equal(existsSync(path),false);const e=await seed(path),db=await openInitialized(path);try{db.exec('DROP TABLE codex_observed_completions');await assert.rejects(reader.read(e,'runtime',1n),NativeObservedPayloadUnavailable);assert.equal(db.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='codex_observed_completions'").get()!.n,0);}finally{db.close();}}finally{await reader.close();}
}));
test('2MiB raw UTF8 bound is inclusive; escaped native envelope cannot falsely reject an admitted body',async()=>{
 for(const payload of ['é'.repeat(1024*1024),'\u0001'.repeat(2*1024*1024),'x'.repeat(2*1024*1024+1)])await storeFixture(async path=>{
  const e=await seed(path,payload),reader=new NativeObservedPayloadReader(path,10000);try{if(Buffer.byteLength(payload)<=2*1024*1024)assert.equal((await reader.read(e,'runtime',1n))!.json,payload);else await assert.rejects(reader.read(e,'runtime',1n),NativeObservedPayloadUnavailable);const db=await openInitialized(path);try{assert.equal(db.prepare('SELECT length(CAST(payload AS BLOB)) n FROM codex_observed_completions').get()!.n,Buffer.byteLength(payload));}finally{db.close();}}finally{await reader.close();}
 });
});
test('selected malformed SQLite TEXT never becomes a replacement-string success or missing payload',async()=>storeFixture(async path=>{
 const e=await seed(path),db=await openInitialized(path),reader=new NativeObservedPayloadReader(path);try{db.exec("UPDATE codex_observed_completions SET payload=CAST(x'ffff' AS TEXT)");await assert.rejects(reader.read(e,'runtime',1n),NativeObservedPayloadUnavailable);}finally{await reader.close();db.close();}
}));
test('input snapshot precedes worker start; getters and unsupported sources never allocate native work',async()=>storeFixture(async path=>{
 const e=await seed(path),reader=new NativeObservedPayloadReader(path);try{const copy={...e,position:{...e.position}},pending=reader.read(copy,'runtime',1n);copy.target='changed';copy.position.stamp=999;assert.equal((await pending)!.json,'{}');let calls=0;Object.defineProperty(copy,'id',{get(){calls++;return 'turn';}});assert.throws(()=>reader.read(copy,'runtime',1n),TypeError);assert.equal(calls,0);assert.throws(()=>reader.read({...e,source:'Final'},'runtime',1n),TypeError);assert.throws(()=>reader.read({...e,id:'x'.repeat(65537)},'runtime',1n),RangeError);assert.throws(()=>reader.read({...e,position:{...e.position,stamp:NaN}},'runtime',1n),RangeError);assert.equal(reader.active,0);}finally{await reader.close();}
}));
test('three blocked reads reserve Background only, fourth is refused and no queued retry appears',async()=>storeFixture(async path=>{
 const e=await seed(path),db=await openInitialized(path),reader=new NativeObservedPayloadReader(path),pending:Promise<unknown>[]=[];try{db.exec('PRAGMA journal_mode=DELETE;BEGIN EXCLUSIVE');for(let i=0;i<3;i++){const p=reader.read(e,'runtime',1n);void p.catch(()=>{});pending.push(p);}await new Promise(r=>setTimeout(r,40));assert.equal(reader.active,3);assert.deepEqual(ownedWorkerUsage(),{Background:3,Control:0,Bridge:0,Observation:0,Discovery:0,Maintenance:0});await assert.rejects(reader.read(e,'runtime',1n),OwnedWorkerBudgetError);assert.equal(reader.active,3);db.exec('ROLLBACK');await Promise.all(pending);assert.equal(reader.active,0);}finally{if(db.isTransaction)db.exec('ROLLBACK');await Promise.allSettled(pending);await reader.close();db.close();}
}));
test('cancel and close join real blocked DB exit before releasing read ownership',async()=>storeFixture(async path=>{
 const e=await seed(path),db=await openInitialized(path),reader=new NativeObservedPayloadReader(path),c=new AbortController(),reason={cancelOriginal:true};let pending:Promise<unknown>|undefined;try{db.exec('PRAGMA journal_mode=DELETE;BEGIN EXCLUSIVE');pending=reader.read(e,'runtime',1n,c.signal);const rejected=assert.rejects(pending,x=>x===reason);c.abort(reason);let closed=false;const closing=reader.close().then(()=>{closed=true;});await new Promise(r=>setTimeout(r,40));assert.equal(closed,false);assert.equal(reader.active,1);assert.equal(ownedWorkerUsage().Background,1);db.exec('ROLLBACK');await rejected;await closing;assert.equal(reader.active,0);assert.equal(ownedWorkerUsage().Background,0);assert.throws(()=>reader.read(e,'runtime',1n),NativeObservedPayloadUnavailable);}finally{if(db.isTransaction)db.exec('ROLLBACK');if(pending)await Promise.allSettled([pending]);await reader.close();db.close();}
}));
test('native timeout retains ownership until join and never delivers a late successful payload',async()=>storeFixture(async path=>{
 const e=await seed(path),db=await openInitialized(path),reader=new NativeObservedPayloadReader(path,20);let pending:Promise<unknown>|undefined;try{db.exec('PRAGMA journal_mode=DELETE;BEGIN EXCLUSIVE');pending=reader.read(e,'runtime',1n);const rejected=assert.rejects(pending,OwnedWorkerTimeoutError);await new Promise(r=>setTimeout(r,60));assert.equal(reader.active,1);assert.equal(ownedWorkerUsage().Background,1);db.exec('ROLLBACK');await rejected;assert.equal(reader.active,0);}finally{if(db.isTransaction)db.exec('ROLLBACK');if(pending)await Promise.allSettled([pending]);await reader.close();db.close();}
}));
test('pre-cancel and invalid original generation never start a worker',async()=>storeFixture(async path=>{
 const reader=new NativeObservedPayloadReader(path),c=new AbortController(),reason=new Error('pre-cancel');try{c.abort(reason);assert.throws(()=>reader.read(fabricated,'runtime',1n,c.signal),e=>e===reason);assert.throws(()=>reader.read(fabricated,'runtime',-1n),TypeError);assert.throws(()=>reader.read(fabricated,'\ud800',1n),TypeError);assert.equal(reader.active,0);assert.equal(existsSync(path),false);}finally{await reader.close();}
}));
