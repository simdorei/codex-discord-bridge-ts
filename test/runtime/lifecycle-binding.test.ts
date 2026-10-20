import {ActionIntegerRangeError} from '../../src/runtime/action-executor/errors.ts';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {join,dirname} from 'node:path';
import {existsSync} from 'node:fs';
import {storeFixture} from '../helpers/store-fixture.ts';
import {SettingsTargetResolver,SlashSettingsTargetResolver,isSettingsMutation,isSlashSettingsMutation} from '../../src/runtime/settings-binding.ts';
import {BridgeState} from '../../src/runtime/bridge-state.ts';
import {openInitialized} from '../../src/store/owned-driver.ts';
import type {CommandAction} from '../../src/runtime/command-plan.ts';
function setup(path:string){const state=join(dirname(path),'codex.sqlite'),db=new DatabaseSync(state);try{db.exec("CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,updated_at INTEGER,rollout_path TEXT,model TEXT,reasoning_effort TEXT,tokens_used INTEGER,archived INTEGER,archived_at INTEGER); INSERT INTO threads(id,title,cwd,updated_at,archived) VALUES ('selected','Selected','/selected',30,0),('mapped','Mapped','/mapped',20,0),('explicit','Explicit','/explicit',10,0),('archived','Archived','/archived',40,1)");}finally{db.close();}const bridge=new BridgeState(join(dirname(path),'bridge.json'));bridge.setSelectedThreadId('selected');return {state,bridge,resolver:new SettingsTargetResolver(state,path,bridge)};}
async function mapping(path:string,target:string|null){const db=await openInitialized(path);try{db.exec('DELETE FROM mirror_threads');if(target!==null)db.prepare('INSERT INTO mirror_threads VALUES(?,?,?,?,?,?)').run(target,'p','title',9n,10n,1);}finally{db.close();}}
test('full resolver is the identical existing slash class and ignores unrelated/read-only actions',()=>storeFixture(async path=>{
 assert.equal(SettingsTargetResolver,SlashSettingsTargetResolver);const {resolver}=setup(path);
 for(const a of ['Help',{Ask:{prompt:'x'}},{Settings:{reference:'unknown',model:null,effort:null,speed:null}},{SettingsOptions:{reference:'unknown',field:'model'}}] as const){assert.equal(await resolver.bind(a,10n),null);assert.equal(await resolver.bindLifecycle(a,10n),null);}assert.equal(existsSync(path),false);
}));
test('all five lifecycle actions bind only their exact explicit active reference',()=>storeFixture(async path=>{
 const {resolver}=setup(path);for(const key of ['Archive','Resume','Recover','Repair','Stop'] as const){const action={[key]:{reference:' explicit '}} as CommandAction;const b=await resolver.bindLifecycle(action,(1n<<64n)-1n);assert.equal(b!.target,'explicit');assert.equal(b!.route,'Explicit');assert.deepEqual(b!.command,action);await resolver.validateLifecycle(b!,(1n<<64n)-1n);assert.equal(await resolver.bind(action,10n),null);}assert.equal(existsSync(path),false);
}));
test('lifecycle mapped target is original and mapping changes refuse replacement',()=>storeFixture(async path=>{
 const {resolver}=setup(path);await mapping(path,'mapped');const b=await resolver.bindLifecycle({Stop:{reference:null}},10n);assert.equal(b!.target,'mapped');assert.equal(b!.route,'Mapped');
 await mapping(path,'explicit');await assert.rejects(resolver.validateLifecycle(b!,10n),/lifecycle target changed after admission; no replacement target will be used/);assert.equal(b!.target,'mapped');
}));
test('lifecycle selected target rejects changed selection and newly appearing mirror',()=>storeFixture(async path=>{
 const {resolver,bridge}=setup(path);await mapping(path,null);const b=await resolver.bindLifecycle({Archive:{reference:null}},10n);assert.equal(b!.route,'Selected');bridge.setSelectedThreadId('explicit');await assert.rejects(resolver.validateLifecycle(b!,10n),/lifecycle target changed/);
 bridge.setSelectedThreadId('selected');await mapping(path,'mapped');await assert.rejects(resolver.validateLifecycle(b!,10n),/lifecycle target changed/);
}));
test('lifecycle inactive mapping, missing explicit target and missing selection are errors',()=>storeFixture(async path=>{
 const {resolver,bridge}=setup(path);await mapping(path,'archived');await assert.rejects(resolver.bindLifecycle({Resume:{reference:null}},10n),/lifecycle admission target is not an active original thread/);
 await assert.rejects(resolver.bindLifecycle({Repair:{reference:'missing'}},10n),/Thread not found/);
 await mapping(path,null);bridge.setSelectedThreadId(null);await assert.rejects(resolver.bindLifecycle({Recover:{reference:null}},10n),/no Codex thread target/);
}));
test('lifecycle exact list index shares original POSIX resolver and preserves canonical command',()=>storeFixture(async path=>{
 const {resolver}=setup(path);const action={Stop:{reference:'2'}} as const,b=await resolver.bindLifecycle(action,10n);assert.equal(b!.target,'mapped');assert.equal(b!.route,'Explicit');assert.deepEqual(b!.command,action);assert.ok(Object.isFrozen(b)&&Object.isFrozen(b!.command));
}));
test('full mutation predicate and legacy AutoReserve description do not broaden slash parser or execute changes',()=>storeFixture(async path=>{
 const {resolver}=setup(path);const action={AutoReserve:{reference:'explicit',enabled:false}} as const;assert.equal(isSettingsMutation(action),true);assert.equal(isSlashSettingsMutation({Settings:{reference:null,model:null,effort:null,speed:null}}),false);
 assert.equal(isSettingsMutation('Help'),false);assert.equal(isSettingsMutation({Settings:{reference:null,model:'x',effort:null,speed:null}}),true);
 const b=await resolver.bind(action,10n);assert.equal(b!.target,'explicit');assert.deepEqual(b!.command,action);assert.equal(await resolver.bindLifecycle(action,10n),null);assert.equal(existsSync(path),false);
}));
test('lifecycle channel range errors occur only on routes needing mirror lookup',()=>storeFixture(async path=>{
 const {resolver}=setup(path);await assert.rejects(resolver.bindLifecycle({Stop:{reference:null}},1n<<63n),ActionIntegerRangeError);await assert.rejects(resolver.bindLifecycle({Stop:{reference:'explicit'}},1n<<64n),TypeError);
}));
