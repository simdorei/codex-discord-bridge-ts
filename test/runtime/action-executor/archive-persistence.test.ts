import assert from 'node:assert/strict';import {it} from 'node:test';import {DatabaseSync} from 'node:sqlite';import {setTimeout as delay} from 'node:timers/promises';import {join,dirname} from 'node:path';
import {storeFixture} from '../../helpers/store-fixture.ts';import {verifyArchivedScope} from '../../../src/runtime/action-executor/archive-persistence.ts';import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
function setup(path:string){const file=join(dirname(path),'codex.sqlite'),db=new DatabaseSync(file);try{db.exec("CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,updated_at INTEGER,rollout_path TEXT,model TEXT,reasoning_effort TEXT,tokens_used INTEGER,archived INTEGER,archived_at INTEGER);INSERT INTO threads(id,title,cwd,updated_at,archived,archived_at) VALUES ('a','A','/tmp',1,0,0),('b','B','/tmp',1,1,2)");}finally{db.close();}return file;}
function archive(file:string){const db=new DatabaseSync(file);try{db.exec("UPDATE threads SET archived=1,archived_at=2 WHERE id='a'");}finally{db.close();}}
it('all persisted members are required; delayed native state change is observed without mutating reservations',async()=>storeFixture(async path=>{
 const file=setup(path),op=await state.reserveArchiveScope(path,['a','b'],null);let finished=false;const pending=verifyArchivedScope(file,['a','b']).then(()=>{finished=true;});await delay(40);assert.equal(finished,false);archive(file);await pending;assert.equal(await state.archiveTargetFenced(path,'a'),true);await state.releaseRejectedArchive(path,op);
}));
it('three-second bounded verification fails on incomplete persisted scope, retaining both fences',async()=>storeFixture(async path=>{
 const file=setup(path);await state.reserveArchiveScope(path,['a','b'],null);const start=performance.now();await assert.rejects(verifyArchivedScope(file,['a','b']),/not verified for \[a\].*do not automatically retry/);assert.ok(performance.now()-start>=2900);assert.ok(performance.now()-start<6000);assert.equal(await state.archiveTargetFenced(path,'a'),true);assert.equal(await state.archiveTargetFenced(path,'b'),true);
}));
it('cancellation joins delay and retains exact caller reason and reservation',async()=>storeFixture(async path=>{
 const file=setup(path);await state.reserveArchiveScope(path,['a'],null);const c=new AbortController(),reason=new Error('caller cancel'),pending=verifyArchivedScope(file,['a'],c.signal);const assertion=assert.rejects(pending,e=>e===reason);await delay(20);c.abort(reason);await assertion;assert.equal(await state.archiveTargetFenced(path,'a'),true);
 const before=new AbortController();before.abort(reason);await assert.rejects(verifyArchivedScope('/absent',['a'],before.signal),e=>e===reason);
}));
it('scope is copied before await and malformed or getter-backed scopes fail before database reads',async()=>storeFixture(async path=>{
 const file=setup(path),scope=['a','b'];const pending=verifyArchivedScope(file,scope);scope[0]='missing';archive(file);await pending;
 for(const bad of [[],[''],['a','a'],Array.from({length:102},(_,i)=>String(i)),['\ud800']])await assert.rejects(verifyArchivedScope('/absent',bad),TypeError);
 let called=0;const hostile:string[]=[];Object.defineProperty(hostile,'0',{get(){called++;return 'a';},enumerable:true});await assert.rejects(verifyArchivedScope('/absent',hostile),TypeError);assert.equal(called,0);
}));
it('native malformed state errors are visible and cannot be treated as archive confirmation',async()=>storeFixture(async path=>{
 const file=setup(path),db=new DatabaseSync(file);try{db.exec('DROP TABLE threads');}finally{db.close();}await assert.rejects(verifyArchivedScope(file,['a']));
}));
