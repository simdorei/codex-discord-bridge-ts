import assert from 'node:assert/strict';
import {test} from 'node:test';
import {existsSync} from 'node:fs';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {StoreIntegrityError} from '../../../src/store/schema-assembly.ts';
import {InteractionAccessPolicy} from '../../../src/discord/interaction-access.ts';
import {decodeGatewayInteraction} from '../../../src/discord/gateway/decoded-interaction.ts';
import {refreshMirrorPolicy} from '../../../src/runtime/discord-runtime/mirror-policy.ts';
async function edit(path: string, sql: string) {const db = await openInitialized(path); try {db.exec(sql);} finally {db.close();}}
function input(channel: bigint | null, user = 2n) {
  return decodeGatewayInteraction(JSON.stringify({application_id: '4', id: '3', token: 'offline_token', type: 2,
    authorizing_integration_owners: {}, channel_id: channel === null ? null : String(channel),
    user: {id: String(user), username: 'u', discriminator: '0001'}, data: {id: '9', name: 'help', type: 1}}));
}
const policy = () => new InteractionAccessPolicy({allowedChannelIds: [1n], allowedUserIds: [2n], mirroredChannelIds: [77n], allowAllChannels: false});
const allowed = (p: InteractionAccessPolicy, channel: bigint, user = 2n) => p.evaluate(input(channel, user)).kind === 'Allowed';

