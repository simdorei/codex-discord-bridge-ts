import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {InteractionWorkerError, interactionErrorDisposition} from '../../../src/runtime/interaction-worker/errors.ts';
import {reportInteractionError} from '../../../src/runtime/interaction-worker/error-report.ts';
import {ComponentWorkerError} from '../../../src/runtime/component-worker/errors.ts';
import {BusyComponentError} from '../../../src/runtime/component-worker/busy-errors.ts';
import {ConfirmationError} from '../../../src/runtime/component-worker/confirmation.ts';
import {ExecutionCustody} from '../../../src/runtime/interaction-worker/execution-custody.ts';
import {recordCleanupNotificationFailure} from '../../../src/runtime/cleanup-notification-failure.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {DiscordChannelClient} from '../../../src/discord/channel-client.ts';
import {decodeGatewayInteraction} from '../../../src/discord/gateway/decoded-interaction.ts';
import {routeGatewayComponent, routeGatewayCommand} from '../../../src/discord/interaction-routing.ts';
import type {InboundInteractionWork} from '../../../src/runtime/discord-dispatch/interaction-work.ts';
import {storeFixture} from '../../helpers/store-fixture.ts';
const error = (kind: ConstructorParameters<typeof ComponentWorkerError>[0], source?: unknown) => new InteractionWorkerError('Component', new ComponentWorkerError(kind, source));
function work(path: string, component = true, interaction = 3n): InboundInteractionWork {
  const decoded = decodeGatewayInteraction(JSON.stringify({application_id: '4', authorizing_integration_owners: {}, id: String(interaction), token: 'offline_token', type: component ? 3 : 2,
    data: component ? {custom_id: 'codex_approval:t:1', component_type: 2} : {id: '8', name: 'help', type: 1}}));
  return {applicationId: 4n, interactionId: interaction, channelId: 1n, userId: 2n, sourceMessageId: 9n, interactionToken: 'offline_token',
    work: (component ? routeGatewayComponent(decoded) : routeGatewayCommand(decoded, false)).work, processingMode: 'Execute', custodyDatabase: path, custodyIngressId: 'original', authorizedBusyChoice: null, admissionPermit: null};
}
async function fixture(run: (db: string, client: DiscordChannelClient, seen: {method: string; path: string; body: any}[]) => Promise<void>, fail = false) {
  await storeFixture(async db => {
    const seen: {method: string; path: string; body: any}[] = [], server = createServer((req, res) => {let body = ''; req.on('data', b => {body += b;}); req.on('end', () => {
      seen.push({method: req.method!, path: req.url!, body: JSON.parse(body)});
      if (fail) {res.statusCode = 400; res.end('{"code":50035,"message":"fixture rejection"}');}
      else if (req.method === 'PATCH') {res.statusCode = 204; res.end();}
      else res.end(JSON.stringify({attachments: [], author: {id: '1', username: 'u', discriminator: '0'}, channel_id: '1', content: '', embeds: [], id: String(100 + seen.length), type: 0, mention_everyone: false, mention_roles: [], mentions: [], pinned: false, timestamp: '2020-01-01T00:00:00+00:00', tts: false}));
    });});
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); const client = await DiscordChannelClient.create({token: null, testOrigin: `http://127.0.0.1:${(server.address() as {port: number}).port}/api/v10/`, report: () => {}});
    try {await run(db, client, seen);} finally {await client.close(); server.closeAllConnections(); await new Promise<void>((r, j) => server.close(e => e ? j(e) : r())); assert.equal(client.activeRequests, 0); assert.equal(client.ownedSockets, 0);}
  });
}
test('central disposition distinguishes duplicates, uncertain actions and reportable failures without string heuristics', () => {
  for (const nested of [false, true]) {
    const make = (k: 'AlreadyHandled' | 'ActionUnconfirmed' | 'ActionOutcomeIndeterminate' | 'Confirmation') => nested ? error('Busy', new BusyComponentError(k, 'fixture')) : error(k, 'fixture');
    assert.equal(interactionErrorDisposition(make('AlreadyHandled')), 'IgnoreDuplicate');
    for (const k of ['ActionUnconfirmed', 'ActionOutcomeIndeterminate', 'Confirmation'] as const) assert.equal(interactionErrorDisposition(make(k)), 'LogOnly');
  }
  for (const e of [error('NoPendingRequest'), error('Authority', new Error('fixture')), error('Busy', new BusyComponentError('WrongUser')), new InteractionWorkerError('Action', new Error('AlreadyHandled'))]) assert.equal(interactionErrorDisposition(e), 'Report');
  assert.equal(interactionErrorDisposition(Object.create(InteractionWorkerError.prototype)), 'Report');
  assert.throws(() => new InteractionWorkerError('KnownOutcomeNotification', {}), TypeError); assert.throws(() => new InteractionWorkerError('Component', Object.create(ComponentWorkerError.prototype)), TypeError);
});
test('duplicate is a complete no-op; uncertain and confirmation failures log without HTTP', async () => {
  await reportInteractionError(null as any, error('AlreadyHandled'), null as any, null as any);
  await fixture(async (db, http, seen) => {
    const logs: string[] = [];
    for (const e of [error('ActionUnconfirmed'), error('ActionOutcomeIndeterminate', 'offline_token uncertain'), error('Confirmation', new ConfirmationError('Clear', 'fixture'))]) await reportInteractionError(work(db), e, http, (code, text) => {logs.push(code + ':' + text);});
    assert.equal(seen.length, 0); assert.equal(logs.length, 3); assert.ok(logs.every(s => s.startsWith('interaction_notification_recovery_error:'))); assert.ok(logs.every(s => !s.includes('offline_token')));
  });
});
test('known persisted cleanup refusal notification failure logs only and preserves recorded outcome', async () => {
  await fixture(async (db, http, seen) => {
    await state.admitIngress(db, {ingressId: 'original', kind: 'interaction', eventId: 3n, applicationId: 4n, channelId: 1n, ownerUserId: 2n, sourceMessageId: null, payload: {}, targetThreadId: null, canonicalOwner: 'original', now: 1});
    const custody = await ExecutionCustody.begin(db, db, 'original', 'Execute', {now: () => 2, report: () => {}});
    const outcome = {kind: 'mirror_cleanup_refused', version: 1n, sync_completed: false, delete_dispatched: false, earlier_changes_possible: true, blocked_room_id: 9n, protection_reason: 'queued requests'};
    try {
      await custody.recordResult(outcome); const e = await recordCleanupNotificationFailure(db, 'original', 'delivery', new Error('fixture'), () => 3), logs: string[] = [];
      await reportInteractionError(work(db), new InteractionWorkerError('KnownOutcomeNotification', e), http, (code) => {logs.push(code);});
      assert.equal(logs.length, 1); assert.equal(seen.length, 0); assert.deepEqual((await state.getIngress(db, 'original'))!.outcome, outcome);
    } finally {await custody.dispose();}
  });
});
test('component errors use durable channel receipt and repeat identical report sends no second HTTP', async () => {
  await fixture(async (db, http, seen) => {
    const logs: string[] = [], report = (_code: string, text: string) => {logs.push(text);}; const w = work(db), e = error('NoPendingRequest');
    await reportInteractionError(w, e, http, report); await reportInteractionError(w, e, http, report);
    assert.equal(seen.length, 1); assert.equal(seen[0]!.method, 'POST'); assert.equal(seen[0]!.path, '/api/v10/channels/1/messages'); assert.equal(seen[0]!.body.content, 'ERROR: no matching pending app-server request is available');
    assert.deepEqual(seen[0]!.body.allowed_mentions, {parse: []}); assert.equal(logs.length, 0);
  });
});
test('same component report identity with changed error text is held rather than overwriting previous receipt', async () => {
  await fixture(async (db, http, seen) => {
    const logs: string[] = [], report = (_code: string, text: string) => {logs.push(text);};
    await reportInteractionError(work(db), error('NoPendingRequest'), http, report);
    await reportInteractionError(work(db), error('LegacyComponentExpired'), http, report);
    assert.equal(seen.length, 1); assert.equal(logs.length, 1); assert.match(logs[0]!, /additionally failed to report/);
    await reportInteractionError(work(db, true, 4n), error('LegacyComponentExpired'), http, report); assert.equal(seen.length, 2);
  });
});
test('ordinary errors update original interaction and use indexed channel chunks for overflow', async () => {
  await fixture(async (db, http, seen) => {
    await reportInteractionError(work(db, false), new InteractionWorkerError('Action', 'x'.repeat(2000)), http, () => {});
    assert.deepEqual(seen.map(v => v.method), ['PATCH', 'POST']); assert.equal(seen[0]!.path, '/api/v10/webhooks/4/offline_token/messages/@original');
    assert.ok(seen[1]!.body.nonce); assert.equal(seen[1]!.body.enforce_nonce, true);
  });
});
test('component report HTTP failure is joined and logged once, with no interaction PATCH fallback', async () => {
  await fixture(async (db, http, seen) => {
    const logs: string[] = []; await reportInteractionError(work(db), error('NoPendingRequest'), http, (code, text) => {logs.push(code + ':' + text);});
    assert.equal(seen.length, 1); assert.equal(seen[0]!.method, 'POST'); assert.equal(logs.length, 1); assert.ok(logs[0]!.startsWith('interaction_error_report_failed:'));
  }, true);
});
test('passive error formatting never invokes getters/coercion and literal interaction token is redacted from delivery', async () => {
  let hooks = 0; const e = new InteractionWorkerError('Action', {get message() {hooks++; return 'secret';}, toString() {hooks++; return 'secret';}}); assert.equal(hooks, 0);
  await fixture(async (db, http, seen) => {
    await reportInteractionError(work(db, false), new InteractionWorkerError('Action', 'offline_token failed'), http, () => {});
    assert.equal(seen[0]!.body.content, 'ERROR: [redacted] failed');
    await assert.rejects(reportInteractionError(work(db), Object.create(InteractionWorkerError.prototype), http, () => {}), TypeError);
  });
});
