import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {setImmediate as tick} from 'node:timers/promises';
import WebSocket, {WebSocketServer} from 'ws';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {RecommendedGateway} from '../../../src/discord/gateway/recommended.ts';
import {InteractionAccessPolicy} from '../../../src/discord/interaction-access.ts';
import {AdmissionGate, DrainFenceKey} from '../../../src/admission/drain-gate.ts';
import {AutocompleteCatalog} from '../../../src/runtime/discord-dispatch/autocomplete.ts';
import {createInteractionWorkQueue, releaseInboundInteractionWork} from '../../../src/runtime/discord-dispatch/interaction-work.ts';
import {createOrdinaryInteractionHandler} from '../../../src/runtime/discord-runtime/ordinary-interaction-handler.ts';
import {runInteractionLane} from '../../../src/runtime/discord-runtime/interaction-lane.ts';
import {runReceiveErrorConsumer} from '../../../src/runtime/discord-runtime/receive-error-consumer.ts';
class Clock {
  now = 0n; timers = new Set<{at: bigint; finish: () => void}>();
  nowNs = () => this.now;
  sleepUntilNs = (at: bigint, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
    if (signal.aborted) {reject(signal.reason); return;} if (at <= this.now) {resolve(); return;}
    const clean = () => {this.timers.delete(item); signal.removeEventListener('abort', abort);};
    const finish = () => {clean(); resolve();}, abort = () => {clean(); reject(signal.reason);}, item = {at, finish};
    this.timers.add(item); signal.addEventListener('abort', abort, {once: true});
  });
  advance(ms: number) {this.now += BigInt(ms) * 1000000n; for (const t of [...this.timers]) if (t.at <= this.now) t.finish();}
}
async function until(predicate: () => boolean) {
  const deadline = performance.now() + 3000;
  while (!predicate() && performance.now() < deadline) await tick();
  assert.equal(predicate(), true);
}
const ready = {application: {id: '4', flags: 0}, guilds: [], resume_gateway_url: 'wss://gateway.discord.gg',
  session_id: 'offline', user: {id: '2', username: 'bot', discriminator: '0', mfa_enabled: false}, v: 10};
const data = (id: string) => ({application_id: '4', authorizing_integration_owners: {}, channel_id: '7', id,
  token: 'offline_token', type: 2, user: {id: '2', username: 'u', discriminator: '0001'}, data: {id: '9', name: 'help', type: 1}});
