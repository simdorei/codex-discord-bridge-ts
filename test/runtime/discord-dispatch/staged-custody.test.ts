import assert from 'node:assert/strict';
import {test} from 'node:test';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import type {IngressAdmission} from '../../../src/store/ingress-admission.ts';
import type {BusyChoice} from '../../../src/store/busy-choice.ts';
import {StoreIntegrityError} from '../../../src/store/schema-assembly.ts';
import {interactionCustodyFromAdmission as fromAdmission, type CustodyCleanupReport, type CustodyOptions, StagedInteractionCustody} from '../../../src/runtime/discord-dispatch/staged-custody.ts';

const report = (_value: CustodyCleanupReport): void => {};
const options = {now: () => 2, report};
async function admit(path: string) {
  return state.admitIngress(path, {
    ingressId: 'interaction:3', kind: 'interaction', eventId: 3n, applicationId: 4n,
    channelId: 1n, ownerUserId: 2n, sourceMessageId: null,
    payload: {version: 1n, processing_mode: 'normal', work: {Slash: {name: 'help', values: {}}}},
    targetThreadId: null, canonicalOwner: 'interaction:3', now: 1,
  });
}
function created(path: string, admission: IngressAdmission, opts: CustodyOptions = options) {
  const staged = fromAdmission(path, admission, false, opts);
  assert.equal(staged.kind, 'Created');
  if (staged.kind !== 'Created') throw new Error('fixture');
  return staged.custody;
}
const read = (path: string) => state.getIngress(path, 'interaction:3');
async function edit(path: string, sql: string): Promise<void> {
  const db = await openInitialized(path);
  try {db.exec(sql);} finally {db.close();}
}
const choice = (): BusyChoice => ({choiceId: 'a'.repeat(24), ownerUserId: 2n, channelId: 1n,
  targetThreadId: null, prompt: 'original', allowSteer: false, createdAt: 1, expiresAt: 20});

