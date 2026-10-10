import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {join, dirname} from 'node:path';
import {writeFileSync, readFileSync} from 'node:fs';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {BridgeState} from '../../../src/runtime/bridge-state.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {ActionThreadSelection} from '../../../src/runtime/action-executor/thread-selection.ts';
import {ActionIntegerRangeError, NoActionTargetError} from '../../../src/runtime/action-executor/errors.ts';
import {ThreadResolveError} from '../../../src/codex-state/thread-reference.ts';
function setup(mirror:string) {
  const state=join(dirname(mirror),'codex.sqlite'), bridgePath=join(dirname(mirror),'bridge.json');
  const db=new DatabaseSync(state);
  try {db.exec(`CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,updated_at INTEGER,rollout_path TEXT,model TEXT,reasoning_effort TEXT,tokens_used INTEGER,archived INTEGER,archived_at INTEGER);
    INSERT INTO threads(id,title,cwd,updated_at,archived,archived_at) VALUES ('selected','Selected','/a/shared',30,0,0),('mapped','Mapped','/b/shared',20,0,0),('explicit','Explicit','C:\\work\\chosen\\',10,0,0),('archived','Archived','/old',40,1,50);`);} finally {db.close();}
  const bridge=new BridgeState(bridgePath); bridge.setSelectedThreadId('selected');
  return {state,bridge,bridgePath,resolver:new ActionThreadSelection(state,mirror,bridge)};
}
async function mapping(path:string,target:string|null){const db=await openInitialized(path);try{db.exec('DELETE FROM mirror_threads');if(target!==null)db.prepare('INSERT INTO mirror_threads VALUES (?, ?, ?, ?, ?, ?)').run(target,'/p','title',99n,10n,1);}finally{db.close();}}
test('mirror wins without touching corrupt selection, and stale mapping never falls back',async()=>{await storeFixture(async path=>{const f=setup(path);await mapping(path,'mapped');writeFileSync(f.bridgePath,'not json');assert.deepEqual(await f.resolver.target(10n),['mapped','mirror']);assert.equal((await f.resolver.resolveThread(10n,null)).id,'mapped');await mapping(path,'gone');await assert.rejects(f.resolver.resolveThread(10n,null),e=>e instanceof ThreadResolveError&&e.kind==='NotFound');});});
test('unmapped uses selected and absent selection rejects',async()=>{await storeFixture(async path=>{const f=setup(path);await mapping(path,null);assert.deepEqual(await f.resolver.target(10n),['selected','selected']);f.bridge.setSelectedThreadId(null);await assert.rejects(f.resolver.target(10n),NoActionTargetError);});});
test('explicit exact lookup bypasses broken selection and mirror, including channel conversion',async()=>{await storeFixture(async path=>{const f=setup(path);writeFileSync(f.bridgePath,'not json');assert.equal((await f.resolver.resolveThread((1n<<64n)-1n,'\u0085explicit\u0085')).id,'explicit');});});
test('reference disambiguation reads all candidates and preserves archived scope',async()=>{await storeFixture(async path=>{const f=setup(path);assert.equal(f.resolver.resolveReference('3').id,'explicit');assert.equal(f.resolver.resolveReference('next').id,'mapped');assert.throws(()=>f.resolver.resolveReference('shared'),e=>e instanceof ThreadResolveError&&e.kind==='Ambiguous');assert.equal(f.resolver.resolveReference('1',true).id,'archived');assert.throws(()=>f.resolver.resolveReference('archived'),ThreadResolveError);});});
test('selection persists exact original id and source workspace formatting',async()=>{await storeFixture(async path=>{const f=setup(path);assert.equal(f.resolver.select('explicit'),'Selected Codex thread\nthread_id: explicit\nworkspace: chosen\ntitle: Explicit');assert.equal(f.bridge.selectedThreadId(),'explicit');const before=readFileSync(f.bridgePath);assert.throws(()=>f.resolver.select('missing'),ThreadResolveError);assert.deepEqual(readFileSync(f.bridgePath),before);});});
test('where output distinguishes mapped and selected provenance',async()=>{await storeFixture(async path=>{const f=setup(path);await mapping(path,null);assert.equal(await f.resolver.whereMessage(10n),'Codex target\nsource: selected\nthread_id: selected\ndiscord_mapping: unmapped; using global selected thread (not a room mapping)\ntitle: Selected\ncwd: /a/shared');await mapping(path,'mapped');assert.match(await f.resolver.whereMessage(10n),/source: mirror\nthread_id: mapped\ndiscord_mapping: mapped to this Discord room/);});});
test('u64 and SQLite i64 boundaries reject before database effects',async()=>{await storeFixture(async path=>{const f=setup(path);await assert.rejects(f.resolver.target(1n<<63n),ActionIntegerRangeError);for(const value of [-1n,1n<<64n,1 as unknown as bigint])await assert.rejects(f.resolver.target(value),TypeError);assert.throws(()=>f.resolver.resolveReference('\ud800'),TypeError);});});
