import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer, type ServerResponse} from 'node:http';
import {existsSync, writeFileSync} from 'node:fs';
import {setImmediate as tick} from 'node:timers/promises';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {AdmissionGate, DrainFenceKey} from '../../../src/admission/drain-gate.ts';
import {DiscordChannelClient} from '../../../src/discord/channel-client.ts';
import {InteractionAccessPolicy} from '../../../src/discord/interaction-access.ts';
import {decodeGatewayInteraction, type DecodedGatewayInteraction} from '../../../src/discord/gateway/decoded-interaction.ts';
import {InteractionClaimCache} from '../../../src/runtime/discord-dispatch/claim-cache.ts';
import {AutocompleteCatalog} from '../../../src/runtime/discord-dispatch/autocomplete.ts';
import {createInteractionWorkQueue, releaseInboundInteractionWork} from '../../../src/runtime/discord-dispatch/interaction-work.ts';
import {OrdinaryInteractionDispatcher, type OrdinaryDispatcherOptions, type InteractionDispatchReport} from '../../../src/runtime/discord-dispatch/ordinary-dispatcher.ts';
import {InteractionDispatchError} from '../../../src/runtime/discord-dispatch/errors.ts';
import {serializeBusyChoice} from '../../../src/store/busy-choice.ts';

class Clock {
  value = 0;
  readonly timers = new Set<{deadline: number; finish: () => void}>();
  now() {return this.value;}
  sleepUntil(deadline: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.value >= deadline) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {this.timers.delete(timer); signal.removeEventListener('abort', abort);};
      const timer = {deadline, finish: () => {cleanup(); resolve();}};
      const abort = () => {cleanup(); reject(signal.reason);};
      this.timers.add(timer); signal.addEventListener('abort', abort, {once: true});
    });
  }
  advance(value: number) {this.value = value; for (const timer of [...this.timers]) if (timer.deadline <= value) timer.finish();}
}
const interaction = (extra: Record<string, unknown> = {}) => decodeGatewayInteraction(JSON.stringify({
  application_id: '4', authorizing_integration_owners: {}, channel_id: '1', id: '3', token: 'offline_token',
  type: 2, user: {id: '2', username: 'u', discriminator: '0001'}, data: {id: '9', name: 'help', type: 1}, ...extra,
}));
type Seen = {url: string; body: Record<string, any>; authorization: string | undefined};
type Context = {
  path: string; client: DiscordChannelClient; queue: ReturnType<typeof createInteractionWorkQueue>;
  clock: Clock; gate: AdmissionGate; fence: DrainFenceKey; claims: InteractionClaimCache; force: AbortController;
  requests: Seen[]; reports: InteractionDispatchReport[]; dispatcher: OrdinaryInteractionDispatcher;
  make: (options: Partial<OrdinaryDispatcherOptions>) => OrdinaryInteractionDispatcher;
  dispatch: (input?: DecodedGatewayInteraction, tag?: 'Normal' | 'Busy' | 'Stopping', received?: number, instance?: OrdinaryInteractionDispatcher) => ReturnType<OrdinaryInteractionDispatcher['dispatch']>;
};
async function fixture(run: (ctx: Context) => Promise<void>, options: {
  capacity?: number;
  handler?: (ctx: Context, res: ServerResponse, request: Seen) => void | Promise<void>;
} = {}) {
  await storeFixture(async path => {
    let ctx!: Context;
    const handlerErrors: unknown[] = [], tasks: Promise<unknown>[] = [], instances: OrdinaryInteractionDispatcher[] = [];
    const requests: Seen[] = [], reports: InteractionDispatchReport[] = [];
    const server = createServer((req, res) => {
      let raw = ''; req.on('data', chunk => {raw += chunk;});
      req.on('end', () => {
        const seen = {url: req.url!, body: JSON.parse(raw), authorization: req.headers.authorization};
        requests.push(seen);
        void Promise.resolve().then(() => options.handler ? options.handler(ctx, res, seen) : (() => {res.statusCode = 204; res.end();})())
          .catch(error => {handlerErrors.push(error); if (!res.headersSent) res.statusCode = 500; res.end('{}');});
      });
    });
    await new Promise<void>((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
    const client = await DiscordChannelClient.create({token: null, report: () => {},
      testOrigin: 'http://127.0.0.1:' + (server.address() as {port: number}).port + '/api/v10/'});
    const queue = createInteractionWorkQueue(options.capacity ?? 64), clock = new Clock(), gate = new AdmissionGate();
    const fence = DrainFenceKey.create('runtime', '1|2', 'fixture'), claims = new InteractionClaimCache(), force = new AbortController();
    const defaults: OrdinaryDispatcherOptions = {
      client, queue, clock, database: path, claims, admission: gate, qaEnabled: false,
      policy: new InteractionAccessPolicy({allowedChannelIds: [1n], allowedUserIds: [], mirroredChannelIds: [], allowAllChannels: false}),
      autocomplete: new AutocompleteCatalog('{"data":[{"model":"gpt"}]}'), settingsResolver: null,
      report: value => {reports.push(value);}, custodyNow: () => 1,
    };
    const make = (extra: Partial<OrdinaryDispatcherOptions>) => {
      const value = new OrdinaryInteractionDispatcher({...defaults, ...extra}); instances.push(value); return value;
    };
    const dispatcher = make({});
    const dispatch: Context['dispatch'] = (value = interaction(), tag = 'Normal', received = clock.value, instance = dispatcher) => {
      const task = instance.dispatch(value, received, tag, force.signal); tasks.push(task); void task.catch(() => {}); return task;
    };
    ctx = {path, client, queue, clock, gate, fence, claims, force, requests, reports, dispatcher, make, dispatch};
    try {await run(ctx); assert.deepEqual(handlerErrors, []);}
    finally {
      force.abort(new Error('fixture cleanup')); await Promise.allSettled(tasks);
      queue.receiver.dispose(); for (const instance of instances) instance.dispose(); queue.sender.dispose();
      await client.close(); server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      assert.equal(clock.timers.size, 0); assert.equal(client.activeRequests, 0); assert.equal(client.ownedSockets, 0);
      gate.seal(fence); assert.equal(gate.isDrainedFor(fence), true);
    }
  });
}
async function seen(ctx: Context, count = 1) {
  for (let i = 0; i < 3000 && ctx.requests.length < count; i++) await tick();
  assert.equal(ctx.requests.length, count);
}
async function edit(path: string, sql: string) {
  const db = await openInitialized(path); try {db.exec(sql);} finally {db.close();}
}

test('native ACK occurs after durable stage and reservation, before custody confirmation and enqueue', {timeout: 8000}, async () => {
  await fixture(async ctx => {
    assert.equal(await ctx.dispatch(), 'Queued');
    assert.deepEqual(ctx.requests.map(r => [r.url, r.authorization, r.body]), [['/api/v10/interactions/3/offline_token/callback', undefined, {type: 5}]]);
    assert.equal((await state.getIngress(ctx.path, 'interaction:3'))!.state, 'acknowledged');
    assert.equal(ctx.claims.snapshot().committed, 1);
    ctx.gate.seal(ctx.fence); assert.equal(ctx.gate.isDrainedFor(ctx.fence), false);
    const item = ctx.queue.receiver.tryReceive(); assert.equal(item.kind, 'Value');
    if (item.kind !== 'Value') throw new Error('fixture');
    assert.equal(item.value.processingMode, 'Execute'); assert.equal(item.value.applicationId, 4n);
    assert.equal(item.value.custodyIngressId, 'interaction:3'); assert.equal(item.value.interactionToken, 'offline_token');
    releaseInboundInteractionWork(item.value); assert.equal(ctx.gate.isDrainedFor(ctx.fence), true);
  }, {handler: async (ctx, res) => {
    assert.equal((await state.getIngress(ctx.path, 'interaction:3'))!.state, 'staged');
    assert.equal(ctx.queue.snapshot().reserved, 1); assert.equal(ctx.queue.snapshot().queued, 0);
    res.statusCode = 204; res.end();
  }});
});
test('expired ingress performs no HTTP, claim or DB stage', async () => {
  await fixture(async ctx => {
    ctx.clock.advance(2500); assert.equal(await ctx.dispatch(interaction(), 'Normal', 0), 'DeadlineExceeded');
    assert.equal(ctx.requests.length, 0); assert.equal(existsSync(ctx.path), false); assert.equal(ctx.claims.snapshot().size, 0);
  });
});
test('no-work Ping and missing identity acknowledge once without durable execution custody', async () => {
  await fixture(async ctx => {
    assert.equal(await ctx.dispatch(interaction({type: 1, data: null})), 'RespondedWithoutWork');
    assert.deepEqual(ctx.requests[0]!.body, {type: 1});
    assert.equal(await ctx.dispatch(interaction({id: '5', user: null})), 'RespondedWithoutWork');
    assert.equal(ctx.requests[1]!.body.data.content, 'Discord interaction identity is missing.');
    assert.equal(existsSync(ctx.path), false); assert.equal(ctx.queue.snapshot().queued, 0);
  });
});
test('access denial and busy/stopping nonexecution response never stage command work', async () => {
  await fixture(async ctx => {
    const denied = ctx.make({policy: new InteractionAccessPolicy({allowedChannelIds: [1n], allowedUserIds: [99n], mirroredChannelIds: [], allowAllChannels: false})});
    assert.equal(await ctx.dispatch(interaction(), 'Normal', 0, denied), 'RespondedWithoutWork');
    assert.equal(ctx.requests[0]!.body.data.content, 'This Discord user is not allowed to control Codex.');
    for (const [tag, id] of [['Busy', '5'], ['Stopping', '6']] as const) assert.equal(await ctx.dispatch(interaction({id}), tag), 'RespondedWithoutWork');
    assert.equal(ctx.requests[1]!.body.data.content, 'Codex Discord is busy. Please retry shortly.');
    assert.equal(ctx.requests[2]!.body.data.content, 'Codex Discord is stopping. Please retry after restart.');
    assert.equal(existsSync(ctx.path), false);
  });
});
test('sealed admission overrides ordinary response but preserves autocomplete choices', async () => {
  await fixture(async ctx => {
    ctx.gate.seal(ctx.fence);
    assert.equal(await ctx.dispatch(), 'Stopping');
    assert.equal(ctx.requests[0]!.body.data.content, 'Codex Discord is restarting. Please retry after restart.');
    assert.equal(await ctx.dispatch(interaction({id: '5', type: 4, data: {id: '9', name: 'settings', type: 1,
      options: [{name: 'model', type: 3, value: 'g', focused: true}]}})), 'Stopping');
    assert.deepEqual(ctx.requests[1]!.body, {type: 8, data: {choices: [{name: 'gpt', value: 'gpt'}]}});
    assert.equal(existsSync(ctx.path), false);
  });
});
test('queue full and closed are durably held before their distinct status ACK', async () => {
  await fixture(async ctx => {
    const held = ctx.queue.sender.tryReserve(); assert.equal(held.kind, 'Reserved');
    if (held.kind !== 'Reserved') throw new Error('fixture');
    try {
      assert.equal(await ctx.dispatch(), 'QueueFull');
      assert.equal((await state.getIngress(ctx.path, 'interaction:3'))!.holdReason, 'interaction_queue_full');
      assert.equal(ctx.requests[0]!.body.data.content, 'Codex Discord work queue is full. Please retry shortly.');
    } finally {held.reservation.release();}
    ctx.queue.receiver.close();
    assert.equal(await ctx.dispatch(interaction({id: '5'})), 'Stopping');
    assert.equal((await state.getIngress(ctx.path, 'interaction:5'))!.holdReason, 'interaction_queue_closed');
    assert.equal(ctx.requests[1]!.body.data.content, 'Codex Discord runtime is stopping. Please retry after restart.');
  }, {capacity: 1, handler: async (ctx, res, request) => {
    const id = request.url.split('/')[4]!;
    assert.equal((await state.getIngress(ctx.path, 'interaction:' + id))!.state, 'held');
    res.statusCode = 204; res.end();
  }});
});
test('HTTP acknowledgement failure holds the row and releases reservation, claim and admission', async () => {
  await fixture(async ctx => {
    await assert.rejects(ctx.dispatch(), e => e instanceof InteractionDispatchError && e.kind === 'Acknowledge');
    assert.equal((await state.getIngress(ctx.path, 'interaction:3'))!.holdReason, 'discord_ack_failed');
    assert.equal(ctx.queue.snapshot().reserved, 0); assert.equal(ctx.queue.snapshot().queued, 0);
    assert.equal(ctx.claims.snapshot().size, 0); assert.equal(ctx.requests.length, 1);
  }, {handler: (_ctx, res) => {res.statusCode = 500; res.end('{}');}});
});
test('deadline cancels and joins native HTTP before recording a not-executed hold', async () => {
  await fixture(async ctx => {
    const pending = ctx.dispatch(); await seen(ctx); ctx.clock.advance(2500);
    assert.equal(await pending, 'DeadlineExceeded');
    assert.equal((await state.getIngress(ctx.path, 'interaction:3'))!.holdReason, 'discord_ack_deadline');
    assert.equal(ctx.client.activeRequests, 0); assert.equal(ctx.queue.snapshot().reserved, 0);
    assert.equal(ctx.claims.snapshot().size, 0);
  }, {handler: () => {}});
});
test('forced cancellation joins native HTTP and retains cancellation custody rather than enqueueing', async () => {
  await fixture(async ctx => {
    const reason = new Error('forced'), pending = ctx.dispatch();
    await seen(ctx); assert.throws(() => ctx.dispatcher.dispose(), /still borrowed/);
    ctx.force.abort(reason); await assert.rejects(pending, e => e === reason);
    assert.equal((await state.getIngress(ctx.path, 'interaction:3'))!.holdReason, 'interaction_dispatch_cancelled');
    assert.equal(ctx.client.activeRequests, 0); assert.equal(ctx.queue.snapshot().queued, 0); ctx.dispatcher.dispose();
  }, {handler: () => {}});
});
test('elapsed budget after DB staging holds without sending any HTTP request', async () => {
  await fixture(async ctx => {
    const dispatcher = ctx.make({custodyNow: () => {ctx.clock.advance(2500); return 1;}});
    assert.equal(await ctx.dispatch(interaction(), 'Normal', 0, dispatcher), 'DeadlineExceeded');
    assert.equal((await state.getIngress(ctx.path, 'interaction:3'))!.holdReason, 'discord_ack_deadline');
    assert.equal(ctx.requests.length, 0); assert.equal(ctx.queue.snapshot().queued, 0);
  });
});
test('durable stage error and excluded recovery path never acknowledge or enqueue', async () => {
  await fixture(async ctx => {
    await assert.rejects(ctx.dispatch(interaction({type: 3, data: {custom_id: 'codex_pub:v1:' + 'a'.repeat(32) + ':1:a', component_type: 2}})),
      e => e instanceof InteractionDispatchError && e.kind === 'Custody');
    assert.equal(existsSync(ctx.path), false);
    writeFileSync(ctx.path, 'not a database');
    await assert.rejects(ctx.dispatch(interaction({id: '5'})), e => e instanceof InteractionDispatchError && e.kind === 'Custody');
    assert.equal(ctx.requests.length, 0); assert.equal(ctx.claims.snapshot().size, 0);
  });
});
test('pending and committed claims suppress duplicate ACKs and duplicated queue work', async () => {
  let finish: (() => void) | undefined;
  await fixture(async ctx => {
    const first = ctx.dispatch(); await seen(ctx);
    assert.equal(await ctx.dispatch(), 'DuplicatePending'); assert.equal(ctx.requests.length, 1);
    finish!(); assert.equal(await first, 'Queued');
    assert.equal(await ctx.dispatch(), 'Duplicate'); assert.equal(ctx.queue.snapshot().queued, 1);
    assert.equal(ctx.requests.length, 1);
  }, {handler: (_ctx, res) => {finish = () => {res.statusCode = 204; res.end();};}});
});

test('sealed gate accepts existing approval controls until controls close', async () => {
  await fixture(async ctx => {
    ctx.gate.seal(ctx.fence);
    const value = interaction({type: 3, data: {custom_id: 'codex_approval:t:1', component_type: 2}});
    assert.equal(await ctx.dispatch(value), 'Queued');
    const item = ctx.queue.receiver.tryReceive(); assert.equal(item.kind, 'Value');
    if (item.kind !== 'Value') throw new Error('fixture');
    assert.equal(ctx.gate.isDrainedFor(ctx.fence), false); releaseInboundInteractionWork(item.value);
    ctx.gate.closeControls(ctx.fence);
    assert.equal(await ctx.dispatch(interaction({id: '5', type: 3, data: {custom_id: 'codex_approval:t:1', component_type: 2}})), 'Stopping');
    assert.equal(await state.getIngress(ctx.path, 'interaction:5'), null);
  });
});
test('durable duplicate after a fresh in-memory cache sends no second ACK or work', async () => {
  await fixture(async ctx => {
    assert.equal(await ctx.dispatch(), 'Queued');
    const item = ctx.queue.receiver.tryReceive(); if (item.kind !== 'Value') throw new Error('fixture');
    releaseInboundInteractionWork(item.value);
    const claims = new InteractionClaimCache(), restarted = ctx.make({claims});
    assert.equal(await ctx.dispatch(interaction(), 'Normal', 0, restarted), 'Duplicate');
    assert.equal(claims.snapshot().size, 0); assert.equal(ctx.requests.length, 1);
    assert.equal(ctx.queue.snapshot().queued, 0);
  });
});
test('claim saturation is fatal before DB/HTTP and does not lose the existing pending owner', async () => {
  await fixture(async ctx => {
    const claims = new InteractionClaimCache(1), held = claims.tryClaim(99n);
    if (held.kind !== 'Claimed') throw new Error('fixture');
    try {
      await assert.rejects(ctx.dispatch(interaction(), 'Normal', 0, ctx.make({claims})),
        e => e instanceof InteractionDispatchError && e.kind === 'ClaimCacheSaturated');
      assert.equal(claims.snapshot().pending, 1); assert.equal(ctx.requests.length, 0);
      assert.equal(existsSync(ctx.path), false);
    } finally {held.claim.release();}
  });
});
const busyId = 'a'.repeat(24);
const busyInteraction = (id = '3') => interaction({id, type: 3, data: {custom_id: 'codex_busy:' + busyId + ':queue', component_type: 2}});
const busyChoice = {choiceId: busyId, ownerUserId: 2n, channelId: 1n, targetThreadId: 'target', prompt: 'original',
  allowSteer: false, createdAt: 0, expiresAt: 10};
async function promptReceipt(ctx: Context) {
  const db = await openInitialized(ctx.path);
  try {db.prepare("INSERT INTO discord_ingress_owner_receipts VALUES (?,'prompt','job','target',1,2,?,1)").run('busy-choice:' + busyId, serializeBusyChoice(busyChoice));}
  finally {db.close();}
}
test('unavailable busy choice receives an explanatory ACK without a durable command row', async () => {
  await fixture(async ctx => {
    assert.equal(await ctx.dispatch(busyInteraction()), 'RespondedWithoutWork');
    assert.equal(ctx.requests[0]!.body.data.content, 'This busy-choice button is no longer active. Please use the latest prompt.');
    assert.equal(await state.getIngress(ctx.path, 'interaction:3'), null);
    assert.equal(ctx.queue.snapshot().queued, 0); assert.equal(ctx.claims.snapshot().committed, 1);
  });
});
test('saved canonical ingress repeat is acknowledged without executing or queueing again', async () => {
  await fixture(async ctx => {
    await edit(ctx.path, `INSERT INTO busy_choices(choice_id,owner_user_id,channel_id,target_thread_id,prompt,allow_steer,created_at,expires_at,claimed_at,require_current_mirror)
      VALUES ('${busyId}',2,1,'target','original',0,0,10,NULL,0)`);
    assert.equal(await ctx.dispatch(busyInteraction()), 'Queued');
    const item = ctx.queue.receiver.tryReceive(); if (item.kind !== 'Value') throw new Error('fixture');
    releaseInboundInteractionWork(item.value); await edit(ctx.path, 'DELETE FROM busy_choices');
    assert.equal(await ctx.dispatch(busyInteraction('5')), 'RespondedWithoutWork');
    assert.equal(ctx.requests[1]!.body.data.content, 'This busy request is already saved and requires manual review. No action was started again.');
    assert.equal(ctx.queue.snapshot().queued, 0);
    const repeat = (await state.getIngress(ctx.path, 'interaction:5'))!;
    assert.equal(repeat.state, 'owned'); assert.equal(repeat.ownerKind, 'ingress'); assert.equal(repeat.ownerId, 'interaction:3');
  });
});
test('prompt-owned canonical repeat queues confirmation only without re-acknowledging its DB state', async () => {
  await fixture(async ctx => {
    await promptReceipt(ctx); assert.equal(await ctx.dispatch(busyInteraction()), 'Queued');
    const item = ctx.queue.receiver.tryReceive(); if (item.kind !== 'Value') throw new Error('fixture');
    try {
      assert.equal(item.value.processingMode, 'ConfirmationOnly');
      assert.deepEqual(item.value.authorizedBusyChoice, busyChoice);
      const repeat = (await state.getIngress(ctx.path, 'interaction:3'))!;
      assert.equal(repeat.state, 'owned'); assert.equal(repeat.phase, 'canonical_duplicate');
    } finally {releaseInboundInteractionWork(item.value);}
  });
});
test('full queue preserves canonical prompt ownership and returns confirmation-unavailable status', async () => {
  await fixture(async ctx => {
    await promptReceipt(ctx);
    const blocked = ctx.queue.sender.tryReserve(); if (blocked.kind !== 'Reserved') throw new Error('fixture');
    try {
      assert.equal(await ctx.dispatch(busyInteraction()), 'QueueFull');
      assert.equal(ctx.requests[0]!.body.data.content, 'The busy action is already saved, but its confirmation cannot run now. Please retry shortly.');
      const record = (await state.getIngress(ctx.path, 'interaction:3'))!;
      assert.equal(record.state, 'owned'); assert.equal(record.ownerKind, 'prompt'); assert.equal(record.holdReason, '');
    } finally {blocked.reservation.release();}
  }, {capacity: 1});
});
test('DB acknowledgement failure after successful HTTP holds custody and cannot reach the queue', async () => {
  await fixture(async ctx => {
    await assert.rejects(ctx.dispatch(), e => e instanceof InteractionDispatchError && e.kind === 'Custody');
    assert.equal((await state.getIngress(ctx.path, 'interaction:3'))!.holdReason, 'custody_acknowledge_failed');
    assert.equal(ctx.queue.snapshot().queued, 0); assert.equal(ctx.claims.snapshot().size, 0);
  }, {handler: async (ctx, res) => {
    await edit(ctx.path, "CREATE TRIGGER reject_ack BEFORE UPDATE OF state ON discord_ingress_journal WHEN NEW.state='acknowledged' BEGIN SELECT RAISE(ABORT,'ack persistence failed'); END");
    res.statusCode = 204; res.end();
  }});
});
test('failed full-queue hold prevents status ACK and reports failed cancellation cleanup', async () => {
  await fixture(async ctx => {
    await edit(ctx.path, "CREATE TRIGGER reject_hold BEFORE UPDATE OF state ON discord_ingress_journal WHEN NEW.state='held' BEGIN SELECT RAISE(ABORT,'hold persistence failed'); END");
    const blocked = ctx.queue.sender.tryReserve(); if (blocked.kind !== 'Reserved') throw new Error('fixture');
    try {
      await assert.rejects(ctx.dispatch(), e => e instanceof InteractionDispatchError && e.kind === 'Custody');
      assert.equal(ctx.requests.length, 0);
      assert.equal((await state.getIngress(ctx.path, 'interaction:3'))!.state, 'staged');
      assert.equal(ctx.reports.at(-1)!.code, 'interaction_custody_cancel_hold_failed');
    } finally {blocked.reservation.release();}
  }, {capacity: 1});
});
test('reporter failure cannot hide the primary acknowledgement failure and cleanup still joins', async () => {
  const reporterFailure = new Error('reporter failed');
  const containsAck = (error: unknown): boolean => error instanceof InteractionDispatchError && error.kind === 'Acknowledge'
    || error instanceof AggregateError && error.errors.some(containsAck);
  await fixture(async ctx => {
    const dispatcher = ctx.make({report: () => {throw reporterFailure;}});
    await assert.rejects(ctx.dispatch(interaction(), 'Normal', 0, dispatcher), containsAck);
    assert.equal(ctx.client.activeRequests, 0); assert.equal(ctx.queue.snapshot().reserved, 0);
    assert.equal(ctx.claims.snapshot().size, 0);
  }, {handler: async (ctx, res) => {
    await edit(ctx.path, "CREATE TRIGGER reject_hold BEFORE UPDATE OF state ON discord_ingress_journal WHEN NEW.state='held' BEGIN SELECT RAISE(ABORT,'hold persistence failed'); END");
    res.statusCode = 500; res.end('{}');
  }});
});
test('graceful receiver close after reservation still accepts the confirmed queued work', async () => {
  await fixture(async ctx => {
    assert.equal(await ctx.dispatch(), 'Queued');
    const item = ctx.queue.receiver.tryReceive(); if (item.kind !== 'Value') throw new Error('fixture');
    releaseInboundInteractionWork(item.value); assert.deepEqual(ctx.queue.receiver.tryReceive(), {kind: 'Closed'});
  }, {handler: (ctx, res) => {ctx.queue.receiver.close(); res.statusCode = 204; res.end();}});
});
test('receiver disposal after reservation retains late handoff permit until final sender ownership ends', async () => {
  await fixture(async ctx => {
    assert.equal(await ctx.dispatch(), 'Queued');
    assert.deepEqual(ctx.queue.receiver.tryReceive(), {kind: 'Closed'});
    ctx.gate.seal(ctx.fence); assert.equal(ctx.gate.isDrainedFor(ctx.fence), false);
    assert.equal((await state.getIngress(ctx.path, 'interaction:3'))!.state, 'acknowledged');
    ctx.dispatcher.dispose(); assert.equal(ctx.gate.isDrainedFor(ctx.fence), false);
    ctx.queue.sender.dispose(); assert.equal(ctx.gate.isDrainedFor(ctx.fence), true);
  }, {handler: (ctx, res) => {ctx.queue.receiver.dispose(); res.statusCode = 204; res.end();}});
});
test('force during the Node DB-ack await joins the write then holds instead of queueing', async () => {
  await fixture(async ctx => {
    let calls = 0; const reason = new Error('cancel during store acknowledgement');
    const dispatcher = ctx.make({custodyNow: () => {if (++calls === 2) ctx.force.abort(reason); return calls;}});
    await assert.rejects(ctx.dispatch(interaction(), 'Normal', 0, dispatcher), e => e === reason);
    const record = (await state.getIngress(ctx.path, 'interaction:3'))!;
    assert.equal(record.state, 'held'); assert.equal(record.phase, 'acknowledged'); assert.equal(record.holdReason, 'interaction_dispatch_cancelled');
    assert.equal(ctx.queue.snapshot().queued, 0); assert.equal(ctx.claims.snapshot().size, 0);
  });
});
