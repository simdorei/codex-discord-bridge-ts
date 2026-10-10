import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {setImmediate as tick} from 'node:timers/promises';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {serializeBusyChoice, type BusyChoice} from '../../../src/store/busy-choice.ts';
import {serializeSerdeValue} from '../../../src/core/serde-json.ts';
import {getOwn} from '../../../src/store/async-resolution-json-helpers.ts';
import {decodeGatewayInteraction} from '../../../src/discord/gateway/decoded-interaction.ts';
import {routeGatewayCommand, routeGatewayComponent} from '../../../src/discord/interaction-routing.ts';
import {BridgeState} from '../../../src/runtime/bridge-state.ts';
import {SlashSettingsTargetResolver} from '../../../src/runtime/settings-binding.ts';
import {stageOrdinaryInteraction as stage, type OrdinaryInteractionStageRequest as Request} from '../../../src/runtime/discord-dispatch/stage-ordinary.ts';
const options = {settingsResolver: null, cleanup: {now: () => 1, report: () => {}}};
const id = 'a'.repeat(24);
function routed(name = 'help', values: Record<string, string> = {}, customId?: string, autocomplete = false) {
  const interaction = decodeGatewayInteraction(JSON.stringify({
    application_id: '4', authorizing_integration_owners: {}, channel_id: '1', id: '3', token: 'not-a-persistable-token',
    type: customId ? 3 : autocomplete ? 4 : 2,
    data: customId ? {custom_id: customId, component_type: 2} : {id: '9', name, type: 1,
      options: Object.entries(values).map(([name, value]) => ({name, type: 3, value, ...(autocomplete ? {focused: true} : {})}))},
  }));
  return customId ? routeGatewayComponent(interaction).work : routeGatewayCommand(interaction, false).work;
}
function request(work = routed(), extra: Partial<Request> = {}): Request {
  return {applicationId: 4n, interactionId: 3n, channelId: 1n, userId: 2n, sourceMessageId: null, work, ...extra};
}
async function edit(path: string, sql: string): Promise<void> {
  const db = await openInitialized(path); try {db.exec(sql);} finally {db.close();}
}
async function active(path: string): Promise<void> {
  await edit(path, `INSERT INTO busy_choices(choice_id,owner_user_id,channel_id,target_thread_id,prompt,allow_steer,created_at,expires_at,claimed_at,require_current_mirror)
    VALUES ('${id}',2,1,'target','original',0,0,10,NULL,0)`);
}
const choice: BusyChoice = {choiceId: id, ownerUserId: 2n, channelId: 1n, targetThreadId: 'target',
  prompt: 'original', allowSteer: false, createdAt: 0, expiresAt: 10};

