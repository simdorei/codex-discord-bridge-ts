import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {join, dirname} from 'node:path';
import {existsSync, writeFileSync} from 'node:fs';
import {storeFixture} from '../helpers/store-fixture.ts';
import {BridgeState} from '../../src/runtime/bridge-state.ts';
import {openInitialized} from '../../src/store/owned-driver.ts';
import {SlashSettingsTargetResolver, isSettingsRequestRejection} from '../../src/runtime/settings-binding.ts';
import {prepareSettingsAdmission} from '../../src/runtime/discord-dispatch/settings-admission.ts';
import {planSlash, type SlashCommandAction} from '../../src/runtime/command-plan.ts';
import {decodeGatewayInteraction} from '../../src/discord/gateway/decoded-interaction.ts';
import {routeGatewayCommand} from '../../src/discord/interaction-routing.ts';
import {InvalidActionRequestError, ActionIntegerRangeError} from '../../src/runtime/action-executor/errors.ts';
import {StoreIntegrityError} from '../../src/store/schema-assembly.ts';
function work(values: Record<string, string> = {}, name = 'settings') {
  return routeGatewayCommand(decodeGatewayInteraction(JSON.stringify({
    application_id: '2', authorizing_integration_owners: {}, id: '4', token: 'offline-token', type: 2,
    data: {id: '3', name, type: 1, options: Object.entries(values).map(([name, value]) => ({name, type: 3, value}))},
  })), false).work;
}
function setup(mirror: string) {
  const state = join(dirname(mirror), 'codex-state.sqlite'), bridgePath = join(dirname(mirror), 'bridge.json');
  const db = new DatabaseSync(state);
  try {
    db.exec(`CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,updated_at INTEGER,rollout_path TEXT,
      model TEXT,reasoning_effort TEXT,tokens_used INTEGER,archived INTEGER,archived_at INTEGER);
      INSERT INTO threads(id,title,cwd,updated_at,archived) VALUES
      ('selected','Selected','/selected',30,0),('mapped','Mapped','/mapped',20,0),
      ('explicit','Explicit','/explicit',10,0),('archived','Archived','/archived',40,1)`);
  } finally {db.close();}
  const bridge = new BridgeState(bridgePath); bridge.setSelectedThreadId('selected');
  return {state, bridgePath, bridge, resolver: new SlashSettingsTargetResolver(state, mirror, bridge)};
}
async function mapping(path: string, target: string | null): Promise<void> {
  const db = await openInitialized(path);
  try {
    db.exec('DELETE FROM mirror_threads');
    if (target !== null) db.prepare('INSERT INTO mirror_threads VALUES (?, ?, ?, ?, ?, ?)').run(target, '/p', 'title', 99n, 10n, 1);
  } finally {db.close();}
}
test('nonsettings and read-only settings do not require resolver or read any state', async () => {
  for (const input of [work({}, 'help'), work(), work({ref: 'missing'})]) {
    assert.deepEqual(await prepareSettingsAdmission(input, null, 10n), {binding: null, rejection: null});
  }
});
test('invalid settings input becomes an ordinary rejection before resolver requirements', async () => {
  assert.deepEqual(await prepareSettingsAdmission(work({ref: ' ', model: 'gpt'}), null, 10n),
    {binding: null, rejection: 'slash command option must not be blank: ref'});
  await assert.rejects(prepareSettingsAdmission(work({model: 'gpt'}), null, 10n),
    e => e instanceof StoreIntegrityError && e.message.includes('settings admission resolver is unavailable'));
});
test('explicit active reference has priority and skips mirror lookup including i64 channel restriction', async () => {
  await storeFixture(async mirror => {
    const {resolver} = setup(mirror), result = await prepareSettingsAdmission(work({ref: ' explicit ', model: ' gpt '}), resolver, (1n << 64n) - 1n);
    assert.equal(result.rejection, null); assert.equal(result.binding!.target, 'explicit'); assert.equal(result.binding!.route, 'Explicit');
    assert.deepEqual(result.binding!.command, {Settings: {reference: 'explicit', model: 'gpt', effort: null, speed: null}});
    assert.equal(existsSync(mirror), false); assert.ok(Object.isFrozen(result.binding) && Object.isFrozen(result.binding!.command));
  });
});
test('explicit list index and workspace references use all original active rows', async () => {
  await storeFixture(async mirror => {
    const {resolver} = setup(mirror);
    for (const reference of ['2', '/mapped', 'mapped']) {
      const binding = await resolver.bind(planSlash(work({ref: reference, effort: 'high'})), 10n);
      assert.equal(binding!.target, 'mapped'); assert.equal(binding!.route, 'Explicit');
    }
  });
});
test('mapped route overrides selected state and later mapping change rejects without replacement', async () => {
  await storeFixture(async mirror => {
    const {resolver} = setup(mirror); await mapping(mirror, 'mapped');
    const binding = await resolver.bind(planSlash(work({model: 'gpt'})), 10n);
    assert.equal(binding!.target, 'mapped'); assert.equal(binding!.route, 'Mapped');
    await mapping(mirror, 'explicit');
    await assert.rejects(resolver.validate(binding!, 10n), e => e instanceof InvalidActionRequestError
      && e.message === 'invalid command request: settings target changed after admission; no replacement target will be used');
    assert.equal(binding!.target, 'mapped');
  });
});
test('selected route stays bound and detects either a new mirror or changed selection', async () => {
  await storeFixture(async mirror => {
    const {resolver, bridge} = setup(mirror); await mapping(mirror, null);
    const binding = await resolver.bind(planSlash(work({speed: 'fast'})), 10n);
    assert.equal(binding!.target, 'selected'); assert.equal(binding!.route, 'Selected');
    bridge.setSelectedThreadId('explicit');
    assert.throws(() => resolver.validateSelectedSnapshot(binding!), /selected target changed after admission/);
    await assert.rejects(resolver.validate(binding!, 10n), /settings target changed/);
    bridge.setSelectedThreadId('selected'); await mapping(mirror, 'mapped');
    await assert.rejects(resolver.validate(binding!, 10n), /settings target changed/);
  });
});
test('no target, inactive mapped target and unresolved explicit input are ordinary request rejections', async () => {
  await storeFixture(async mirror => {
    const {resolver, bridge} = setup(mirror); bridge.setSelectedThreadId(null); await mapping(mirror, null);
    const missing = await prepareSettingsAdmission(work({model: 'gpt'}), resolver, 10n);
    assert.deepEqual(missing, {binding: null, rejection: 'no Codex thread target is selected or mirrored for this channel'});
    await mapping(mirror, 'archived');
    assert.match((await prepareSettingsAdmission(work({model: 'gpt'}), resolver, 10n)).rejection!, /not an active original thread/);
    assert.match((await prepareSettingsAdmission(work({ref: 'missing', model: 'gpt'}), resolver, 10n)).rejection!, /Thread not found/);
  });
});
test('state/bridge failures stay fatal custody errors rather than ordinary input rejections', async () => {
  await storeFixture(async mirror => {
    const {state, resolver, bridge, bridgePath} = setup(mirror);
    const absent = new SlashSettingsTargetResolver(state + '.missing', mirror, bridge);
    await assert.rejects(prepareSettingsAdmission(work({model: 'gpt'}), absent, 10n),
      e => e instanceof StoreIntegrityError && e.message.includes('Codex state database not found'));
    writeFileSync(bridgePath, '{');
    await assert.rejects(prepareSettingsAdmission(work({ref: 'explicit', model: 'gpt'}), resolver, 10n),
      e => e instanceof StoreIntegrityError && e.message.includes('not valid JSON'));
  });
});
test('nonexplicit channel i64 overflow is fatal and does not initialize a mirror DB', async () => {
  await storeFixture(async mirror => {
    const {resolver} = setup(mirror), action = planSlash(work({model: 'gpt'}));
    await assert.rejects(resolver.bind(action, 1n << 63n), ActionIntegerRangeError);
    await assert.rejects(prepareSettingsAdmission(work({model: 'gpt'}), resolver, 1n << 63n),
      e => e instanceof StoreIntegrityError && e.message.includes('SQLite integer contract'));
    assert.equal(existsSync(mirror), false);
  });
});
test('action data is snapshotted before asynchronous mirror lookup', async () => {
  await storeFixture(async mirror => {
    const {resolver} = setup(mirror);
    const action = {Settings: {reference: null, model: 'original', effort: null, speed: null}};
    const pending = resolver.bind(action, 10n); action.Settings.model = 'changed';
    const binding = await pending;
    assert.equal((binding!.command as typeof action).Settings.model, 'original');
    assert.ok(Object.isFrozen((binding!.command as typeof action).Settings));
  });
});
test('selection changing during admission lookup is rejected by final route validation', async () => {
  await storeFixture(async mirror => {
    const {resolver, bridge} = setup(mirror); await mapping(mirror, null);
    const pending = resolver.bind(planSlash(work({model: 'gpt'})), 10n);
    queueMicrotask(() => bridge.setSelectedThreadId('explicit'));
    await assert.rejects(pending, /settings target changed after admission/);
  });
});
test('request rejection classification does not invoke unknown error proxy hooks', () => {
  let calls = 0;
  assert.equal(isSettingsRequestRejection(new Proxy({}, {get() {calls++; throw new Error('get');}, getPrototypeOf() {calls++; throw new Error('proto');}})), false);
  assert.equal(calls, 0);
  assert.equal(isSettingsRequestRejection(new InvalidActionRequestError('bad')), true);
  assert.equal(isSettingsRequestRejection(new StoreIntegrityError('bad')), false);
});
