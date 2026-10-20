import test from 'node:test';
import assert from 'node:assert/strict';
import type {DatabaseSync} from 'node:sqlite';
import {storeFixture} from '../helpers/store-fixture.ts';
import {openInitialized} from '../../src/store/owned-driver.ts';
import {commitThreadSync as commit,commitNewThreadSync as commitNew,retireMirrorThreadSync as retireThread,retireMirrorProjectSync as retireProject,type MirrorThreadUpdate} from '../../src/store/mirror-mapping.ts';
import {staleMirrorThreads as staleThreads,staleMirrorProjects as staleProjects} from '../../src/store/mirror-stale.ts';
import {beginMirrorCreation,confirmMirrorCreation,readMirrorCreationIn} from '../../src/store/mirror-creation.ts';
async function fixture(run:(path:string,db:DatabaseSync)=>Promise<void>){await storeFixture(async path=>{const db=await openInitialized(path);try{await run(path,db);}finally{db.close();}});}
const update:MirrorThreadUpdate={threadId:'target',projectKey:'p',title:'Title',parentId:2n,channelId:3n,now:1};
function mapping(db:DatabaseSync,thread='target',room=3n,updated=1){db.prepare('INSERT INTO mirror_threads VALUES(?,?,?,?,?,?)').run(thread,'p','Title',2n,room,updated);}
function project(db:DatabaseSync,key='p',room=2n,updated=1){db.prepare('INSERT INTO mirror_projects VALUES(?,?,?,?)').run(key,'Project',room,updated);}
test('normal sync shares mapping CAS without new-thread extra project check',async()=>fixture(async(path,db)=>{
 project(db);await assert.rejects(commitNew(path,update,null,null),/project mapping changed/);await commit(path,update,null);assert.equal(db.prepare('SELECT discord_thread_id FROM mirror_threads').get()?.discord_thread_id,3);
 await assert.rejects(commit(path,{...update,title:'Changed'},null),/mapping changed/i);assert.equal(db.prepare('SELECT thread_title FROM mirror_threads').get()?.thread_title,'Title');await commit(path,{...update,title:'Changed'},[2n,3n]);assert.equal(db.prepare('SELECT thread_title FROM mirror_threads').get()?.thread_title,'Changed');
}));
test('normal sync retains occupied-room and creation-custody checks',async()=>fixture(async(path,db)=>{
 mapping(db,'other');await assert.rejects(commit(path,update,null),/another Codex thread/);db.exec('DELETE FROM mirror_threads');
 const scope={thread:'target',guild:1n,parent:2n,expected:null};const token=await beginMirrorCreation(path,scope);await assert.rejects(commit(path,update,null),/mapping was not confirmed/);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mirror_threads').get()?.n,0);
 await confirmMirrorCreation(path,scope,token,3n);await commit(path,update,null);assert.equal(readMirrorCreationIn(db,'target'),null);
}));
test('confirmed custody changed by mapping trigger rolls back exact sync',async()=>fixture(async(path,db)=>{
 const scope={thread:'target',guild:1n,parent:2n,expected:null};const token=await beginMirrorCreation(path,scope);await confirmMirrorCreation(path,scope,token,3n);const original=readMirrorCreationIn(db,'target');db.exec("CREATE TRIGGER change_custody AFTER INSERT ON mirror_threads BEGIN UPDATE cdr_mirror_thread_creations SET token='foreign'; END");await assert.rejects(commit(path,update,null),/custody changed/);assert.deepEqual(readMirrorCreationIn(db,'target'),original);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mirror_threads').get()?.n,0);
}));
test('thread retirement requires matching room and strict older-than cutoff',async()=>fixture(async(path,db)=>{
 mapping(db);assert.equal(await retireThread(path,'target',4n,2),false);assert.equal(await retireThread(path,'target',3n,1),false);assert.equal(await retireThread(path,'target',3n,2),true);assert.equal(await retireThread(path,'target',3n,2),false);
}));
test('project retirement preserves current mappings and projects with surviving threads',async()=>fixture(async(path,db)=>{
 project(db);mapping(db);assert.equal(await retireProject(path,'p',2n,2),false);db.exec('DELETE FROM mirror_threads');assert.equal(await retireProject(path,'p',9n,2),false);assert.equal(await retireProject(path,'p',2n,1),false);assert.equal(await retireProject(path,'p',2n,2),true);
}));
test('stale inventory preserves valid identities, exact cutoff and timestamp decoding',async()=>fixture(async(path,db)=>{
 mapping(db,'old',3n,1);mapping(db,'valid',4n,0);mapping(db,'equal',5n,2);project(db,'old',2n,1);project(db,'valid',6n,0);project(db,'equal',7n,2);
 assert.deepEqual(await staleThreads(path,['valid'],2),[{threadId:'old',discordThreadId:3n,title:'Title'}]);assert.deepEqual(await staleProjects(path,['valid'],2),[{projectKey:'old',projectName:'Project',discordChannelId:2n}]);assert.deepEqual(await staleThreads(path,[],NaN),[]);
}));
test('even filtered-out malformed rows fail full inventory instead of proving absence',async()=>fixture(async(path,db)=>{
 mapping(db,'valid',3n,1);db.exec("UPDATE mirror_threads SET thread_title=CAST(x'ff' AS TEXT)");await assert.rejects(staleThreads(path,['valid'],2),/Invalid text encoding/);project(db,'valid',2n,1);db.exec("UPDATE mirror_projects SET updated_at='invalid'");await assert.rejects(staleProjects(path,['valid'],2),/mapping timestamp/);
}));
test('stale inventory snapshots caller identity list before asynchronous open',async()=>fixture(async(path,db)=>{
 mapping(db);const valid=['target'];const pending=staleThreads(path,valid,2);valid.length=0;assert.deepEqual(await pending,[]);
}));