test('actual SQLite staged admission acknowledges once and transfers an immutable token-free receipt', async () => {
  await storeFixture(async path => {
    const admission = await admit(path), custody = created(path, admission);
    const before = (await read(path))!.payload;
    await custody.acknowledge();
    assert.equal((await read(path))!.state, 'acknowledged');
    await assert.rejects(custody.acknowledge(), e => e instanceof StoreIntegrityError && e.message.includes('no longer current'));
    const receipt = custody.intoReceipt();
    assert.deepEqual(receipt, {database: path, ingressId: 'interaction:3', busyChoice: null});
    assert.ok(Object.isFrozen(receipt));
    await custody.dispose();
    assert.equal((await read(path))!.state, 'acknowledged');
    assert.deepEqual((await read(path))!.payload, before);
    assert.throws(() => custody.acknowledge(), /closed/);
  });
});
test('cancellation disposal saves a not-executed hold and one outbox notice', async () => {
  await storeFixture(async path => {
    const custody = created(path, await admit(path));
    const first = custody.dispose(); assert.equal(custody.dispose(), first); await first;
    const record = (await read(path))!;
    assert.equal(record.state, 'held'); assert.equal(record.holdReason, 'interaction_dispatch_cancelled');
    const db = await openInitialized(path);
    try {
      const rows = db.prepare("SELECT content FROM codex_delivery_outbox WHERE delivery_id='ingress-hold:interaction:3'").all();
      assert.equal(rows.length, 1); assert.match(String(rows[0]!.content), /saved but was not executed/);
    } finally {db.close();}
  });
});
test('explicit hold disarms later cancellation cleanup and preserves the selected phase reason', async () => {
  await storeFixture(async path => {
    const custody = created(path, await admit(path));
    await custody.holdNotExecuted('discord_ack_deadline'); await custody.dispose();
    assert.equal((await read(path))!.holdReason, 'discord_ack_deadline');
  });
});
test('dispose waits for an already-started acknowledgement before writing cancellation hold', async () => {
  await storeFixture(async path => {
    const custody = created(path, await admit(path));
    const ack = custody.acknowledge(), cleanup = custody.dispose();
    assert.throws(() => custody.intoReceipt(), /closed|borrowed/);
    await ack; await cleanup;
    const record = (await read(path))!; assert.equal(record.phase, 'acknowledged'); assert.equal(record.state, 'held');
  });
});
test('overlapping mutation and transfer are refused without losing the original operation', async () => {
  await storeFixture(async path => {
    const custody = created(path, await admit(path)), pending = custody.acknowledge();
    assert.throws(() => custody.acknowledge(), /borrowed/);
    assert.throws(() => custody.holdNotExecuted('racing'), /borrowed/);
    assert.throws(() => custody.intoReceipt(), /borrowed/);
    await pending; await custody.dispose(); assert.equal((await read(path))!.state, 'held');
  });
});
test('failed explicit hold remains armed so disposal attempts the cancellation hold', async () => {
  await storeFixture(async path => {
    let calls = 0;
    const custody = created(path, await admit(path), {now: () => ++calls === 1 ? -1 : 2, report});
    await assert.rejects(custody.holdNotExecuted('first'), /timestamp/);
    await custody.dispose(); assert.equal((await read(path))!.holdReason, 'interaction_dispatch_cancelled');
    assert.equal(calls, 2);
  });
});
test('cancellation clock failure is reported without making a DB write or inventing success', async () => {
  await storeFixture(async path => {
    const reports: CustodyCleanupReport[] = [], failure = new Error('clock');
    const custody = created(path, await admit(path), {now: () => {throw failure;}, report: value => {reports.push(value);}});
    await custody.dispose(); await custody.dispose();
    assert.equal((await read(path))!.state, 'staged');
    assert.deepEqual(reports, [{code: 'interaction_custody_cancel_hold_clock_failed', error: failure}]);
  });
});
test('cancellation store failure is reported and the explicit disposer cannot be reused', async () => {
  await storeFixture(async path => {
    const reports: CustodyCleanupReport[] = [];
    const custody = created(path, await admit(path), {now: () => 2, report: value => {reports.push(value);}});
    await edit(path, "DELETE FROM discord_ingress_journal WHERE ingress_id='interaction:3'");
    await custody.dispose(); await custody.dispose();
    assert.equal(reports.length, 1); assert.equal(reports[0]!.code, 'interaction_custody_cancel_hold_failed');
    assert.ok(reports[0]!.error instanceof StoreIntegrityError);
  });
});
test('ordinary duplicate returns without constructing a new cleanup owner or inspecting record', () => {
  let calls = 0;
  const admission = {created: false, canonicalRepeatCreated: false,
    get record() {calls++; throw new Error('record');}, get busyChoice() {calls++; throw new Error('choice');}};
  assert.deepEqual(fromAdmission('not-opened.sqlite', admission as unknown as IngressAdmission, false, options), {kind: 'Duplicate'});
  assert.equal(calls, 0);
});
test('canonical repeat conversion distinguishes prompt/ingress and snapshots existing authorization', async () => {
  await storeFixture(async path => {
    const admission = await admit(path);
    for (const ownerKind of ['prompt', 'ingress']) {
      const busyChoice = choice();
      const result = fromAdmission(path, {...admission, created: false, canonicalRepeatCreated: true,
        record: {...admission.record!, ownerKind}, busyChoice}, true, options);
      assert.equal(result.kind, 'CanonicalRepeat');
      if (result.kind !== 'CanonicalRepeat') throw new Error('fixture');
      assert.equal(result.confirmationReady, ownerKind === 'prompt');
      busyChoice.prompt = 'mutated'; assert.equal(result.receipt.busyChoice!.prompt, 'original');
      assert.ok(Object.isFrozen(result.receipt.busyChoice));
    }
    assert.equal((await read(path))!.state, 'staged');
  });
});
test('missing record, unexpected busy snapshot, and malformed canonical ownership fail closed', async () => {
  await storeFixture(async path => {
    const admission = await admit(path);
    for (const [value, busy, text] of [
      [{...admission, record: null}, false, 'new interaction custody has no durable record'],
      [admission, true, 'busy interaction custody has no frozen authorization snapshot'],
      [{...admission, busyChoice: choice()}, false, 'busy interaction custody has no frozen authorization snapshot'],
      [{...admission, created: false, canonicalRepeatCreated: true}, false, 'non-busy interaction unexpectedly coalesced'],
      [{...admission, created: false, canonicalRepeatCreated: true, record: null}, true, 'canonical interaction repeat has no durable record'],
      [{...admission, created: false, canonicalRepeatCreated: true}, true, 'canonical interaction repeat has no durable owner'],
      [{...admission, created: false, canonicalRepeatCreated: true, record: {...admission.record!, ownerKind: 'prompt'}}, true, 'canonical interaction repeat has no frozen authorization snapshot'],
    ] as const) assert.throws(() => fromAdmission(path, value, busy, options),
      e => e instanceof StoreIntegrityError && e.message.includes(text));
    assert.equal((await read(path))!.state, 'staged');
  });
});
test('guard cannot be constructed without module ownership token', () => {
  assert.throws(() => new StagedInteractionCustody(Symbol(), {database: 'x', ingressId: 'i', busyChoice: null}, options), TypeError);
});