async function edit(path: string, sql: string) {const db = await openInitialized(path); try {db.exec(sql);} finally {db.close();}}
async function fixture(run: (f: {
  send: (value: unknown) => void; requests: {url: string; body: any}[]; errors: string[];
  queue: ReturnType<typeof createInteractionWorkQueue>; path: string;
  stopAccepting: () => void; completed: bigint[]; reports: unknown[];
}) => Promise<void>, failId?: string) {
  await storeFixture(async path => {
    await edit(path, "INSERT INTO mirror_threads VALUES ('t','p','T',1,7,1)");
    const requests: {url: string; body: any}[] = [], errors: string[] = [], reports: unknown[] = [];
    const http = createServer((req, res) => {
      assert.equal(req.headers.authorization, undefined);
      let raw = ''; req.on('data', chunk => {raw += chunk;}); req.on('end', () => {
        if (req.url?.endsWith('/gateway/bot')) {res.end(JSON.stringify({shards: 1, url: 'ignored', session_start_limit: {max_concurrency: 1, remaining: 1000, total: 1000, reset_after: 86400000}})); return;}
        requests.push({url: req.url!, body: JSON.parse(raw)});
        if (failId !== undefined && req.url?.includes('/interactions/' + failId + '/')) {res.statusCode = 400; res.end('{"code":50035,"message":"offline failure"}');}
        else {res.statusCode = 204; res.end();}
      });
    });
    await new Promise<void>(r => http.listen(0, '127.0.0.1', r));
    const ws = new WebSocketServer({host: '127.0.0.1', port: 0}); await once(ws, 'listening');
    const peers: WebSocket[] = [];
    ws.on('connection', peer => {
      peers.push(peer); peer.on('error', () => {}); peer.on('message', raw => {
        const value = JSON.parse(raw.toString());
        if (value.op === 2) peer.send(JSON.stringify({op: 0, t: 'READY', s: 1, d: ready}));
        if (value.op === 1) peer.send('{"op":11}');
      }); peer.send('{"op":10,"d":{"heartbeat_interval":60000}}');
    });
    const clock = new Clock(), owner = await RecommendedGateway.startPausedForTest({
      httpOrigin: `http://127.0.0.1:${(http.address() as {port: number}).port}/api/v10/`,
      gatewayUrl: `ws://127.0.0.1:${(ws.address() as {port: number}).port}/`, clock, jitter: n => n,
      messageContent: false, reportReceiveErrorDrop: v => {reports.push(v);}, reportTriggerFailure: v => {reports.push(v);}, reportHttpError: v => {reports.push(v);},
    });
    const receivers = owner.runtime.takeIngressReceivers(), identity = owner.runtime.subscribeIdentity();
    const shutdown = new AbortController(), force = new AbortController(), queue = createInteractionWorkQueue(), gate = new AdmissionGate();
    const handler = createOrdinaryInteractionHandler({client: owner.http, database: path, queue,
      policy: new InteractionAccessPolicy(), qaEnabled: false, autocomplete: new AutocompleteCatalog(),
      admission: gate, settingsResolver: null, report: v => {reports.push(v);}, custodyNow: () => 1});
    const completed: bigint[] = [];
    const wrapped: typeof handler = async (item, signal) => {await handler(item, signal); completed.push(item.event.id);};
    const jobs = [runInteractionLane('Normal', receivers.normalInteractions, wrapped, shutdown.signal, force.signal, {report: v => {reports.push(v);}}),
      runInteractionLane('Reserved', receivers.reservedInteractions, wrapped, shutdown.signal, force.signal, {report: v => {reports.push(v);}})];
    const outcomes = jobs.map(job => job.then(() => ({ok: true as const}), error => ({ok: false as const, error})));
    const errorWork = runReceiveErrorConsumer(receivers.receiveErrors, shutdown.signal, force.signal, item => {errors.push(item.message);});
    let sequence = 1;
    try {
      owner.runtime.activateTypedConsumers(); for (let i = 0; i < 10; i++) await tick(); clock.advance(1000);
      await until(() => identity.snapshot() !== null);
      await run({path, requests, errors, queue, completed, reports, stopAccepting: () => owner.runtime.beginStopping(),
        send: value => peers[0]!.send(JSON.stringify({op: 0, t: 'INTERACTION_CREATE', s: ++sequence, d: value}))});
    } finally {
      shutdown.abort(); await owner.runtime.shutdown(performance.now() + 2000);
      const results = await Promise.all(outcomes); const errorResult = await errorWork;
      queue.receiver.dispose(); queue.sender.dispose(); await owner.close(); identity.dispose();
      receivers.messages.dispose(); receivers.emergencyMessages.dispose();
      for (const peer of ws.clients) peer.terminate(); await new Promise<void>(r => ws.close(() => r()));
      http.closeAllConnections(); await new Promise<void>((r, j) => http.close(e => e ? j(e) : r()));
      assert.deepEqual(results, [{ok: true}, {ok: true}]); assert.deepEqual(errorResult, {ok: true});
      if (failId === undefined) assert.deepEqual(reports, []); assert.equal(owner.snapshot().httpSockets, 0); assert.equal(owner.runtime.pendingTasks, 0); assert.equal(clock.timers.size, 0);
      const fence = DrainFenceKey.create('runtime', '1|2', 'integration'); gate.seal(fence); assert.equal(gate.isDrainedFor(fence), true);
    }
  });
}
test('real Gateway packet passes full decoding, policy, HTTP ACK, durable custody and work queue once', {timeout: 10000}, async () => {
  await fixture(async f => {
    f.send(data('30')); await until(() => f.completed.length === 1);
    assert.equal(f.requests.length, 1); assert.equal(f.requests[0]!.url, '/api/v10/interactions/30/offline_token/callback');
    const queued = f.queue.receiver.tryReceive(); assert.equal(queued.kind, 'Value');
    if (queued.kind === 'Value') {
      assert.equal(queued.value.interactionId, 30n); assert.equal(queued.value.processingMode, 'Execute');
      const db = await openInitialized(f.path); try {
        const row = db.prepare('SELECT state,phase FROM discord_ingress_journal WHERE ingress_id=?').get(queued.value.custodyIngressId);
        assert.ok(row); assert.equal(row.phase, 'acknowledged'); assert.equal(row.state, 'acknowledged');
      } finally {db.close(); releaseInboundInteractionWork(queued.value);}
    }
    f.send(data('30')); await until(() => f.completed.length === 2);
    assert.equal(f.requests.length, 1); assert.equal(f.queue.receiver.tryReceive().kind, 'Empty');
    f.stopAccepting(); f.send(data('31')); await until(() => f.completed.length === 3);
    assert.equal(f.requests.length, 2); assert.match(f.requests[1]!.body.data.content, /stopping|restarting/i);
    assert.equal(f.queue.receiver.tryReceive().kind, 'Empty'); assert.deepEqual(f.errors, []);
  });
});
test('invalid Gateway interaction never reaches handler; following valid events reread removed mapping', {timeout: 10000}, async () => {
  await fixture(async f => {
    const {token: _token, ...invalid} = data('40'); f.send(invalid); await until(() => f.errors.length === 1);
    assert.equal(f.requests.length, 0); assert.deepEqual(f.completed, []);
    f.send(data('41')); await until(() => f.completed.length === 1);
    const queued = f.queue.receiver.tryReceive(); assert.equal(queued.kind, 'Value'); if (queued.kind === 'Value') releaseInboundInteractionWork(queued.value);
    await edit(f.path, 'DELETE FROM mirror_threads'); f.send(data('42')); await until(() => f.completed.length === 2);
    assert.equal(f.requests.length, 2); assert.equal(f.queue.receiver.tryReceive().kind, 'Empty');
    assert.notEqual(f.requests[0]!.body.type, f.requests[1]!.body.type);
  });
});

