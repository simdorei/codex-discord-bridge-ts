import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {newReply} from '../../helpers/delivery-custody.ts';
import {promptFixture} from '../../helpers/server-prompt-fixture.ts';
import {DiscordChannelClient} from '../../../src/discord/channel-client.ts';
import type {PortableResidentLifecycle} from '../../../src/app-server/portable-resident-lifecycle.ts';
import {DeliveryFailure} from '../../../src/discord/delivery.ts';
import {deliverActionResult} from '../../../src/runtime/interaction-worker/action-delivery.ts';
import {snapshotActionResult, type ActionResult} from '../../../src/runtime/action-result.ts';
import {prepareServerPrompts, PromptRedisplayChangedError} from '../../../src/runtime/server-prompt-redisplay.ts';
const work = () => ({applicationId: 4n, interactionId: 3n, channelId: 1n, userId: 2n, interactionToken: 'offline_token', custodyIngressId: 'original'});
const result = (text = 'result', ui: ActionResult['ui'] = null): ActionResult => ({text, waitsForFinal: false, ui});
// Plain/new/UI branches do not read the borrowed server; this sentinel catches any accidental new dependency.
const unusedServer = null as unknown as PortableResidentLifecycle;
async function httpFixture(run: (http: DiscordChannelClient, seen: {method: string; path: string; body: any}[]) => Promise<void>, fail = false) {
  const seen: {method: string; path: string; body: any}[] = [], server = createServer((req, res) => {let raw = ''; req.on('data', b => {raw += b;}); req.on('end', () => {
    seen.push({method: req.method!, path: req.url!, body: JSON.parse(raw)});
    if (fail) {res.statusCode = 400; res.end('{"code":50035,"message":"offline"}');}
    else if (req.method === 'PATCH') {res.statusCode = 204; res.end();}
    else res.end(JSON.stringify({attachments: [], author: {id: '1', username: 'fixture', discriminator: '0'}, channel_id: '1', content: '', embeds: [], id: String(100 + seen.length), type: 0, mention_everyone: false, mention_roles: [], mentions: [], pinned: false, timestamp: '2020-01-01T00:00:00+00:00', tts: false}));
  });});
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const client = await DiscordChannelClient.create({token: null, testOrigin: `http://127.0.0.1:${(server.address() as {port: number}).port}/api/v10/`, report: () => {}});
  try {await run(client, seen);} finally {await client.close(); server.closeAllConnections(); await new Promise<void>((r, j) => server.close(e => e ? j(e) : r())); assert.equal(client.activeRequests, 0); assert.equal(client.ownedSockets, 0);}
}
test('ordinary result with no UI follows first PATCH then indexed text channel chunks', async () => {
  await storeFixture(async path => {await httpFixture(async (http, seen) => {
    await deliverActionResult(work(), result('x'.repeat(2000)), path, unusedServer, http);
    assert.deepEqual(seen.map(v => v.method), ['PATCH', 'POST']); assert.equal(seen[1]!.path, '/api/v10/channels/1/messages');
  });});
});
test('Busy and ProBusy results use a single component PATCH and immutable original snapshot', async () => {
  await storeFixture(async path => {await httpFixture(async (http, seen) => {
    const ui = {kind: 'Busy' as const, choiceId: 'a'.repeat(24), allowSteer: true}, value = {text: 'busy', waitsForFinal: false, ui}, input = work();
    const task = deliverActionResult(input, value, path, unusedServer, http); ui.choiceId = 'b'.repeat(24); value.text = 'changed'; input.interactionToken = 'changed'; await task;
    assert.equal(seen[0]!.method, 'PATCH'); assert.equal(seen[0]!.body.content, 'busy'); assert.ok(seen[0]!.body.components[0].components[0].custom_id.includes('a'.repeat(24)));
    await deliverActionResult(work(), result('pro', {kind: 'ProBusy', choiceId: 'a'.repeat(24)}), path, unusedServer, http);
    assert.equal(seen[1]!.body.components[0].components.length, 3); assert.deepEqual(seen.map(v => v.method), ['PATCH', 'PATCH']);
  });});
});
test('component delivery failure is one application attempt without text split or POST fallback', async () => {
  await storeFixture(async path => {await httpFixture(async (http, seen) => {
    await assert.rejects(deliverActionResult(work(), result('busy', {kind: 'Busy', choiceId: 'a'.repeat(24), allowSteer: false}), path, unusedServer, http), error => {
      assert.ok(error instanceof DeliveryFailure); assert.deepEqual([error.part, error.totalParts, error.attempts], [1, 1, 1]); return true;
    }); assert.equal(seen.length, 1); assert.equal(seen[0]!.method, 'PATCH');
  }, true);});
});
test('oversize component text rejects as one failed update, not a text-only downgrade', async () => {
  await storeFixture(async path => {await httpFixture(async (http, seen) => {
    await assert.rejects(deliverActionResult(work(), result('x'.repeat(2001), {kind: 'ProBusy', choiceId: 'a'.repeat(24)}), path, unusedServer, http), DeliveryFailure); assert.equal(seen.length, 0);
  });});
});
test('/new exact acknowledgement receipt takes precedence and confirmed repeat skips all delivery branches', async () => {
  await storeFixture(async path => {await newReply(path, 'turn', 'interaction'); await httpFixture(async (http, seen) => {
    await deliverActionResult(work(), result('accepted'), path, unusedServer, http); await deliverActionResult(work(), result('accepted'), path, unusedServer, http); assert.equal(seen.length, 1);
    await assert.rejects(deliverActionResult(work(), result('accepted', {kind: 'ProBusy', choiceId: 'invalid'}), path, unusedServer, http), /new slash acknowledgement changed/); assert.equal(seen.length, 1);
  });});
});
test('prepared server prompts are delivered before the original action text and remain pending', {timeout: 10000}, async () => {
  await promptFixture(async (path, server) => {const prompts = await prepareServerPrompts(path, server, 't', 1n, 2n);
    await httpFixture(async (http, seen) => {
      await deliverActionResult(work(), result('displayed', {kind: 'ServerPrompts', prompts}), path, server, http);
      assert.deepEqual(seen.map(v => v.method), ['POST', 'PATCH']); assert.equal(seen[1]!.body.content, 'displayed');
      assert.equal(server.pendingServerRequests('t').length, 1);
    });
  });
});
test('changed server prompt authority stops before action-result PATCH', {timeout: 10000}, async () => {
  await promptFixture(async (path, server) => {const prompts = await prepareServerPrompts(path, server, 't', 1n, 2n);
    await httpFixture(async (http, seen) => {
      await assert.rejects(deliverActionResult({...work(), userId: 99n}, result('must not send', {kind: 'ServerPrompts', prompts}), path, server, http), PromptRedisplayChangedError); assert.equal(seen.length, 0);
    });
  });
});
test('action result snapshots reject active fields and forged prepared prompt projections', () => {
  let calls = 0; assert.throws(() => snapshotActionResult({get text() {calls++; return 'x';}, waitsForFinal: false, ui: null})); assert.equal(calls, 0);
  assert.throws(() => snapshotActionResult(result('x', {kind: 'ServerPrompts', prompts: [{} as never]})), TypeError);
  assert.ok(Object.isFrozen(snapshotActionResult(result())));
});
