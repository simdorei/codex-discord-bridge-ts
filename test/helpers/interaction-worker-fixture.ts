import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createInteractionWorkQueue, type InboundInteractionWork} from '../../src/runtime/discord-dispatch/interaction-work.ts';
import {AdmissionGate, DrainFenceKey} from '../../src/admission/drain-gate.ts';
import {StateAccessFacade as state} from '../../src/store/state-access-facade.ts';
import {openInitialized} from '../../src/store/owned-driver.ts';
import {DiscordChannelClient} from '../../src/discord/channel-client.ts';
import {decodeGatewayInteraction} from '../../src/discord/gateway/decoded-interaction.ts';
import {routeGatewayCommand, routeGatewayComponent} from '../../src/discord/interaction-routing.ts';
export function work(db: string, id: bigint, gate: AdmissionGate, customId?: string): InboundInteractionWork {
  const decoded = decodeGatewayInteraction(JSON.stringify({application_id: '4', authorizing_integration_owners: {}, id: String(id), token: 'offline_token', type: customId ? 3 : 2, data: customId ? {custom_id: customId, component_type: 2} : {id: '9', name: 'help', type: 1}}));
  return Object.freeze({applicationId: 4n, interactionId: id, channelId: 1n, userId: 2n, sourceMessageId: customId ? 9n : null, interactionToken: 'offline_token', work: (customId ? routeGatewayComponent(decoded) : routeGatewayCommand(decoded, false)).work,
    processingMode: 'Execute' as const, custodyDatabase: db, custodyIngressId: `interaction:${id}`, authorizedBusyChoice: null, admissionPermit: gate.tryEnter()});
}
export async function stage(w: InboundInteractionWork) {
  await state.admitIngress(w.custodyDatabase, {ingressId: w.custodyIngressId, kind: 'interaction', eventId: w.interactionId, applicationId: w.applicationId, channelId: w.channelId, ownerUserId: w.userId, sourceMessageId: w.sourceMessageId, payload: {work: w.work}, targetThreadId: null, canonicalOwner: w.custodyIngressId, now: 1});
  await state.acknowledgeIngress(w.custodyDatabase, w.custodyIngressId, 2);
}
export function enqueue(queue: ReturnType<typeof createInteractionWorkQueue>, w: InboundInteractionWork) {const r = queue.sender.tryReserve(); assert.equal(r.kind, 'Reserved'); if (r.kind === 'Reserved') r.reservation.send(w);}
export async function httpFixture(run: (http: DiscordChannelClient, seen: string[]) => Promise<void>) {
  const seen: string[] = [], server = createServer((req, res) => {req.resume(); req.on('end', () => {seen.push(req.method!);
    if (req.method === 'PATCH') {res.statusCode = 204; res.end();}
    else res.end(JSON.stringify({attachments: [], author: {id: '1', username: 'u', discriminator: '0'}, channel_id: '1', content: '', embeds: [], id: String(100 + seen.length), type: 0, mention_everyone: false, mention_roles: [], mentions: [], pinned: false, timestamp: '2020-01-01T00:00:00+00:00', tts: false}));
  });});
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); const http = await DiscordChannelClient.create({token: null, testOrigin: `http://127.0.0.1:${(server.address() as {port: number}).port}/api/v10/`, report: () => {}});
  try {await run(http, seen);} finally {await http.close(); server.closeAllConnections(); await new Promise<void>((r, j) => server.close(e => e ? j(e) : r())); assert.equal(http.activeRequests, 0); assert.equal(http.ownedSockets, 0);}
}
export const fence = () => DrainFenceKey.create('runtime', '1|2', 'worker');
export async function edit(db: string, sql: string) {const handle = await openInitialized(db); try {handle.exec(sql);} finally {handle.close();}}
