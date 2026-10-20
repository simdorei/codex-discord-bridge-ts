import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer, type ServerResponse} from 'node:http';
import {setImmediate as tick} from 'node:timers/promises';
import {existsSync} from 'node:fs';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {DiscordChannelClient} from '../../../src/discord/channel-client.ts';
import {InteractionAccessPolicy} from '../../../src/discord/interaction-access.ts';
import {decodeGatewayInteraction} from '../../../src/discord/gateway/decoded-interaction.ts';
import {AutocompleteCatalog} from '../../../src/runtime/discord-dispatch/autocomplete.ts';
import {createInteractionWorkQueue, releaseInboundInteractionWork} from '../../../src/runtime/discord-dispatch/interaction-work.ts';
import {createOrdinaryInteractionHandler} from '../../../src/runtime/discord-runtime/ordinary-interaction-handler.ts';
import {captureInteractionIngress, runInteractionLane, RuntimeInteractionTagError, type OwnedInteractionIngress} from '../../../src/runtime/discord-runtime/interaction-lane.ts';
import {GatewayIngressLane} from '../../../src/discord/gateway/lane.ts';
import {nativeGatewayShutdownClock} from '../../../src/discord/gateway/shutdown.ts';
const event = (id = '3', channel = '7') => decodeGatewayInteraction(JSON.stringify({
  application_id: '4', authorizing_integration_owners: {}, channel_id: channel, id, token: 'offline_token', type: 2,
  user: {id: '2', username: 'u', discriminator: '0001'}, data: {id: '9', name: 'help', type: 1},
}));
const item = (id = '3', tag: OwnedInteractionIngress['tag'] = 'Normal'): OwnedInteractionIngress => ({event: event(id), tag, sequence: 1n, receivedAtMs: performance.now()});
async function edit(path: string, sql: string) {const db = await openInitialized(path); try {db.exec(sql);} finally {db.close();}}
async function fixture(run: (c: {
  path: string; handler: ReturnType<typeof createOrdinaryInteractionHandler>; force: AbortController;
  requests: {body: any; res: ServerResponse}[]; queue: ReturnType<typeof createInteractionWorkQueue>;
  policy: InteractionAccessPolicy; expire: () => void;
}) => Promise<void>, stall = false) {
  await storeFixture(async path => {
    const requests: {body: any; res: ServerResponse}[] = [];
    const server = createServer((req, res) => {let raw = ''; req.on('data', chunk => {raw += chunk;}); req.on('end', () => {
      requests.push({body: JSON.parse(raw), res}); if (!stall) {res.statusCode = 204; res.end();}
    });});
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const client = await DiscordChannelClient.create({token: null, report: () => {}, testOrigin: `http://127.0.0.1:${(server.address() as {port: number}).port}/api/v10/`});
    const queue = createInteractionWorkQueue(), force = new AbortController();
    const policy = new InteractionAccessPolicy({allowedChannelIds: [1n], allowedUserIds: [], mirroredChannelIds: [], allowAllChannels: false});
    let offset = 0;
    const clock = {now: () => performance.now() + offset, sleepUntil: nativeGatewayShutdownClock.sleepUntil};
    const raw = createOrdinaryInteractionHandler({client, queue, policy, clock, database: path, qaEnabled: false,
      admission: null, autocomplete: new AutocompleteCatalog(), settingsResolver: null, report: () => {}, custodyNow: () => 1});
    const tasks: Promise<void>[] = [];
    const handler: typeof raw = (input, signal) => {const p = raw(input, signal); tasks.push(p); void p.catch(() => {}); return p;};
    try {await run({path, handler, force, requests, queue, policy, expire: () => {offset = 10000;}});}
    finally {
      force.abort(new Error('cleanup')); await Promise.allSettled(tasks);
      queue.receiver.dispose(); queue.sender.dispose(); await client.close(); server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      assert.equal(client.activeRequests, 0); assert.equal(client.ownedSockets, 0);
    }
  });
}
test('each request replaces mirror policy; removed mapping denies without mutating base policy', async () => {
  await fixture(async c => {
    await edit(c.path, "INSERT INTO mirror_threads VALUES ('t','p','T',1,7,1)");
    await c.handler(item(), c.force.signal);
    const queued = c.queue.receiver.tryReceive(); assert.equal(queued.kind, 'Value');
    if (queued.kind === 'Value') releaseInboundInteractionWork(queued.value);
    assert.equal(c.policy.evaluate(event()).kind, 'DeniedChannel');
    await edit(c.path, 'DELETE FROM mirror_threads');
    await c.handler(item('5'), c.force.signal);
    assert.equal(c.queue.receiver.tryReceive().kind, 'Empty'); assert.equal(c.requests.length, 2);
    assert.notEqual(c.requests[0]!.body.type, c.requests[1]!.body.type);
  });
});
test('Normal and Reserved calls share pending and committed claim state', async () => {
  await fixture(async c => {
    await edit(c.path, "INSERT INTO mirror_threads VALUES ('t','p','T',1,7,1)");
    const first = c.handler(item(), c.force.signal);
    for (let i = 0; i < 3000 && c.requests.length === 0; i++) await tick();
    assert.equal(c.requests.length, 1);
    await c.handler(item('3', 'Busy'), c.force.signal); assert.equal(c.requests.length, 1);
    c.requests[0]!.res.statusCode = 204; c.requests[0]!.res.end(); await first;
    await c.handler(item('3', 'Stopping'), c.force.signal); assert.equal(c.requests.length, 1);
    const queued = c.queue.receiver.tryReceive(); assert.equal(queued.kind, 'Value');
    if (queued.kind === 'Value') releaseInboundInteractionWork(queued.value);
    assert.equal(c.queue.receiver.tryReceive().kind, 'Empty');
  }, true);
});
test('corrupt mirror read fails even when dispatch deadline already expired', async () => {
  await fixture(async c => {
    await edit(c.path, "INSERT INTO mirror_threads VALUES ('t','p','T',1,1.5,1)");
    c.expire();
    await assert.rejects(c.handler({...item(), receivedAtMs: 0}, c.force.signal));
    assert.equal(c.requests.length, 0); assert.equal(c.queue.receiver.tryReceive().kind, 'Empty');
  });
});
test('metadata is captured before async store read rather than borrowed from mutable caller', async () => {
  await fixture(async c => {
    await edit(c.path, "INSERT INTO mirror_threads VALUES ('t','p','T',1,7,1)");
    const mutable = {...item()}; const task = c.handler(mutable, c.force.signal);
    mutable.event = event('99'); mutable.tag = 'Stopping'; mutable.receivedAtMs = 0;
    await task;
    const queued = c.queue.receiver.tryReceive(); assert.equal(queued.kind, 'Value');
    if (queued.kind === 'Value') {assert.equal(queued.value.interactionId, 3n); releaseInboundInteractionWork(queued.value);}
  });
});
test('pre-cancelled handler does not open or create database', async () => {
  await fixture(async c => {
    const reason = new Error('already stopped'); c.force.abort(reason);
    await assert.rejects(c.handler(item(), c.force.signal), error => error === reason);
    assert.equal(existsSync(c.path), false); assert.equal(c.requests.length, 0);
  });
});
test('cancellation after store work starts joins refresh and prevents acknowledgement', async () => {
  await fixture(async c => {
    const task = c.handler(item(), c.force.signal), reason = new Error('stop while refreshing');
    c.force.abort(reason); await assert.rejects(task, error => error === reason);
    assert.equal(c.requests.length, 0); assert.equal(c.queue.receiver.tryReceive().kind, 'Empty');
    const db = await openInitialized(c.path); db.close();
  });
});
test('shared capture keeps lane-tag mismatch precedence and rejects active ingress fields', () => {
  assert.throws(() => captureInteractionIngress({tag: 'Busy'} as OwnedInteractionIngress, 'Normal'), RuntimeInteractionTagError);
  let calls = 0;
  assert.throws(() => captureInteractionIngress({get tag() {calls++; return 'Normal';}} as OwnedInteractionIngress), TypeError);
  assert.equal(calls, 0); const saved = captureInteractionIngress(item()); assert.equal(Object.isFrozen(saved), true);
});

