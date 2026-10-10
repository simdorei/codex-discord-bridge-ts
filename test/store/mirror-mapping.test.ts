import test from 'node:test';
import assert from 'node:assert/strict';
import {storeFixture} from '../helpers/store-fixture.ts';
import {openInitialized} from '../../src/store/owned-driver.ts';
import {beginMirrorCreation,confirmMirrorCreation,readMirrorCreationIn} from '../../src/store/mirror-creation.ts';
import {mirrorThreadChannels,mirrorProjectForChannel,commitNewThreadSync,type MirrorThreadUpdate} from '../../src/store/mirror-mapping.ts';
import {MirrorMappingChangedError} from '../../src/store/queue-enqueue.ts';
import type {DatabaseSync} from 'node:sqlite';
const scope={thread:'original',guild:1n,parent:2n,expected:null};const update:MirrorThreadUpdate={threadId:'original',projectKey:'project',title:'hello',parentId:2n,channelId:3n,now:1};
async function fixture(run:(path:string,db:DatabaseSync)=>Promise<void>){await storeFixture(async path=>{const db=await openInitialized(path);try{await run(path,db);}finally{db.close();}});}
function project(db:DatabaseSync,key='project'){db.prepare("INSERT INTO mirror_projects VALUES(?,?,2,1)").run(key,key);}
async function created(path:string){const token=await beginMirrorCreation(path,scope);await confirmMirrorCreation(path,scope,token,3n);}
test('new room mapping atomically consumes exact confirmed creation',async()=>fixture(async(path,db)=>{
 project(db);await created(path);await commitNewThreadSync(path,update,null,'project');assert.deepEqual(await mirrorThreadChannels(path,'original'),[2n,3n]);assert.equal(readMirrorCreationIn(db,'original'),null);assert.deepEqual(await mirrorProjectForChannel(path,2n),['project','project']);assert.equal(await mirrorProjectForChannel(path,null),null);assert.equal(await mirrorProjectForChannel(path,0n),null);
}));
test('project change or duplicate project keys retains returned id without mapping',async()=>fixture(async(path,db)=>{
 project(db);await created(path);project(db,'second');await assert.rejects(commitNewThreadSync(path,update,null,'project'),/project mapping changed/);db.exec("DELETE FROM mirror_projects WHERE project_key='second'; UPDATE mirror_projects SET project_key='changed'");await assert.rejects(commitNewThreadSync(path,update,null,'project'),/project mapping changed/);assert.equal(await mirrorThreadChannels(path,'original'),null);assert.equal(readMirrorCreationIn(db,'original')?.channel,3n);
}));
test('absence is exact project expectation rather than a wildcard',async()=>fixture(async(path,db)=>{
 project(db);await created(path);await assert.rejects(commitNewThreadSync(path,update,null,null),/project mapping changed/);db.exec('DELETE FROM mirror_projects');await commitNewThreadSync(path,update,null,null);assert.deepEqual(await mirrorThreadChannels(path,'original'),[2n,3n]);
}));
test('another thread cannot have its room stolen',async()=>fixture(async(path,db)=>{
 await created(path);db.exec("INSERT INTO mirror_threads VALUES('other','p','other',2,3,1)");await assert.rejects(commitNewThreadSync(path,update,null,null),/already belongs/);assert.equal(await mirrorThreadChannels(path,'original'),null);assert.equal(readMirrorCreationIn(db,'original')?.channel,3n);
}));
test('mapping CAS uses both prior parent and room and preserves typed mismatch',async()=>fixture(async(path,db)=>{
 db.exec("INSERT INTO mirror_threads VALUES('original','p','old',2,4,1)");await assert.rejects(commitNewThreadSync(path,update,null,null),e=>e instanceof MirrorMappingChangedError&&e.discordChannelId===3n&&e.expectedTargetThreadId==='original'&&e.actualTargetThreadId===null);await assert.rejects(commitNewThreadSync(path,update,[9n,4n],null),MirrorMappingChangedError);await commitNewThreadSync(path,update,[2n,4n],null);assert.deepEqual(await mirrorThreadChannels(path,'original'),[2n,3n]);
}));
test('unknown creation, ignored mapping and substituted custody prevent attachment',async()=>fixture(async(path,db)=>{
 const token=await beginMirrorCreation(path,scope);await assert.rejects(commitNewThreadSync(path,update,null,null),/mapping was not confirmed/);assert.equal(await mirrorThreadChannels(path,'original'),null);await confirmMirrorCreation(path,scope,token,3n);
 db.exec("CREATE TRIGGER ignore_mapping BEFORE INSERT ON mirror_threads BEGIN SELECT RAISE(IGNORE); END");await assert.rejects(commitNewThreadSync(path,update,null,null),/mapping was not confirmed/);db.exec('DROP TRIGGER ignore_mapping');
 db.exec("CREATE TRIGGER change_custody AFTER INSERT ON mirror_threads BEGIN UPDATE cdr_mirror_thread_creations SET token='foreign'; END");await assert.rejects(commitNewThreadSync(path,update,null,null),/custody changed/);assert.equal(await mirrorThreadChannels(path,'original'),null);assert.equal(readMirrorCreationIn(db,'original')?.token,token);
}));
test('post-delete cleanup race rolls back mapping and custody together',async()=>fixture(async(path,db)=>{
 await created(path);db.exec("CREATE TRIGGER late_fence AFTER DELETE ON cdr_mirror_thread_creations BEGIN INSERT INTO cdr_cleanup_fences VALUES(2,NULL,'f','deleting',1); END");await assert.rejects(commitNewThreadSync(path,update,null,null),/blocked by room cleanup/);assert.equal(await mirrorThreadChannels(path,'original'),null);assert.equal(readMirrorCreationIn(db,'original')?.channel,3n);assert.equal(db.prepare('SELECT count(*) AS n FROM cdr_cleanup_fences').get()?.n,0);
}));
test('original input snapshot and lossless IDs survive async open',async()=>fixture(async(path,db)=>{
 const u={...update,title:'😀 original'},job=commitNewThreadSync(path,u,null,null);u.threadId='other';u.title='changed';await job;assert.equal(db.prepare("SELECT thread_title FROM mirror_threads WHERE codex_thread_id='original'").get()?.thread_title,'😀 original');await assert.rejects(commitNewThreadSync(path,{...update,parentId:1n<<63n},null,null),TypeError);
}));
test('malformed native project text is rejected before mapping',async()=>fixture(async(path,db)=>{
 db.exec("INSERT INTO mirror_projects VALUES(CAST(x'ff' AS TEXT),'bad',2,1)");await assert.rejects(mirrorProjectForChannel(path,2n),/Invalid text encoding/);await assert.rejects(commitNewThreadSync(path,update,null,null),/Invalid text encoding/);assert.equal(await mirrorThreadChannels(path,'original'),null);
}));
