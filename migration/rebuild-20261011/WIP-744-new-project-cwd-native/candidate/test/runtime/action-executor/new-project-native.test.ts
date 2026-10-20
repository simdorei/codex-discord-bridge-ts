import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {dirname,join} from 'node:path';import {mkdirSync,symlinkSync,existsSync} from 'node:fs';
import {storeFixture} from '../../helpers/store-fixture.ts';import {decodeNewThreadOrigin,resolveNewProjectCwd} from '../../../src/runtime/action-executor/new-project-cwd.ts';import {createNativeNewProjectLookup,NativeNewProjectUnavailableError} from '../../../src/runtime/action-executor/new-project-native.ts';import {OwnedWorkerSlot,OwnedWorkerBudgetError,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';import {InvalidActionRequestError} from '../../../src/runtime/action-executor/errors.ts';
function origin(extra:object={}){return decodeNewThreadOrigin({version:1n,channel:1n,chat_targets:[],...extra});}
function seed(path:string,cwd:string){const db=new DatabaseSync(path);try{db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,updated_at INTEGER,rollout_path TEXT,model TEXT,reasoning_effort TEXT,tokens_used INTEGER,archived INTEGER,archived_at INTEGER)');db.prepare('INSERT INTO threads(id,title,cwd,updated_at,archived) VALUES(?,?,?,?,0)').run('target','title',cwd,2);}finally{db.close();}}
test('native project keeps target precedence and exact cwd while selecting newest matching chat target',async()=>storeFixture(async path=>{
 const root=dirname(path),cwd=join(root,'cwd'),other=join(root,'other');mkdirSync(cwd);mkdirSync(other);seed(path,cwd);const read=createNativeNewProjectLookup(path);assert.equal(await read(path,origin({target:'target',project:other})),cwd);
 const db=new DatabaseSync(path);try{db.prepare('INSERT INTO threads(id,title,cwd,updated_at,archived) VALUES(?,?,?,?,0)').run('second','title',other,3);}finally{db.close();}
 const input=origin({project:'codex:chats',chat_targets:['target','second']});assert.equal(resolveNewProjectCwd(path,input),other);assert.equal(await read(path,input),other);
}));
test('direct and null project branches do not open absent Codex state; missing mapped state is not created',async()=>storeFixture(async path=>{
 const read=createNativeNewProjectLookup(path);assert.equal(await read(path,origin()),null);assert.equal(await read(path,origin({project:dirname(path)})),dirname(path));await assert.rejects(read(path,origin({target:'missing'})),NativeNewProjectUnavailableError);assert.equal(existsSync(path),false);
}));
test('expected directory and missing target failures retain nominal invalid-action error',async()=>storeFixture(async path=>{
 const read=createNativeNewProjectLookup(path);await assert.rejects(read(path,origin({project:join(dirname(path),'absent')})),e=>e instanceof InvalidActionRequestError&&e.message.includes('project directory is unavailable'));
 seed(path,dirname(path));await assert.rejects(read(path,origin({target:'absent'})),e=>e instanceof InvalidActionRequestError&&e.message.includes('cannot resolve project of mapped thread'));await assert.rejects(read(path,origin({project:'codex:chats',chat_targets:['absent']})),/chat project has no known working directory/);
}));
test('full recent row decoding still rejects corrupt unrelated row rather than accepting early matching target',async()=>storeFixture(async path=>{
 seed(path,dirname(path));const db=new DatabaseSync(path);try{db.prepare('INSERT INTO threads(id,title,cwd,updated_at,archived,tokens_used) VALUES(?,?,?,?,0,?)').run('bad','bad',dirname(path),1,'not-integer');}finally{db.close();}const input=origin({project:'codex:chats',chat_targets:['target']});assert.throws(()=>resolveNewProjectCwd(path,input));await assert.rejects(createNativeNewProjectLookup(path)(path,input),NativeNewProjectUnavailableError);
}));
test('native directory stat preserves symlink-parent traversal and returned spelling',async()=>storeFixture(async path=>{
 const root=dirname(path);mkdirSync(join(root,'physical','child'),{recursive:true});mkdirSync(join(root,'physical','wanted'));symlinkSync(join(root,'physical','child'),join(root,'alias'),'dir');const spelling=root+'/alias/../wanted';assert.equal(await createNativeNewProjectLookup(path)(path,origin({project:spelling})),spelling);
}));
test('preabort, mismatched store and active input reject without file creation or proxy hooks',async()=>storeFixture(async path=>{
 const read=createNativeNewProjectLookup(path),abort=new AbortController(),reason=Error('cancel');abort.abort(reason);await assert.rejects(read(path,origin(),abort.signal),e=>e===reason);await assert.rejects(read(path+'other',origin()),/differs/);let calls=0;await assert.rejects(read(path,new Proxy(origin(),{get(){calls++;throw Error('trap');}})));assert.equal(calls,0);assert.equal(existsSync(path),false);assert.equal(ownedWorkerUsage().Discovery,0);
}));
test('crossed path/base/origin or malformed cwd cannot be a confirmed project',async t=>storeFixture(async path=>{
 const read=createNativeNewProjectLookup(path);for(const change of [{path:'other'},{base:'other'},{origin:'other'},{cwd:1},{ok:false,kind:'Other'}]){const mock=t.mock.method(OwnedWorkerSlot.prototype,'run',async(_url:unknown,input:any)=>({...input,ok:true,cwd:null,...change}));try{await assert.rejects(read(path,origin()),NativeNewProjectUnavailableError);}finally{mock.mock.restore();}}
}));
test('native project deadline joins locked SQLite worker and retains Discovery capacity until exit',async()=>storeFixture(async path=>{
 seed(path,dirname(path));const db=new DatabaseSync(path);db.exec('PRAGMA journal_mode=DELETE;BEGIN EXCLUSIVE');const read=createNativeNewProjectLookup(path,10),task=read(path,origin({target:'target'})),failure=assert.rejects(task,NativeNewProjectUnavailableError);let ended=false;void task.then(()=>{ended=true;},()=>{ended=true;});
 try{await new Promise(r=>setTimeout(r,100));assert.equal(ended,false);assert.equal(ownedWorkerUsage().Discovery,1);await assert.rejects(read(path,origin()),OwnedWorkerBudgetError);db.exec('ROLLBACK');await failure;assert.equal(ownedWorkerUsage().Discovery,0);}finally{if(db.isTransaction)db.exec('ROLLBACK');await task.catch(()=>{});db.close();}
}));