test('actual Normal and Reserved lane loops share handler, ACK once and release all owned work', async () => {
  await fixture(async c => {
    await edit(c.path, "INSERT INTO mirror_threads VALUES ('t','p','T',1,7,1)");
    const normal = new GatewayIngressLane<OwnedInteractionIngress>(8), reserved = new GatewayIngressLane<OwnedInteractionIngress>(8);
    const stop = new AbortController(), reports: unknown[] = [], completed: string[] = [];
    const shared: typeof c.handler = async (value, signal) => {await c.handler(value, signal); completed.push(value.tag);};
    const jobs = [runInteractionLane('Normal', normal.receiver(), shared, stop.signal, c.force.signal, {report: v => {reports.push(v);}}),
      runInteractionLane('Reserved', reserved.receiver(), shared, stop.signal, c.force.signal, {report: v => {reports.push(v);}})];
    for (const job of jobs) void job.catch(() => {});
    try {
      assert.equal(normal.trySend(item()), 'Accepted');
      for (let i = 0; i < 3000 && c.requests.length === 0; i++) await tick();
      assert.equal(c.requests.length, 1);
      assert.equal(reserved.trySend(item('3', 'Busy')), 'Accepted');
      // Observe completion of the duplicate call itself: a distinct callback
      // may legitimately wait in the HTTP bucket until the first ACK finishes.
      const until = performance.now() + 2000;
      while (!completed.includes('Busy') && performance.now() < until) await tick();
      assert.equal(completed.includes('Busy'), true); assert.equal(c.requests.length, 1);
      c.requests[0]!.res.statusCode = 204; c.requests[0]!.res.end();
      let got = c.queue.receiver.tryReceive();
      for (let i = 0; i < 3000 && got.kind === 'Empty'; i++) {await tick(); got = c.queue.receiver.tryReceive();}
      assert.equal(got.kind, 'Value');
      if (got.kind === 'Value') {assert.equal(got.value.interactionId, 3n); releaseInboundInteractionWork(got.value);}
      assert.equal(c.queue.receiver.tryReceive().kind, 'Empty');
    } finally {
      stop.abort(); normal.close(); reserved.close(); await Promise.all(jobs);
    }
    assert.deepEqual(reports, []);
  }, true);
});
