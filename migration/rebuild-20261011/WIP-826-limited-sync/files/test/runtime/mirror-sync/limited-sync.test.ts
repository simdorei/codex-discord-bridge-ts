import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {dirname, join} from 'node:path';
import {writeFileSync, linkSync, readFileSync} from 'node:fs';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {DiscordChannelClient} from '../../../src/discord/channel-client.ts';
import {TargetLocks} from '../../../src/core/keyed-locks.ts';
import {LimitedMirrorSynchronizer} from '../../../src/runtime/mirror-sync/limited-sync.ts';
import {NativeMirrorStore} from '../../../src/runtime/mirror-sync/store-native.ts';
const fresh = () => new AbortController().signal;
type Room = {id: string; type: number; guild_id: string; parent_id?: string; name: string; topic?: string};
async function fixture(run: (f: {sync: LimitedMirrorSynchronizer; store: NativeMirrorStore; locks: TargetLocks; calls: string[]; rooms: Map<string, Room>; client: DiscordChannelClient; codex: string; mirror: string}) => Promise<void>) {
  await storeFixture(async mirror => {
    const codex = join(dirname(mirror), 'codex.sqlite'), rollout = join(dirname(mirror), 'rollout.jsonl'); writeFileSync(rollout, '{}');
    const db = new DatabaseSync(codex);
    try {
      db.exec('CREATE TABLE threads(id TEXT,title TEXT,cwd TEXT,updated_at INTEGER,rollout_path TEXT,model TEXT,reasoning_effort TEXT,tokens_used INTEGER,archived INTEGER,archived_at INTEGER,source TEXT,thread_source TEXT)');
      const insert = db.prepare("INSERT INTO threads VALUES(?,?,'/project',?,?,NULL,NULL,0,0,0,'cli','user')");
      insert.run('a', 'First', 1, rollout); insert.run('b', 'Second', 2, rollout); insert.run('missing', 'Missing', 3, rollout + '.missing');
    } finally { db.close(); }
    writeFileSync(join(dirname(codex), 'session_index.jsonl'), JSON.stringify({id: 'a', thread_name: 'From index'}) + '\n');
    const calls: string[] = [], rooms = new Map<string, Room>([['10', {id: '10', type: 4, guild_id: '1', name: 'Codex'}]]); let next = 30;
    const server = http.createServer((request, response) => {
      calls.push(`${request.method} ${request.url}`); let body = '';
      request.on('data', bytes => { body += bytes; });
      request.on('end', () => {
        if (request.method === 'GET' && request.url === '/api/v10/guilds/1/channels') { response.end(JSON.stringify([...rooms.values()].filter(room => room.type !== 11))); return; }
        if (request.method === 'GET') { const room = rooms.get(request.url!.split('/').at(-1)!); if (!room) { response.writeHead(404); response.end('{"code":10003,"message":"gone"}'); } else response.end(JSON.stringify(room)); return; }
        if (request.method === 'POST') {
          const value = JSON.parse(body), thread = request.url!.endsWith('/threads'), id = thread ? String(next++) : '20';
          const room: Room = {id, type: thread ? 11 : value.type, guild_id: '1', parent_id: thread ? '20' : value.parent_id, name: value.name, ...(value.topic === undefined ? {} : {topic: value.topic})}; rooms.set(id, room); response.end(JSON.stringify(room)); return;
        }
        if (request.method === 'PATCH') { Object.assign(rooms.get(request.url!.split('/').at(-1)!)!, JSON.parse(body)); response.writeHead(204); response.end(); return; }
        response.writeHead(500); response.end('{"code":0,"message":"unexpected"}');
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address !== 'string');
    const client = await DiscordChannelClient.create({token: null, report: () => {}, testOrigin: `http://127.0.0.1:${address.port}/api/v10/`}), locks = new TargetLocks();
    try { const sync = await LimitedMirrorSynchronizer.create(codex, mirror, client, locks, 1n, fresh()); await run({sync, store: new NativeMirrorStore(mirror), locks, calls, rooms, client, codex, mirror}); }
    finally { await client.close(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); assert.equal(locks.activeTargetCount, 0); }
  });
}
test('real limited sync combines scope, category/project/thread custody, index titles and mapping commits', async () => fixture(async f => {
  const before = readFileSync(f.codex), result = await f.sync.sync(10n, 100n);
  assert.deepEqual(result, {projects: 1, threads: 2, unavailable: 1, archived: 0, orphanDeleted: 0, projectsDeleted: 0, limited: true});
  assert.equal(f.rooms.get('30')?.name, 'From index'); assert.equal(f.rooms.get('31')?.name, 'Second');
  assert.deepEqual(await f.store.execute({kind: 'ThreadChannels', args: ['a']}), [20n, 30n]);
  assert.equal(f.calls.filter(call => call.startsWith('POST')).length, 3);
  assert.equal(f.calls.some(call => call.startsWith('DELETE')), false); assert.deepEqual(readFileSync(f.codex), before);
  await f.sync.sync(10n, 100n); assert.equal(f.calls.filter(call => call.startsWith('POST')).length, 3);
}));
test('limited sync preserves preexisting mappings outside its explicit selected window', async () => fixture(async f => {
  await f.store.execute({kind: 'CommitThread', args: [{threadId: 'outside', projectKey: '/old', title: 'Old', parentId: 88n, channelId: 99n, now: 1}, null]});
  const result = await f.sync.sync(10n, 1n); assert.equal(result.threads, 0); assert.equal(result.unavailable, 1);
  assert.deepEqual(await f.store.execute({kind: 'ThreadChannels', args: ['outside']}), [88n, 99n]); assert.equal(f.calls.some(call => call.startsWith('DELETE')), false);
}));
test('unknown cleanup custody blocks before any remote inventory or create', async () => fixture(async f => {
  await f.store.execute({kind: 'BeginCleanup', args: [99n, null, 1]});
  await assert.rejects(f.sync.sync(10n, 100n), /manual reconciliation/); assert.deepEqual(f.calls, []);
}));
test('cancelled global lock waiter never cancels or releases current owner', async () => fixture(async f => {
  const lease = await f.locks.acquire('mirror-sync-operation'), abort = new AbortController(), reason = new Error('cancel waiter');
  try { const pending = f.sync.sync(10n, 100n, abort.signal), observed = assert.rejects(pending, error => error === reason); abort.abort(reason); await observed; lease.requireTarget('mirror-sync-operation'); assert.equal(f.locks.activeTargetCount, 1); assert.deepEqual(f.calls, []); }
  finally { lease.release(); }
}));
test('null limit cannot silently enter unlimited cleanup and preabort makes no requests', async () => fixture(async f => {
  await assert.rejects(f.sync.sync(10n, null as unknown as bigint), TypeError);
  const abort = new AbortController(), reason = new Error('cancel'); abort.abort(reason);
  await assert.rejects(f.sync.sync(10n, 1n, abort.signal), error => error === reason); assert.deepEqual(f.calls, []);
}));
test('preparation rejects hardlinked original Codex DB before bridge mutation', async () => fixture(async f => {
  const alias = join(dirname(f.codex), 'codex-alias.sqlite'); linkSync(f.codex, alias); const before = readFileSync(f.codex);
  await assert.rejects(LimitedMirrorSynchronizer.create(f.codex, alias, f.client, f.locks, 1n, fresh()), /different files/); assert.deepEqual(readFileSync(f.codex), before);
}));
