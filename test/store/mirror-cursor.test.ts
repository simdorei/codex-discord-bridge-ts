import test from 'node:test';import assert from 'node:assert/strict';import {existsSync} from 'node:fs';import type {DatabaseSync} from 'node:sqlite';
import {storeFixture} from '../helpers/store-fixture.ts';import {openInitialized} from '../../src/store/owned-driver.ts';import {StateAccessFacade as state} from '../../src/store/state-access-facade.ts';
async function edit<T>(path:string,f:(db:DatabaseSync)=>T):Promise<T>{const db=await openInitialized(path);try{return f(db);}finally{db.close();}}
test('initial cursor preserves lossless i64 and matching path never rewrites time or turn',async()=>storeFixture(async path=>{
 assert.equal(await state.getMirrorOffset(path,'t'),null);assert.equal(await state.getMirrorCursorTurn(path,'t'),null);
 const large=9007199254740993n;assert.equal(await state.getOrInitMirrorCursor(path,'t','rollout',large,1),large);
 assert.deepEqual(await state.getMirrorOffset(path,'t'),{rolloutPath:'rollout',cursor:large,updatedAt:1});
 await state.updateMirrorCursorWithTurn(path,'t','rollout',large,2,'turn');
 assert.equal(await state.getOrInitMirrorCursor(path,'t','rollout',0n,99),large);assert.equal((await state.getMirrorOffset(path,'t'))!.updatedAt,2);assert.equal(await state.getMirrorCursorTurn(path,'t'),'turn');
}));
test('changed rollout path uses supplied initial cursor and clears inherited legacy context',async()=>storeFixture(async path=>{
 await state.updateMirrorCursorWithTurn(path,'t','old',9n,1,'old-turn');assert.equal(await state.getOrInitMirrorCursor(path,'t','new',25n,2),25n);
 assert.deepEqual(await state.getMirrorOffset(path,'t'),{rolloutPath:'new',cursor:25n,updatedAt:2});assert.equal(await state.getMirrorCursorTurn(path,'t'),null);
}));
test('legacy NULL versus initialized empty turn remains exact across replacements',async()=>storeFixture(async path=>{
 await state.updateMirrorCursor(path,'t','p',1n,1);assert.equal(await state.getMirrorCursorTurn(path,'t'),null);
 await state.updateMirrorCursorWithTurn(path,'t','p',2n,2,null);assert.equal(await state.getMirrorCursorTurn(path,'t'),'');
 await state.updateMirrorCursorWithTurn(path,'t','p',3n,3,'한😀');assert.equal(await state.getMirrorCursorTurn(path,'t'),'한😀');
 await state.updateMirrorCursor(path,'t','p',4n,4);assert.equal(await state.getMirrorCursorTurn(path,'t'),null);
}));
test('event identity is globally unique while presence remains thread scoped',async()=>storeFixture(async path=>{
 assert.equal(await state.claimMirrorEvent(path,'digest','one',1),true);assert.equal(await state.claimMirrorEvent(path,'digest','one',2),false);assert.equal(await state.claimMirrorEvent(path,'digest','two',3),false);
 assert.equal(await state.hasMirrorEvent(path,'digest','one'),true);assert.equal(await state.hasMirrorEvent(path,'digest','two'),false);
 assert.equal(await edit(path,db=>db.prepare("SELECT created_at FROM codex_session_mirror_events WHERE event_digest='digest'").get()?.created_at),1);
}));
test('cleanup uses strict older-than threshold and preserves NaN/Infinity SQL behavior',async()=>storeFixture(async path=>{
 await state.claimMirrorEvent(path,'old','t',1);await state.claimMirrorEvent(path,'edge','t',2);await state.claimMirrorEvent(path,'future','t',Infinity);
 assert.equal(await state.cleanupMirrorEvents(path,8,10),1n);assert.equal(await state.hasMirrorEvent(path,'edge','t'),true);
 assert.equal(await state.cleanupMirrorEvents(path,NaN,10),0n);assert.equal(await state.cleanupMirrorEvents(path,0,Infinity),1n);assert.equal(await state.hasMirrorEvent(path,'future','t'),true);
}));
test('native abort on replacement rolls back transaction and retains original offset',async()=>storeFixture(async path=>{
 await state.updateMirrorCursorWithTurn(path,'t','old',9n,1,'turn');const before=await state.getMirrorOffset(path,'t');
 await edit(path,db=>db.exec("CREATE TRIGGER reject_cursor BEFORE INSERT ON codex_session_mirror_offsets BEGIN SELECT RAISE(ABORT,'reject cursor'); END"));
 await assert.rejects(state.getOrInitMirrorCursor(path,'t','new',0n,2),/reject cursor/);assert.deepEqual(await state.getMirrorOffset(path,'t'),before);assert.equal(await state.getMirrorCursorTurn(path,'t'),'turn');
}));
test('stored path and cursor both decode before replacement decision; corrupt values do not get repaired',async()=>storeFixture(async path=>{
 await state.updateMirrorCursor(path,'t','p',1n,1);await edit(path,db=>db.exec("UPDATE codex_session_mirror_offsets SET cursor='not-integer'"));
 await assert.rejects(state.getOrInitMirrorCursor(path,'t','different',0n,2),/integer|i64/);assert.equal(await edit(path,db=>db.prepare("SELECT rollout_path FROM codex_session_mirror_offsets").get()?.rollout_path),'p');
 await edit(path,db=>db.exec("UPDATE codex_session_mirror_offsets SET cursor=1,rollout_path=CAST(x'80' AS TEXT)"));await assert.rejects(state.getMirrorOffset(path,'t'),/encoding/);
}));
test('source signed cursor contract permits negative and empty IDs; NaN write fails atomically',async()=>storeFixture(async path=>{
 await state.updateMirrorCursorWithTurn(path,'','',-1n,Infinity,null);assert.deepEqual(await state.getMirrorOffset(path,''),{rolloutPath:'',cursor:-1n,updatedAt:Infinity});
 await assert.rejects(state.updateMirrorCursor(path,'','other',2n,NaN),/NOT NULL/);assert.equal((await state.getMirrorOffset(path,''))!.cursor,-1n);
}));
test('invalid Unicode and rounded/out-of-range cursor fail before opening or creating store',async()=>storeFixture(async path=>{
 await assert.rejects(state.updateMirrorCursor(path,'\uD800','p',1n,1),TypeError);
 for(const cursor of [1,1n<<63n,-(1n<<63n)-1n])await assert.rejects(state.getOrInitMirrorCursor(path,'t','p',cursor as bigint,1),RangeError);
 await assert.rejects(state.updateMirrorCursorWithTurn(path,'t','p',1n,1,undefined as unknown as null),TypeError);assert.equal(existsSync(path),false);
}));
