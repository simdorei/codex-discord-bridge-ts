import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {setImmediate as tick} from 'node:timers/promises';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {DiscordChannelClient} from '../../../src/discord/channel-client.ts';
import {DiscordResponseEngine, type DiscordWireRequest} from '../../../src/discord/response-engine.ts';
import {NodeDiscordHttpWire} from '../../../src/discord/node-http-wire.ts';
import {DiscordChannelRateState} from '../../../src/discord/channel-rate-state.ts';
import {DiscordChannelRateLimiter} from '../../../src/discord/rate-header-adapter.ts';
import {clearMessageComponentsRequest, messageComponentClearResource} from '../../../src/discord/message-component-clear-request.ts';
import {busyConfirmationPlan, confirmationErrorInfo} from '../../../src/runtime/component-worker/confirmation.ts';
import {sendThenClear, deliverConfirmationAndClear} from '../../../src/runtime/component-worker/confirmation-delivery.ts';
async function fixture(run: (path: string, client: DiscordChannelClient, seen: {method: string; url: string; body: string}[]) => Promise<void>, status: (method: string, count: number) => number = () => 200) {
  await storeFixture(async path => {
    const seen: {method: string; url: string; body: string}[] = [], tasks: Promise<void>[] = [], errors: unknown[] = [];
    const server = createServer((req, res) => {let body = ''; req.on('data', b => {body += b;}); req.on('end', () => {
      seen.push({method: req.method!, url: req.url!, body}); tasks.push(Promise.resolve().then(async () => {
        if (req.method === 'PATCH') {const db = await openInitialized(path); try {assert.equal(db.prepare('SELECT count(*) AS n FROM codex_delivery_receipts WHERE message_id IS NOT NULL').get()!.n, 1);} finally {db.close();}}
        res.statusCode = status(req.method!, seen.length);
        if (res.statusCode >= 400) res.end('{"code":50035,"message":"offline"}');
        else if (req.method === 'PATCH') {res.write('{'); res.end();}
        else res.end(JSON.stringify({attachments: [], author: {id: '1', username: 'u', discriminator: '0'}, channel_id: '1', content: '', embeds: [], id: '100', type: 0, mention_everyone: false, mention_roles: [], mentions: [], pinned: false, timestamp: '2020-01-01T00:00:00+00:00', tts: false}));
      }).catch(error => {errors.push(error); res.statusCode = 500; res.end('{}');}));
    });});
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const client = await DiscordChannelClient.create({token: null, testOrigin: `http://127.0.0.1:${(server.address() as {port: number}).port}/api/v10/`, report: () => {}});
    try {await run(path, client, seen); await Promise.all(tasks); assert.deepEqual(errors, []);} finally {await client.close(); await Promise.all(tasks); server.closeAllConnections();
      await new Promise<void>((r, j) => server.close(e => e ? j(e) : r())); assert.equal(client.activeRequests, 0); assert.equal(client.ownedSockets, 0);}
  });
}
test('send-then-clear uses lazy operations and never starts clear before fulfilled send', async () => {
  let finish!: () => void; const order: string[] = [], send = new Promise<void>(r => {finish = r;});
  const task = sendThenClear(() => {order.push('send'); return send;}, async () => {order.push('clear');});
  await tick(); assert.deepEqual(order, ['send']); finish(); await task; assert.deepEqual(order, ['send', 'clear']);
  const reason = new Error('send failed'); await assert.rejects(sendThenClear(async () => {throw reason;}, async () => {throw new Error('must not clear');}), e => e === reason);
});
test('native confirmation persists receipt before exact components-only PATCH', async () => {
  await fixture(async (path, client, seen) => {
    await deliverConfirmationAndClear(client, path, 1n, 2n, busyConfirmationPlan('choice'));
    assert.deepEqual(seen.map(v => v.method), ['POST', 'PATCH']); assert.equal(seen[1]!.url, '/api/v10/channels/1/messages/2'); assert.equal(seen[1]!.body, '{"components":[]}');
  });
});
test('clear failure retries only clear while delivered confirmation skips repeat POST', async () => {
  await fixture(async (path, client, seen) => {const plan = busyConfirmationPlan('choice');
    await assert.rejects(deliverConfirmationAndClear(client, path, 1n, 2n, plan), e => confirmationErrorInfo(e)?.kind === 'Clear');
    await deliverConfirmationAndClear(client, path, 1n, 2n, plan); assert.deepEqual(seen.map(v => v.method), ['POST', 'PATCH', 'PATCH']);
  }, (method, count) => method === 'PATCH' && count === 2 ? 400 : 200);
});
test('confirmation rejection never clears original buttons or retries blocked POST', async () => {
  await fixture(async (path, client, seen) => {const plan = busyConfirmationPlan('choice');
    for (let i = 0; i < 2; i++) await assert.rejects(deliverConfirmationAndClear(client, path, 1n, 2n, plan), e => confirmationErrorInfo(e)?.kind === 'Delivery');
    assert.deepEqual(seen.map(v => v.method), ['POST']);
  }, () => 400);
});
test('absent source message confirms without any PATCH; forged plans cannot send', async () => {
  await fixture(async (path, client, seen) => {const plan = busyConfirmationPlan('choice');
    await assert.rejects(deliverConfirmationAndClear(client, path, 1n, 2n, {...plan}), TypeError); assert.equal(seen.length, 0);
    await deliverConfirmationAndClear(client, path, 1n, null, plan); assert.deepEqual(seen.map(v => v.method), ['POST']);
  });
});
test('clear request profile rejects noncanonical IDs/paths and preserves exact source body', async () => {
  assert.deepEqual(clearMessageComponentsRequest(1n, 2n), {method: 'PATCH', path: 'channels/1/messages/2', body: '{"components":[]}'});
  for (const path of ['channels/01/messages/2', 'channels/1/messages/0', 'channels/1/messages/2\n', 'channels/1/messages/2?x', 'channels/1/messages/@original']) assert.equal(messageComponentClearResource(path), null);
  assert.throws(() => clearMessageComponentsRequest(1n, 0n));
  const wire = new NodeDiscordHttpWire('http://127.0.0.1:9/api/v10/'), rate = new DiscordChannelRateLimiter({report: () => {}}), signal = new AbortController().signal;
  try {
    await assert.rejects(wire.request({method: 'POST', path: 'channels/1/messages/2', body: '{"components":[]}', authorization: null}, 1000, signal));
    await assert.rejects(wire.request({method: 'PATCH', path: 'channels/1/messages/2', body: '{"content":"changed"}', authorization: null}, 1000, signal));
    await assert.rejects(rate.acquire('POST', 'channels/1/messages/2', signal).then(permit => {permit.release();}));
  } finally {await Promise.all([wire.close(), rate.close()]);}
});
test('channel clear is not global-exempt and shares channel resource with message creation', async () => {
  let now = 0; const timers = new Map<number, () => void>(); let next = 0;
  const rate = new DiscordChannelRateState(1, {now: () => now, schedule(at, callback) {const id = ++next; timers.set(id, () => {if (at <= now) {timers.delete(id); callback();}}); return () => {timers.delete(id);};}}), signal = new AbortController().signal;
  const first = await rate.acquire('channels/1/messages', signal); first.complete(null);
  let granted = false; const pending = rate.acquire('channels/1/messages/2', signal).then(p => {granted = true; return p;});
  await tick(); assert.equal(granted, false); now = 1000; for (const callback of [...timers.values()]) callback();
  const clear = await pending; clear.complete(null); await rate.close(); assert.equal(timers.size, 0);
  const other = new DiscordChannelRateState(), p = await other.acquire('channels/1/messages', signal); let sameGranted = false;
  const same = other.acquire('channels/1/messages/2', signal).then(v => {sameGranted = true; return v;});
  const different = await other.acquire('channels/2/messages/2', signal); await tick(); assert.equal(sameGranted, false);
  p.complete(null); (await same).complete(null); different.complete(null); await other.close();
});
test('clear carries configured Bot authorization and401 invalidates that owner', async () => {
  const seen: DiscordWireRequest[] = [];
  const engine = new DiscordResponseEngine({token: 'offline-fixture', decoder: {decode: () => 1n}, rateLimiter: {acquire: async () => ({complete() {}, release() {}})},
    wire: {request: async request => {seen.push(request); return {status: 401, headers: new Map(), bytes: async () => Buffer.from('{}'), release: async () => {}};}}});
  try {await assert.rejects(engine.clearMessageComponents(1n, 2n)); assert.equal(seen[0]!.authorization, 'Bot offline-fixture'); assert.equal(engine.authorizationInvalidated, true);
    await assert.rejects(engine.clearMessageComponents(1n, 2n), /invalidated/); assert.equal(seen.length, 1);
  } finally {await engine.close();}
});
