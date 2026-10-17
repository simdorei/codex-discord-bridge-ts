import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {dirname, join} from 'node:path';
import {writeFileSync, linkSync, readFileSync} from 'node:fs';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {DiscordChannelClient} from '../../../src/discord/channel-client.ts';
import {TargetLocks} from '../../../src/core/keyed-locks.ts';
import {MirrorSynchronizer} from '../../../src/runtime/mirror-sync/sync.ts';
import {NativeMirrorStore} from '../../../src/runtime/mirror-sync/store-native.ts';
const fresh = () => new AbortController().signal;
type Room = {id: string; type: number; guild_id: string; parent_id?: string; name: string; topic?: string; owner_id?: string};
async function fixture(run: (f: {sync: MirrorSynchronizer; store: NativeMirrorStore; locks: TargetLocks; calls: string[]; rooms: Map<string, Room>; client: DiscordChannelClient; codex: string; mirror: string}) => Promise<void>) {
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
        if (request.method === 'GET' && request.url === '/api/v10/users/@me') { response.end(JSON.stringify({id:'9',username:'bot',discriminator:'0',avatar:null,bot:true})); return; }
        if (request.method === 'GET' && request.url === '/api/v10/guilds/1/threads/active') { response.end(JSON.stringify({threads:[...rooms.values()].filter(r=>r.type===11),members:[],has_more:false})); return; }
        if (request.method === 'GET' && request.url!.includes('/threads/archived/public?')) { response.end(JSON.stringify({threads:[],members:[],has_more:false})); return; }
        if (request.method === 'DELETE') { rooms.delete(request.url!.split('/').at(-1)!); response.writeHead(204); response.end(); return; }
        if (request.method === 'GET' && request.url === '/api/v10/guilds/1/channels') { response.end(JSON.stringify([...rooms.values()].filter(room => room.type !== 11))); return; }
        if (request.method === 'GET') { const room = rooms.get(request.url!.split('/').at(-1)!); if (!room) { response.writeHead(404); response.end('{"code":10003,"message":"gone"}'); } else response.end(JSON.stringify(room)); return; }
        if (request.method === 'POST') {
          const value = JSON.parse(body), thread = request.url!.endsWith('/threads'), id = thread ? String(next++) : '20';
          const room: Room = {id, owner_id: '9', type: thread ? 11 : value.type, guild_id: '1', parent_id: thread ? '20' : value.parent_id, name: value.name, ...(value.topic === undefined ? {} : {topic: value.topic})}; rooms.set(id, room); response.end(JSON.stringify(room)); return;
        }
        if (request.method === 'PATCH') { Object.assign(rooms.get(request.url!.split('/').at(-1)!)!, JSON.parse(body)); response.writeHead(204); response.end(); return; }
        response.writeHead(500); response.end('{"code":0,"message":"unexpected"}');
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address !== 'string');
    const client = await DiscordChannelClient.create({token: null, report: () => {}, testOrigin: `http://127.0.0.1:${address.port}/api/v10/`}), locks = new TargetLocks();
    try { const sync = await MirrorSynchronizer.create(codex, mirror, client, locks, 1n, fresh()); await run({sync, store: new NativeMirrorStore(mirror), locks, calls, rooms, client, codex, mirror}); }
    finally { await client.close(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); assert.equal(locks.activeTargetCount, 0); }
  });
}
test('full sync creates mappings then completes cleanup, and replay creates no duplicates', async () => fixture(async f => {
  const before = readFileSync(f.codex);
  assert.deepEqual(await f.sync.sync(10n, null), {projects:1,threads:2,unavailable:1,archived:0,orphanDeleted:0,projectsDeleted:0,limited:false});
  assert.deepEqual(readFileSync(f.codex),before);
  assert.equal(f.calls.filter(x=>x.startsWith('POST')).length,3);
  assert.equal(f.calls.some(x=>x.startsWith('DELETE')),false);
  assert.ok(f.calls.includes('GET /api/v10/users/@me'));
  await f.sync.sync(10n,null);
  assert.equal(f.calls.filter(x=>x.startsWith('POST')).length,3);
}));
test('full sync retires obsolete mapping, old bot orphan and empty stale project in source order', async () => fixture(async f => {
  await f.store.execute({kind:'CommitThread',args:[{threadId:'outside',projectKey:'/old',title:'Old',parentId:88n,channelId:99n,now:1},null]});
  await f.store.execute({kind:'UpsertProject',args:['/old','Old',88n,1]});
  f.rooms.set('88',{id:'88',type:0,guild_id:'1',parent_id:'10',name:'Old'});
  f.rooms.set('99',{id:'99',type:11,guild_id:'1',parent_id:'88',name:'Old',owner_id:'9'});
  f.rooms.set('98',{id:'98',type:11,guild_id:'1',parent_id:'20',name:'Orphan',owner_id:'9'});
  const result=await f.sync.sync(10n,null);
  assert.deepEqual(result,{projects:1,threads:2,unavailable:1,archived:1,orphanDeleted:1,projectsDeleted:1,limited:false});
  assert.deepEqual(f.calls.filter(x=>x.startsWith('DELETE')),['DELETE /api/v10/channels/99','DELETE /api/v10/channels/98','DELETE /api/v10/channels/88']);
  assert.equal(await f.store.execute({kind:'ThreadChannels',args:['outside']}),null);
  assert.deepEqual(await f.store.execute({kind:'ThreadChannels',args:['a']}),[20n,30n]);
}));
test('full cleanup retains active thread mapping even when its rollout is missing', async () => fixture(async f => {
  await f.store.execute({kind:'CommitThread',args:[{threadId:'missing',projectKey:'/old',title:'Missing',parentId:88n,channelId:99n,now:1},null]});
  await f.store.execute({kind:'UpsertProject',args:['/old','Old',88n,1]});
  f.rooms.set('88',{id:'88',type:0,guild_id:'1',parent_id:'10',name:'Old'});
  f.rooms.set('99',{id:'99',type:11,guild_id:'1',parent_id:'88',name:'Missing',owner_id:'9'});
  const result=await f.sync.sync(10n,null);assert.equal(result.unavailable,1);assert.equal(result.archived,0);assert.equal(result.projectsDeleted,0);
  assert.deepEqual(await f.store.execute({kind:'ThreadChannels',args:['missing']}),[88n,99n]);
  assert.equal(f.calls.some(x=>x.startsWith('DELETE')),false);
}));
test('explicit general sync limit bypasses all orphan inventory and deletion', async () => fixture(async f => {
  const result=await f.sync.sync(10n,100n);assert.equal(result.limited,true);assert.equal(result.archived,0);
  assert.equal(f.calls.some(x=>x.includes('/threads/active')||x.includes('/users/@me')||x.startsWith('DELETE')),false);
}));
test('unreconciled cleanup blocks full sync before any remote changes', async () => fixture(async f => {
  await f.store.execute({kind:'BeginCleanup',args:[99n,null,1]});
  await assert.rejects(f.sync.sync(10n,null),/manual reconciliation/);assert.deepEqual(f.calls,[]);
}));
test('full sync cancellation waiting for shared lock preserves owner and makes no HTTP', async () => fixture(async f => {
  const lease=await f.locks.acquire('mirror-sync-operation'),abort=new AbortController(),reason=new Error('cancel full sync');
  try{const pending=f.sync.sync(10n,null,abort.signal),observed=assert.rejects(pending,e=>e===reason);abort.abort(reason);await observed;lease.requireTarget('mirror-sync-operation');assert.deepEqual(f.calls,[]);}finally{lease.release();}
}));
