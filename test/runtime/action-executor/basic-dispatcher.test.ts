import {it} from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {dirname,join} from 'node:path';import {readFileSync} from 'node:fs';
import {storeFixture} from '../../helpers/store-fixture.ts';import {openInitialized} from '../../../src/store/owned-driver.ts';import {BridgeState} from '../../../src/runtime/bridge-state.ts';import {TargetLocks} from '../../../src/core/keyed-locks.ts';import {BasicActionDispatcher} from '../../../src/runtime/action-executor/basic-dispatcher.ts';import {actionExecutionErrorInfo} from '../../../src/runtime/action-executor/action-error.ts';import {MissingActionAppServerError} from '../../../src/runtime/action-executor/errors.ts';import {joinContextReader,joinThreadListReader} from '../../../src/codex-state/context-reader.ts';import {joinDiagnosticReaders} from '../../../src/runtime/diagnostic-report.ts';import type {CommandAction} from '../../../src/runtime/command-plan.ts';
const actor={channelId:42n,userId:7n,discordMessageId:5n,autoQueueWhenBusy:false};
async function fixture(run:(f:{dispatcher:BasicActionDispatcher;bridge:BridgeState;mirror:string;state:string})=>Promise<void>){await storeFixture(async mirror=>{
 const state=join(dirname(mirror),'state.sqlite'),bridgePath=join(dirname(mirror),'bridge.json');const db=new DatabaseSync(state);
 try{db.exec("CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,updated_at INTEGER,rollout_path TEXT,model TEXT,reasoning_effort TEXT,tokens_used INTEGER,archived INTEGER,archived_at INTEGER);INSERT INTO threads VALUES('selected','Selected','/work',2,'/absent-rollout',NULL,NULL,0,0,0),('mapped','Mapped','/work',1,'/absent-rollout',NULL,NULL,0,0,0),('archived','Archived','/work',0,'/absent-rollout',NULL,NULL,0,1,3)");}finally{db.close();}
 const store=await openInitialized(mirror);store.close();const bridge=new BridgeState(bridgePath);bridge.setSelectedThreadId('selected');const dispatcher=new BasicActionDispatcher({state,mirror,bridge:bridgePath},bridge,null,new TargetLocks(),()=> 'safe error',1000);
 try{await run({dispatcher,bridge,mirror,state});}finally{await Promise.all([joinContextReader(),joinThreadListReader(),joinDiagnosticReaders()]);}
});}
it('identity and where share the exact mirrored target; selecting another thread does not replace room mapping',async()=>fixture(async f=>{
 const db=await openInitialized(f.mirror);try{db.prepare('INSERT INTO mirror_threads VALUES (?, ?, ?, ?, ?, ?)').run('mapped','/work','Mapped',99n,42n,1);}finally{db.close();}
 assert.equal(await f.dispatcher.targetThreadId(42n),'mapped');assert.match((await f.dispatcher.execute('Identity',actor)).text,/user_id: 7\nchannel_id: 42\nthread_id: mapped/);assert.match((await f.dispatcher.execute('Where',actor)).text,/source: mirror/);
 const selected=await f.dispatcher.execute({Use:{reference:'selected'}},actor);assert.equal(selected.waitsForFinal,false);assert.equal(selected.ui,null);assert.equal(f.bridge.selectedThreadId(),'selected');assert.equal(await f.dispatcher.targetThreadId(42n),'mapped');
}));
it('list and archived dispatch preserve distinct scope and snapshot results',async()=>fixture(async f=>{
 const active=await f.dispatcher.execute({List:{limit:10n}},actor),archived=await f.dispatcher.execute({ArchivedList:{limit:10n}},actor);assert.ok(active.text.includes('selected | Selected'));assert.ok(!active.text.includes('archived | Archived'));assert.ok(archived.text.includes('archived | Archived'));assert.ok(!archived.text.includes('selected | Selected'));assert.ok(Object.isFrozen(active));
}));
it('saved request dispatch retains original actor/channel restriction and does not release its hold',async()=>fixture(async f=>{
 let db=await openInitialized(f.mirror);try{db.exec("INSERT INTO discord_ingress_journal(ingress_id,kind,channel_id,owner_user_id,payload_json,state,phase,target_thread_id,hold_reason,created_at,updated_at) VALUES('request','message',42,7,'{\"prompt\":\"private\"}','held','claimed','selected','review',0,0)");}finally{db.close();}
 const cmd={SavedRequest:{request_id:'request'}};assert.match((await f.dispatcher.execute(cmd,actor)).text,/private/);await assert.rejects(f.dispatcher.execute(cmd,{...actor,userId:8n}),/unavailable for this user and channel/);await assert.rejects(f.dispatcher.execute(cmd,{...actor,channelId:43n}),/unavailable for this user and channel/);
 db=await openInitialized(f.mirror);try{assert.equal(db.prepare('SELECT state FROM discord_ingress_journal').get()?.state,'held');}finally{db.close();}
}));
it('unsupported lifecycle and host commands fail explicitly with zero selection/database change',async()=>fixture(async f=>{
 const before=readFileSync(f.bridge.path()),commands:CommandAction[]=[{Archive:{reference:null}},{Resume:{reference:null}},{Stop:{reference:null}},{Recover:{reference:null}},{Repair:{reference:null}},{DiscardRequest:{job_id:'job'}},'ForceRestartCodex','HostReboot'];
 for(const action of commands)await assert.rejects(f.dispatcher.execute(action,actor),e=>actionExecutionErrorInfo(e)?.kind==='Unsupported');assert.deepEqual(readFileSync(f.bridge.path()),before);
}));
it('doctor and resources route actual diagnostic workers; missing resident preserves typed leaf failures',async()=>fixture(async f=>{
 assert.match((await f.dispatcher.execute('Doctor',actor)).text,/runtime_pid:/);assert.match((await f.dispatcher.execute('Resources',actor)).text,/Windows 실측 API만 지원/);
 for(const action of ['RestartCodex',{Usage:{days:0xffffffffn}},{SettingsOptions:{reference:null,field:null}}] as CommandAction[])await assert.rejects(f.dispatcher.execute(action,actor),MissingActionAppServerError);
 assert.match((await f.dispatcher.execute('Runners',actor)).text,/Your saved requests needing attention/);
}));
it('pre-abort prevents Use mutation and keeps exact cancellation reason',async()=>fixture(async f=>{
 const controller=new AbortController(),reason={cancel:true};controller.abort(reason);await assert.rejects(f.dispatcher.execute({Use:{reference:'mapped'}},actor,controller.signal),e=>e===reason);await assert.rejects(f.dispatcher.targetThreadId(42n,controller.signal),e=>e===reason);assert.equal(f.bridge.selectedThreadId(),'selected');
}));
it('command and actor mutations after invocation cannot redirect asynchronous query',async()=>fixture(async f=>{
 const action={Status:{reference:'selected'}},context={...actor};const pending=f.dispatcher.execute(action,context);action.Status.reference='mapped';context.channelId=99n;const result=await pending;assert.match(result.text,/selected/);assert.ok(!result.text.includes('title: Mapped'));
}));
