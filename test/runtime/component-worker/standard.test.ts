import assert from 'node:assert/strict';
import {test} from 'node:test';
import {prepareStandardComponentAction} from '../../../src/runtime/component-worker/standard.ts';
import {appServerClaimFailure, retainOrReleaseComponentClaim} from '../../../src/runtime/component-worker/claim-failure.ts';
import {componentWorkerErrorInfo, actionCompletedBeforeFailure} from '../../../src/runtime/component-worker/errors.ts';
import {standardReadyMarker} from '../../../src/runtime/component-worker/confirmation.ts';
import {requestFingerprint, threadFingerprint, persistentComponentClaimKey, type ComponentId} from '../../../src/discord/components.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {AppServerSpawnError} from '../../../src/app-server/portable-process.ts';
import {ResidentStateError} from '../../../src/app-server/resident-state.ts';
import {AppServerRequestError} from '../../../src/app-server/request-client.ts';
import {ServerResponseStateError, type PendingServerRequest} from '../../../src/app-server/server-request-state.ts';
import {AppServerClosedError} from '../../../src/app-server/client-errors.ts';
import {promptFixture, callPromptFixture, editPromptFixture} from '../../helpers/server-prompt-fixture.ts';
import {storeFixture} from '../../helpers/store-fixture.ts';
const work = {sourceMessageId: 9n, channelId: 1n, userId: 2n};
const component = (r: PendingServerRequest, input = false): ComponentId => {
  const fields = {thread_fingerprint: threadFingerprint('t'), request_fingerprint: requestFingerprint(1n, r.occurrence.asBytes(), r.id)};
  return input ? {BoundInput: {...fields, value: '1'}} : {BoundApproval: {...fields, answer: 'Approve'}};
};
const claim = (c: ComponentId, user = 2n, channel = 1n) => `actor-v1:${persistentComponentClaimKey(9n, c)}:${user}:${channel}`;
const kind = (k: string) => (e: unknown) => componentWorkerErrorInfo(e)?.kind === k;
test('owned app-server release allowlist rejects forged prototypes and retains unknown/cancelled errors', () => {
  const release = [new AppServerSpawnError('fixture', null), new AppServerRequestError({kind: 'Remote', method: 'm', code: -1n, message: 'fixture', data: null}), new ResidentStateError({kind: 'GenerationMismatch', expected: 1n, actual: 2n}), new ResidentStateError({kind: 'GenerationQuarantined', generation: 1n}), new ServerResponseStateError('StaleServerRequest', 'r')];
  for (const e of release) {assert.equal(appServerClaimFailure(e), 'Release'); assert.equal(appServerClaimFailure(Object.create(Object.getPrototypeOf(e))), 'RetainIndeterminate');}
  for (const e of [new AppServerClosedError(), new ServerResponseStateError('ServerRequestResponseIndeterminate', 'r'), new ServerResponseStateError('ServerRequestResponseInFlight', 'r'), new Error('Remote'), {kind: 'StaleServerRequest'}, new AppServerRequestError({kind: 'Timeout', method: 'm', timeoutMs: 1})]) assert.equal(appServerClaimFailure(e), 'RetainIndeterminate');
  let hooks = 0; assert.equal(appServerClaimFailure(new Proxy({}, {get() {hooks++; throw Error();}})), 'RetainIndeterminate'); assert.equal(hooks, 0);
});
test('persistent failure disposition releases only definite rejection and leaves unknown claim intact', async () => storeFixture(async db => {
  await state.claimComponent(db, 'definite', 1, 100); await state.claimComponent(db, 'unknown', 1, 100);
  assert.equal(await retainOrReleaseComponentClaim(db, 'definite', new ServerResponseStateError('StaleServerRequest', 'r')), 'Release');
  assert.equal(await retainOrReleaseComponentClaim(db, 'unknown', new Error('untyped')), 'RetainIndeterminate');
  assert.equal(await state.isComponentClaimLive(db, 'definite', 2), false); assert.equal(await state.isComponentClaimLive(db, 'unknown', 2), true);
}));
test('native bound approval submits once and writes actor-specific confirmation marker; retry returns plan only', async () => {
  await promptFixture(async (db, server, r) => {
    const c = component(r), first = await prepareStandardComponentAction(work, c, db, server, () => 100);
    assert.equal(first.content, 'Approval response submitted.'); assert.equal(await state.isComponentClaimLive(db, standardReadyMarker(claim(c)), 100), true);
    assert.deepEqual(await callPromptFixture(server, 'answers'), [{id: 'approval', result: {decision: 'accept'}}]);
    assert.deepEqual(await prepareStandardComponentAction(work, c, db, server, () => 101), first);
    assert.equal((await callPromptFixture(server, 'answers') as unknown[]).length, 1);
    await assert.rejects(prepareStandardComponentAction({...work, userId: 3n}, c, db, server, () => 101), kind('NoPendingRequest'));
    assert.equal(await state.isComponentClaimLive(db, claim(c, 3n), 101), false);
  }, {enableResponses: true});
});
test('native bound input uses its exact pending occurrence and records generic confirmation after write', async () => {
  await promptFixture(async (db, server, r) => {
    const plan = await prepareStandardComponentAction(work, component(r, true), db, server, () => 100);
    assert.equal(plan.content, 'Codex input choice submitted.'); assert.deepEqual(await callPromptFixture(server, 'answers'), [{id: 'approval', result: {answers: {q: {answers: ['One']}}}}]);
  }, {enableResponses: true, method: 'item/tool/requestUserInput', params: {threadId: 't', turnId: 'v', questions: [{id: 'q', options: [{label: 'One'}]}]}});
});
test('existing action claim without ready marker never retries server response', async () => {
  await promptFixture(async (db, server, r) => {
    const c = component(r); await state.claimComponent(db, claim(c), 100, 1800);
    await assert.rejects(prepareStandardComponentAction(work, c, db, server, () => 101), kind('ActionUnconfirmed'));
    assert.deepEqual(await callPromptFixture(server, 'answers'), []);
  }, {enableResponses: true});
});
test('concurrent identical clicks emit at most one native response and never release an uncertain competing claim', async () => {
  await promptFixture(async (db, server, r) => {
    const c = component(r), results = await Promise.allSettled([prepareStandardComponentAction(work, c, db, server, () => 100), prepareStandardComponentAction(work, c, db, server, () => 100)]);
    assert.ok(results.some(r => r.status === 'fulfilled'));
    for (const r of results) if (r.status === 'rejected') assert.ok(kind('ActionUnconfirmed')(r.reason));
    assert.equal((await callPromptFixture(server, 'answers') as unknown[]).length, 1); assert.equal(await state.isComponentClaimLive(db, claim(c), 100), true);
  }, {enableResponses: true});
});
test('wrong actor authority releases only its own claim and leaves correct actor eligible', async () => {
  await promptFixture(async (db, server, r) => {
    const c = component(r);
    await assert.rejects(prepareStandardComponentAction({...work, userId: 3n}, c, db, server, () => 100), kind('Authority'));
    assert.equal(await state.isComponentClaimLive(db, claim(c, 3n), 100), false); assert.deepEqual(await callPromptFixture(server, 'answers'), []);
    await prepareStandardComponentAction(work, c, db, server, () => 100); assert.equal((await callPromptFixture(server, 'answers') as unknown[]).length, 1);
  }, {enableResponses: true});
});
test('missing source precedes legacy expiry, and legacy buttons never acquire claims', async () => {
  const legacy: ComponentId = {Approval: {thread_id: 't', answer: 'Approve'}};
  await assert.rejects(prepareStandardComponentAction({...work, sourceMessageId: null}, legacy, '/unused', null as any), kind('MissingSourceMessage'));
  await assert.rejects(prepareStandardComponentAction(work, legacy, '/unused', null as any), kind('LegacyComponentExpired'));
  await assert.rejects(prepareStandardComponentAction(work, {Busy: {choice_id: 'x', action: 'Queue'}}, '/unused', null as any), kind('BusyChoice'));
});
test('post-submit clock failure keeps action claim, reports known completion and never replays', async () => {
  await promptFixture(async (db, server, r) => {
    const c = component(r); let calls = 0;
    await assert.rejects(prepareStandardComponentAction(work, c, db, server, () => {if (++calls === 2) throw new Error('clock fixture'); return 100;}), actionCompletedBeforeFailure);
    assert.equal((await callPromptFixture(server, 'answers') as unknown[]).length, 1);
    assert.equal(await state.isComponentClaimLive(db, claim(c), 101), true); assert.equal(await state.isComponentClaimLive(db, standardReadyMarker(claim(c)), 101), false);
    await assert.rejects(prepareStandardComponentAction(work, c, db, server, () => 101), kind('ActionUnconfirmed'));
  }, {enableResponses: true});
});
test('failed ready-marker persistence after native submission retains completed action and no replay', async () => {
  await promptFixture(async (db, server, r) => {
    await editPromptFixture(db, "CREATE TRIGGER block_ready BEFORE INSERT ON persistent_component_claims WHEN NEW.claim_key LIKE 'confirmation-ready:%' BEGIN SELECT RAISE(ABORT,'ready fixture'); END");
    const c = component(r); await assert.rejects(prepareStandardComponentAction(work, c, db, server, () => 100), actionCompletedBeforeFailure);
    assert.equal((await callPromptFixture(server, 'answers') as unknown[]).length, 1); assert.equal(await state.isComponentClaimLive(db, claim(c), 101), true);
  }, {enableResponses: true});
});
test('missing response adapter remains conservatively indeterminate with no claimed retry', async () => {
  await promptFixture(async (db, server, r) => {
    const c = component(r); await assert.rejects(prepareStandardComponentAction(work, c, db, server, () => 100), kind('ActionOutcomeIndeterminate'));
    assert.equal(await state.isComponentClaimLive(db, claim(c), 101), true); assert.deepEqual(await callPromptFixture(server, 'answers'), []);
    await assert.rejects(prepareStandardComponentAction(work, c, db, server, () => 101), kind('ActionUnconfirmed'));
  });
});
