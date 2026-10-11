import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {storeFixture} from '../../helpers/store-fixture.ts';import {queueJob} from '../../helpers/queue-job.ts';import {enqueue} from '../../../src/store/queue-enqueue.ts';import {openInitialized} from '../../../src/store/owned-driver.ts';import {listFilteredIn} from '../../../src/store/queue-read.ts';
import {collectSessionItems} from '../../../src/runtime/session-mirror/collect.ts';import {sourceMirrorDispositionsIn as batch,MirrorOwnershipPendingError} from '../../../src/runtime/session-mirror/ownership.ts';
import {discoverMirrorStore} from '../../../src/runtime/session-mirror/store-discovery.ts';import {observeSourceMirrorDispositions as native,mirrorOwnershipReaderBusy} from '../../../src/runtime/session-mirror/ownership-reader.ts';import {OwnedWorkerBusyError} from '../../../src/runtime/owned-worker-slot.ts';
const limits={maxJobs:32n,maxValueBytes:1048576n,timeoutMs:5000},discovery={...limits,maxTargets:32n,maxOutputBytes:1048576};
const items=(n:number)=>collectSessionItems('target',Array.from({length:n},(_,i)=>({type:'event_msg',payload:{type:'agent_message',message:'item'+i}})),'All','turn').items;
test('1000-item provisional batch reads queue measurement and complete queue only once, not per item',async()=>storeFixture(async path=>{
 const db=await openInitialized(path),values=items(1000);let measures=0,reads=0;const prepare=DatabaseSync.prototype.prepare;
 DatabaseSync.prototype.prepare=function(sql:string){if(sql.includes('FROM codex_turn_queue')){if(sql.includes('COUNT'))measures++;else reads++}return prepare.call(this,sql)};
 try{const result=batch(db,'target',values,[],32n,1048576n);assert.equal(result.length,1000);assert.ok(result.every(x=>x==='Unclaimed'));assert.equal(measures,1);assert.equal(reads,1);assert.equal(db.isTransaction,false)}finally{DatabaseSync.prototype.prepare=prepare;db.close()}
}));
test('source current, historical and durable marker order remains explicit; historical alone never becomes current proof',async()=>storeFixture(async path=>{
 await enqueue(path,queueJob({state:'Running',turnId:'turn'}));const db=await openInitialized(path);try{db.exec("UPDATE codex_turn_queue SET state='running',turn_id='turn'");const old=listFilteredIn(db,'target',null),value=items(1);assert.deepEqual(batch(db,'target',value,old,32n,1048576n),['CurrentOwner']);db.exec('DELETE FROM codex_turn_queue');assert.deepEqual(batch(db,'target',value,old,32n,1048576n),['HistoricalOwner']);db.prepare('INSERT INTO codex_session_mirror_events VALUES(?,?,1)').run(value[0]!.digest,'target');assert.deepEqual(batch(db,'target',value,[],32n,1048576n),['RecordedEvent'])}finally{db.close()}
}));
test('pending state and complete snapshot budget fail the whole batch, preserving outer transactions',async()=>storeFixture(async path=>{
 await enqueue(path,queueJob({state:'Starting'}));const db=await openInitialized(path);try{db.exec("UPDATE codex_turn_queue SET state='starting'");assert.throws(()=>batch(db,'target',items(5),[],32n,1048576n),MirrorOwnershipPendingError);assert.equal(db.isTransaction,false);assert.throws(()=>batch(db,'target',items(5),[],32n,1n),/budget/);db.exec('BEGIN');assert.throws(()=>batch(db,'target',items(1),[],32n,1048576n));assert.equal(db.isTransaction,true);db.exec('ROLLBACK')}finally{db.close()}
}));
test('native whole-batch classification preserves authentic jobs and shares the single read slot',async()=>storeFixture(async path=>{
 const db=await openInitialized(path);db.close();const jobs=(await discoverMirrorStore(path,discovery)).jobs,values=items(1000);const pending=native(path,'target',values,limits,jobs);assert.equal(mirrorOwnershipReaderBusy(),true);await assert.rejects(native(path,'target',values,limits,jobs),OwnedWorkerBusyError);const result=await pending;assert.equal(result.length,1000);assert.ok(result.every(x=>x==='Unclaimed'));assert.equal(mirrorOwnershipReaderBusy(),false);await assert.rejects(native(path,'target',values,limits,[...jobs]),TypeError);
}));
test('batch capture rejects getters/proxies and oversize before native work; preabort preserves exact reason',async()=>storeFixture(async path=>{
 const db=await openInitialized(path);db.close();const jobs=(await discoverMirrorStore(path,discovery)).jobs;let hooks=0;const value=items(1)[0]!;
 await assert.rejects(native(path,'target',[{...value,get digest(){hooks++;return 'x'}}],limits,jobs),TypeError);await assert.rejects(native(path,'target',new Proxy([value],{get(){hooks++;throw Error('hook')}}),limits,jobs),TypeError);await assert.rejects(native(path,'target',Array(4097).fill(value),limits,jobs));
 const a=new AbortController(),reason={stop:true};a.abort(reason);await assert.rejects(native(path,'target',[value],limits,jobs,a.signal),e=>e===reason);assert.equal(hooks,0);assert.equal(mirrorOwnershipReaderBusy(),false);
}));
