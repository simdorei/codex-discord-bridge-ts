import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {NativeMirrorStore} from '../../../src/runtime/mirror-sync/store-native.ts';
import {MirrorThreadChannelCoordinator} from '../../../src/runtime/mirror-sync/thread-channel.ts';
import {DiscordNewMirrorTransport} from '../../../src/runtime/mirror-sync/new-mirror-http.ts';
import {DiscordChannelClient} from '../../../src/discord/channel-client.ts';
import {ownContainerReceipt, type MirrorContainerReceipt} from '../../../src/store/mirror-container-creation.ts';
const fresh = () => new AbortController().signal;
const room = (extra = {}) => ({id: '3', type: 11, guild_id: '1', parent_id: '2', name: 'project', topic: 'Codex project mirror: project', ...extra});
async function fixture(handler: http.RequestListener, run: (store: NativeMirrorStore, custody: MirrorThreadChannelCoordinator) => Promise<void>) {
  await storeFixture(async path => {
    const server = http.createServer(handler);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const client = await DiscordChannelClient.create({token: null, report: () => {}, testOrigin: `http://127.0.0.1:${address.port}/api/v10/`});
    const store = new NativeMirrorStore(path);
    try { await run(store, new MirrorThreadChannelCoordinator(store, new DiscordNewMirrorTransport(client))); }
    finally { await client.close(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
}
const scope = {thread: 'thread', guild: 1n, parent: 2n, expected: null};
test('pre-epoch clock leaves confirmed thread creation unbound without mapping', async context => {
  await fixture((_request, response) => response.end(JSON.stringify(room())), async (store, coordinator) => {
    context.mock.method(Date, 'now', () => -1);
    try {
      await assert.rejects(coordinator.sync(1n, 2n, 'thread', '/project', 'project', fresh()), /before the Unix epoch/);
      assert.equal(await store.execute({kind: 'ThreadChannels', args: ['thread']}), null);
      assert.equal(await store.execute({kind: 'ConfirmedThreadCreation', args: [scope]}), 3n);
    } finally { context.mock.restoreAll(); }
  });
});
const update = (channelId = 3n) => ({threadId: 'thread', projectKey: '/project', title: 'project', parentId: 2n, channelId, now: 1});
test('one native thread creation commits exact mapping and replay only reads channel', async () => {
  const seen: string[] = [];
  await fixture((request, response) => { seen.push(request.method!); response.end(JSON.stringify(room())); }, async (store, coordinator) => {
    assert.equal(await coordinator.sync(1n, 2n, 'thread', '/project', 'project', fresh()), 3n);
    assert.deepEqual(await store.execute({kind: 'ThreadChannels', args: ['thread']}), [2n, 3n]);
    assert.equal(await store.execute({kind: 'ConfirmedThreadCreation', args: [{...scope, expected: [2n, 3n]}]}), null);
    assert.equal(await coordinator.sync(1n, 2n, 'thread', '/project', 'project', fresh()), 3n);
    assert.deepEqual(seen, ['POST', 'GET']);
  });
});
test('unknown creation leaves attempted record and refuses second POST', async () => {
  let calls = 0;
  await fixture((_request, response) => { calls++; response.end('{}'); }, async (store, coordinator) => {
    await assert.rejects(coordinator.sync(1n, 2n, 'thread', '/project', 'project', fresh()));
    await assert.rejects(coordinator.sync(1n, 2n, 'thread', '/project', 'project', fresh()));
    assert.equal(calls, 1); assert.equal(await store.execute({kind: 'ThreadChannels', args: ['thread']}), null);
  });
});
test('confirmed missing thread never creates a replacement', async () => {
  const seen: string[] = [];
  await fixture((request, response) => { seen.push(request.method!); response.writeHead(404); response.end('{"code":10003,"message":"gone"}'); }, async (store, coordinator) => {
    const token = await store.execute({kind: 'BeginThreadCreation', args: [scope]}) as string;
    await store.execute({kind: 'ConfirmThreadCreation', args: [scope, token, 3n]});
    await assert.rejects(coordinator.sync(1n, 2n, 'thread', '/project', 'project', fresh()), /creation will not be repeated/);
    assert.deepEqual(seen, ['GET']);
  });
});
test('confirmed thread exact ID is verified before binding', async () => {
  await fixture((_request, response) => response.end(JSON.stringify(room({id: '9'}))), async (store, coordinator) => {
    const token = await store.execute({kind: 'BeginThreadCreation', args: [scope]}) as string;
    await store.execute({kind: 'ConfirmThreadCreation', args: [scope, token, 3n]});
    await assert.rejects(coordinator.sync(1n, 2n, 'thread', '/project', 'project', fresh()), /identity changed/);
    assert.equal(await store.execute({kind: 'ThreadChannels', args: ['thread']}), null);
  });
});
test('existing mapping with fresh404 can create and replace using original pair CAS', async () => {
  const seen: string[] = [];
  await fixture((request, response) => {
    seen.push(request.method!); if (request.method === 'GET') { response.writeHead(404); response.end('{"code":10003,"message":"gone"}'); }
    else response.end(JSON.stringify(room({id: '4'})));
  }, async (store, coordinator) => {
    await store.execute({kind: 'CommitThread', args: [update(), null]});
    assert.equal(await coordinator.sync(1n, 2n, 'thread', '/project', 'project', fresh()), 4n);
    assert.deepEqual(await store.execute({kind: 'ThreadChannels', args: ['thread']}), [2n, 4n]); assert.deepEqual(seen, ['GET', 'POST']);
  });
});
test('renamed existing thread PATCH occurs before mapping commit', async () => {
  const seen: string[] = []; const bodies: string[] = [];
  await fixture((request, response) => {
    seen.push(request.method!); if (request.method === 'GET') response.end(JSON.stringify(room({name: 'old'})));
    else { let body = ''; request.on('data', value => { body += value; }); request.on('end', () => { bodies.push(body); response.writeHead(204); response.end(); }); }
  }, async (store, coordinator) => {
    await store.execute({kind: 'CommitThread', args: [update(), null]});
    assert.equal(await coordinator.sync(1n, 2n, 'thread', '/project', 'project', fresh()), 3n);
    assert.deepEqual(seen, ['GET', 'PATCH']); assert.deepEqual(JSON.parse(bodies[0]!), {archived: false, name: 'project'});
  });
});
test('wrong public thread parent fails without changing original mapping', async () => {
  const seen: string[] = [];
  await fixture((request, response) => { seen.push(request.method!); response.end(JSON.stringify(room({parent_id: '9'}))); }, async (store, coordinator) => {
    await store.execute({kind: 'CommitThread', args: [update(), null]});
    await assert.rejects(coordinator.sync(1n, 2n, 'thread', '/project', 'project', fresh()), /wrong guild, kind, or parent/);
    assert.deepEqual(await store.execute({kind: 'ThreadChannels', args: ['thread']}), [2n, 3n]); assert.deepEqual(seen, ['GET']);
  });
});
test('native mapping CAS rejects stale expected pair', async () => {
  await fixture((_request, response) => response.end('{}'), async (store, _coordinator) => {
    await store.execute({kind: 'CommitThread', args: [update(), null]});
    await assert.rejects(store.execute({kind: 'CommitThread', args: [update(4n), null]}));
    assert.deepEqual(await store.execute({kind: 'ThreadChannels', args: ['thread']}), [2n, 3n]);
  });
});
