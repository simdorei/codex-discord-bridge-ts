import assert from 'node:assert/strict';
import {test} from 'node:test';
import {storeFixture} from '../helpers/store-fixture.ts';
import {queueJob} from '../helpers/queue-job.ts';
import {StateAccessFacade as state} from '../../src/store/state-access-facade.ts';
import {createBusyChoice} from '../../src/store/busy-choice-store.ts';
import {openInitialized} from '../../src/store/owned-driver.ts';
import {bindBusyControl, resolveBusyControl} from '../../src/store/control-binding.ts';
async function choice(db: string) {return createBusyChoice(db, {ownerUserId: 2n, channelId: 1n, targetThreadId: 't', prompt: 'fixture', allowSteer: true, now: 1, timeToLive: 100});}
async function edit(path: string, sql: string) {const db = await openInitialized(path); try {db.exec(sql);} finally {db.close();}}
async function raw(path: string) {const db = await openInitialized(path); try {return db.prepare('SELECT choice_id,thread_id,turn_id,job_id FROM codex_busy_control_bindings ORDER BY choice_id').all();} finally {db.close();}}
test('explicit original turn is immutable under duplicate bind and foreign thread cannot resolve', async () => storeFixture(async db => {
  const id = await choice(db); await bindBusyControl(db,id,'t','first',null); await bindBusyControl(db,id,'t','later',null); await bindBusyControl(db,id,'foreign','third',null);
  assert.equal(await resolveBusyControl(db,id,'t'),'first');assert.equal(await resolveBusyControl(db,id,'foreign'),null);assert.equal(await resolveBusyControl(db,'missing','t'),null);
}));
test('preparing binding migration trigger pins first turn before goal advances to later turn', async()=>storeFixture(async db=>{
  await state.enqueue(db,queueJob({jobId:'job',targetThreadId:'t',turnId:null})); const id=await choice(db);await bindBusyControl(db,id,'t',null,'job');assert.equal(await resolveBusyControl(db,id,'t'),null);
  await edit(db,"UPDATE codex_turn_queue SET state='running',turn_id='first' WHERE job_id='job'; UPDATE codex_turn_queue SET turn_id='later',goal_waiting=1 WHERE job_id='job'");
  assert.equal(await resolveBusyControl(db,id,'t'),'first');
}));
test('late binding resolves and persists only exact running non-goal-waiting preceding job',async()=>storeFixture(async db=>{
  await state.enqueue(db,queueJob({jobId:'job',targetThreadId:'t'}));await edit(db,"UPDATE codex_turn_queue SET state='running',turn_id='first'");const id=await choice(db);await bindBusyControl(db,id,'t',null,'job');
  assert.equal(await resolveBusyControl(db,id,'t'),'first');await edit(db,"UPDATE codex_turn_queue SET turn_id='later',state='completed'");assert.equal(await resolveBusyControl(db,id,'t'),'first');assert.equal((await raw(db))[0]!.turn_id,'first');
}));
test('wrong target, absent job, nonrunning and goal-waiting never discover another active turn',async()=>storeFixture(async db=>{
  await state.enqueue(db,queueJob({jobId:'job',targetThreadId:'other'}));await edit(db,"UPDATE codex_turn_queue SET state='running',turn_id='turn'");
  const id=await choice(db);await bindBusyControl(db,id,'t',null,'job');assert.equal(await resolveBusyControl(db,id,'t'),null);
  await edit(db,"UPDATE codex_turn_queue SET target_thread_id='t',state='starting'");assert.equal(await resolveBusyControl(db,id,'t'),null);
  await edit(db,"UPDATE codex_turn_queue SET state='running',goal_waiting=1");assert.equal(await resolveBusyControl(db,id,'t'),null);
  const other=await choice(db);await bindBusyControl(db,other,'t',null,'absent');assert.equal(await resolveBusyControl(db,other,'t'),null);
}));
test('empty explicit turn is Some empty, not absence; missing turn/job remains null',async()=>storeFixture(async db=>{
  const id=await choice(db);await bindBusyControl(db,id,'t','',null);assert.equal(await resolveBusyControl(db,id,'t'),'');const second=await choice(db);await bindBusyControl(db,second,'t',null,null);assert.equal(await resolveBusyControl(db,second,'t'),null);
}));
test('orphan cleanup and insertion share transaction, with rollback on insertion failure',async()=>storeFixture(async db=>{
  await bindBusyControl(db,'orphan','t','original',null);const id=await choice(db);
  await edit(db,"CREATE TRIGGER fail_bind BEFORE INSERT ON codex_busy_control_bindings WHEN NEW.choice_id!='orphan' BEGIN SELECT RAISE(ABORT,'bind fixture'); END");
  await assert.rejects(bindBusyControl(db,id,'t','next',null),/bind fixture/);assert.equal((await raw(db))[0]!.choice_id,'orphan');
  await edit(db,'DROP TRIGGER fail_bind');await bindBusyControl(db,id,'t','next',null);assert.equal((await raw(db)).length,1);assert.equal((await raw(db))[0]!.choice_id,id);
}));
test('tuple decodes nullable job even when explicit turn exists; malformed native BLOB is rejected',async()=>storeFixture(async db=>{
  const id=await choice(db);await bindBusyControl(db,id,'t','original',null);await edit(db,"UPDATE codex_busy_control_bindings SET job_id=x'ff'");await assert.rejects(resolveBusyControl(db,id,'t'),/Expected string for column job_id/);
  await edit(db,"UPDATE codex_busy_control_bindings SET job_id=NULL,turn_id=CAST(x'ff' AS TEXT)");await assert.rejects(resolveBusyControl(db,id,'t'),/Invalid text encoding|Text decode mismatch/);
}));
test('failed bind-on-resolve update rolls back and a later valid retry persists original observed turn',async()=>storeFixture(async db=>{
  await state.enqueue(db,queueJob({jobId:'job',targetThreadId:'t'}));await edit(db,"UPDATE codex_turn_queue SET state='running',turn_id='turn'");const id=await choice(db);await bindBusyControl(db,id,'t',null,'job');
  await edit(db,"CREATE TRIGGER block_resolve BEFORE UPDATE ON codex_busy_control_bindings BEGIN SELECT RAISE(ABORT,'resolve fixture'); END");await assert.rejects(resolveBusyControl(db,id,'t'),/resolve fixture/);assert.equal((await raw(db))[0]!.turn_id,null);
  await edit(db,'DROP TRIGGER block_resolve');assert.equal(await resolveBusyControl(db,id,'t'),'turn');
}));
test('Unicode identities are bound parameters and invalid surrogate arguments fail before opening',async()=>storeFixture(async db=>{
  const id=await choice(db);await bindBusyControl(db,id,"t'😀",'턴',null);assert.equal(await resolveBusyControl(db,id,"t'😀"),'턴');
  assert.throws(()=>bindBusyControl('/unused',id,'\ud800',null,null),TypeError);assert.throws(()=>resolveBusyControl('/unused',id,'\ud800'),TypeError);
}));
