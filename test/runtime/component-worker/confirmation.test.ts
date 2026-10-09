import assert from 'node:assert/strict';
import {test} from 'node:test';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {standardReadyMarker, busyReadyMarker, standardConfirmationPlan, busyConfirmationPlan, isConfirmationPlan, ConfirmationPlanError, ConfirmationError, confirmationErrorInfo, confirmationReady, recordConfirmationReady, claimStandardAction} from '../../../src/runtime/component-worker/confirmation.ts';
import type {ComponentId} from '../../../src/discord/components.ts';
const approval: ComponentId = {Approval: {thread_id: 't', answer: 'Approve'}};
test('standard/busy confirmation plans and ready markers preserve exact UTF8-length identity', () => {
  assert.deepEqual(standardConfirmationPlan(approval, '한😀'), {content: 'Approval response submitted.', domain: 'component/confirmation/v1', logicalKey: 'v1;kind=8:approval;action=7:한😀;'});
  assert.equal(standardConfirmationPlan({BoundInput: {thread_fingerprint: 't', request_fingerprint: 'r', value: '1'}}, 'claim').content, 'Codex input choice submitted.');
  assert.deepEqual(busyConfirmationPlan('c'), {content: 'Busy action submitted.', domain: 'component/busy-confirmation/v1', logicalKey: 'v1;kind=4:busy;action=1:c;'});
  assert.equal(standardReadyMarker('한😀'), 'confirmation-ready:v1;kind=8:standard;action=7:한😀;');
  assert.equal(busyReadyMarker('c', 2n, 1n), 'confirmation-ready:v1;kind=4:busy;action=1:c;user=1:2;channel=1:1;');
  assert.notEqual(busyReadyMarker('c', 2n, 1n), busyReadyMarker('c', 1n, 2n));
  const p = busyConfirmationPlan('c'); assert.ok(Object.isFrozen(p)); assert.equal(isConfirmationPlan(p), true); assert.equal(isConfirmationPlan({...p}), false);
});
test('nonstandard component families require their own confirmation plans', () => {
  for (const component of [{Busy: {choice_id: 'c', action: 'Stop'}}, {AsyncChoice: {question_id: 'q', option: 1n}},
    {RecoveryPublicationDecision: {proposal_id: 'p', revision: 1n, decision: 'KeepHeld'}}, {RecoveryAbandonDecision: {proposal_id: 'p', revision: 1n, decision: 'KeepHeld'}}] as ComponentId[]) {
    assert.throws(() => standardConfirmationPlan(component, 'claim'), ConfirmationPlanError);
  }
});
test('first action claims ExecuteAction, repeat without success marker is unconfirmed', async () => {
  await storeFixture(async path => {
    const ready = standardReadyMarker('action'); assert.equal(await claimStandardAction(path, 'action', ready, 1, 100), 'ExecuteAction');
    assert.equal(await claimStandardAction(path, 'action', ready, 2, 100), 'ActionUnconfirmed');
    assert.equal(await confirmationReady(path, ready, 2), false);
  });
});
test('ready marker permits confirmation only and never creates an action claim', async () => {
  await storeFixture(async path => {
    const ready = standardReadyMarker('action'); assert.equal(await recordConfirmationReady(path, ready, 1, 100), true);
    assert.equal(await claimStandardAction(path, 'action', ready, 2, 100), 'DeliverConfirmation');
    assert.equal(await state.isComponentClaimLive(path, 'action', 2), false); assert.equal(recordConfirmationReady, state.claimComponent); assert.equal(confirmationReady, state.isComponentClaimLive);
  });
});
test('exact expiration boundary is not live; duplicate ready write does not extend expiry', async () => {
  await storeFixture(async path => {
    const ready = standardReadyMarker('action'); await recordConfirmationReady(path, ready, 1, 10);
    assert.equal(await recordConfirmationReady(path, ready, 5, 100), false);
    assert.equal(await confirmationReady(path, ready, 10.999), true); assert.equal(await confirmationReady(path, ready, 11), false);
    assert.equal(await claimStandardAction(path, 'action', ready, 11, 100), 'ExecuteAction');
  });
});
test('second ready read observes success marker written during a failed duplicate claim', async () => {
  await storeFixture(async path => {
    const ready = standardReadyMarker('action'); await state.claimComponent(path, 'action', 1, 100);
    const db = await openInitialized(path); try {db.exec(`CREATE TRIGGER publish_ready BEFORE INSERT ON persistent_component_claims WHEN NEW.claim_key='action' BEGIN INSERT OR IGNORE INTO persistent_component_claims VALUES ('${ready}',2,100); END`);} finally {db.close();}
    assert.equal(await confirmationReady(path, ready, 2), false);
    assert.equal(await claimStandardAction(path, 'action', ready, 2, 100), 'DeliverConfirmation');
    assert.equal(await confirmationReady(path, ready, 2), true);
  });
});
test('concurrent claimants cannot both receive execution permission for the same claim', async () => {
  await storeFixture(async path => {
    const ready = standardReadyMarker('action'); const outcomes = await Promise.all([claimStandardAction(path, 'action', ready, 1, 100), claimStandardAction(path, 'action', ready, 1, 100)]);
    assert.deepEqual(outcomes.sort(), ['ActionUnconfirmed', 'ExecuteAction']);
  });
});
test('actor-bound busy markers do not authorize a different user or channel', async () => {
  await storeFixture(async path => {
    await recordConfirmationReady(path, busyReadyMarker('c', 2n, 1n), 1, 100);
    assert.equal(await confirmationReady(path, busyReadyMarker('c', 2n, 1n), 2), true);
    assert.equal(await confirmationReady(path, busyReadyMarker('c', 3n, 1n), 2), false);
    assert.equal(await confirmationReady(path, busyReadyMarker('c', 2n, 3n), 2), false);
  });
});
test('native store errors propagate instead of granting execution or confirmation', async () => {
  await storeFixture(async path => {
    await state.claimComponent(path, 'action', 1, 100);
    const db = await openInitialized(path); try {db.exec("CREATE TRIGGER fail_claim BEFORE INSERT ON persistent_component_claims BEGIN SELECT RAISE(ABORT,'fixture failure'); END");} finally {db.close();}
    await assert.rejects(claimStandardAction(path, 'action', standardReadyMarker('action'), 2, 100), /fixture failure/);
  });
});
test('confirmation errors retain typed owned failure and raw cause without prototype forgery', () => {
  const source = new Error('cause'); const e = new ConfirmationError('Recovery', 'store unavailable', source);
  assert.equal(e.cause, source); assert.equal(confirmationErrorInfo(e)!.kind, 'Recovery'); assert.equal(confirmationErrorInfo(e)!.source, source);
  assert.equal(e.message, 'action succeeded; durable confirmation recovery state failed: store unavailable');
  assert.equal(confirmationErrorInfo(Object.create(ConfirmationError.prototype)), null);
});
