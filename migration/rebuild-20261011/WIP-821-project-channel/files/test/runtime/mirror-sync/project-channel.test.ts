import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {NativeMirrorStore} from '../../../src/runtime/mirror-sync/store-native.ts';
import {MirrorProjectChannelCoordinator, mirrorProjectChannelName} from '../../../src/runtime/mirror-sync/project-channel.ts';
import {DiscordMirrorContainerTransport} from '../../../src/runtime/mirror-sync/container-http.ts';
import {DiscordChannelClient} from '../../../src/discord/channel-client.ts';
import {ownContainerReceipt, type MirrorContainerReceipt} from '../../../src/store/mirror-container-creation.ts';
const fresh = () => new AbortController().signal;
const room = (extra = {}) => ({id: '3', type: 0, guild_id: '1', parent_id: '2', name: 'codex-project', topic: 'Codex project mirror: project', ...extra});
async function fixture(handler: http.RequestListener, run: (store: NativeMirrorStore, custody: MirrorProjectChannelCoordinator) => Promise<void>) {
  await storeFixture(async path => {
    const server = http.createServer(handler);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const client = await DiscordChannelClient.create({token: null, report: () => {}, testOrigin: `http://127.0.0.1:${address.port}/api/v10/`});
    const store = new NativeMirrorStore(path);
    try { await run(store, new MirrorProjectChannelCoordinator(store, new DiscordMirrorContainerTransport(client))); }
    finally { await client.close(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
}
const local = (extra = {}) => ({id: 3n, kind: 0n, guildId: 1n, parentId: 2n, name: 'codex-project', topic: 'Codex project mirror: project', archived: false, ownerId: null, archiveBefore: null, ...extra});
test('channel name preserves Rust alphabet, dash collapse, prefix and UTF16 bound', () => {
  assert.equal(mirrorProjectChannelName('Hello  🐱 World'), 'codex-hello-world');
  assert.equal(mirrorProjectChannelName('...한글_프로젝트...'), 'codex-한글_프로젝트');
  assert.equal(mirrorProjectChannelName('CODEX-Ready'), 'codex-ready');
  assert.equal(mirrorProjectChannelName('💥'), 'codex');
  assert.equal(mirrorProjectChannelName('가'.repeat(100)).length, 80);
});
test('new project creates once, consumes custody and updates returned inventory without mutating caller', async () => {
  const seen: string[] = [];
  await fixture((request, response) => { seen.push(request.method!); response.end(JSON.stringify(room())); }, async (store, coordinator) => {
    const inventory = Object.freeze([]);
    const result = await coordinator.resolve(1n, 2n, '/project', 'project', inventory, fresh());
    assert.equal(result.channel.id, 3n); assert.equal(result.channels.length, 1); assert.equal(inventory.length, 0);
    assert.deepEqual(await store.execute({kind: 'ProjectSnapshot', args: ['/project']}), [['/project', 3n]]);
    assert.equal(await store.execute({kind: 'ProjectReceipt', args: ['/project', 1n, 2n, [['/project', 3n]]]}), null);
    await coordinator.resolve(1n, 2n, '/project', 'project', result.channels, fresh());
    assert.deepEqual(seen, ['POST', 'GET']);
  });
});
test('adopts exact-topic unowned project without HTTP and preserves existing parent mapping semantics', async () => {
  let calls = 0;
  await fixture((_request, response) => { calls++; response.end('{}'); }, async (store, coordinator) => {
    const result = await coordinator.resolve(1n, 2n, '/project', 'project', [local()], fresh());
    assert.equal(result.channel.id, 3n); assert.equal(calls, 0);
    assert.deepEqual(await store.execute({kind: 'ProjectForChannel', args: [3n]}), ['/project', 'project']);
  });
});
test('unresolved sibling claim prevents inventory adoption and any remote creation', async () => {
  let calls = 0;
  await fixture((_request, response) => { calls++; response.end('{}'); }, async (store, coordinator) => {
    await store.execute({kind: 'BeginProject', args: ['/other', 1n, 2n, []]});
    await assert.rejects(coordinator.resolve(1n, 2n, '/project', 'project', [local()], fresh()));
    assert.equal(calls, 0); assert.deepEqual(await store.execute({kind: 'ProjectSnapshot', args: ['/project']}), []);
  });
});
test('owned inventory room is not stolen; another project creates separately', async () => {
  const seen: string[] = [];
  await fixture((request, response) => { seen.push(request.method!); response.end(JSON.stringify(room({id: '4'}))); }, async (store, coordinator) => {
    await store.execute({kind: 'UpsertProject', args: ['/other', 'other', 3n, 1]});
    assert.equal((await coordinator.resolve(1n, 2n, '/project', 'project', [local()], fresh())).channel.id, 4n);
    assert.deepEqual(await store.execute({kind: 'ProjectForChannel', args: [3n]}), ['/other', 'other']);
    assert.deepEqual(seen, ['POST']);
  });
});
test('renamed existing project uses PATCH and refreshes copied inventory', async () => {
  const seen: string[] = []; const bodies: string[] = [];
  await fixture((request, response) => {
    seen.push(request.method!);
    if (request.method === 'GET') response.end(JSON.stringify(room({name: 'old', topic: 'old'})));
    else { let body = ''; request.on('data', data => { body += data; }); request.on('end', () => { bodies.push(body); response.writeHead(204); response.end(); }); }
  }, async (store, coordinator) => {
    await store.execute({kind: 'UpsertProject', args: ['/project', 'old', 3n, 1]});
    const original = [local({name: 'old', topic: 'old'})];
    const result = await coordinator.resolve(1n, 2n, '/project', 'project', original, fresh());
    assert.equal(result.channel.name, 'codex-project'); assert.equal(result.channels[0]?.topic, 'Codex project mirror: project'); assert.equal(original[0]?.name, 'old');
    assert.deepEqual(seen, ['GET', 'PATCH']); assert.equal(JSON.parse(bodies[0]!).name, 'codex-project');
  });
});
test('name collision appends six-character SHA256 key suffix only for another ID', async () => {
  const bodies: string[] = [];
  await fixture((request, response) => {
    let body = ''; request.on('data', data => { body += data; }); request.on('end', () => { bodies.push(body); response.end(JSON.stringify(room())); });
  }, async (_store, coordinator) => {
    await coordinator.resolve(1n, 2n, '/project', 'project', [local({id: 8n, topic: 'unrelated'})], fresh());
    const {createHash} = await import('node:crypto');
    assert.equal(JSON.parse(bodies[0]!).name, `codex-project-${createHash('sha256').update('/project').digest('hex').slice(0, 6)}`);
  });
});
test('failed PATCH retains prior project name and mapping without create', async () => {
  const seen: string[] = [];
  await fixture((request, response) => {
    seen.push(request.method!); if (request.method === 'GET') response.end(JSON.stringify(room({name: 'old', topic: 'old'})));
    else { response.writeHead(500); response.end('{"code":0,"message":"failed"}'); }
  }, async (store, coordinator) => {
    await store.execute({kind: 'UpsertProject', args: ['/project', 'old', 3n, 1]});
    await assert.rejects(coordinator.resolve(1n, 2n, '/project', 'project', [], fresh()));
    assert.deepEqual(await store.execute({kind: 'ProjectForChannel', args: [3n]}), ['/project', 'old']); assert.deepEqual(seen, ['GET', 'PATCH']);
  });
});
