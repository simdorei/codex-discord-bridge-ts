import test from 'node:test';
import assert from 'node:assert/strict';
import type {DatabaseSync} from 'node:sqlite';
import {storeFixture} from '../helpers/store-fixture.ts';
import {openInitialized} from '../../src/store/owned-driver.ts';
import {mirrorProjectSnapshot as snapshot,mirrorProjectCreationReceipt as receipt,beginMirrorProject as begin,ensureMirrorProjectAdoptable as adoptable,upsertMirrorProject as upsert} from '../../src/store/mirror-project-creation.ts';
import {confirmMirrorContainer as confirm,loadContainerIn} from '../../src/store/mirror-container-creation.ts';
const match=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
async function fixture(run:(path:string,db:DatabaseSync)=>Promise<void>){await storeFixture(async path=>{const db=await openInitialized(path);try{await run(path,db);}finally{db.close();}});}
function project(db:DatabaseSync,key:string,id=3n){db.prepare('INSERT INTO mirror_projects VALUES(?,?,?,1)').run(key,key,id);}
function thread(db:DatabaseSync,key='P'){db.prepare("INSERT INTO mirror_threads VALUES('thread',?,'title',3,4,1)").run(key);}
const read=(db:DatabaseSync,key='p')=>loadContainerIn(db,'project',key);
test('project snapshot detects aliases, conflicting identities and preserves order',async()=>fixture(async(path,db)=>{
 assert.deepEqual(await snapshot(path,'p',match),[]);project(db,'p');project(db,'P');assert.deepEqual(await snapshot(path,'p',match),[['P',3n],['p',3n]]);
 db.exec("UPDATE mirror_projects SET discord_channel_id=9 WHERE project_key='P'");await assert.rejects(snapshot(path,'p',match),/conflicting channel identities/);
}));
test('project attempted result blocks replay, and confirmed creation maps and consumes custody atomically',async()=>fixture(async(path,db)=>{
 project(db,'P');thread(db);const original=await snapshot(path,'p',match);const a=await begin(path,'p',1n,2n,original,match);
 await assert.rejects(receipt(path,'p',1n,2n,original,match),/outcome is unknown/);await assert.rejects(begin(path,'P',1n,2n,original,match),/already claimed/);
 await confirm(path,a,5n);assert.equal((await receipt(path,'P',1n,2n,original,match))?.channel,5n);assert.deepEqual(await upsert(path,'p','Project',5n,2,match),['P']);
 assert.equal(read(db),null);assert.deepEqual(await snapshot(path,'p',match),[['p',5n]]);assert.equal(db.prepare("SELECT project_key FROM mirror_threads WHERE codex_thread_id='thread'").get()?.project_key,'p');
}));
test('mapping drift refuses creation or confirmed reuse',async()=>fixture(async(path,db)=>{
 project(db,'p');await assert.rejects(begin(path,'p',1n,2n,[],match),/mapping changed/);const original=await snapshot(path,'p',match);const a=await begin(path,'p',1n,2n,original,match);await confirm(path,a,5n);
 db.exec('UPDATE mirror_projects SET discord_channel_id=7');await assert.rejects(receipt(path,'p',1n,2n,original,match),/scope or mapping changed/);await assert.rejects(upsert(path,'p','Project',5n,2,match),/mapping is not confirmed/);assert.equal(read(db)?.channel,5n);
}));
test('metadata adoption is blocked by unknown sibling creation and exact returned IDs',async()=>fixture(async(path,db)=>{
 const a=await begin(path,'p',1n,2n,[],match);await assert.rejects(adoptable(path,8n,2n),/unresolved creation/);await adoptable(path,8n,9n);await assert.rejects(upsert(path,'q','Q',8n,1,match),/unresolved creation from another scope/);
 await confirm(path,a,5n);await adoptable(path,8n,2n);await assert.rejects(adoptable(path,5n,9n),/unresolved creation/);await assert.rejects(upsert(path,'q','Q',5n,1,match),/unresolved creation from another scope/);
}));
test('known existing mapping may refresh despite unrelated unknown creation',async()=>fixture(async(path,db)=>{
 project(db,'q',8n);await begin(path,'p',1n,2n,[],match);await upsert(path,'q','Q',8n,2,match);assert.equal(read(db)?.phase,'attempted');
}));
test('created room cannot bind across project ownership',async()=>fixture(async(path,db)=>{
 const a=await begin(path,'p',1n,2n,[],match);await confirm(path,a,5n);project(db,'q',5n);await assert.rejects(upsert(path,'p','P',5n,1,match),/another project/);assert.equal(read(db)?.channel,5n);
}));
test('insert trigger mapping mutation rolls back intent and mapping',async()=>fixture(async(path,db)=>{
 project(db,'p');const original=await snapshot(path,'p',match);db.exec("CREATE TRIGGER drift AFTER INSERT ON cdr_mirror_container_creations BEGIN UPDATE mirror_projects SET discord_channel_id=9; END");
 await assert.rejects(begin(path,'p',1n,2n,original,match),/changed during intent write/);assert.equal(read(db),null);assert.deepEqual(await snapshot(path,'p',match),original);
}));
test('duplicate normalized claims introduced by trigger are rolled back',async()=>fixture(async(path,db)=>{
 db.exec("CREATE TRIGGER duplicate_claim AFTER INSERT ON cdr_mirror_container_creations WHEN NEW.scope_key='p' BEGIN INSERT INTO cdr_mirror_container_creations VALUES('project','P','foreign',1,2,'[]','attempted',NULL); END");await assert.rejects(begin(path,'p',1n,2n,[],match),/multiple project creation claims/);assert.equal(read(db),null);assert.equal(read(db,'P'),null);
}));
test('mapping custody mutation and ignored final delete roll back complete update',async()=>fixture(async(path,db)=>{
 project(db,'P');thread(db);const original=await snapshot(path,'p',match),a=await begin(path,'p',1n,2n,original,match),c=await confirm(path,a,5n);
 db.exec("CREATE TRIGGER drift_mapping AFTER INSERT ON mirror_projects BEGIN UPDATE cdr_mirror_container_creations SET token='foreign'; END");await assert.rejects(upsert(path,'p','P',5n,2,match),/custody changed/);assert.deepEqual(read(db),c);assert.deepEqual(await snapshot(path,'p',match),original);db.exec('DROP TRIGGER drift_mapping');
 db.exec("CREATE TRIGGER ignore_delete BEFORE DELETE ON cdr_mirror_container_creations BEGIN SELECT RAISE(IGNORE); END");await assert.rejects(upsert(path,'p','P',5n,2,match),/completion was not stored/);assert.deepEqual(read(db),c);assert.deepEqual(await snapshot(path,'p',match),original);
}));
test('post-consumption cleanup fence rolls back mapping and restores receipt',async()=>fixture(async(path,db)=>{
 const c=await confirm(path,await begin(path,'p',1n,2n,[],match),5n);db.exec("CREATE TRIGGER cleanup AFTER DELETE ON cdr_mirror_container_creations BEGIN INSERT INTO cdr_cleanup_fences VALUES(5,NULL,'fence','deleting',1); END");
 await assert.rejects(upsert(path,'p','P',5n,1,match),/blocked by room cleanup/);assert.deepEqual(read(db),c);assert.deepEqual(await snapshot(path,'p',match),[]);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cdr_cleanup_fences').get()?.n,0);
}));
test('cleanup protects parent, old mapping and mapped child target during creation',async()=>fixture(async(path,db)=>{
 project(db,'p');thread(db,'p');const original=await snapshot(path,'p',match);
 for(const [id,target] of [[2n,null],[3n,null],[4n,null],[99n,'thread']] as const){db.prepare("INSERT INTO cdr_cleanup_fences VALUES(?,?,'fence','deleting',1)").run(id,target);await assert.rejects(begin(path,'p',1n,2n,original,match),/blocked by room cleanup/);assert.equal(read(db),null);db.exec('DELETE FROM cdr_cleanup_fences');}
}));
test('snapshot copying and synchronous matcher validation prevent changing transaction scope',async()=>fixture(async(path,db)=>{
 project(db,'p');const original:[string,bigint][]=[['p',3n]];const pending=begin(path,'p',1n,2n,original,match);original[0]![1]=9n;const a=await pending;assert.equal(a.expected,'[["p",3]]');
 await assert.rejects(snapshot(path,'p',(async()=>true) as unknown as typeof match),TypeError);await assert.rejects(snapshot(path,'p',(()=>1) as unknown as typeof match),TypeError);
}));
