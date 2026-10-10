import assert from 'node:assert/strict';
import {test} from 'node:test';
import {existsSync} from 'node:fs';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {createBusyChoice, getBusyChoice} from '../../../src/store/busy-choice-store.ts';
import type {BusyChoice} from '../../../src/store/busy-choice.ts';
import {isProCommand} from '../../../src/pro/prompt.ts';
import {BusyComponentError, busyComponentErrorInfo} from '../../../src/runtime/component-worker/busy-errors.ts';
import {authorizedBusyChoice, validateBusyChoice, prepareBusyConfirmationOnly} from '../../../src/runtime/component-worker/busy-preflight.ts';
import {busyReadyMarker, recordConfirmationReady} from '../../../src/runtime/component-worker/confirmation.ts';
const choice = (): BusyChoice => ({choiceId: 'a'.repeat(24), ownerUserId: 2n, channelId: 1n, targetThreadId: 't', prompt: 'ordinary', allowSteer: false, createdAt: 1, expiresAt: 11});
const kind = (name: string) => (error: unknown) => busyComponentErrorInfo(error)?.kind === name;
async function edit(path: string, sql: string) {const db = await openInitialized(path); try {db.exec(sql);} finally {db.close();}}
test('busy state read retains claimed status and never deletes expired row, unlike get helper', async () => {
  await storeFixture(async path => {
    const id = await createBusyChoice(path, {ownerUserId: 2n, channelId: 1n, targetThreadId: 't', prompt: 'ordinary', allowSteer: false, now: 1, timeToLive: 10});
    assert.equal((await state.readBusyChoiceState(path, id, 2))!.claimed, false);
    assert.equal(await state.claimBusyChoice(path, id, 2), true); assert.equal((await state.readBusyChoiceState(path, id, 2))!.claimed, true); assert.equal(await getBusyChoice(path, id, 2), null);
    assert.equal(await state.readBusyChoiceState(path, id, 11), null);
    const db = await openInitialized(path); try {assert.equal(db.prepare('SELECT count(*) AS n FROM busy_choices').get()!.n, 1);} finally {db.close();}
    await getBusyChoice(path, id, 11); const db2 = await openInitialized(path); try {assert.equal(db2.prepare('SELECT count(*) AS n FROM busy_choices').get()!.n, 0);} finally {db2.close();}
  });
});
test('busy row decodes all columns before expiry filtering and distinguishes null claimed_at from zero', async () => {
  await storeFixture(async path => {
    const id = await createBusyChoice(path, {ownerUserId: 2n, channelId: 1n, targetThreadId: null, prompt: 'p', allowSteer: true, now: 1, timeToLive: 10});
    await edit(path, 'UPDATE busy_choices SET claimed_at=0'); const row = (await state.readBusyChoiceState(path, id, 2))!;
    assert.equal(row.claimed, true); assert.equal(row.choice.targetThreadId, null); assert.equal(row.choice.allowSteer, true);
    await edit(path, 'UPDATE busy_choices SET owner_user_id=1.5'); await assert.rejects(state.readBusyChoiceState(path, id, 20), /owner_user_id/);
  });
});
test('read results are detached from storage and claim release uses central state facade', async () => {
  await storeFixture(async path => {
    const id = await createBusyChoice(path, {ownerUserId: 2n, channelId: 1n, targetThreadId: null, prompt: 'p', allowSteer: false, now: 1, timeToLive: 10});
    const row = (await state.readBusyChoiceState(path, id, 2))!; row.choice.prompt = 'changed'; assert.equal((await state.readBusyChoiceState(path, id, 2))!.choice.prompt, 'p');
    await state.claimBusyChoice(path, id, 2); assert.equal(await state.releaseBusyChoiceClaim(path, id), true); assert.equal((await state.readBusyChoiceState(path, id, 2))!.claimed, false);
  });
});
test('busy actor validation preserves user/channel overflow and mismatch ordering', () => {
  assert.throws(() => validateBusyChoice(choice(), 'Queue', 1n << 63n, 1n), kind('IntegerRange'));
  assert.throws(() => validateBusyChoice(choice(), 'Queue', 3n, 1n << 63n), kind('WrongUser'));
  assert.throws(() => validateBusyChoice(choice(), 'Queue', 2n, 1n << 63n), kind('IntegerRange'));
  assert.throws(() => validateBusyChoice(choice(), 'Queue', 2n, 3n), kind('WrongChannel'));
  validateBusyChoice(choice(), 'Queue', 2n, 1n);
});
test('source validator does not invent allowSteer=false or expiry rejection for original snapshot', () => {
  validateBusyChoice({...choice(), expiresAt: 0, allowSteer: false}, 'Steer', 2n, 1n);
  assert.throws(() => validateBusyChoice({...choice(), prompt: '!PrO review this'}, 'Steer', 2n, 1n), kind('ControlNotDispatched'));
  validateBusyChoice({...choice(), prompt: '!pro'}, 'Queue', 2n, 1n);
});
test('Pro predicate uses Rust whitespace and ASCII case on exact first word only', () => {
  for (const text of ['!pro', '!PrO x', '\u0085\t!PRO\nreview x', '!pro\u2028x']) assert.equal(isProCommand(text), true);
  for (const text of ['', '!profile', '\ufeff!pro x', '!ＰＲＯ', '$ask-chatgpt-pro', 'x !pro']) assert.equal(isProCommand(text), false);
});
test('missing or mismatched pre-ACK snapshot cannot be substituted with a current database row', () => {
  assert.throws(() => authorizedBusyChoice({authorizedBusyChoice: null}, choice().choiceId), kind('MissingAuthorizationSnapshot'));
  assert.throws(() => authorizedBusyChoice({authorizedBusyChoice: choice()}, 'other'), kind('MissingAuthorizationSnapshot'));
  const input = choice(), result = authorizedBusyChoice({authorizedBusyChoice: input}, input.choiceId); input.prompt = 'changed'; assert.equal(result.prompt, 'ordinary'); assert.ok(Object.isFrozen(result));
});
test('ConfirmationOnly requires matching ready marker but never reads/creates/claims a busy choice', async () => {
  await storeFixture(async path => {
    const saved = choice(), work = {authorizedBusyChoice: saved, userId: 2n, channelId: 1n}, component = {Busy: {choice_id: saved.choiceId, action: 'Queue' as const}};
    await assert.rejects(prepareBusyConfirmationOnly(work, component, path, () => 2), kind('ActionUnconfirmed'));
    await recordConfirmationReady(path, busyReadyMarker(saved.choiceId, 2n, 1n), 1, 100);
    const plan = await prepareBusyConfirmationOnly(work, component, path, () => 2); assert.equal(plan.content, 'Busy action submitted.');
    const db = await openInitialized(path); try {assert.equal(db.prepare('SELECT count(*) AS n FROM busy_choices').get()!.n, 0);} finally {db.close();}
  });
});
test('ConfirmationOnly rejects wrong actor, Pro steering and nonbusy component before touching store', async () => {
  await storeFixture(async path => {
    const saved = choice(), work = {authorizedBusyChoice: saved, userId: 3n, channelId: 1n};
    await assert.rejects(prepareBusyConfirmationOnly(work, {Busy: {choice_id: saved.choiceId, action: 'Queue'}}, path), kind('WrongUser'));
    await assert.rejects(prepareBusyConfirmationOnly(work, {Input: {thread_id: 't', value: '1'}}, path), kind('ActionUnconfirmed'));
    await assert.rejects(prepareBusyConfirmationOnly({...work, userId: 2n, authorizedBusyChoice: {...saved, prompt: '!pro'}}, {Busy: {choice_id: saved.choiceId, action: 'Steer'}}, path), kind('ControlNotDispatched'));
    assert.equal(existsSync(path), false);
  });
});
test('busy error metadata is owned and never trusts forged prototype or active cause display', () => {
  let calls = 0; const cause = {get message() {calls++; return 'secret';}}; const error = new BusyComponentError('Store', cause);
  assert.equal(error.cause, cause); assert.equal(calls, 0); assert.equal(busyComponentErrorInfo(error)!.kind, 'Store');
  assert.equal(busyComponentErrorInfo(Object.create(BusyComponentError.prototype)), null);
});
