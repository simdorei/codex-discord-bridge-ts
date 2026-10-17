import assert from 'node:assert/strict';
import {test} from 'node:test';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {ExecutionCustody} from '../../../src/runtime/interaction-worker/execution-custody.ts';
import {recordCleanupNotificationFailure, cleanupNotificationFailureInfo, CleanupNotificationFailure} from '../../../src/runtime/cleanup-notification-failure.ts';
import {passiveErrorText} from '../../../src/core/passive-error-text.ts';
import {settingsErrorText} from '../../../src/runtime/settings-binding.ts';
const key = 'interaction:7';
const refusal = () => ({kind: 'mirror_cleanup_refused', version: 1n, sync_completed: false, delete_dispatched: false,
  earlier_changes_possible: true, blocked_room_id: 9n, protection_reason: 'queued requests'});
async function begin(path: string, now: () => number = () => 3) {
  await state.admitIngress(path, {ingressId: key, kind: 'interaction', eventId: 7n, applicationId: 4n,
    channelId: 1n, ownerUserId: 2n, sourceMessageId: null, payload: {}, targetThreadId: null, canonicalOwner: key, now: 1});
  return ExecutionCustody.begin(path, path, key, 'Execute', {now, report: () => {}});
}
async function edit(path: string, sql: string) {const db = await openInitialized(path); try {db.exec(sql);} finally {db.close();}}
const confirmFailure = "CREATE TRIGGER fail_confirmation BEFORE UPDATE OF confirmation_delivered ON discord_ingress_journal BEGIN SELECT RAISE(ABORT,'confirmation failed'); END";
test('known refusal confirmation failure is centrally wrapped and persists refusal-specific hold', async () => {
  await storeFixture(async path => {const c = await begin(path); await c.recordResult(refusal()); await edit(path, confirmFailure);
    try {await assert.rejects(c.finishNotification({must_not_replace: true}), error => {
      const info = cleanupNotificationFailureInfo(error); assert.ok(info); assert.equal(info.holdSaved, true); assert.equal(info.holdStatus, 'saved');
      assert.equal(info.stage, 'notification delivery confirmed; ingress confirmation write failed');
      assert.match((info.source as Error).message, /confirmation failed/); assert.equal((error as Error).cause, info.source); return true;
    }); await c.holdFailed();} finally {await c.dispose();}
    const row = (await state.getIngress(path, key))!; assert.equal(row.state, 'held'); assert.equal(row.phase, 'result_recorded');
    assert.equal(row.confirmationDelivered, false); assert.deepEqual(row.outcome, refusal());
    assert.match(row.holdReason, /^Mirror sync stopped:/); assert.match(row.holdReason, /ingress confirmation write failed/);
  });
});
test('ordinary confirmation failure retains its original native error category', async () => {
  await storeFixture(async path => {const c = await begin(path); await c.recordResult({action_completed: true}); await edit(path, confirmFailure);
    try {await assert.rejects(c.finishNotification({}), error => {assert.equal(cleanupNotificationFailureInfo(error), null); assert.match((error as Error).message, /confirmation failed/); return true;});}
    finally {await c.dispose();}
    assert.equal((await state.getIngress(path, key))!.state, 'completed');
  });
});
test('delivery failure keeps original cause and records distinct delivery stage', async () => {
  await storeFixture(async path => {const c = await begin(path); await c.recordResult(refusal()); const cause = new Error('PATCH failed');
    const error = await recordCleanupNotificationFailure(path, key, 'delivery', cause, () => 4);
    const info = cleanupNotificationFailureInfo(error)!; assert.equal(info.source, cause); assert.equal(error.cause, cause);
    assert.equal(info.stage, 'notification delivery unconfirmed'); assert.equal(info.holdSaved, true); assert.ok(Object.isFrozen(info));
    await c.dispose(); assert.equal((await state.getIngress(path, key))!.state, 'held');
  });
});
test('secondary hold SQL failure retains both errors and does not claim hold saved', async () => {
  await storeFixture(async path => {const c = await begin(path); await c.recordResult(refusal());
    await edit(path, "CREATE TRIGGER fail_hold BEFORE UPDATE OF hold_reason ON discord_ingress_journal BEGIN SELECT RAISE(ABORT,'hold failed'); END");
    const cause = new Error('delivery failed'), error = await recordCleanupNotificationFailure(path, key, 'delivery', cause, () => 4);
    const info = cleanupNotificationFailureInfo(error)!; assert.equal(info.source, cause); assert.equal(info.holdSaved, false);
    assert.match(info.holdStatus, /hold failed/); assert.match((info.holdError as Error).message, /hold failed/);
    assert.equal((await state.getIngress(path, key))!.state, 'completed'); await c.dispose();
  });
});
test('secondary clock failure preserves original cause without a false persistence claim', async () => {
  await storeFixture(async path => {const c = await begin(path); await c.recordResult(refusal()); const cause = new Error('delivery failed');
    const error = await recordCleanupNotificationFailure(path, key, 'delivery', cause, () => NaN);
    const info = cleanupNotificationFailureInfo(error)!; assert.equal(info.source, cause); assert.equal(info.holdSaved, false);
    assert.match(info.holdStatus, /timestamp/); assert.equal((await state.getIngress(path, key))!.state, 'completed'); await c.dispose();
  });
});
test('finishNotification records refusal before confirming, and dispose joins its failed-confirmation hold', async () => {
  await storeFixture(async path => {const c = await begin(path); await edit(path, confirmFailure);
    const task = c.finishNotification(refusal()); void task.catch(() => {}); const cleanup = c.dispose();
    await assert.rejects(task, error => cleanupNotificationFailureInfo(error)?.holdSaved === true); await cleanup;
    const row = (await state.getIngress(path, key))!; assert.equal(row.state, 'held'); assert.deepEqual(row.outcome, refusal());
  });
});
test('error rendering and branded classification never invoke active foreign properties', async () => {
  let hits = 0; const active = {get message() {hits++; return 'secret';}, toString() {hits++; return 'secret';}};
  const proxy = new Proxy({}, {getOwnPropertyDescriptor() {hits++; throw new Error('trap');}, get() {hits++; throw new Error('trap');}});
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const value of [active, proxy, revoked.proxy, Object.create(CleanupNotificationFailure.prototype)]) {
    assert.equal(cleanupNotificationFailureInfo(value), null); assert.equal(passiveErrorText(value, 'safe'), 'safe');
    assert.equal(settingsErrorText(value), 'settings admission failed');
  }
  assert.equal(hits, 0); assert.equal(passiveErrorText(new Error('own'), 'safe'), 'own');
  await storeFixture(async path => {const c = await begin(path); await c.recordResult(refusal());
    const error = await recordCleanupNotificationFailure(path, key, 'delivery', active, () => 4);
    assert.equal(cleanupNotificationFailureInfo(error)!.source, active); assert.equal(hits, 0); assert.match(error.message, /notification failed/); await c.dispose();
  });
});
