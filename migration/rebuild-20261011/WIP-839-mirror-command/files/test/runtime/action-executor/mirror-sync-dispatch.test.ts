import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {dirname, join} from 'node:path';
import {writeFileSync, linkSync, readFileSync} from 'node:fs';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {DiscordChannelClient} from '../../../src/discord/channel-client.ts';
import {TargetLocks} from '../../../src/core/keyed-locks.ts';
import {RuntimeCommandExecutor} from '../../../src/runtime/action-executor/command-executor.ts';
import {BridgeState} from '../../../src/runtime/bridge-state.ts';
import {QueueStartCoordinator} from '../../../src/runtime/queue-runner/start-coordinator.ts';
import {actionExecutionErrorInfo} from '../../../src/runtime/action-executor/action-error.ts';
import {cleanupRefusalFromActionError} from '../../../src/runtime/cleanup-refusal.ts';
import {formatMirrorSyncResult} from '../../../src/runtime/mirror-sync/result.ts';
import {NativeMirrorStore} from '../../../src/runtime/mirror-sync/store-native.ts';
const fresh = () => new AbortController().signal;
type Room = {id: string; type: number; guild_id: string; parent_id?: string; name: string; topic?: string; owner_id?: string};
async function fixture(run: (f: {executor: RuntimeCommandExecutor; store: NativeMirrorStore; locks: TargetLocks; calls: string[]; rooms: Map<string, Room>; client: DiscordChannelClient; codex: string; mirror: string}) => Promise<void>) {
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
    const client = await DiscordChannelClient.create({token: null, report: () => {}, testOrigin: `http://127.0.0.1:${address.port}/api/v10/`});
    const bridgePath=join(dirname(mirror),'bridge.json'),bridge=new BridgeState(bridgePath);
    const queue=new QueueStartCoordinator(mirror,{generation:()=>1n,residentInstanceId:()=> 'fixture',activeTurnId:async()=>null,resumeThread:async()=>{},readTurns:async()=>[],startClaimedTurn:async()=>{assert.fail('mirror sync cannot start a turn');}}),locks=queue.locks;
    const executor=new RuntimeCommandExecutor({paths:{state:codex,mirror,bridge:bridgePath},bridge,server:null,backend:null,queue,render:()=> 'fixture',preparePrompt:async p=>p,mirror:null,reportNewAttempt:()=>{},resumeTimeoutMs:1000});
    try { await run({executor, store: new NativeMirrorStore(mirror), locks, calls, rooms, client, codex, mirror}); }
    finally { await client.close(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); assert.equal(locks.activeTargetCount, 0); }
  });
}
const actor={channelId:10n,userId:3n,discordMessageId:5n,autoQueueWhenBusy:false};
test('BridgeSync without configured transport remains unsupported and performs no HTTP',async()=>fixture(async f=>{
 await assert.rejects(f.executor.executeWithIngressContext({BridgeSync:{limit:null}},actor,'message:5'),e=>actionExecutionErrorInfo(e)?.kind==='Unsupported');assert.deepEqual(f.calls,[]);
}));
test('configured full BridgeSync reaches real HTTP, commits mappings and returns source result text',async()=>fixture(async f=>{
 await f.executor.configureMirrorSync(f.client,1n,fresh());
 const result=await f.executor.executeWithIngressContext({BridgeSync:{limit:null}},actor,'message:5');
 assert.deepEqual(result,{text:'Mirror sync complete.\nprojects: 1\nthreads: 2\nstale_threads_deleted: 0\nunavailable: 1\norphan_threads_deleted: 0\nprojects_deleted: 0\ncleanup: obsolete mirror rooms deleted; current mappings protected',waitsForFinal:false,ui:null});
 assert.deepEqual(await f.store.execute({kind:'ThreadChannels',args:['a']}),[20n,30n]);
 assert.ok(f.calls.includes('GET /api/v10/users/@me'));
 const check=await f.executor.executeWithIngressContext('MirrorCheck',actor,'message:6');assert.match(check.text,/Discord mirror check/);
 await assert.rejects(f.executor.configureMirrorSync(f.client,1n,fresh()),/already configured/);
}));
test('explicit-limit BridgeSync uses limited path and never enters cleanup inventory',async()=>fixture(async f=>{
 await f.executor.configureMirrorSync(f.client,1n,fresh());
 const result=await f.executor.executeWithIngressContext({BridgeSync:{limit:100n}},actor,'message:5');
 assert.match(result.text,/cleanup: limited sync; existing mappings retained$/);
 assert.equal(f.calls.some(x=>x.includes('/threads/active')||x.includes('/users/@me')||x.startsWith('DELETE')),false);
}));
test('concurrent configuration has one owner and cancelled preparation can be retried explicitly',async()=>fixture(async f=>{
 const lease=await f.locks.acquire('mirror-sync-operation'),abort=new AbortController(),reason=new Error('cancel preparation');
 const first=f.executor.configureMirrorSync(f.client,1n,abort.signal),observed=assert.rejects(first,e=>e===reason);
 await assert.rejects(f.executor.configureMirrorSync(f.client,1n,fresh()),/already configured/);abort.abort(reason);await observed;lease.release();
 await f.executor.configureMirrorSync(f.client,1n,fresh());assert.deepEqual(f.calls,[]);
}));
test('command cancellation preserves shared lock owner and exact abort reason',async()=>fixture(async f=>{
 await f.executor.configureMirrorSync(f.client,1n,fresh());const lease=await f.locks.acquire('mirror-sync-operation'),abort=new AbortController(),reason=new Error('cancel command');
 try{const request=f.executor.executeWithIngressContext({BridgeSync:{limit:null}},actor,'message:5',abort.signal),observed=assert.rejects(request,e=>e===reason);abort.abort(reason);await observed;lease.requireTarget('mirror-sync-operation');assert.deepEqual(f.calls,[]);}finally{lease.release();}
}));
test('durable pending cleanup propagates a MirrorSync error without a success result',async()=>fixture(async f=>{
 await f.executor.configureMirrorSync(f.client,1n,fresh());await f.store.execute({kind:'BeginCleanup',args:[99n,null,1]});
 await assert.rejects(f.executor.executeWithIngressContext({BridgeSync:{limit:null}},actor,'message:5'),e=>actionExecutionErrorInfo(e)?.kind==='MirrorSync'&&cleanupRefusalFromActionError(e)===undefined);assert.deepEqual(f.calls,[]);
}));
test('formatter rejects active getters and invalid counts without pretending partial success',()=>{
 const base={projects:1,threads:2,archived:0,unavailable:0,orphanDeleted:0,projectsDeleted:0,limited:false};let calls=0;
 assert.throws(()=>formatMirrorSyncResult({...base,get projects(){calls++;return 1;}}),TypeError);assert.equal(calls,0);
 assert.throws(()=>formatMirrorSyncResult({...base,threads:NaN}),TypeError);
});
test('protected old room produces typed pre-delete refusal even after earlier sync work',async()=>fixture(async f=>{
 await f.executor.configureMirrorSync(f.client,1n,fresh());
 await f.store.execute({kind:'CommitThread',args:[{threadId:'outside',projectKey:'/old',title:'Old',parentId:88n,channelId:99n,now:1},null]});
 const db=new DatabaseSync(f.mirror);try{db.exec("INSERT INTO discord_ingress_journal(ingress_id,kind,event_id,channel_id,owner_user_id,payload_json,state,phase,target_thread_id,created_at,updated_at) VALUES('message:900','message',900,99,7,'{}','held','received','outside',1,1)");}finally{db.close();}
 await assert.rejects(f.executor.executeWithIngressContext({BridgeSync:{limit:null}},actor,'message:5'),error=>{assert.deepEqual(cleanupRefusalFromActionError(error),{room:99n,reason:'ingress'});return true;});
 assert.equal(f.calls.some(x=>x.startsWith('DELETE')),false);assert.ok(f.calls.some(x=>x.startsWith('POST')));
 assert.deepEqual(await f.store.execute({kind:'ThreadChannels',args:['outside']}),[88n,99n]);
}));
