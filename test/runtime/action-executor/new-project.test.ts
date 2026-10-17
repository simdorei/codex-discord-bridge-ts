import assert from 'node:assert/strict';
import {test} from 'node:test';
import {dirname,join} from 'node:path';
import {mkdirSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {NewThreadJournal} from '../../../src/runtime/action-executor/new-journal.ts';
import {NewThreadProject,decodeNewThreadOrigin} from '../../../src/runtime/action-executor/new-project.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
const context=()=>({channelId:99n,userId:20n,discordMessageId:30n,autoQueueWhenBusy:true});
async function project(path:string,key:string){const db=await openInitialized(path);try{db.prepare('INSERT INTO mirror_projects VALUES (?,?,?,?)').run(key,'project',99n,1);}finally{db.close();}}
async function admitted(path:string){const journal=new NewThreadJournal(path,()=>10),record=await journal.admit(context(),'original');assert.equal(await state.beginIngressThreadStart(path,record.ingressId,1n,11),true);return {journal,record};}
function codex(path:string,cwd:string){const db=new DatabaseSync(path);try{db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,updated_at INTEGER,rollout_path TEXT,model TEXT,reasoning_effort TEXT,tokens_used INTEGER,archived INTEGER,archived_at INTEGER)');db.prepare('INSERT INTO threads(id,title,cwd,updated_at,archived) VALUES (?,?,?,?,?)').run('mapped','title',cwd,10,0);}finally{db.close();}}
test('headless origin without a project records null cwd without consulting global selection',async()=>storeFixture(async path=>{
 const {journal,record}=await admitted(path),resolver=new NewThreadProject(path,'missing-state',journal,false,()=>12);assert.equal(await resolver.freeze(record,99n,1n),null);const saved=await state.getIngress(path,record.ingressId);assert.deepEqual((saved?.outcome as {new_creation:unknown}).new_creation,{version:1n,cwd:null,origin_channel_id:99n});
}));
test('mirror-enabled new request without a verified project is held before creation',async()=>storeFixture(async path=>{
 const {journal,record}=await admitted(path),resolver=new NewThreadProject(path,'missing-state',journal,true,()=>12);await assert.rejects(resolver.freeze(record,99n,1n),/no verified originating project/);assert.equal((await state.getIngress(path,record.ingressId))?.state,'held');
}));
test('real existing project directory is frozen once under matching attempt generation',async()=>storeFixture(async path=>{
 const cwd=join(dirname(path),'project');mkdirSync(cwd);await project(path,cwd);const {journal,record}=await admitted(path),resolver=new NewThreadProject(path,'unused-state',journal,true,()=>12);assert.equal(await resolver.freeze(record,99n,1n),cwd);await assert.rejects(resolver.freeze(record,99n,1n),/matching unwritten attempt/);
}));
test('mapping changes after admission cannot become a new creation context',async()=>storeFixture(async path=>{
 const cwd=join(dirname(path),'project');mkdirSync(cwd);await project(path,cwd);const {journal,record}=await admitted(path);const db=await openInitialized(path);try{db.exec("UPDATE mirror_projects SET project_key='changed'");}finally{db.close();}
 await assert.rejects(new NewThreadProject(path,'unused',journal,true,()=>12).freeze(record,99n,1n),/new origin mapping changed/);assert.equal((await state.getIngress(path,record.ingressId))?.state,'held');
}));
test('mapped Codex cwd must agree with all frozen project keys',async()=>storeFixture(async path=>{
 const root=dirname(path),original=join(root,'original'),different=join(root,'different');mkdirSync(original);mkdirSync(different);const statePath=join(root,'codex.sqlite');codex(statePath,different);
 const db=await openInitialized(path);try{db.prepare('INSERT INTO mirror_threads VALUES (?,?,?,?,?,?)').run('mapped',original,'title',99n,100n,1);}finally{db.close();}
 const {journal,record}=await admitted(path);await assert.rejects(new NewThreadProject(path,statePath,journal,true,()=>12).freeze(record,99n,1n),/differs from the frozen Discord project/);assert.equal((await state.getIngress(path,record.ingressId))?.state,'held');
}));
test('typed origin decoder preserves u8/i64/optional map and sequence contracts',()=>{
 const origin=decodeNewThreadOrigin({version:1n,channel:99n,chat_targets:[]});assert.equal(origin.target,null);assert.equal(origin.parent_channel,null);assert.equal(origin.version,1n);
 assert.equal(decodeNewThreadOrigin([255n,99n,null,null,null,null,null,[]]).version,255n);
 for(const version of [256n,-1n,1])assert.throws(()=>decodeNewThreadOrigin({version,channel:99n,chat_targets:[]}));
 assert.throws(()=>decodeNewThreadOrigin([1n,99n]));assert.throws(()=>decodeNewThreadOrigin({version:1n,channel:99n,chat_targets:[1n]}));
});
test('foreign journal database and mutated admission records are rejected before project access',async()=>storeFixture(async path=>{
 const {journal,record}=await admitted(path);assert.throws(()=>new NewThreadProject(path+'other','unused',journal,false),/database mismatch/);record.ingressId='foreign';await assert.rejects(new NewThreadProject(path,'unused',journal,false).freeze(record,99n,1n),/original journal admission/);
}));
