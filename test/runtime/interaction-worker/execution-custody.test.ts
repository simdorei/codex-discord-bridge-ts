import assert from 'node:assert/strict';
import {test} from 'node:test';
import {existsSync} from 'node:fs';
import {symlink, unlink} from 'node:fs/promises';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {ExecutionCustody, type ExecutionCustodyOptions} from '../../../src/runtime/interaction-worker/execution-custody.ts';
import {decodeGatewayInteraction} from '../../../src/discord/gateway/decoded-interaction.ts';
import {routeInteraction} from '../../../src/discord/route-interaction.ts';
import {InteractionAccessPolicy} from '../../../src/discord/interaction-access.ts';
import type {InboundInteractionWork} from '../../../src/runtime/discord-dispatch/interaction-work.ts';
const options: ExecutionCustodyOptions = {now: () => 3, report: () => {}};
const key = 'interaction:3';
const work = () => routeInteraction(decodeGatewayInteraction(JSON.stringify({application_id: '4', authorizing_integration_owners: {},
  channel_id: '1', id: '3', token: 'offline_token', type: 2, user: {id: '2', username: 'u', discriminator: '0001'},
  data: {id: '9', name: 'help', type: 1}})), new InteractionAccessPolicy({allowedChannelIds: [1n], allowedUserIds: [], mirroredChannelIds: [], allowAllChannels: false}), false).work!;
const envelope = () => ({channelId: 1n, userId: 2n, work: work()}) as InboundInteractionWork;
async function stage(path: string, rejection?: unknown) {
  await state.admitIngress(path, {ingressId: key, kind: 'interaction', eventId: 3n, applicationId: 4n, channelId: 1n,
    ownerUserId: 2n, sourceMessageId: null, payload: {work: work(), ...(rejection === undefined ? {} : {request_rejection: rejection})},
    targetThreadId: null, canonicalOwner: key, now: 1});
  assert.equal(await state.acknowledgeIngress(path, key, 2), true);
}
const read = (path: string) => state.getIngress(path, key);
const begin = (path: string, opts = options) => ExecutionCustody.begin(path, path, key, 'Execute', opts);
async function edit(path: string, sql: string) {const db = await openInitialized(path); try {db.exec(sql);} finally {db.close();}}

