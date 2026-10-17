import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer, type ServerResponse} from 'node:http';
import {setImmediate as tick} from 'node:timers/promises';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {DiscordChannelClient} from '../../../src/discord/channel-client.ts';
import {ExecutionCustody} from '../../../src/runtime/interaction-worker/execution-custody.ts';
import {deliverCleanupRefusal} from '../../../src/runtime/interaction-worker/cleanup-refusal-delivery.ts';
import {cleanupNotificationFailureInfo} from '../../../src/runtime/cleanup-notification-failure.ts';
import type {InboundInteractionWork} from '../../../src/runtime/discord-dispatch/interaction-work.ts';
import {CLEANUP_REFUSAL_REASONS} from '../../../src/store/async-resolution-cleanup-refusal.ts';
const key = 'interaction:3';
async function fixture(run: (f: {path: string; work: InboundInteractionWork; custody: ExecutionCustody; client: DiscordChannelClient;
  signal: AbortSignal; abort: AbortController; requests: {method: string; url: string; body: any}[];
}) => Promise<void>, respond?: (path: string, response: ServerResponse) => Promise<void>) {
  await storeFixture(async path => {
    await state.admitIngress(path, {ingressId: key, kind: 'interaction', eventId: 3n, applicationId: 4n, channelId: 1n,
      ownerUserId: 2n, sourceMessageId: null, payload: {}, targetThreadId: null, canonicalOwner: key, now: 1});
    const custody = await ExecutionCustody.begin(path, path, key, 'Execute', {now: () => 3, report: () => {}});
    const requests: {method: string; url: string; body: any}[] = [], serverErrors: unknown[] = [], serverJobs: Promise<void>[] = [];
    const server = createServer((req, res) => {let raw = ''; req.on('data', b => {raw += b;}); req.on('end', () => {
      requests.push({method: req.method!, url: req.url!, body: JSON.parse(raw)});
      serverJobs.push(Promise.resolve().then(async () => {assert.equal(req.headers.authorization, undefined);
        const row = (await state.getIngress(path, key))!; assert.equal(row.phase, 'result_recorded'); assert.equal(row.confirmationDelivered, false);
        if (respond) await respond(path, res); else {res.statusCode = 204; res.end();}
      }).catch(error => {serverErrors.push(error); res.statusCode = 500; res.end('{}');}));
    });});
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const client = await DiscordChannelClient.create({token: null, testOrigin: `http://127.0.0.1:${(server.address() as {port: number}).port}/api/v10/`, report: () => {}});
    const abort = new AbortController(), work = {applicationId: 4n, interactionToken: 'offline_token', custodyDatabase: path, custodyIngressId: key} as InboundInteractionWork;
    try {await run({path, client, custody, work, signal: abort.signal, abort, requests}); assert.deepEqual(serverErrors, []);}
    finally {abort.abort(); await client.close(); await Promise.all(serverJobs); await custody.dispose(); server.closeAllConnections(); await new Promise<void>((r, j) => server.close(e => e ? j(e) : r()));
      assert.equal(client.activeRequests, 0); assert.equal(client.ownedSockets, 0);}
  });
}
const refusal = {room: 9n, reason: 'queued requests'};
test('persists known refusal before one PATCH; subsequent confirmation preserves sync_completed false', async () => {
  await fixture(async f => {
    assert.equal(await deliverCleanupRefusal(f.work, f.custody, f.client, refusal, f.signal), false);
    assert.equal(f.requests.length, 1); assert.equal(f.requests[0]!.method, 'PATCH'); assert.equal(f.requests[0]!.url, '/api/v10/webhooks/4/offline_token/messages/@original');
    assert.deepEqual(f.requests[0]!.body, {allowed_mentions: {parse: []}, content: 'Mirror sync stopped.\nroom: 9\nreason: queued requests\nNo deletion was dispatched for this room. Earlier sync changes may have completed.\nPending work is preserved; this request will not retry automatically.'});
    await f.custody.finishNotification({action_completed: true}); const row = (await state.getIngress(f.path, key))!;
    assert.equal(row.confirmationDelivered, true); assert.equal((row.outcome as {sync_completed: boolean}).sync_completed, false);
  });
});
test('failed PATCH is held as a known outcome, never replaced by a follow-up POST', async () => {
  await fixture(async f => {
    await assert.rejects(deliverCleanupRefusal(f.work, f.custody, f.client, refusal), e => cleanupNotificationFailureInfo(e)?.holdSaved === true);
    assert.equal(f.requests.length, 1); assert.equal(f.requests[0]!.method, 'PATCH');
    const row = (await state.getIngress(f.path, key))!; assert.equal(row.state, 'held'); assert.equal(row.phase, 'result_recorded');
    assert.equal((row.outcome as {delete_dispatched: boolean}).delete_dispatched, false); assert.match(row.holdReason, /notification delivery unconfirmed/);
  }, async (_path, res) => {res.statusCode = 400; res.end('{"code":50035,"message":"offline"}');});
});
test('failed result persistence prevents all network work', async () => {
  await fixture(async f => {
    const db = await openInitialized(f.path); try {db.exec("CREATE TRIGGER fail_result BEFORE UPDATE OF outcome_json ON discord_ingress_journal BEGIN SELECT RAISE(ABORT,'cannot save'); END");} finally {db.close();}
    await assert.rejects(deliverCleanupRefusal(f.work, f.custody, f.client, refusal), /cannot save/); assert.equal(f.requests.length, 0);
  });
});
test('invalid refusal is rejected before any result or HTTP side effect', async () => {
  await fixture(async f => {
    for (const value of [{room: 0n, reason: refusal.reason}, {room: 1n << 63n, reason: refusal.reason}, {room: 9n, reason: 'made up'}]) await assert.rejects(deliverCleanupRefusal(f.work, f.custody, f.client, value), TypeError);
    assert.equal(f.requests.length, 0); assert.equal((await state.getIngress(f.path, key))!.outcome, undefined);
  });
});
test('every exact protection reason is supported without losing pre-effect flags', async () => {
  for (const reason of CLEANUP_REFUSAL_REASONS) await fixture(async f => {
    await deliverCleanupRefusal(f.work, f.custody, f.client, {room: 9n, reason});
    assert.ok(f.requests[0]!.body.content.includes('reason: ' + reason + '\n'));
    const outcome = (await state.getIngress(f.path, key))!.outcome as Record<string, unknown>;
    assert.equal(outcome.protection_reason, reason); assert.equal(outcome.earlier_changes_possible, true); assert.equal(outcome.delete_dispatched, false);
  });
});
test('cancellation joins actual PATCH and retains its exact cause behind known-outcome boundary', async () => {
  await fixture(async f => {
    const task = deliverCleanupRefusal(f.work, f.custody, f.client, refusal, f.signal), reason = new Error('force stopped');
    const rejected = assert.rejects(task, e => cleanupNotificationFailureInfo(e)?.source === reason);
    const deadline = performance.now() + 2000; while (f.requests.length === 0 && performance.now() < deadline) await tick();
    assert.equal(f.requests.length, 1); f.abort.abort(reason); await rejected; assert.equal(f.client.activeRequests, 0);
    assert.equal((await state.getIngress(f.path, key))!.state, 'held');
  }, async () => {});
});
test('mutable caller envelope is captured before result persistence awaits', async () => {
  await fixture(async f => {
    const mutable = {...f.work}, input = {...refusal};
    const task = deliverCleanupRefusal(mutable, f.custody, f.client, input, f.signal);
    mutable.applicationId = 99n; mutable.interactionToken = 'changed'; mutable.custodyDatabase = 'missing'; input.room = 100n;
    await task; assert.equal(f.requests[0]!.url, '/api/v10/webhooks/4/offline_token/messages/@original');
    assert.match(f.requests[0]!.body.content, /room: 9\n/);
  });
});
test('pre-aborted call makes no result transition; unsupported token after persistence becomes known delivery failure', async () => {
  await fixture(async f => {
    const reason = new Error('not started'); f.abort.abort(reason);
    await assert.rejects(deliverCleanupRefusal(f.work, f.custody, f.client, refusal, f.signal), e => e === reason);
    assert.equal((await state.getIngress(f.path, key))!.outcome, undefined); assert.equal(f.requests.length, 0);
    await assert.rejects(deliverCleanupRefusal({...f.work, interactionToken: 'bad/token'}, f.custody, f.client, refusal), e => cleanupNotificationFailureInfo(e)?.holdSaved === true);
    assert.equal((await state.getIngress(f.path, key))!.state, 'held'); assert.equal(f.requests.length, 0);
  });
});
