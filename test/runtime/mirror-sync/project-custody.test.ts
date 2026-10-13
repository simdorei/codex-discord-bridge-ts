import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {NativeMirrorStore} from '../../../src/runtime/mirror-sync/store-native.ts';
import {MirrorProjectCustody} from '../../../src/runtime/mirror-sync/project-custody.ts';
import {DiscordMirrorContainerTransport} from '../../../src/runtime/mirror-sync/container-http.ts';
import {DiscordChannelClient} from '../../../src/discord/channel-client.ts';
import {ownContainerReceipt, type MirrorContainerReceipt} from '../../../src/store/mirror-container-creation.ts';
const fresh = () => new AbortController().signal;
const room = (extra = {}) => ({id: '3', type: 0, guild_id: '1', parent_id: '2', name: 'project', topic: 'Codex project mirror: project', ...extra});
async function fixture(handler: http.RequestListener, run: (store: NativeMirrorStore, custody: MirrorProjectCustody) => Promise<void>) {
  await storeFixture(async path => {
    const server = http.createServer(handler);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const client = await DiscordChannelClient.create({token: null, report: () => {}, testOrigin: `http://127.0.0.1:${address.port}/api/v10/`});
    const store = new NativeMirrorStore(path);
    try { await run(store, new MirrorProjectCustody(store, new DiscordMirrorContainerTransport(client))); }
    finally { await client.close(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
}
async function seed(store: NativeMirrorStore) {
  const receipt = ownContainerReceipt(await store.execute({kind: 'BeginProject', args: ['/project', 1n, 2n, []]}) as MirrorContainerReceipt);
  await store.execute({kind: 'ConfirmContainer', args: [receipt, 3n]});
}
test('project intent precedes POST, confirmation survives readback and is consumed only by atomic mapping', async () => {
  const seen: string[] = [];
  await fixture((request, response) => { seen.push(request.method!); response.end(JSON.stringify(room())); }, async (store, custody) => {
    assert.equal(await custody.confirmed(1n, 2n, '/project', [], fresh()), null);
    assert.equal((await custody.create(1n, 2n, '/project', [], 'project', 'Codex project mirror: project', fresh())).id, 3n);
    const receipt = ownContainerReceipt(await store.execute({kind: 'ProjectReceipt', args: ['/project', 1n, 2n, []]}) as MirrorContainerReceipt);
    assert.equal(receipt.phase, 'confirmed');
    assert.equal((await custody.confirmed(1n, 2n, '/project', [], fresh()))?.id, 3n);
    await assert.rejects(custody.create(1n, 2n, '/project', [], 'project', 'topic', fresh()));
    assert.deepEqual(seen, ['POST', 'GET']);
    await store.execute({kind: 'UpsertProject', args: ['/project', 'project', 3n, 123]});
    assert.deepEqual(await store.execute({kind: 'ProjectSnapshot', args: ['/project']}), [['/project', 3n]]);
    assert.equal(await custody.confirmed(1n, 2n, '/project', [['/project', 3n]], fresh()), null);
  });
});
test('unknown project create response retains claim and never repeats POST', async () => {
  let calls = 0;
  await fixture((_request, response) => { calls++; response.end('{"id":"3"}'); }, async (_store, custody) => {
    await assert.rejects(custody.create(1n, 2n, '/project', [], 'project', 'topic', fresh()));
    await assert.rejects(custody.confirmed(1n, 2n, '/project', [], fresh()));
    await assert.rejects(custody.create(1n, 2n, '/project', [], 'project', 'topic', fresh()));
    assert.equal(calls, 1);
  });
});
test('confirmed exact project404 stays held without replacement', async () => {
  const seen: string[] = [];
  await fixture((request, response) => { seen.push(request.method!); response.writeHead(404); response.end('{"code":10003,"message":"gone"}'); }, async (store, custody) => {
    await seed(store);
    await assert.rejects(custody.confirmed(1n, 2n, '/project', [], fresh()), /creation not repeated/);
    await assert.rejects(custody.create(1n, 2n, '/project', [], 'project', 'topic', fresh()));
    assert.deepEqual(seen, ['GET']);
  });
});
test('changed response identity, parent, guild and kind fail before mapping', async () => {
  for (const extra of [{id: '9'}, {parent_id: '9'}, {guild_id: '9'}, {type: 4}]) {
    await fixture((_request, response) => response.end(JSON.stringify(room(extra))), async (store, custody) => {
      await seed(store);
      await assert.rejects(custody.confirmed(1n, 2n, '/project', [], fresh()), /identity changed|wrong guild, kind, or parent/);
      assert.deepEqual(await store.execute({kind: 'ProjectSnapshot', args: ['/project']}), []);
    });
  }
});
test('stale expected project mapping blocks intent before HTTP', async () => {
  let calls = 0;
  await fixture((_request, response) => { calls++; response.end(JSON.stringify(room())); }, async (store, custody) => {
    await store.execute({kind: 'UpsertProject', args: ['/project', 'project', 8n, 123]});
    await assert.rejects(custody.create(1n, 2n, '/project', [], 'project', 'topic', fresh()));
    assert.equal(calls, 0);
    assert.deepEqual(await store.execute({kind: 'ProjectSnapshot', args: ['/project']}), [['/project', 8n]]);
  });
});
test('pre-cancel and invalid IDs do not admit a project intent', async () => {
  let calls = 0;
  await fixture((_request, response) => { calls++; response.end(JSON.stringify(room())); }, async (_store, custody) => {
    const abort = new AbortController(); const reason = new Error('cancel'); abort.abort(reason);
    await assert.rejects(custody.create(1n, 2n, '/project', [], 'project', 'topic', abort.signal), error => error === reason);
    await assert.rejects(custody.create(0n, 2n, '/project', [], 'project', 'topic', fresh()), TypeError);
    assert.equal(await custody.confirmed(1n, 2n, '/project', [], fresh()), null);
    assert.equal(calls, 0);
  });
});
test('wrong create parent retains unresolved creation and blocks any second create', async () => {
  let calls = 0;
  await fixture((_request, response) => { calls++; response.end(JSON.stringify(room({parent_id: '9'}))); }, async (_store, custody) => {
    await assert.rejects(custody.create(1n, 2n, '/project', [], 'project', 'topic', fresh()), /wrong guild, kind, or parent/);
    await assert.rejects(custody.create(1n, 2n, '/project', [], 'project', 'topic', fresh()));
    assert.equal(calls, 1);
  });
});
