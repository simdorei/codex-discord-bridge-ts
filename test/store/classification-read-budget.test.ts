import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {SelectedReadBudget} from '../../src/store/selected-read-budget.ts';
import {asyncResolutionHeldIn} from '../../src/store/async-resolution-admission.ts';
/** Query-only corrupt-value fixture. Never weakens a real store's guards. */
function fixture(run:(db:DatabaseSync)=>void){const db=new DatabaseSync(':memory:');try{
 db.exec(`CREATE TABLE cdr_async_execution_obligations(question_id TEXT,thread_id TEXT);INSERT INTO cdr_async_execution_obligations VALUES('q','t');
 CREATE VIEW cdr_async_unsettled_obligations AS SELECT thread_id FROM cdr_async_execution_obligations WHERE 0;
 CREATE TABLE discord_ingress_journal(ingress_id TEXT,created_at INTEGER,target_thread_id TEXT,owner_id TEXT,state TEXT,phase TEXT,payload_json,outcome_json);`);
 db.prepare("INSERT INTO discord_ingress_journal VALUES('i',1,'t',NULL,'pending','received',?,NULL)").run('{"version":1,"command":"stop","extra":"'+ 'x'.repeat(2048)+'"}');run(db);
 }finally{db.close();}}
test('conditional lifecycle payload consumes shared classification selected-value budget',()=>fixture(db=>{
 assert.equal(asyncResolutionHeldIn(db,'t'),true);assert.throws(()=>asyncResolutionHeldIn(db,'t',new SelectedReadBudget(100n,1024n)),/selected values exceed budget/);assert.equal(asyncResolutionHeldIn(db,'t',new SelectedReadBudget(100n,65536n)),true);
}));
test('lifecycle selected row consumes shared budget only when parent reaches that branch',()=>fixture(db=>{
 assert.throws(()=>asyncResolutionHeldIn(db,'t',new SelectedReadBudget(5n,65536n)),/selected rows exceed budget/);
 db.exec("CREATE TABLE cdr_async_recovery_policies(thread_id TEXT);INSERT INTO cdr_async_recovery_policies VALUES('t')");assert.equal(asyncResolutionHeldIn(db,'t',new SelectedReadBudget(2n,16n)),true);
}));
