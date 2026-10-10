import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {setImmediate as tick} from 'node:timers/promises';
import {DiscordChannelClient} from '../../../src/discord/channel-client.ts';
import {deliverInteractionTextIdempotent, INTERACTION_FOLLOWUP_DOMAIN, INTERACTION_ERROR_DOMAIN} from '../../../src/runtime/interaction-worker/text-delivery.ts';
import type {InboundInteractionWork} from '../../../src/runtime/discord-dispatch/interaction-work.ts';
import {splitDeliveryChunks} from '../../../src/discord/text.ts';
import {idempotentMessageRequest} from '../../../src/discord/idempotent-message.ts';
import {DeliveryFailure} from '../../../src/discord/delivery.ts';
const work = () => ({applicationId: 4n, interactionId: 3n, channelId: 7n, interactionToken: 'offline_token'}) as InboundInteractionWork;
type Seen = {method: string; path: string; body: string};
async function fixture(run: (client: DiscordChannelClient, seen: Seen[]) => Promise<void>, response: (seen: Seen[]) => number = () => 204) {
  const seen: Seen[] = [], server = createServer((req, res) => {let body = ''; req.on('data', b => {body += b;}); req.on('end', () => {
    seen.push({method: req.method!, path: req.url!, body}); res.statusCode = response(seen);
    if (res.statusCode >= 400) res.end('{"code":50035,"message":"offline failure"}'); else res.end();
  });});
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const client = await DiscordChannelClient.create({token: null, testOrigin: `http://127.0.0.1:${(server.address() as {port: number}).port}/api/v10/`, report: () => {}});
  try {await run(client, seen);} finally {await client.close(); server.closeAllConnections(); await new Promise<void>((r, j) => server.close(e => e ? j(e) : r()));
    assert.equal(client.activeRequests, 0); assert.equal(client.ownedSockets, 0);}
}
test('short/empty ordinary text updates original response without channel POST', async () => {
  assert.equal(INTERACTION_FOLLOWUP_DOMAIN, 'interaction/followup/v1'); assert.equal(INTERACTION_ERROR_DOMAIN, 'interaction/error/v1');
  await fixture(async (client, seen) => {
    assert.equal(await deliverInteractionTextIdempotent(client, work(), 'hello', INTERACTION_FOLLOWUP_DOMAIN), 1);
    assert.equal(await deliverInteractionTextIdempotent(client, work(), '', INTERACTION_FOLLOWUP_DOMAIN), 1);
    assert.deepEqual(seen.map(v => v.method), ['PATCH', 'PATCH']); assert.equal(JSON.parse(seen[1]!.body).content, '(no output)');
  });
});
test('multipart text uses first PATCH and stable per-part channel POST nonce/body', async () => {
  const content = 'x'.repeat(5000), chunks = splitDeliveryChunks(content, true);
  await fixture(async (client, seen) => {
    assert.equal(await deliverInteractionTextIdempotent(client, work(), content, INTERACTION_FOLLOWUP_DOMAIN), chunks.length);
    assert.equal(seen[0]!.method, 'PATCH'); assert.equal(JSON.parse(seen[0]!.body).content, chunks[0]);
    for (let i = 1; i < chunks.length; i++) {
      const expected = idempotentMessageRequest(7n, chunks[i]!, INTERACTION_FOLLOWUP_DOMAIN, 'interaction:3', i);
      assert.deepEqual(seen[i], {method: 'POST', path: '/api/v10/' + expected.path, body: expected.body});
    }
  });
});
test('failed second chunk retries exact bytes without resending successful first PATCH', async () => {
  const content = 'x'.repeat(2000), sleeps: number[] = [];
  await fixture(async (client, seen) => {
    assert.equal(await deliverInteractionTextIdempotent(client, work(), content, INTERACTION_FOLLOWUP_DOMAIN, {sleep: async ms => {sleeps.push(ms);}}), 2);
    assert.deepEqual(seen.map(v => v.method), ['PATCH', 'POST', 'POST']); assert.equal(seen[1]!.body, seen[2]!.body); assert.deepEqual(sleeps, [750]);
  }, seen => seen.length === 2 ? 500 : 204);
});
test('permanent initial update failure exhausts source retries without fallback channel POST', async () => {
  const sleeps: number[] = [];
  await fixture(async (client, seen) => {
    await assert.rejects(deliverInteractionTextIdempotent(client, work(), 'x'.repeat(2000), INTERACTION_FOLLOWUP_DOMAIN, {sleep: async ms => {sleeps.push(ms);}}), error => {
      assert.ok(error instanceof DeliveryFailure); assert.equal(error.part, 1); assert.equal(error.totalParts, 2); assert.equal(error.attempts, 3); return true;
    }); assert.deepEqual(seen.map(v => v.method), ['PATCH', 'PATCH', 'PATCH']); assert.deepEqual(sleeps, [750, 2000]);
  }, () => 400);
});
test('cancelled retry sleep prevents another send and retains exact cancellation reason', async () => {
  const controller = new AbortController(), reason = new Error('stop retries');
  await fixture(async (client, seen) => {
    await assert.rejects(deliverInteractionTextIdempotent(client, work(), 'hello', INTERACTION_FOLLOWUP_DOMAIN,
      {signal: controller.signal, sleep: async () => {controller.abort(reason);}}), error => error === reason);
    assert.equal(seen.length, 1);
  }, () => 500);
});
test('envelope capture prevents mutable caller IDs/token from changing later chunk destinations', async () => {
  await fixture(async (client, seen) => {
    const input = {...work()}, task = deliverInteractionTextIdempotent(client, input, 'x'.repeat(2000), INTERACTION_FOLLOWUP_DOMAIN);
    input.channelId = 99n; input.interactionToken = 'changed'; input.interactionId = 99n;
    await task; assert.equal(seen[0]!.path, '/api/v10/webhooks/4/offline_token/messages/@original');
    assert.equal(seen[1]!.path, '/api/v10/channels/7/messages');
    assert.equal(seen[1]!.body, idempotentMessageRequest(7n, splitDeliveryChunks('x'.repeat(2000), true)[1]!, INTERACTION_FOLLOWUP_DOMAIN, 'interaction:3', 1).body);
  });
});

test('native retry timer cancellation joins promptly and reports the caller reason', async () => {
  await fixture(async (client, seen) => {
    const controller = new AbortController(), reason = new Error('cancel native sleep');
    const task = deliverInteractionTextIdempotent(client, work(), 'hello', INTERACTION_FOLLOWUP_DOMAIN, {signal: controller.signal});
    const rejected = assert.rejects(task, error => error === reason);
    const deadline = performance.now() + 2000;
    while ((seen.length === 0 || client.activeRequests !== 0) && performance.now() < deadline) await tick();
    assert.equal(seen.length, 1); await tick(); controller.abort(reason); await rejected; assert.equal(seen.length, 1);
  }, () => 500);
});
