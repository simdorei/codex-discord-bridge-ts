import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer, type RequestListener} from 'node:http';
import {setImmediate as tick} from 'node:timers/promises';
import {interactionUpdateRequest, originalInteractionResponseResource, isOriginalInteractionResponsePath} from '../../src/discord/interaction-update-request.ts';
import {DiscordChannelClient} from '../../src/discord/channel-client.ts';
import {DiscordResponseEngine, type DiscordWireRequest} from '../../src/discord/response-engine.ts';
import {NodeDiscordHttpWire} from '../../src/discord/node-http-wire.ts';
import {DiscordChannelRateLimiter} from '../../src/discord/rate-header-adapter.ts';
import {DiscordChannelRateState} from '../../src/discord/channel-rate-state.ts';
async function fixture(handler: RequestListener, run: (client: DiscordChannelClient, origin: string) => Promise<void>) {
  const server = createServer(handler); await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(server.address() as {port: number}).port}/api/v10/`;
  const client = await DiscordChannelClient.create({token: null, testOrigin: origin, report: () => {}});
  try {await run(client, origin);} finally {await client.close(); server.closeAllConnections();
    await new Promise<void>((r, j) => server.close(e => e ? j(e) : r())); assert.equal(client.activeRequests, 0); assert.equal(client.ownedSockets, 0);}
}
const path = (id = 4, token = 'offline_token') => `webhooks/${id}/${token}/messages/@original`;
test('original-response update has exact source fields; scalar limit permits empty content and astral text', () => {
  assert.deepEqual(interactionUpdateRequest(4n, 'offline_token', 'hello'), {method: 'PATCH', path: path(), authorization: null,
    body: '{"allowed_mentions":{"parse":[]},"content":"hello"}'});
  for (const content of ['', '   ', '😀'.repeat(2000)]) assert.equal(JSON.parse(interactionUpdateRequest(4n, 'offline_token', content).body).content, content);
  assert.throws(() => interactionUpdateRequest(4n, 'offline_token', '😀'.repeat(2001)), RangeError);
  assert.throws(() => interactionUpdateRequest(4n, 'offline_token', '\ud800'), TypeError);
  assert.equal(originalInteractionResponseResource(path()), 'webhooks/4/offline_token');
});
test('URL profile rejects traversal, trailing lines, invalid IDs and arbitrary endpoints', () => {
  for (const token of ['', '.', '..', 'a/b', 'a?b', 'a#b', '%2e', 'a\n', 'é']) assert.throws(() => interactionUpdateRequest(4n, token, 'x'));
  for (const id of [0n, -1n, 1n << 64n]) assert.throws(() => interactionUpdateRequest(id, 'offline_token', 'x'));
  for (const value of [path() + '\n', path() + '?x', path().replace('/4/', '/04/'), path().replace('@original', '5'), 'https://discord.com/' + path()]) assert.equal(isOriginalInteractionResponsePath(value), false);
});
test('native PATCH omits bot authorization and preserves attachments/components by omitting their fields', {timeout: 5000}, async () => {
  const seen: unknown[] = [];
  await fixture((req, res) => {let body = ''; req.on('data', b => {body += b;}); req.on('end', () => {
    seen.push([req.method, req.url, req.headers.authorization, body]); res.statusCode = 204; res.end();
  });}, async client => {
    await client.updateInitialResponse(4n, 'offline_token', '<@1>');
    assert.deepEqual(seen, [['PATCH', '/api/v10/' + path(), undefined, '{"allowed_mentions":{"parse":[]},"content":"<@1>"}']]);
  });
});
test('success headers suffice and stalled malformed response body is joined without decoding', {timeout: 5000}, async () => {
  await fixture((_req, res) => {res.writeHead(200); res.write('{');}, async client => {
    await client.updateInitialResponse(4n, 'offline_token', 'x', AbortSignal.timeout(1000)); assert.equal(client.activeRequests, 0);
  });
});
test('native 429 retries the exact PATCH body and respects provider bucket delay', {timeout: 5000}, async () => {
  const bodies: string[] = [];
  await fixture((req, res) => {let body = ''; req.on('data', b => {body += b;}); req.on('end', () => {
    bodies.push(body); res.setHeader('x-ratelimit-scope', 'user'); res.setHeader('x-ratelimit-bucket', 'edit');
    res.setHeader('x-ratelimit-limit', '1'); res.setHeader('x-ratelimit-remaining', '0'); res.setHeader('x-ratelimit-reset-after', '0.01');
    res.statusCode = bodies.length === 1 ? 429 : 204; res.end();
  });}, async client => {await client.updateInitialResponse(4n, 'offline_token', 'x'); assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1]);});
});
test('webhook rate identity includes both application ID and token and bypasses exhausted global allowance', async () => {
  const rate = new DiscordChannelRateState(1, {now: () => 0, schedule: () => () => {}}), signal = new AbortController().signal;
  const ordinary = await rate.acquire('channels/1/typing', signal); ordinary.complete(null); assert.equal(rate.globalRemaining, 0);
  const first = await rate.acquire(path(), signal), differentToken = await rate.acquire(path(4, 'other'), signal), differentId = await rate.acquire(path(5), signal);
  let granted = false; const pending = rate.acquire(path(), signal).then(p => {granted = true; return p;});
  await tick(); assert.equal(granted, false); first.complete(null); const next = await pending;
  assert.equal(rate.globalRemaining, 0); next.complete(null); differentToken.complete(null); differentId.complete(null); await rate.close();
});
test('update401 never invalidates configured bot credentials and prior bot invalidation still blocks update', async () => {
  const seen: DiscordWireRequest[] = []; let status = 401;
  const engine = new DiscordResponseEngine({token: 'offline-fixture', decoder: {decode: () => 1n}, rateLimiter: {acquire: async () => ({complete() {}, release() {}})},
    wire: {request: async input => {seen.push(input); return {status, headers: new Map(), bytes: async () => Buffer.from('{}'), release: async () => {}};}}});
  try {
    await assert.rejects(engine.updateInitialResponse(4n, 'offline_token', 'x')); assert.equal(engine.authorizationInvalidated, false);
    assert.equal(seen[0]!.authorization, null); status = 204; await engine.createTyping(1n, new AbortController().signal);
    assert.equal(seen[1]!.authorization, 'Bot offline-fixture'); status = 401; await assert.rejects(engine.createTyping(1n, new AbortController().signal));
    assert.equal(engine.authorizationInvalidated, true); await assert.rejects(engine.updateInitialResponse(4n, 'offline_token', 'x'), /invalidated/); assert.equal(seen.length, 3);
  } finally {await engine.close();}
});
test('native cancelled PATCH joins request and retains exact cancellation reason', {timeout: 5000}, async () => {
  let received = false;
  await fixture((_req, _res) => {received = true;}, async client => {
    const controller = new AbortController(), reason = new Error('cancel update');
    const pending = client.updateInitialResponse(4n, 'offline_token', 'x', controller.signal), check = assert.rejects(pending, e => e === reason);
    const deadline = performance.now() + 2000; while (!received && performance.now() < deadline) await tick();
    assert.equal(received, true); controller.abort(reason); await check; assert.equal(client.activeRequests, 0);
  });
});
test('wire and rate adapters reject wrong method, bot header and unsupported webhook path before IO', {timeout: 5000}, async () => {
  let calls = 0;
  await fixture((_req, res) => {calls++; res.end();}, async (_client, origin) => {
    const wire = new NodeDiscordHttpWire(origin), rate = new DiscordChannelRateLimiter({report: () => {}}), signal = new AbortController().signal;
    try {
      await assert.rejects(wire.request({method: 'PATCH', path: path(), body: '{}', authorization: 'Bot offline-fixture'}, 1000, signal));
      for (const method of ['GET', 'POST', 'PUT'] as const) {
        await assert.rejects(wire.request({method, path: path(), body: '{}', authorization: null}, 1000, signal));
        await assert.rejects(rate.acquire(method, path(), signal));
      }
      await assert.rejects(rate.acquire('PATCH', 'webhooks/4/offline_token/messages/5', signal)); assert.equal(calls, 0);
    } finally {await Promise.all([wire.close(), rate.close()]);}
  });
});