test('cancellation after execution claim becomes held without replay authority', async () => {
  await storeFixture(async path => {await stage(path); const c = await begin(path); await c.dispose();
    const row = (await read(path))!; assert.equal(row.state, 'held'); assert.equal(row.phase, 'processing');
    assert.equal(row.holdReason, 'interaction_processing_cancelled'); assert.equal(row.confirmationDelivered, false);
    await assert.rejects(begin(path), /cannot begin Execute/);
  });
});
test('result and confirmation are separate durable writes; confirmation does not overwrite result', async () => {
  await storeFixture(async path => {await stage(path); const c = await begin(path);
    try {await c.recordResult({action_completed: true}); let row = (await read(path))!;
      assert.equal(row.state, 'completed'); assert.equal(row.confirmationDelivered, false);
      await c.finishSuccess({must_not_replace: true}); row = (await read(path))!;
      assert.deepEqual(row.outcome, {action_completed: true}); assert.equal(row.confirmationDelivered, true);
    } finally {await c.dispose();}
  });
});
test('known result survives failed notification and cleanup without becoming unknown', async () => {
  await storeFixture(async path => {await stage(path); const c = await begin(path);
    await c.recordResult({action_completed: true}); await c.holdFailed(); await c.dispose();
    const row = (await read(path))!; assert.equal(row.state, 'completed'); assert.equal(row.phase, 'result_recorded');
    assert.equal(row.holdReason, ''); assert.equal(row.confirmationDelivered, false);
  });
});
test('same key in different databases does not authorize execution or mutate either row', async () => {
  await storeFixture(async left => {await storeFixture(async right => {await stage(left); await stage(right);
    await assert.rejects(ExecutionCustody.begin(left, right, key, 'Execute', options), /different worker database/);
    assert.equal((await read(left))!.state, 'acknowledged'); assert.equal((await read(right))!.state, 'acknowledged');
  });});
});
test('canonical same-file symlink accepted but absent path is not initialized', async () => {
  await storeFixture(async path => {
    await assert.rejects(begin(path), error => (error as NodeJS.ErrnoException).code === 'ENOENT'); assert.equal(existsSync(path), false);
    await stage(path); const alias = path + '.alias'; await symlink(path, alias);
    try {const c = await ExecutionCustody.begin(path, alias, key, 'Execute', options); await c.holdFailed(); await c.dispose();}
    finally {await unlink(alias);}
    assert.equal((await read(path))!.holdReason, 'interaction_processing_failed');
  });
});
test('confirmation-only begin requires canonical duplicate owned by prompt', async () => {
  await storeFixture(async path => {await stage(path);
    await assert.rejects(ExecutionCustody.begin(path, path, key, 'ConfirmationOnly', options), /cannot begin ConfirmationOnly/);
    await edit(path, "UPDATE discord_ingress_journal SET state='owned',phase='canonical_duplicate',owner_kind='prompt',owner_id='saved' WHERE ingress_id='interaction:3'");
    const c = await ExecutionCustody.begin(path, path, key, 'ConfirmationOnly', options);
    assert.equal((await read(path))!.phase, 'confirmation_retry');
    await c.recordResult({known: true}); await c.finishSuccess({ignored: true}); await c.dispose();
    assert.equal((await read(path))!.state, 'owned'); assert.equal((await read(path))!.confirmationDelivered, true);
  });
});
test('request rejection checks identity and owned routed-work equality only when rejection present', async () => {
  await storeFixture(async path => {await stage(path, 'wrong selection'); const c = await begin(path);
    try {
      assert.equal(await c.requestRejection(envelope()), 'wrong selection');
      await assert.rejects(c.requestRejection({...envelope(), userId: 4n}), /envelope identity changed/);
      await edit(path, "UPDATE discord_ingress_journal SET payload_json=json_set(payload_json,'$.work.Slash.name','status')");
      await assert.rejects(c.requestRejection(envelope()), /envelope identity changed/);
      await edit(path, "UPDATE discord_ingress_journal SET payload_json=json_remove(payload_json,'$.request_rejection')");
      assert.equal(await c.requestRejection({...envelope(), userId: 4n}), null);
    } finally {await c.dispose();}
  });
});
test('null rejection is absent; empty string and non-string rejection are malformed', async () => {
  for (const rejection of [null, '', false, 1n, {}]) await storeFixture(async path => {await stage(path, rejection); const c = await begin(path);
    try {if (rejection === null) assert.equal(await c.requestRejection(envelope()), null);
      else await assert.rejects(c.requestRejection(envelope()), /rejection is malformed/);
    } finally {await c.dispose();}
  });
});
test('owned mutation snapshots input and prevents overlaps; dispose joins in-flight result', async () => {
  await storeFixture(async path => {await stage(path); const c = await begin(path), value = {text: 'original'};
    const pending = c.recordResult(value); value.text = 'changed'; assert.throws(() => c.holdFailed(), /already borrowed/);
    const disposed = c.dispose(); assert.equal(c.dispose(), disposed); await pending; await disposed;
    assert.deepEqual((await read(path))!.outcome, {text: 'original'}); assert.equal((await read(path))!.state, 'completed');
    assert.throws(() => c.holdFailed(), /closed/);
  });
});
test('failed result write leaves custody armed and cleanup records cancellation hold', async () => {
  await storeFixture(async path => {await stage(path); const c = await begin(path);
    await edit(path, "CREATE TRIGGER fail_result BEFORE UPDATE OF outcome_json ON discord_ingress_journal BEGIN SELECT RAISE(ABORT,'fixture result failure'); END");
    await assert.rejects(c.recordResult({known: true}), /fixture result failure/); await c.dispose();
    assert.equal((await read(path))!.state, 'held'); assert.equal((await read(path))!.holdReason, 'interaction_processing_cancelled');
  });
});
test('cleanup clock and store failures are reported without fabricating successful hold', async () => {
  await storeFixture(async path => {await stage(path); const reports: unknown[] = []; let bad = false;
    const c = await begin(path, {now: () => bad ? NaN : 3, report: v => {reports.push(v);}}); bad = true; await c.dispose();
    assert.equal((reports[0] as {code: string}).code, 'interaction_processing_cancel_hold_clock_failed'); assert.equal((await read(path))!.state, 'executing');
  });
  await storeFixture(async path => {await stage(path); const reports: unknown[] = [];
    const c = await begin(path, {now: () => 3, report: v => {reports.push(v);}});
    await edit(path, "CREATE TRIGGER fail_hold BEFORE UPDATE OF hold_reason ON discord_ingress_journal BEGIN SELECT RAISE(ABORT,'fixture hold failure'); END");
    await c.dispose(); assert.equal((reports[0] as {code: string}).code, 'interaction_processing_cancel_hold_failed');
    assert.equal((await read(path))!.state, 'executing');
  });
});
test('known cleanup refusal flag follows last successfully recorded outcome', async () => {
  await storeFixture(async path => {await stage(path); const c = await begin(path);
    try {assert.equal(c.knownCleanupRefusal, false);
      await c.recordResult({kind: 'mirror_cleanup_refused', version: 1n, sync_completed: false, delete_dispatched: false,
        earlier_changes_possible: true, blocked_room_id: 9n, protection_reason: 'queued requests'});
      assert.equal(c.knownCleanupRefusal, true); await c.recordResult({other: true}); assert.equal(c.knownCleanupRefusal, false);
    } finally {await c.dispose();}
  });
});
test('actual confirmation write failure preserves the known result and never rearms execution', async () => {
  await storeFixture(async path => {await stage(path); const c = await begin(path);
    try {
      await c.recordResult({action_completed: true});
      await edit(path, "CREATE TRIGGER fail_confirmation BEFORE UPDATE OF confirmation_delivered ON discord_ingress_journal BEGIN SELECT RAISE(ABORT,'fixture confirm failure'); END");
      await assert.rejects(c.finishSuccess({must_not_replace: true}), /fixture confirm failure/);
      await c.holdFailed();
    } finally {await c.dispose();}
    const row = (await read(path))!; assert.equal(row.state, 'completed'); assert.equal(row.phase, 'result_recorded');
    assert.equal(row.confirmationDelivered, false); assert.deepEqual(row.outcome, {action_completed: true});
    await assert.rejects(begin(path), /cannot begin Execute/);
  });
});
test('finish without a prior result records once before confirmation and cleanup reporter errors stay visible', async () => {
  await storeFixture(async path => {await stage(path); const c = await begin(path);
    try {await c.finishSuccess({finished: true});} finally {await c.dispose();}
    assert.deepEqual((await read(path))!.outcome, {finished: true}); assert.equal((await read(path))!.confirmationDelivered, true);
  });
  await storeFixture(async path => {await stage(path); let bad = false; const error = new Error('report failed');
    const c = await begin(path, {now: () => bad ? NaN : 3, report: () => {throw error;}}); bad = true;
    await assert.rejects(c.dispose(), e => e === error); assert.equal((await read(path))!.state, 'executing');
  });
});
