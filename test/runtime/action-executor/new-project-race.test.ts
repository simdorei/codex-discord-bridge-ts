import test from 'node:test';import assert from 'node:assert/strict';import {mkdirSync} from 'node:fs';import {dirname,join} from 'node:path';import {DatabaseSync} from 'node:sqlite';
import {storeFixture} from '../../helpers/store-fixture.ts';import {NewThreadJournal} from '../../../src/runtime/action-executor/new-journal.ts';import {NewThreadProject} from '../../../src/runtime/action-executor/new-project.ts';import {createNativeNewProjectLookup} from '../../../src/runtime/action-executor/new-project-native.ts';import {decodeNewThreadOrigin} from '../../../src/runtime/action-executor/new-project-cwd.ts';import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';import {openInitialized} from '../../../src/store/owned-driver.ts';
test('mapping drift while native CWD result is pending cannot be committed as a creation context',async()=>storeFixture(async path=>{
 const cwd=join(dirname(path),'original');mkdirSync(cwd);const db=await openInitialized(path);try{db.prepare('INSERT INTO mirror_projects VALUES(?,?,?,?)').run(cwd,'original',99n,1);}finally{db.close();}
 const journal=new NewThreadJournal(path,()=>10),record=await journal.admit({channelId:99n,userId:2n,discordMessageId:3n,autoQueueWhenBusy:false},'raw');assert.equal(await state.beginIngressThreadStart(path,record.ingressId,1n,11),true);
 let reached!:()=>void,release!:()=>void;const observed=new Promise<void>(r=>{reached=r;}),gate=new Promise<void>(r=>{release=r;}),native=createNativeNewProjectLookup('unused-codex');
 const project=new NewThreadProject(path,'unused-codex',journal,true,()=>12,state,async(p,origin,signal)=>{const result=await native(p,origin,signal);reached();await gate;return result;});
 const task=project.freeze(record,99n,1n),failure=assert.rejects(task,/new origin mapping changed/);
 void failure.catch(()=>{});
 try{await Promise.race([observed,task.then(()=>{throw Error('context finished before mapping changed');})]);const changed=new DatabaseSync(path);try{changed.prepare('UPDATE mirror_projects SET project_key=?').run(cwd+'-changed');}finally{changed.close();}release();await failure;
  const saved=await state.getIngress(path,record.ingressId);assert.equal(saved?.state,'held');assert.equal(saved?.targetThreadId,null);assert.equal(Object.hasOwn(saved!.outcome as object,'new_creation'),false);
 }finally{release();await Promise.allSettled([task,failure]);}
}));
test('caller mutation after native CWD dispatch cannot replace captured original project',async()=>storeFixture(async path=>{
 const original=join(dirname(path),'original'),other=join(dirname(path),'other');mkdirSync(original);mkdirSync(other);
 const input=decodeNewThreadOrigin({version:1n,channel:1n,project:original,chat_targets:[]}),read=createNativeNewProjectLookup(path),task=read(path,input);
 (input as {project:string|null}).project=other;input.chat_targets.push('late');assert.equal(await task,original);
}));