test('remaining IDs deduplicate and sort threads but retain project vector multiplicity and signed values', async () => {
  await storeFixture(async path => {
    await edit(path, `INSERT INTO mirror_threads VALUES
      ('a','p','A',10,7,1),('b','p','B',10,7,2),('c','p','C',10,-2,3),('d','p','D',10,0,4);
      INSERT INTO mirror_projects VALUES ('a','A',9,1),('b','B',9,2),('c','C',0,3),('d','D',-3,4)`);
    const ids = await state.remainingDiscordIds(path);
    assert.deepEqual(ids.threadIds, [-2n, 7n]);
    const db = await openInitialized(path);
    try {const q = db.prepare('SELECT discord_channel_id AS id FROM mirror_projects'); q.setReadBigInts(true);
      assert.deepEqual(ids.projectChannelIds, q.all().map(r => r.id).filter(id => id !== null && id !== 0n));}
    finally {db.close();}
    assert.equal(ids.projectChannelIds.filter(id => id === 9n).length, 2);
  });
});
test('mirror target SQL limit applies before empty-ID and zero-room filtering', async () => {
  await storeFixture(async path => {
    await edit(path, "INSERT INTO mirror_threads VALUES ('','p','empty',5,9,30),('zero','p','zero',6,0,20),('valid','p','valid',7,8,10)");
    assert.deepEqual(await state.mirrorTargets(path, 1n), []);
    assert.deepEqual(await state.mirrorTargets(path, 2n), []);
    assert.deepEqual(await state.mirrorTargets(path, 0n), []);
    assert.deepEqual(await state.mirrorTargets(path, -1n), [{codexThreadId: 'valid', threadTitle: 'valid', discordChannelId: 7n, discordThreadId: 8n}]);
  });
});
test('source target filter does not trim a nonempty thread ID or remove negative channel values', async () => {
  await storeFixture(async path => {
    await edit(path, "INSERT INTO mirror_threads VALUES (' ','p','space',-9,-8,1)");
    assert.deepEqual(await state.mirrorTargets(path, 10n), [{codexThreadId: ' ', threadTitle: 'space', discordChannelId: -9n, discordThreadId: -8n}]);
  });
});
test('required text decoding still rejects a malformed row that would later be filtered out', async () => {
  await storeFixture(async path => {
    await edit(path, "INSERT INTO mirror_threads VALUES ('','p',CAST(x'ff' AS TEXT),1,0,1)");
    assert.deepEqual((await state.remainingDiscordIds(path)).threadIds, []);
    await assert.rejects(state.mirrorTargets(path, 10n), StoreIntegrityError);
    await assert.rejects(refreshMirrorPolicy(policy(), path), StoreIntegrityError);
  });
});
test('numeric mapping reads reject REAL/text storage classes instead of converting them', async () => {
  await storeFixture(async path => {
    await edit(path, "INSERT INTO mirror_threads VALUES ('a','p','A',1,1.5,1)");
    await assert.rejects(state.remainingDiscordIds(path), StoreIntegrityError);
    await edit(path, "DELETE FROM mirror_threads; INSERT INTO mirror_projects VALUES ('p','P','bad',1)");
    await assert.rejects(state.remainingDiscordIds(path), StoreIntegrityError);
  });
});
test('i64 extremes remain lossless and negative values are removed only at u64 policy collection', async () => {
  await storeFixture(async path => {
    await edit(path, `INSERT INTO mirror_threads VALUES
      ('max','p','Max',9223372036854775807,9007199254740993,1),('neg','p','Neg',10,-9223372036854775808,2)`);
    assert.deepEqual((await state.remainingDiscordIds(path)).threadIds, [-(1n << 63n), 9007199254740993n]);
    const refreshed = await refreshMirrorPolicy(policy(), path);
    assert.ok(allowed(refreshed, 9223372036854775807n));
    assert.ok(allowed(refreshed, 9007199254740993n)); assert.ok(allowed(refreshed, 10n));
  });
});
test('refresh combines thread rooms, project rooms and target parents while retaining static user/channel restrictions', async () => {
  await storeFixture(async path => {
    await edit(path, "INSERT INTO mirror_threads VALUES ('t','p','T',8,7,1); INSERT INTO mirror_projects VALUES ('p','P',9,1)");
    const original = policy(), refreshed = await refreshMirrorPolicy(original, path);
    for (const id of [1n, 7n, 8n, 9n]) assert.ok(allowed(refreshed, id));
    assert.equal(allowed(refreshed, 77n), false); assert.equal(allowed(refreshed, 7n, 3n), false);
    assert.equal(allowed(original, 77n), true); assert.equal(allowed(original, 7n), false);
  });
});
test('empty named target still contributes its room through remaining IDs, but not its parent through targets', async () => {
  await storeFixture(async path => {
    await edit(path, "INSERT INTO mirror_threads VALUES ('','p','Empty',6,7,1)");
    const refreshed = await refreshMirrorPolicy(policy(), path);
    assert.ok(allowed(refreshed, 7n)); assert.equal(allowed(refreshed, 6n), false);
  });
});
test('each refresh replaces removed mappings rather than merging stale allowed rooms', async () => {
  await storeFixture(async path => {
    await edit(path, "INSERT INTO mirror_threads VALUES ('t','p','T',8,7,1)");
    const first = await refreshMirrorPolicy(policy(), path);
    await edit(path, 'DELETE FROM mirror_threads');
    const second = await refreshMirrorPolicy(first, path);
    assert.ok(allowed(first, 7n)); assert.equal(allowed(second, 7n), false); assert.equal(allowed(second, 8n), false);
    assert.ok(allowed(second, 1n));
  });
});
test('failed refresh throws without returning an old-policy fallback or mutating the base', async () => {
  await storeFixture(async path => {
    await edit(path, "INSERT INTO mirror_threads VALUES ('t','p',CAST(x'ff' AS TEXT),8,7,1)");
    const original = policy();
    await assert.rejects(refreshMirrorPolicy(original, path), StoreIntegrityError);
    assert.ok(allowed(original, 77n)); assert.equal(allowed(original, 7n), false);
  });
});
test('allow-all still needs a channel and user allowlist after an empty dynamic refresh', async () => {
  await storeFixture(async path => {
    assert.equal(existsSync(path), false);
    const original = new InteractionAccessPolicy({allowedChannelIds: [], allowedUserIds: [2n], mirroredChannelIds: [77n], allowAllChannels: true});
    const refreshed = await refreshMirrorPolicy(original, path);
    assert.equal(existsSync(path), true); // Source uses the bridge-store initializer.
    assert.ok(allowed(refreshed, 123n)); assert.equal(allowed(refreshed, 123n, 3n), false);
    assert.equal(refreshed.evaluate(input(null)).kind, 'DeniedChannel');
  });
});
test('query arguments and detached returned snapshots cannot alter store or policy ownership', async () => {
  await storeFixture(async path => {
    await assert.rejects(state.mirrorTargets(path, 1n << 63n), TypeError); assert.equal(existsSync(path), false);
    await edit(path, "INSERT INTO mirror_threads VALUES ('t','p','T',8,7,1)");
    const ids = await state.remainingDiscordIds(path), targets = await state.mirrorTargets(path, 10n);
    assert.ok(Object.isFrozen(ids) && Object.isFrozen(ids.threadIds) && Object.isFrozen(ids.projectChannelIds));
    assert.ok(Object.isFrozen(targets) && Object.isFrozen(targets[0]));
    const replacement = [55n], copied = policy().withMirroredChannelIds(replacement);
    replacement[0] = 66n; assert.ok(allowed(copied, 55n)); assert.equal(allowed(copied, 66n), false);
  });
});
