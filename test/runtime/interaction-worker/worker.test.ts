import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setImmediate as tick} from 'node:timers/promises';
import {runInteractionWorker, type InteractionProcessor} from '../../../src/runtime/interaction-worker/worker.ts';
import {createInteractionWorkQueue} from '../../../src/runtime/discord-dispatch/interaction-work.ts';
import {AdmissionGate} from '../../../src/admission/drain-gate.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {InteractionWorkerError} from '../../../src/runtime/interaction-worker/errors.ts';
import {ComponentWorkerError} from '../../../src/runtime/component-worker/errors.ts';
import {prepareStandardComponentAction} from '../../../src/runtime/component-worker/standard.ts';
import {deliverConfirmationAndClear} from '../../../src/runtime/component-worker/confirmation-delivery.ts';
import {threadFingerprint, requestFingerprint} from '../../../src/discord/components.ts';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {promptFixture, callPromptFixture} from '../../helpers/server-prompt-fixture.ts';
import {work, stage, enqueue, httpFixture, fence, edit} from '../../helpers/interaction-worker-fixture.ts';
test('worker drains FIFO, preserves recorded results and releases permits only after joined processing', async () => {
  await storeFixture(async db => {
    const q = createInteractionWorkQueue(), gate = new AdmissionGate(), f = fence(), a = work(db, 3n, gate), b = work(db, 4n, gate); await stage(a); await stage(b); enqueue(q, a); enqueue(q, b); q.sender.dispose(); gate.seal(f);
    let release!: () => void, entered!: () => void; const blocked = new Promise<void>(r => {release = r;}), started = new Promise<void>(r => {entered = r;}); const order: bigint[] = []; let notified = 0;
    const operation = runInteractionWorker(q, db, null as any, {async process(w, custody) {order.push(w.interactionId); await custody.recordResult({kind: 'fixture', id: w.interactionId}); if (w.interactionId === 3n) {entered(); await blocked;} return true;}, notifyDeliveryReady() {notified++;}, report() {}});
    await started; assert.equal(gate.isDrainedFor(f), false); assert.deepEqual(order, [3n]); release(); await operation;
    assert.deepEqual(order, [3n, 4n]); assert.equal(notified, 2); assert.equal(gate.isDrainedFor(f), true); assert.equal(q.snapshot().receiverDisposed, true);
    for (const w of [a, b]) {const row = (await state.getIngress(db, w.custodyIngressId))!; assert.equal(row.confirmationDelivered, true); assert.deepEqual(row.outcome, {kind: 'fixture', id: w.interactionId});}
  });
});
test('missing explicit processor result record gets source generic success outcome', async () => {
  await storeFixture(async db => {
    const q = createInteractionWorkQueue(), gate = new AdmissionGate(), w = work(db, 3n, gate); await stage(w); enqueue(q, w); q.sender.dispose();
    await runInteractionWorker(q, db, null as any, {async process() {return false;}, notifyDeliveryReady() {}, report() {}});
    assert.deepEqual((await state.getIngress(db, w.custodyIngressId))!.outcome, {kind: 'interaction', action_completed: true, waits_for_final: false});
  });
});
test('processor failure persists unknown hold, joins error delivery, and continues next item', async () => {
  await storeFixture(async db => httpFixture(async (http, seen) => {
    const q = createInteractionWorkQueue(), gate = new AdmissionGate(), f = fence(), a = work(db, 3n, gate), b = work(db, 4n, gate); for (const w of [a,b]) {await stage(w); enqueue(q,w);} q.sender.dispose(); gate.seal(f); let notify = 0;
    await runInteractionWorker(q, db, http, {async process(w) {if (w.interactionId === 3n) throw new InteractionWorkerError('Action', 'fixture'); return false;}, notifyDeliveryReady() {notify++;}, report() {}});
    assert.deepEqual(seen, ['PATCH']); assert.equal((await state.getIngress(db, a.custodyIngressId))!.holdReason, 'interaction_processing_failed'); assert.equal((await state.getIngress(db, a.custodyIngressId))!.confirmationDelivered, false);
    assert.equal((await state.getIngress(db, b.custodyIngressId))!.confirmationDelivered, true); assert.equal(notify, 1); assert.equal(gate.isDrainedFor(f), true);
  }));
});
test('custody begin failure never calls processor, reports once and releases permit', async () => {
  await storeFixture(async db => httpFixture(async (http, seen) => {
    await edit(db, 'SELECT 1'); const q = createInteractionWorkQueue(), gate = new AdmissionGate(), f = fence(); enqueue(q, work(db, 3n, gate)); q.sender.dispose(); gate.seal(f); let processed = 0;
    await runInteractionWorker(q, db, http, {async process() {processed++; return false;}, notifyDeliveryReady() {throw Error('unexpected');}, report() {}});
    assert.equal(processed, 0); assert.deepEqual(seen, ['PATCH']); assert.equal(gate.isDrainedFor(f), true);
  }));
});
test('confirmation write failure retains known result, suppresses notify and joins report', async () => {
  await storeFixture(async db => httpFixture(async (http, seen) => {
    const q = createInteractionWorkQueue(), gate = new AdmissionGate(), w = work(db, 3n, gate); await stage(w); enqueue(q, w); q.sender.dispose();
    await edit(db, "CREATE TRIGGER fail_confirm BEFORE UPDATE OF confirmation_delivered ON discord_ingress_journal WHEN NEW.confirmation_delivered=1 BEGIN SELECT RAISE(ABORT,'fixture'); END");
    let notified = 0; await runInteractionWorker(q, db, http, {async process(_w, c) {await c.recordResult({action_completed: true}); return false;}, notifyDeliveryReady() {notified++;}, report() {}});
    assert.equal(notified, 0); assert.deepEqual(seen, ['PATCH']); const row = (await state.getIngress(db, w.custodyIngressId))!; assert.equal(row.state, 'completed'); assert.equal(row.confirmationDelivered, false); assert.deepEqual(row.outcome, {action_completed: true});
  }));
});
test('uncertain component error is held and logged but does not send a misleading fresh Discord error', async () => {
  await storeFixture(async db => {
    const q = createInteractionWorkQueue(), gate = new AdmissionGate(), w = work(db, 3n, gate, 'codex_approval:t:1'); await stage(w); enqueue(q, w); q.sender.dispose(); const logs: string[] = [];
    await runInteractionWorker(q, db, null as any, {async process() {throw new ComponentWorkerError('ActionUnconfirmed');}, notifyDeliveryReady() {throw Error('unexpected');}, report(code) {logs.push(code);}});
    assert.deepEqual(logs, ['interaction_notification_recovery_error']); assert.equal((await state.getIngress(db, w.custodyIngressId))!.state, 'held');
  });
});
test('fatal synchronous notification failure still disposes received custody and buffered permit owners', async () => {
  await storeFixture(async db => {
    const q = createInteractionWorkQueue(), gate = new AdmissionGate(), f = fence(), a = work(db, 3n, gate), b = work(db, 4n, gate); for (const w of [a,b]) {await stage(w); enqueue(q,w);} q.sender.dispose(); gate.seal(f); const sentinel = new Error('notify fixture'); let calls = 0;
    await assert.rejects(runInteractionWorker(q, db, null as any, {async process() {calls++; return false;}, notifyDeliveryReady() {throw sentinel;}, report() {}}), e => e === sentinel);
    assert.equal(calls, 1); assert.equal(gate.isDrainedFor(f), true); assert.equal(q.snapshot().queued, 0); assert.equal((await state.getIngress(db, b.custodyIngressId))!.phase, 'acknowledged');
  });
});
test('processor callbacks are pinned before receive and cannot be replaced during an active wait', async () => {
  await storeFixture(async db => {
    const q = createInteractionWorkQueue(), gate = new AdmissionGate(), w = work(db, 3n, gate); await stage(w); let original = 0;
    const processor: InteractionProcessor = {async process() {original++; return false;}, notifyDeliveryReady() {}, report() {}};
    const operation = runInteractionWorker(q, db, null as any, processor); processor.process = async () => {throw Error('changed');}; await tick(); enqueue(q, w); q.sender.dispose(); await operation; assert.equal(original, 1);
  });
});
test('native bound response, durable action result, confirmation receipt and source-button clear join in one worker item', async () => {
  await promptFixture(async (db, server, request) => httpFixture(async (http, seen) => {
    const custom = `codex_approval:v2:${threadFingerprint('t')}:${requestFingerprint(1n,request.occurrence.asBytes(),request.id)}:1`;
    const q = createInteractionWorkQueue(), gate = new AdmissionGate(), f = fence(), w = work(db, 3n, gate, custom); await stage(w); enqueue(q,w); q.sender.dispose(); gate.seal(f); let notify = 0;
    await runInteractionWorker(q, db, http, {async process(item, custody) {
      assert.ok('Component' in item.work); const plan = await prepareStandardComponentAction(item, item.work.Component, db, server);
      await custody.recordResult({kind: 'component', action_completed: true}); await deliverConfirmationAndClear(http, db, item.channelId, item.sourceMessageId, plan); return false;
    }, notifyDeliveryReady() {notify++;}, report() {}});
    assert.deepEqual(await callPromptFixture(server, 'answers'), [{id: 'approval', result: {decision: 'accept'}}]); assert.deepEqual(seen, ['POST','PATCH']);
    assert.equal((await state.getIngress(db, w.custodyIngressId))!.confirmationDelivered, true); assert.equal(notify, 1); assert.equal(gate.isDrainedFor(f), true);
  }), {enableResponses: true});
});
