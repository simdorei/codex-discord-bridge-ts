import {it} from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {existsSync,readFileSync} from 'node:fs';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {archiveRowDigestsIn} from '../../../src/runtime/archive-delete/row-digests.ts';
import {readArchiveRowsOffThread as read,NativeArchiveEvidenceError} from '../../../src/runtime/archive-delete/native-row-digests.ts';
import {ownedWorkerUsage,OwnedWorkerBusyError,OwnedWorkerTimeoutError} from '../../../src/runtime/owned-worker-slot.ts';
const limits={maxRows:32,maxBytes:65536,timeoutMs:5000};
function seed(path:string){const db=new DatabaseSync(path);try{db.exec("CREATE TABLE logs(thread_id TEXT,v);INSERT INTO logs VALUES('t',1),('t',CAST(X'FF00' AS TEXT)),('t',1),('other',7)");return archiveRowDigestsIn(db,'logs','t',limits);}finally{db.close();}}
it('actual native snapshot matches raw-cell leaf and preserves DB bytes',()=>storeFixture(async path=>{
 const expected=seed(path),before=readFileSync(path),mutable={...limits};const pending=read(path,'logs','t',mutable);mutable.maxRows=1;mutable.maxBytes=1;
 assert.equal(ownedWorkerUsage().Background,1);const result=await pending;assert.deepEqual(result,expected);assert.ok(Object.isFrozen(result));assert.deepEqual(readFileSync(path),before);assert.equal(ownedWorkerUsage().Background,0);
 const db=new DatabaseSync(path);try{db.exec("UPDATE logs SET v=2 WHERE typeof(v)='integer' AND thread_id='t'");}finally{db.close();}
 assert.notDeepEqual(await read(path,'logs','t',limits),expected);
}));
it('missing input and preabort never create a file or submit work',()=>storeFixture(async path=>{
 const c=new AbortController(),reason=new Error('cancel before submit');c.abort(reason);
 await assert.rejects(read(path,'logs','t',limits,c.signal),e=>e===reason);assert.equal(existsSync(path),false);assert.equal(ownedWorkerUsage().Background,0);
 await assert.rejects(read(path,'logs','t',limits),NativeArchiveEvidenceError);assert.equal(existsSync(path),false);assert.equal(ownedWorkerUsage().Background,0);
}));
it('single-slot overload, timeout and abort join real native exit before returning',()=>storeFixture(async path=>{
 seed(path);const first=read(path,'logs','t',limits);await assert.rejects(read(path,'logs','t',limits),OwnedWorkerBusyError);await first;
 await assert.rejects(read(path,'logs','t',{...limits,timeoutMs:1}),OwnedWorkerTimeoutError);assert.equal(ownedWorkerUsage().Background,0);
 const c=new AbortController(),reason=new Error('cancel submitted read'),pending=read(path,'logs','t',limits,c.signal);c.abort(reason);await assert.rejects(pending,e=>e===reason);assert.equal(ownedWorkerUsage().Background,0);
 assert.equal((await read(path,'logs','t',limits)).length,3);
}));
it('budget or malformed schema failure yields no digests and releases native capacity',()=>storeFixture(async path=>{
 seed(path);await assert.rejects(read(path,'logs','t',{...limits,maxRows:2}),NativeArchiveEvidenceError);
 const db=new DatabaseSync(path);try{db.exec('DROP TABLE logs;CREATE TABLE logs(wrong TEXT)');}finally{db.close();}
 await assert.rejects(read(path,'logs','t',limits),NativeArchiveEvidenceError);assert.equal(ownedWorkerUsage().Background,0);
}));
it('passive limit capture rejects accessors without executing hooks',()=>storeFixture(async path=>{
 let hooks=0;await assert.rejects(read(path,'logs','t',{get maxRows(){hooks++;return 32;},maxBytes:65536,timeoutMs:5000}),TypeError);
 await assert.rejects(read(path,'logs','t'.repeat(4097),limits),RangeError);
 assert.equal(hooks,0);assert.equal(ownedWorkerUsage().Background,0);assert.equal(existsSync(path),false);
}));
