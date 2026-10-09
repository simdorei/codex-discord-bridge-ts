import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {serializeSerdeValue as json} from '../../../src/core/serde-json.ts';
import {newReplyAcknowledgementKey} from '../../../src/store/new-reply-claims.ts';
import {receiptHash} from '../../../src/store/delivery-receipt-key.ts';
import {DiscordChannelClient} from '../../../src/discord/channel-client.ts';
import {deliverNewReply} from '../../../src/runtime/interaction-worker/new-reply-delivery.ts';
import {DeliveryFailure} from '../../../src/discord/delivery.ts';
import type {InboundInteractionWork} from '../../../src/runtime/discord-dispatch/interaction-work.ts';
const work = () => ({applicationId: 4n, interactionId: 3n, interactionToken: 'offline_token', custodyIngressId: 'original'}) as InboundInteractionWork;
const result = () => ({text: 'accepted', ui: null});
async function seed(path: string) {
  await state.admitIngress(path, {ingressId: 'original', kind: 'interaction', eventId: 3n, applicationId: 4n, channelId: 1n,
    ownerUserId: 2n, sourceMessageId: null, payload: {}, targetThreadId: 'target', canonicalOwner: null, now: 1});
  const identity = {ingress_id: 'original', job_id: 'job', thread_id: 'target', cwd: 'C:/work', state_db: 'C:/state.db', channel_id: 2n,
    origin_channel_id: 1n, event_id: 3n, kind: 'interaction', creation_generation: 1n, prompt_sha256: 'a'.repeat(64), acknowledgement: 'accepted'};
  const db = await openInitialized(path); try {
    db.prepare("UPDATE discord_ingress_journal SET state='owned',phase='durable_prompt',owner_kind='prompt',owner_id='job',outcome_json=?").run(json({new_creation: {version: 1n, cwd: 'C:/work'}, new_verification: {thread_id: 'target', channel_id: 2n, prompt_sha256: 'a'.repeat(64)}}));
    db.exec("INSERT INTO mirror_threads VALUES ('target','p','title',1,2,1)");
    db.prepare("INSERT INTO codex_new_first_replies(job_id,ingress_id,identity_json,turn_id,state,warning_due) VALUES ('job','original',?,'turn','verified',1)").run(json(identity));
  } finally {db.close();}
}
async function edit(path: string, sql: string) {const db = await openInitialized(path); try {db.exec(sql);} finally {db.close();}}
async function fixture(run: (path: string, client: DiscordChannelClient, requests: {method: string; url: string; body: any}[]) => Promise<void>, status = 204, seeded = true) {
  await storeFixture(async path => {
    if (seeded) await seed(path);
    const requests: {method: string; url: string; body: any}[] = [];
    const server = createServer((req, res) => {let body = ''; req.on('data', b => {body += b;}); req.on('end', () => {
      requests.push({method: req.method!, url: req.url!, body: JSON.parse(body)}); res.statusCode = status; res.end(status >= 400 ? '{"code":50035,"message":"offline failure"}' : '');
    });});
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const client = await DiscordChannelClient.create({token: null, testOrigin: `http://127.0.0.1:${(server.address() as {port: number}).port}/api/v10/`, report: () => {}});
    try {await run(path, client, requests);} finally {await client.close(); server.closeAllConnections(); await new Promise<void>((r, j) => server.close(e => e ? j(e) : r()));
      assert.equal(client.activeRequests, 0); assert.equal(client.ownedSockets, 0);}
  });
}
test('absence returns false, while central lookup preserves decoded original identity', async () => {
  await fixture(async (path, client, requests) => {assert.equal(await deliverNewReply(client, work(), result(), path), false); assert.equal(requests.length, 0);}, 204, false);
  await fixture(async path => {const row = await state.getNewReplyByIngress(path, 'original'); assert.ok(row); assert.equal(row.identity.kind, 'interaction'); assert.equal(row.identity.event_id, 3n);
    assert.equal(await state.getNewReplyByIngress(path, 'missing'), null);
  });
});
test('one PATCH confirms durable initial-response identity; repeated delivery never sends again', async () => {
  await fixture(async (path, client, requests) => {
    assert.equal(await deliverNewReply(client, work(), result(), path), true);
    assert.equal(await deliverNewReply(client, work(), result(), path), true); assert.equal(requests.length, 1);
    assert.deepEqual(requests[0], {method: 'PATCH', url: '/api/v10/webhooks/4/offline_token/messages/@original', body: {allowed_mentions: {parse: []}, content: 'accepted'}});
    const record = (await state.getNewReplyByIngress(path, 'original'))!; assert.equal(record.confirmationDelivered, true);
    const receipt = await state.beginDeliveryReceipt(path, newReplyAcknowledgementKey(record), receiptHash('accepted'));
    assert.deepEqual(receipt, {kind: 'Delivered', messageId: 'initial-response/3'});
  });
});
test('changed text or any UI rejects before receipt or HTTP', async () => {
  await fixture(async (path, client, requests) => {
    await assert.rejects(deliverNewReply(client, work(), {text: 'changed', ui: null}, path), /PATCH refused/);
    await assert.rejects(deliverNewReply(client, work(), {text: 'accepted', ui: {}}, path), /PATCH refused/);
    assert.equal(requests.length, 0); assert.equal(await state.unknownDeliveryReceiptCount(path), 0n);
  });
});
test('failed PATCH has one application attempt and unknown receipt prevents another send', async () => {
  await fixture(async (path, client, requests) => {
    await assert.rejects(deliverNewReply(client, work(), result(), path), error => {assert.ok(error instanceof DeliveryFailure); assert.equal(error.part, 1); assert.equal(error.totalParts, 1); assert.equal(error.attempts, 1); return true;});
    await assert.rejects(deliverNewReply(client, work(), result(), path), /retained without retry: Unknown/);
    assert.equal(requests.length, 1); assert.equal(await state.unknownDeliveryReceiptCount(path), 1n);
  }, 400);
});
test('preexisting unknown/conflicting/blocked receipt does not reach network', async () => {
  for (const kind of ['Unknown', 'ContentConflict', 'RejectedBlocked'] as const) await fixture(async (path, client, requests) => {
    const record = (await state.getNewReplyByIngress(path, 'original'))!, key = newReplyAcknowledgementKey(record);
    await state.beginDeliveryReceipt(path, key, receiptHash('accepted'));
    if (kind === 'ContentConflict') {const db = await openInitialized(path); try {db.prepare('UPDATE codex_delivery_receipts SET content_hash=? WHERE receipt_key=?').run('changed', key);} finally {db.close();}}
    if (kind === 'RejectedBlocked') await state.blockRejectedDelivery(path, key, 'blocked');
    await assert.rejects(deliverNewReply(client, work(), result(), path), new RegExp('retained without retry: ' + kind)); assert.equal(requests.length, 0);
  });
});
test('uncertain first turn remains Held without creating an intent', async () => {
  await fixture(async (path, client, requests) => {await edit(path, 'UPDATE codex_new_first_replies SET turn_id=NULL');
    await assert.rejects(deliverNewReply(client, work(), result(), path), /retained without retry: Held/);
    assert.equal(requests.length, 0); assert.equal(await state.unknownDeliveryReceiptCount(path), 0n);
  });
});
test('HTTP success with failed confirmation preserves unknown receipt and refuses retry', async () => {
  await fixture(async (path, client, requests) => {
    await edit(path, "CREATE TRIGGER fail_confirm BEFORE UPDATE OF message_id ON codex_delivery_receipts BEGIN SELECT RAISE(ABORT,'fixture confirmation failure'); END");
    await assert.rejects(deliverNewReply(client, work(), result(), path), /fixture confirmation failure/); assert.equal(requests.length, 1);
    await assert.rejects(deliverNewReply(client, work(), result(), path), /retained without retry: Unknown/); assert.equal(requests.length, 1);
    assert.equal((await state.getNewReplyByIngress(path, 'original'))!.confirmationDelivered, false);
  });
});
test('identity or original room mapping drift prevents receipt acquisition and send', async () => {
  await fixture(async (path, client, requests) => {await edit(path, "UPDATE mirror_threads SET codex_thread_id='changed'");
    await assert.rejects(deliverNewReply(client, work(), result(), path), /evidence or original room mapping changed/); assert.equal(requests.length, 0);
  });
});
test('caller result and delivery identity are captured before async lookup', async () => {
  await fixture(async (path, client, requests) => {const item = {...work()}, action = {...result()}; const pending = deliverNewReply(client, item, action, path);
    item.interactionId = 99n; item.interactionToken = 'changed'; action.text = 'changed'; await pending;
    assert.equal(requests[0]!.url, '/api/v10/webhooks/4/offline_token/messages/@original');
    const record = (await state.getNewReplyByIngress(path, 'original'))!;
    assert.deepEqual(await state.beginDeliveryReceipt(path, newReplyAcknowledgementKey(record), receiptHash('accepted')), {kind: 'Delivered', messageId: 'initial-response/3'});
  });
});
test('central ingress lookup rejects malformed Unicode instead of aliasing another key', async () => {
  await fixture(async path => {
    assert.throws(() => state.getNewReplyByIngress(path, '\ud800'), /malformed Unicode/);
    assert.throws(() => state.getNewReplyByIngress(path, 3 as unknown as string), TypeError);
    assert.equal(await state.getNewReplyByIngress(path, ''), null);
  });
});
