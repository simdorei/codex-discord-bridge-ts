import {it} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {deleteArchivedStateRows as state,deleteArchivedLogRows as logs,ArchiveConcurrentMutationError} from '../../../src/runtime/archive-delete/records.ts';
const limits={maxRows:32,maxBytes:65536};
const schema=`CREATE TABLE threads(id TEXT,archived INTEGER,rollout_path TEXT,title TEXT);
CREATE TABLE thread_spawn_edges(child_thread_id TEXT,parent_thread_id TEXT);
CREATE TABLE logs(thread_id TEXT,v);
INSERT INTO threads VALUES('t',1,'/archive/t','old'),('other',1,'/archive/o','other');
INSERT INTO thread_spawn_edges VALUES('t','p'),('c','t'),('t','t'),('x','y');
INSERT INTO logs VALUES('t',1),('t',1),('other',2);`;
function fixture(run:(db:DatabaseSync,backup:DatabaseSync)=>void){const db=new DatabaseSync(':memory:'),backup=new DatabaseSync(':memory:');try{db.exec(schema);backup.exec(schema);run(db,backup);}finally{db.close();backup.close();}}
function count(db:DatabaseSync,table:string):number{return db.prepare('SELECT COUNT(*) AS n FROM '+table).get()!.n as number;}
it('state deletion removes exact thread and both edge roles, preserving other rows and backup',()=>fixture((db,backup)=>{
 backup.exec('PRAGMA query_only=ON');state(db,backup,'t','/archive/t',limits);
 assert.equal(count(db,'threads'),1);assert.equal(count(db,'thread_spawn_edges'),1);assert.equal(count(backup,'threads'),2);assert.equal(db.isTransaction,false);
 assert.equal(db.prepare('SELECT id FROM threads').get()!.id,'other');
}));
it('changed archived flag, path, title or missing thread refuses before deletes',()=>{
 for(const sql of ["UPDATE threads SET archived=0 WHERE id='t'","UPDATE threads SET rollout_path='/new' WHERE id='t'","UPDATE threads SET title='new' WHERE id='t'","DELETE FROM threads WHERE id='t'"]){fixture((db,backup)=>{db.exec(sql);const n=count(db,'threads');assert.throws(()=>state(db,backup,'t','/archive/t',limits),ArchiveConcurrentMutationError);assert.equal(count(db,'threads'),n);assert.equal(count(db,'thread_spawn_edges'),4);assert.equal(db.isTransaction,false);});}
});
it('changed edge multiset refuses even when selected thread is unchanged',()=>fixture((db,backup)=>{
 db.exec("INSERT INTO thread_spawn_edges VALUES('t','p')");assert.throws(()=>state(db,backup,'t','/archive/t',limits),ArchiveConcurrentMutationError);assert.equal(count(db,'threads'),2);assert.equal(count(db,'thread_spawn_edges'),5);
}));
it('zero deleted thread rolls back earlier edge deletion',()=>fixture((db,backup)=>{
 db.exec("CREATE TRIGGER ignore_thread BEFORE DELETE ON threads BEGIN SELECT RAISE(IGNORE); END");assert.throws(()=>state(db,backup,'t','/archive/t',limits),ArchiveConcurrentMutationError);assert.equal(count(db,'thread_spawn_edges'),4);assert.equal(count(db,'threads'),2);
}));
it('multiple deleted threads rolls back rather than reporting success',()=>fixture((db,backup)=>{
 for(const x of [db,backup])x.exec("INSERT INTO threads SELECT * FROM threads WHERE id='t'");assert.throws(()=>state(db,backup,'t','/archive/t',limits),ArchiveConcurrentMutationError);assert.equal(count(db,'threads'),3);assert.equal(count(db,'thread_spawn_edges'),4);
}));
it('native statement failure preserves rows through transaction rollback',()=>fixture((db,backup)=>{
 db.exec("CREATE TRIGGER reject_thread BEFORE DELETE ON threads BEGIN SELECT RAISE(ABORT,'native denial'); END");assert.throws(()=>state(db,backup,'t','/archive/t',limits),/native denial/);assert.equal(count(db,'thread_spawn_edges'),4);assert.equal(db.isTransaction,false);
}));
it('log deletion preserves duplicate evidence and returns exact bigint count',()=>fixture((db,backup)=>{
 assert.equal(logs(db,backup,'t',limits),2n);assert.equal(count(db,'logs'),1);assert.equal(count(backup,'logs'),3);assert.equal(logs(db,backup,'absent',limits),0n);
}));
it('changed log content refuses without deletion',()=>fixture((db,backup)=>{
 db.exec("UPDATE logs SET v='1' WHERE thread_id='t'");assert.throws(()=>logs(db,backup,'t',limits),ArchiveConcurrentMutationError);assert.equal(count(db,'logs'),3);assert.equal(db.isTransaction,false);
}));
it('row budget failure cannot partially approve state or logs',()=>fixture((db,backup)=>{
 assert.throws(()=>state(db,backup,'t','/archive/t',{...limits,maxRows:1}),/row budget/);assert.throws(()=>logs(db,backup,'t',{...limits,maxRows:1}),/row budget/);assert.equal(count(db,'threads'),2);assert.equal(count(db,'logs'),3);assert.equal(db.isTransaction,false);
}));
it('caller transaction and identical backup handle are refused without lifecycle changes',()=>fixture((db,backup)=>{
 assert.throws(()=>state(db,db,'t','/archive/t',limits),/distinct/);db.exec('BEGIN IMMEDIATE');assert.throws(()=>state(db,backup,'t','/archive/t',limits),/idle/);assert.equal(db.isTransaction,true);db.exec('ROLLBACK');
}));
it('missing backup schema, query-only destination and invalid arguments fail closed',()=>fixture((db,backup)=>{
 assert.throws(()=>state(db,backup,'\uD800','/archive/t',limits),TypeError);assert.throws(()=>state(db,backup,'t','/archive/t',{...limits,maxRows:0}),RangeError);
 backup.exec('DROP TABLE thread_spawn_edges');assert.throws(()=>state(db,backup,'t','/archive/t',limits),/no such table/);assert.equal(count(db,'thread_spawn_edges'),4);assert.equal(db.isTransaction,false);
 db.exec('PRAGMA query_only=ON');assert.throws(()=>logs(db,backup,'t',limits),/readonly/);assert.equal(count(db,'logs'),3);
}));
