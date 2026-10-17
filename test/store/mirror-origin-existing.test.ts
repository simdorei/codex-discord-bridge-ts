import assert from 'node:assert/strict';
import {it} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import {storeFixture} from '../helpers/store-fixture.ts';
import {openInitialized} from '../../src/store/owned-driver.ts';
import {recordUserOriginExisting} from '../../src/store/mirror-origin-existing.ts';
import {userOriginMarker} from '../../src/store/mirror-origin.ts';
async function init(path:string){const db=await openInitialized(path);db.close();}
function rows(path:string){const db=new DatabaseSync(path);try{return db.prepare('SELECT event_digest,codex_thread_id,created_at,typeof(created_at) AS storage FROM codex_session_mirror_events ORDER BY event_digest').all();}finally{db.close();}}
it('existing origin preserves Rust whitespace hashing, original Unicode and first timestamp',()=>storeFixture(async path=>{
 await init(path);const prompt='\u2003 방향 😀 \u0085';recordUserOriginExisting(path,'thread😀','turn',prompt,10);recordUserOriginExisting(path,'thread😀','turn','방향 😀',99);
 assert.deepEqual(rows(path).map(r=>({...r})),[{event_digest:userOriginMarker('thread😀','turn',prompt),codex_thread_id:'thread😀',created_at:10,storage:'real'}]);
 recordUserOriginExisting(path,'thread😀','turn','\ufeff방향 😀',11);assert.equal(rows(path).length,2);
}));
it('existing origin preserves borrowed primitive nonfinite timestamp behavior',()=>storeFixture(async path=>{
 await init(path);recordUserOriginExisting(path,'t','positive','p',Infinity);recordUserOriginExisting(path,'t','negative','p',-Infinity);recordUserOriginExisting(path,'t','nan','p',NaN);
 const found=rows(path);assert.equal(found.length,2);assert.deepEqual(found.map(r=>r.created_at).sort(),[-Infinity,Infinity]);assert.ok(found.every(r=>r.storage==='real'));
}));
it('existing origin refuses absent and stale stores without creating or migrating',()=>storeFixture(async path=>{
 assert.throws(()=>recordUserOriginExisting(path,'t','v','p',1));assert.equal(existsSync(path),false);
 const db=new DatabaseSync(path);db.exec('CREATE TABLE untouched(value TEXT)');db.close();assert.throws(()=>recordUserOriginExisting(path,'t','v','p',1));const check=new DatabaseSync(path);try{assert.equal(check.prepare('PRAGMA user_version').get()!.user_version,0);assert.equal(check.prepare("SELECT 1 FROM sqlite_master WHERE name='codex_session_mirror_events'").get(),undefined);}finally{check.close();}
}));
it('trigger failure rolls back the original marker without changing another row',()=>storeFixture(async path=>{
 await init(path);recordUserOriginExisting(path,'t','first','p',1);const db=new DatabaseSync(path);db.exec("CREATE TRIGGER reject_origin BEFORE INSERT ON codex_session_mirror_events BEGIN SELECT RAISE(ABORT,'origin blocked'); END");db.close();assert.throws(()=>recordUserOriginExisting(path,'t','next','p',2),/origin blocked/);assert.equal(rows(path).length,1);
}));
it('invalid origin inputs fail before opening an absent store',()=>storeFixture(async path=>{
 for(const args of [['t','v','\ud800',1],['t','\ud800','p',1],['\ud800','v','p',1],['t','v','p','bad']] as const)assert.throws(()=>recordUserOriginExisting(path,args[0],args[1],args[2],args[3] as number));assert.equal(existsSync(path),false);
}));
