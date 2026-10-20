import test from 'node:test';import assert from 'node:assert/strict';import type {DatabaseSync} from 'node:sqlite';
import {storeFixture} from '../../helpers/store-fixture.ts';import {queueJob} from '../../helpers/queue-job.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';import {enqueue} from '../../../src/store/queue-enqueue.ts';
import {turnOriginMarker} from '../../../src/store/mirror-event-read.ts';
import {requireCurrentMirrorSkipsIn as check,MirrorSkipUnprovenError,MirrorOwnershipPendingError} from '../../../src/runtime/session-mirror/ownership.ts';
import {collectSessionItems} from '../../../src/runtime/session-mirror/collect.ts';
const item=(kind='agent_message',turn:string|null='turn')=>collectSessionItems('target',[{type:'event_msg',payload:{type:kind,message:'hello'}}],'Send',turn).items[0]!;
const mark=(db:DatabaseSync,digest:string,thread='target')=>db.prepare('INSERT INTO codex_session_mirror_events VALUES(?,?,1)').run(digest,thread);
test('all skipped items require current proof, and every result remains inside caller transaction',async()=>storeFixture(async path=>{
 const db=await openInitialized(path),a=item(),b=item('agent_message','second');try{
  db.exec('BEGIN');mark(db,a.digest);assert.throws(()=>check(db,'target',[a,b],32n,1048576n),e=>e instanceof MirrorSkipUnprovenError&&e.itemIndex===1);assert.equal(db.isTransaction,true);
  mark(db,turnOriginMarker('target','second'));check(db,'target',[a,b],32n,1048576n);assert.equal(db.isTransaction,true);db.exec('ROLLBACK;BEGIN');
  assert.throws(()=>check(db,'target',[a],32n,1048576n),MirrorSkipUnprovenError);db.exec('ROLLBACK');
 }finally{db.close()}
}));
test('one complete queue measurement and decode covers whole skipped batch',async()=>storeFixture(async path=>{
 const db=await openInitialized(path);try{
  db.exec('BEGIN');mark(db,turnOriginMarker('target','turn'));let measurements=0,queueReads=0;
  const wrapped={get isTransaction(){return db.isTransaction},prepare(sql:string){if(sql.includes('COUNT(*) AS rows'))measurements++;if(sql.includes('FROM codex_turn_queue'))queueReads++;return db.prepare(sql)}} as DatabaseSync;
  check(wrapped,'target',Array.from({length:100},()=>item()),32n,1048576n);assert.equal(measurements,1);assert.equal(queueReads,2);assert.equal(db.isTransaction,true);db.exec('ROLLBACK');
 }finally{db.close()}
}));
test('pending ownership masks marker success, removed ownership cannot reuse earlier skip',async()=>storeFixture(async path=>{
 await enqueue(path,queueJob());const db=await openInitialized(path);try{
  db.exec("UPDATE codex_turn_queue SET state='running',turn_id='turn';BEGIN");check(db,'target',[item()],32n,1048576n);
  db.exec("SAVEPOINT removed;DELETE FROM codex_turn_queue");assert.throws(()=>check(db,'target',[item()],32n,1048576n),MirrorSkipUnprovenError);
  db.exec('ROLLBACK TO removed;RELEASE removed');mark(db,item().digest);db.exec("UPDATE codex_turn_queue SET state='starting'");assert.throws(()=>check(db,'target',[item()],32n,1048576n),MirrorOwnershipPendingError);assert.equal(db.isTransaction,true);db.exec('ROLLBACK');
 }finally{db.close()}
}));
test('user skip requires user or exact event evidence and wrong target marker is insufficient',async()=>storeFixture(async path=>{
 const db=await openInitialized(path);try{db.exec('BEGIN');mark(db,turnOriginMarker('target','turn'));mark(db,item('user_message').digest,'other');
  assert.throws(()=>check(db,'target',[item('user_message')],32n,1048576n),MirrorSkipUnprovenError);db.prepare('DELETE FROM codex_session_mirror_events WHERE event_digest=?').run(item('user_message').digest);mark(db,item('user_message').digest);check(db,'target',[item('user_message')],32n,1048576n);db.exec('ROLLBACK');
 }finally{db.close()}
}));
test('snapshot budget failures retain caller transaction and never accept a queue prefix',async()=>storeFixture(async path=>{
 await enqueue(path,queueJob());await enqueue(path,{...queueJob(),jobId:'second',discordMessageId:999n});const db=await openInitialized(path);try{db.exec('BEGIN');mark(db,item().digest);
  assert.throws(()=>check(db,'target',[item()],1n,1048576n),/exceeds budget/);assert.equal(db.isTransaction,true);db.exec('ROLLBACK');
 }finally{db.close()}
}));
test('own-data validation bounds skipped batch and never invokes getters or proxies',async()=>storeFixture(async path=>{
 const db=await openInitialized(path);try{db.exec('BEGIN');let calls=0;const bad={...item(),get digest():string{calls++;throw Error('getter')}};
  assert.throws(()=>check(db,'target',[bad],32n,1048576n),TypeError);assert.equal(calls,0);
  const proxy=new Proxy([],{get(){calls++;throw Error('proxy')}});assert.throws(()=>check(db,'target',proxy,32n,1048576n),TypeError);assert.equal(calls,0);
  assert.throws(()=>check(db,'target',Array(4097),32n,1048576n),TypeError);assert.throws(()=>check(db,'target',[{...item(),text:'x'.repeat(1048577)}],32n,1048576n),RangeError);
  assert.throws(()=>check(db,'target',[{...item(),digest:'한'.repeat(1024)}],32n,1048576n),RangeError);assert.equal(db.isTransaction,true);db.exec('ROLLBACK');
 }finally{db.close()}
}));
test('empty proof is vacuous only within active caller transaction and does not inspect absent schema',async()=>storeFixture(async path=>{
 const db=await openInitialized(path);try{assert.throws(()=>check(db,'target',[],32n,1048576n),/active caller transaction/);db.exec('BEGIN;DROP TABLE codex_turn_queue');check(db,'target',[],32n,1048576n);assert.equal(db.isTransaction,true);db.exec('ROLLBACK');}finally{db.close()}
}));
