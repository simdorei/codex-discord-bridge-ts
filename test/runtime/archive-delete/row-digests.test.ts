import {it} from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {createHash} from 'node:crypto';
import {archiveRowDigestsIn as rows,ArchiveEvidenceLimitError} from '../../../src/runtime/archive-delete/row-digests.ts';
const limits={maxRows:32,maxBytes:65536};
function fixture(run:(db:DatabaseSync)=>void){const db=new DatabaseSync(':memory:');try{run(db);}finally{db.close();}}
const text=(v:Buffer,tag=3)=>{const n=Buffer.alloc(8);n.writeBigUInt64LE(BigInt(v.length));return Buffer.concat([Buffer.from([tag]),n,v]);};
it('row digest matches source little-endian typed cells including raw invalid UTF8 and i64',()=>fixture(db=>{
 db.exec("CREATE TABLE logs(thread_id TEXT,n,i,r,t,b); INSERT INTO logs VALUES('t',NULL,-9223372036854775808,1.5,CAST(X'FF00C3' AS TEXT),X'FF00C3')");
 const i=Buffer.alloc(9);i[0]=1;i.writeBigInt64LE(-9223372036854775808n,1);const r=Buffer.alloc(9);r[0]=2;r.writeDoubleLE(1.5,1);
 const input=Buffer.concat([Buffer.from('thread_id\0n\0i\0r\0t\0b'),text(Buffer.from('t')),Buffer.from([0]),i,r,text(Buffer.from([255,0,195])),text(Buffer.from([255,0,195]),4)]);
 const expected=createHash('sha256').update(input).digest('hex');
 assert.deepEqual(rows(db,'logs','t',limits),[expected]);
}));
it('order-independent sorted multiset retains duplicates and differentiates storage classes',()=>fixture(db=>{
 db.exec("CREATE TABLE logs(thread_id TEXT,v);INSERT INTO logs VALUES('t',1),('t',1.0),('t','1'),('t',X'31'),('t',NULL),('t',1),('other',7)");
 const a=rows(db,'logs','t',limits);assert.equal(a.length,6);assert.equal(new Set(a).size,5);assert.ok(Object.isFrozen(a));
 db.exec("CREATE TABLE copy AS SELECT * FROM logs ORDER BY rowid DESC;DELETE FROM logs;INSERT INTO logs SELECT * FROM copy");
 assert.deepEqual(rows(db,'logs','t',limits),a);
}));
it('source column labels and column order participate in digest',()=>fixture(db=>{
 db.exec("CREATE TABLE logs(thread_id TEXT,x);INSERT INTO logs VALUES('t',1)");
 const before=rows(db,'logs','t',limits);db.exec('ALTER TABLE logs RENAME COLUMN x TO y');assert.notDeepEqual(rows(db,'logs','t',limits),before);
}));
it('exact source thread and edge selectors include both roles only',()=>fixture(db=>{
 db.exec("CREATE TABLE threads(id TEXT,archived INTEGER);INSERT INTO threads VALUES('t',1),('other',1);CREATE TABLE thread_spawn_edges(child_thread_id TEXT,parent_thread_id TEXT);INSERT INTO thread_spawn_edges VALUES('t','p'),('c','t'),('t','t'),('x','y')");
 assert.equal(rows(db,'thread','t',limits).length,1);assert.equal(rows(db,'edges','t',limits).length,3);
 assert.deepEqual(rows(db,'edges',"t' OR 1=1 --",limits),[]);
}));
it('whole row and byte exhaustion return no partial approval; huge cells SQL-masked',()=>fixture(db=>{
 db.exec("CREATE TABLE logs(thread_id TEXT,v);INSERT INTO logs VALUES('t',1),('t',2)");
 assert.throws(()=>rows(db,'logs','t',{...limits,maxRows:1}),ArchiveEvidenceLimitError);
 assert.throws(()=>rows(db,'logs','t',{...limits,maxBytes:30}),ArchiveEvidenceLimitError);
 db.exec("DELETE FROM logs;INSERT INTO logs VALUES('t',zeroblob(5000000))");
 assert.throws(()=>rows(db,'logs','t',{...limits,maxBytes:64}),/row bytes exceeded/);
}));
it('native SQL errors propagate and borrowed transaction remains rollbackable',()=>fixture(db=>{
 assert.throws(()=>rows(db,'logs','t',limits),/no such table/);
 db.exec("CREATE TABLE logs(thread_id TEXT,v);BEGIN IMMEDIATE;INSERT INTO logs VALUES('t',1);PRAGMA query_only=ON");
 assert.equal(rows(db,'logs','t',limits).length,1);assert.equal(db.isTransaction,true);
 db.exec('PRAGMA query_only=OFF;ROLLBACK');assert.deepEqual(rows(db,'logs','t',limits),[]);
}));
it('UTF16 is explicitly rejected rather than hashing encoding-dependent CAST bytes',()=>fixture(db=>{
 db.exec("PRAGMA encoding='UTF-16le';CREATE TABLE logs(thread_id TEXT,v);INSERT INTO logs VALUES('t','문자')");
 assert.throws(()=>rows(db,'logs','t',limits),/unsupported database encoding/);
}));
it('input limits, unsupported queries and excessive column count fail closed',()=>fixture(db=>{
 for(const maxRows of [0,4097,NaN])assert.throws(()=>rows(db,'logs','t',{...limits,maxRows}),RangeError);
 assert.throws(()=>rows(db,'logs','\uD800',limits),TypeError);
 assert.throws(()=>rows(db,'other' as 'logs','t',limits),TypeError);
 db.exec('CREATE TABLE logs(thread_id TEXT,'+Array.from({length:128},(_,i)=>'c'+i).join(',')+')');
 assert.throws(()=>rows(db,'logs','t',limits),/column budget/);
}));
