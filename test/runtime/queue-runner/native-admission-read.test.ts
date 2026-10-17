import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {createNativeQueueReadState,NativeQueueReadUnavailableError} from '../../../src/runtime/queue-runner/native-read-state.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {OwnedWorkerSlot,OwnedWorkerBudgetError,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
function edit(path:string,sql:string){const db=new DatabaseSync(path);try{db.exec(sql);}finally{db.close();}}
const questions="CREATE TABLE cdr_async_questions(id TEXT,thread_id TEXT,state TEXT,dispatch_mode TEXT);";
test('existing async dispatch closes first handle before second start-mode query and never shares a transaction',async t=>storeFixture(async path=>{
 edit(path,questions+"INSERT INTO cdr_async_questions VALUES('q','t','dispatching','start')");
 const prepare=DatabaseSync.prototype.prepare,close=DatabaseSync.prototype.close,seen:DatabaseSync[]=[],closed:DatabaseSync[]=[];let second=false;
 t.mock.method(DatabaseSync.prototype,'close',function(this:DatabaseSync){closed.push(this);return close.call(this);});
 t.mock.method(DatabaseSync.prototype,'prepare',function(this:DatabaseSync,sql:string){if(!seen.includes(this))seen.push(this);assert.equal(this.isTransaction,false);if(sql.includes("dispatch_mode='start'")){second=true;assert.equal(seen.length,2);assert.notEqual(this,seen[0]);assert.equal(closed.includes(seen[0]!),true);assert.equal(seen[0]!.isOpen,false);}return prepare.call(this,sql);});
 assert.equal(state.asyncTargetDispatchHeldExisting(path,'t'),true);assert.equal(second,true);assert.equal(seen.length,2);assert.equal(closed.length,2);assert.ok(seen.every(db=>!db.isOpen));
}));
test('native dead-target read preserves empty and astral exact identities and missing-column refusal',async()=>storeFixture(async path=>{
 edit(path,"CREATE TABLE codex_dead_generation_holds(target_thread_id TEXT);INSERT INTO codex_dead_generation_holds VALUES(''),('😀')");const native=createNativeQueueReadState(path);for(const target of ['','😀','missing'])assert.equal(await native.deadTargetHeld(path,target),state.deadGenerationTargetHeldExisting(path,target));edit(path,'DROP TABLE codex_dead_generation_holds;CREATE TABLE codex_dead_generation_holds(wrong TEXT)');await assert.rejects(native.deadTargetHeld(path,'😀'),NativeQueueReadUnavailableError);
}));
test('native async dispatch preserves steer first and separate start check, exact target and valid empty string',async()=>storeFixture(async path=>{
 edit(path,questions+"INSERT INTO cdr_async_questions VALUES('s','steer','dispatching','steer'),('a','start','dispatching','start'),('e','','dispatching','start'),('u','😀','dispatching','start'),('done','done','answered','start')");const native=createNativeQueueReadState(path);for(const target of ['steer','start','','😀','done','absent'])assert.equal(await native.asyncTargetDispatchHeld(path,target),state.asyncTargetDispatchHeldExisting(path,target));assert.equal(await native.asyncTargetDispatchHeld(path,'done'),false);
}));
test('policy and unsettled holds mask malformed later questions without inventing a false result',async()=>storeFixture(async path=>{
 edit(path,"CREATE TABLE cdr_async_recovery_policies(thread_id TEXT);INSERT INTO cdr_async_recovery_policies VALUES('policy');CREATE TABLE cdr_async_execution_obligations(question_id TEXT,thread_id TEXT);INSERT INTO cdr_async_execution_obligations VALUES('q','unsettled');CREATE VIEW cdr_async_unsettled_obligations AS SELECT thread_id FROM cdr_async_execution_obligations;CREATE TABLE cdr_async_questions(wrong TEXT)");const native=createNativeQueueReadState(path);assert.equal(await native.asyncTargetDispatchHeld(path,'policy'),true);assert.equal(await native.asyncTargetDispatchHeld(path,'unsettled'),true);await assert.rejects(native.asyncTargetDispatchHeld(path,'unheld'),NativeQueueReadUnavailableError);
}));
test('false first admission requires second dispatch table and cannot hide an absent table',async()=>storeFixture(async path=>{
 edit(path,'CREATE TABLE unrelated(id INTEGER)');assert.throws(()=>state.asyncTargetDispatchHeldExisting(path,'t'),/no such table/);await assert.rejects(createNativeQueueReadState(path).asyncTargetDispatchHeld(path,'t'),NativeQueueReadUnavailableError);
}));
test('native lifecycle preserves ordinary outcome bypass, control hold and row129 predecode limit',async()=>storeFixture(async path=>{
 edit(path,questions+"CREATE TABLE cdr_async_execution_obligations(question_id TEXT,thread_id TEXT);INSERT INTO cdr_async_execution_obligations VALUES('q','t');CREATE VIEW cdr_async_unsettled_obligations AS SELECT thread_id FROM cdr_async_execution_obligations WHERE 0;CREATE TABLE discord_ingress_journal(ingress_id TEXT,created_at INTEGER,target_thread_id TEXT,owner_id TEXT,state TEXT,phase TEXT,payload_json,outcome_json)");const db=new DatabaseSync(path);try{const q=db.prepare("INSERT INTO discord_ingress_journal VALUES(?,?,'t',NULL,'pending','received',?,X'FF')");for(let i=0;i<128;i++)q.run(String(i),i,'{"version":1,"command":"help"}');}finally{db.close();}const native=createNativeQueueReadState(path);assert.equal(await native.asyncTargetDispatchHeld(path,'t'),false);edit(path,"INSERT INTO discord_ingress_journal VALUES('129',129,'t',NULL,'pending','received',CAST(X'FF' AS TEXT),X'FF')");assert.equal(await native.asyncTargetDispatchHeld(path,'t'),true);edit(path,"UPDATE discord_ingress_journal SET payload_json='{\"version\":1,\"command\":\"stop\"}',outcome_json=NULL WHERE ingress_id='0'");assert.equal(await native.asyncTargetDispatchHeld(path,'t'),true);assert.equal(ownedWorkerUsage().Control,0);
}));
test('admission inputs reject retargeting and lone surrogate; missing store never becomes a permission or created DB',async()=>storeFixture(async path=>{
 const native=createNativeQueueReadState(path);for(const key of ['deadTargetHeld','asyncTargetDispatchHeld'] as const){await assert.rejects(native[key](path+'other','t'),TypeError);await assert.rejects(native[key](path,'\ud800'));await assert.rejects(native[key](path,'t'),NativeQueueReadUnavailableError);assert.equal(existsSync(path),false);}assert.equal(ownedWorkerUsage().Control,0);
}));
test('admission native response accepts only exact boolean, not integer or partial envelope',async t=>storeFixture(async path=>{
 const native=createNativeQueueReadState(path);for(const value of [0,1,null,{},'false']){const stub=t.mock.method(OwnedWorkerSlot.prototype,'run',async()=>({ok:true,value}));try{await assert.rejects(native.deadTargetHeld(path,'t'),NativeQueueReadUnavailableError);await assert.rejects(native.asyncTargetDispatchHeld(path,'t'),NativeQueueReadUnavailableError);}finally{stub.mock.restore();}}assert.equal(existsSync(path),false);
}));
test('native admission reads retain Control saturation and never consume Background capacity',async()=>storeFixture(async path=>{
 edit(path,questions+'CREATE TABLE codex_dead_generation_holds(target_thread_id TEXT)');const native=createNativeQueueReadState(path),first=native.deadTargetHeld(path,'t');await assert.rejects(native.asyncTargetDispatchHeld(path,'t'),OwnedWorkerBudgetError);assert.equal(ownedWorkerUsage().Background,0);assert.equal(await first,false);assert.equal(ownedWorkerUsage().Control,0);
}));