test('ordinary slash creates durable token-free staged custody before any acknowledgement', async () => {
  await storeFixture(async path => {
    const result = await stage(path, request(), options); assert.equal(result.kind, 'Created');
    if (result.kind !== 'Created') throw new Error('fixture');
    try {
      const record = (await state.getIngress(path, 'interaction:3'))!;
      assert.equal(record.state, 'staged'); assert.equal(record.eventId, 3n); assert.equal(record.applicationId, 4n);
      assert.equal(record.canonicalOwner, 'interaction:3'); assert.equal(record.targetThreadId, null);
      assert.deepEqual(record.payload, {version: 1n, processing_mode: 'normal', work: {Slash: {name: 'help', values: {}}}, settings_binding: null, request_rejection: null});
      assert.ok(!serializeSerdeValue(record.payload).includes('not-a-persistable-token'));
      await result.custody.acknowledge(); result.custody.intoReceipt();
      assert.equal((await state.getIngress(path, 'interaction:3'))!.state, 'acknowledged');
    } finally {await result.custody.dispose();}
  });
});
test('same identity returns Duplicate without replacing the original payload', async () => {
  await storeFixture(async path => {
    const first = await stage(path, request(), options); assert.equal(first.kind, 'Created');
    if (first.kind !== 'Created') throw new Error('fixture');
    try {
      first.custody.intoReceipt();
      assert.deepEqual(await stage(path, request(routed('where')), options), {kind: 'Duplicate'});
      assert.equal(getOwn(getOwn(getOwn((await state.getIngress(path, 'interaction:3'))!.payload, 'work'), 'Slash'), 'name'), 'help');
    } finally {await first.custody.dispose();}
  });
});
test('ask and interview freeze exact original mirror target and later remapping blocks execution', async () => {
  for (const name of ['ask', 'interview']) await storeFixture(async path => {
    await edit(path, "INSERT INTO mirror_threads VALUES ('original','p','title',99,1,1)");
    const result = await stage(path, request(routed(name, {prompt: 'hello'})), options);
    assert.equal(result.kind, 'Created'); if (result.kind !== 'Created') throw new Error('fixture');
    try {
      assert.equal((await state.getIngress(path, 'interaction:3'))!.targetThreadId, 'original');
      result.custody.intoReceipt();
      await edit(path, "UPDATE mirror_threads SET codex_thread_id='replacement'");
      await assert.rejects(state.beginIngressExecution(path, 'interaction:3', 'processing', null, 2), /original slash prompt mapping changed/);
      assert.equal((await state.getIngress(path, 'interaction:3'))!.targetThreadId, 'original');
    } finally {await result.custody.dispose();}
  });
});
test('new request retains original source message and prepares original route evidence', async () => {
  await storeFixture(async path => {
    const result = await stage(path, request(routed('new', {prompt: 'hello'}), {sourceMessageId: 55n}), options);
    assert.equal(result.kind, 'Created'); if (result.kind !== 'Created') throw new Error('fixture');
    try {
      const record = (await state.getIngress(path, 'interaction:3'))!;
      assert.equal(record.sourceMessageId, 55n); assert.notEqual(getOwn(record.payload, 'new_origin'), undefined);
    } finally {await result.custody.dispose();}
  });
});
test('settings target and planned command are persisted with original stop origin', async () => {
  await storeFixture(async path => {
    const statePath = join(dirname(path), 'codex.sqlite'), db = new DatabaseSync(statePath);
    try {
      db.exec(`CREATE TABLE threads(id TEXT,title TEXT,cwd TEXT,updated_at INTEGER,rollout_path TEXT,model TEXT,reasoning_effort TEXT,tokens_used INTEGER,archived INTEGER,archived_at INTEGER);
        INSERT INTO threads(id,cwd,archived) VALUES ('selected','/selected',0)`);
    } finally {db.close();}
    const bridge = new BridgeState(join(dirname(path), 'bridge.json')); bridge.setSelectedThreadId('selected');
    const resolver = new SlashSettingsTargetResolver(statePath, path, bridge);
    const result = await stage(path, request(routed('settings', {model: 'gpt'})), {...options, settingsResolver: resolver});
    assert.equal(result.kind, 'Created'); if (result.kind !== 'Created') throw new Error('fixture');
    try {
      const record = (await state.getIngress(path, 'interaction:3'))!;
      assert.equal(record.targetThreadId, 'selected');
      assert.deepEqual(getOwn(record.payload, 'settings_binding'), {target: 'selected', route: 'Selected', command: {Settings: {reference: null, model: 'gpt', effort: null, speed: null}}});
      assert.notEqual(getOwn(record.payload, 'stop_origin'), undefined);
    } finally {await result.custody.dispose();}
  });
});
test('ordinary settings rejection is durably recorded without inventing a target', async () => {
  await storeFixture(async path => {
    const result = await stage(path, request(routed('settings', {model: ' '})), options);
    assert.equal(result.kind, 'Created'); if (result.kind !== 'Created') throw new Error('fixture');
    try {
      const record = (await state.getIngress(path, 'interaction:3'))!;
      assert.equal(record.targetThreadId, null); assert.equal(getOwn(record.payload, 'settings_binding'), null);
      assert.equal(getOwn(record.payload, 'request_rejection'), 'slash command option must not be blank: model');
    } finally {await result.custody.dispose();}
  });
});
test('busy admission preserves action, owner and frozen original choice through canonical repeat', async () => {
  await storeFixture(async path => {
    await active(path);
    const work = routed('help', {}, 'codex_busy:' + id + ':queue');
    const first = await stage(path, request(work), options);
    assert.equal(first.kind, 'Created'); if (first.kind !== 'Created') throw new Error('fixture');
    try {
      const receipt = first.custody.intoReceipt(); assert.deepEqual(receipt.busyChoice, choice);
      const record = (await state.getIngress(path, 'interaction:3'))!;
      assert.equal(record.targetThreadId, 'target'); assert.equal(record.canonicalOwner, 'busy-choice:' + id);
      assert.equal(getOwn(record.payload, 'busy_action'), 'queue');
      await edit(path, 'DELETE FROM busy_choices');
      const repeat = await stage(path, request(work, {interactionId: 5n}), {...options, cleanup: {...options.cleanup, now: () => 50}});
      assert.equal(repeat.kind, 'CanonicalRepeat');
      if (repeat.kind !== 'CanonicalRepeat') throw new Error('fixture');
      assert.equal(repeat.confirmationReady, false); assert.deepEqual(repeat.receipt.busyChoice, choice);
      assert.equal((await state.getIngress(path, 'interaction:5'))!.ownerId, 'interaction:3');
    } finally {await first.custody.dispose();}
  });
});
test('durable prompt-owned busy receipt produces confirmation-ready repeat without transient choice', async () => {
  await storeFixture(async path => {
    const db = await openInitialized(path);
    try {db.prepare("INSERT INTO discord_ingress_owner_receipts VALUES (?,'prompt','job','target',1,2,?,1)").run('busy-choice:' + id, serializeBusyChoice(choice));}
    finally {db.close();}
    const result = await stage(path, request(routed('help', {}, 'codex_busy:' + id + ':ignore')), {...options, cleanup: {...options.cleanup, now: () => 50}});
    assert.equal(result.kind, 'CanonicalRepeat');
    if (result.kind !== 'CanonicalRepeat') throw new Error('fixture');
    assert.equal(result.confirmationReady, true); assert.equal((await state.getIngress(path, 'interaction:3'))!.ownerKind, 'prompt');
  });
});
test('busy wrong actor and expired first choice return unavailable with no admitted row', async () => {
  for (const [userId, now] of [[9n, 1], [2n, 10]] as const) await storeFixture(async path => {
    await active(path);
    assert.deepEqual(await stage(path, request(routed('help', {}, 'codex_busy:' + id + ':stop'), {userId}),
      {...options, cleanup: {...options.cleanup, now: () => now}}), {kind: 'BusyChoiceUnavailable'});
    assert.equal(await state.getIngress(path, 'interaction:3'), null);
  });
});
test('autocomplete cannot enter executable custody', async () => {
  await storeFixture(async path => {
    await assert.rejects(stage(path, request(routed('settings', {model: 'g'}, undefined, true)), options), TypeError);
    assert.equal(existsSync(path), false);
  });
});
test('source integer conversion order precedes settings; application conversion stays after settings', async () => {
  await storeFixture(async path => {
    const overflow = 1n << 63n, settings = routed('settings', {model: 'gpt'});
    await assert.rejects(stage(path, request(settings, {interactionId: overflow}), options), /Discord interaction ID exceeds SQLite range/);
    await assert.rejects(stage(path, request(settings, {sourceMessageId: overflow}), options), /Discord source message ID exceeds SQLite range/);
    await assert.rejects(stage(path, request(settings, {applicationId: overflow}), options), /settings admission resolver is unavailable/);
    await assert.rejects(stage(path, request(routed(), {applicationId: overflow}), options), /Discord application ID exceeds SQLite range/);
    assert.equal(existsSync(path), false);
  });
});
test('identity inputs are captured before asynchronous settings preparation', async () => {
  await storeFixture(async path => {
    const input = {...request()}, pending = stage(path, input, options);
    input.interactionId = 99n; input.work = routed('where');
    const result = await pending;
    assert.equal(result.kind, 'Created'); if (result.kind !== 'Created') throw new Error('fixture');
    try {assert.notEqual(await state.getIngress(path, 'interaction:3'), null); assert.equal(await state.getIngress(path, 'interaction:99'), null);}
    finally {await result.custody.dispose();}
  });
});
test('invalid cleanup callbacks and promise-valued clocks fail before persistence without orphan rejection', async () => {
  await storeFixture(async path => {
    for (const cleanup of [
      {now: async () => 1, report: () => {}},
      {now: () => 1, report: async () => {}},
      {now: () => Promise.reject(new Error('clock')), report: () => {}},
    ]) await assert.rejects(stage(path, request(), {settingsResolver: null, cleanup: cleanup as unknown as typeof options.cleanup}), TypeError);
    await tick(); assert.equal(existsSync(path), false);
  });
});
