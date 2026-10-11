import {it} from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {existsSync} from 'node:fs';
import {storeFixture} from '../helpers/store-fixture.ts';
import {resolveThreadReferenceOffThread as read} from '../../src/codex-state/reference-reader.ts';
import {ThreadResolveError} from '../../src/codex-state/thread-reference.ts';
import {ownedWorkerUsage,OwnedWorkerBusyError,OwnedWorkerTimeoutError} from '../../src/runtime/owned-worker-slot.ts';
function seed(path:string,extra=''){const db=new DatabaseSync(path);try{db.exec("CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,updated_at INTEGER,rollout_path TEXT,model TEXT,reasoning_effort TEXT,tokens_used INTEGER,archived INTEGER,archived_at INTEGER);INSERT INTO threads VALUES('a','A','/one',5,'/a',NULL,NULL,0,1,2),('b','B','/two',3,'/b',NULL,NULL,0,1,4),('live','Live','/live',10,'/live',NULL,NULL,0,0,0);"+extra);}finally{db.close();}}
it('archived numeric, workspace and next references use complete source archived ordering',()=>storeFixture(async path=>{
 seed(path);assert.equal((await read(path,'1',null,true)).id,'b');assert.equal((await read(path,'2',null,true)).id,'a');
 assert.equal((await read(path,'other','b',true)).id,'a');assert.equal((await read(path,'one',null,true)).id,'a');
 assert.equal((await read(path,'live',null,false)).id,'live');
 await assert.rejects(read(path,'3',null,true),e=>e instanceof ThreadResolveError&&e.kind==='IndexOutOfRange'&&e.archived);
 await assert.rejects(read(path,'live',null,true),e=>e instanceof ThreadResolveError&&e.kind==='NotFound');
}));
it('exact lookup masks unrelated malformed inventory; fallback does not hide corruption',()=>storeFixture(async path=>{
 seed(path,"INSERT INTO threads VALUES('bad','Bad','/bad',1,'/bad',NULL,NULL,'invalid',1,1)");
 assert.equal((await read(path,'a',null,true)).id,'a');await assert.rejects(read(path,'1',null,true));assert.equal(ownedWorkerUsage().Background,0);
}));
it('complete inventory overflow never produces a partial alias result but exact ID still works',()=>storeFixture(async path=>{
 seed(path,"WITH RECURSIVE n(x)AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<4095) INSERT INTO threads SELECT 'extra-'||x,'Extra','/extra',0,'/x',NULL,NULL,0,1,0 FROM n");
 await assert.rejects(read(path,'1',null,true),/budget/);assert.equal((await read(path,'a',null,true)).id,'a');
}));
it('exact oversized row and archived_at measurement reject before unbounded decoding',()=>storeFixture(async path=>{
 seed(path,"UPDATE threads SET title=CAST(zeroblob(300000) AS TEXT) WHERE id='a'");
 await assert.rejects(read(path,'a',null,true),/budget/);
 const db=new DatabaseSync(path);try{db.exec("UPDATE threads SET title='A',archived_at=zeroblob(5000000) WHERE id='a'");}finally{db.close();}
 await assert.rejects(read(path,'1',null,true),/budget/);
}));
it('ambiguous alias and empty inventory retain source typed errors',()=>storeFixture(async path=>{
 seed(path,"UPDATE threads SET cwd='/same' WHERE archived=1");
 await assert.rejects(read(path,'same',null,true),e=>e instanceof ThreadResolveError&&e.kind==='Ambiguous'&&e.options==='b, a');
 const db=new DatabaseSync(path);try{db.exec('DELETE FROM threads WHERE archived=1');}finally{db.close();}
 await assert.rejects(read(path,'1',null,true),e=>e instanceof ThreadResolveError&&e.kind==='NoThreads'&&e.archived);
}));
it('missing DB, preabort, overload and timeout never substitute a target or leak capacity',()=>storeFixture(async path=>{
 const c=new AbortController(),reason=new Error('stop');c.abort(reason);await assert.rejects(read(path,'a',null,true,c.signal),e=>e===reason);assert.equal(existsSync(path),false);
 await assert.rejects(read(path,'a',null,true),/not found/);assert.equal(existsSync(path),false);
 seed(path);const pending=read(path,'a',null,true);await assert.rejects(read(path,'b',null,true),OwnedWorkerBusyError);await pending;
 await assert.rejects(read(path,'a',null,true,undefined,1),OwnedWorkerTimeoutError);assert.equal(ownedWorkerUsage().Background,0);
}));