test('HTTP failure after real Gateway delivery retains held custody and does not kill the normal lane', {timeout: 10000}, async () => {
  await fixture(async f => {
    f.send(data('50')); await until(() => f.reports.length === 1);
    assert.equal(f.requests.length, 1); assert.equal(f.queue.receiver.tryReceive().kind, 'Empty');
    const report = f.reports[0] as {lane: string; interactionId: bigint; error: string};
    assert.equal(report.lane, 'normal-interaction'); assert.equal(report.interactionId, 50n);
    assert.equal(report.error.includes('offline_token'), false);
    const db = await openInitialized(f.path); try {
      const row = db.prepare('SELECT state,phase,hold_reason FROM discord_ingress_journal WHERE event_id=50').get();
      assert.ok(row); assert.equal(row.state, 'held'); assert.equal(row.phase, 'staged'); assert.equal(row.hold_reason, 'discord_ack_failed');
    } finally {db.close();}
    f.send(data('51')); await until(() => f.completed.includes(51n));
    assert.equal(f.requests.length, 2); const queued = f.queue.receiver.tryReceive(); assert.equal(queued.kind, 'Value');
    if (queued.kind === 'Value') {assert.equal(queued.value.interactionId, 51n); releaseInboundInteractionWork(queued.value);}
    assert.equal(f.reports.length, 1); assert.deepEqual(f.errors, []);
  }, '50');
});
