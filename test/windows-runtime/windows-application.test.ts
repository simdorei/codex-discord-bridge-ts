import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp, mkdir, readdir, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocketServer, type WebSocket} from 'ws';
import {OwnedPortableAppServerProcess} from '../../src/app-server/portable-process.ts';
import {loadRuntimeConfig} from '../../src/config/runtime.ts';
import {RecommendedGateway} from '../../src/discord/gateway/recommended.ts';
import {runLocalRuntimeApplication} from '../../src/runtime/discord-runtime/local-application.ts';
import {RuntimeStopSignal} from '../../src/runtime/discord-runtime/stop-signal.ts';
import {WindowsRuntimeInstance} from '../../src/runtime/windows/windows-runtime-instance.ts';
import {ownedWorkerUsage} from '../../src/runtime/owned-worker-slot.ts';

const message = (id: string, content: string, user = '2') => ({
  attachments: [], author: {id: user, username: 'fixture', discriminator: '0', bot: user === '9'},
  channel_id: '7', content, embeds: [], id, type: 0, mention_everyone: false,
  mention_roles: [], mentions: [], pinned: false, timestamp: '2026-10-18T00:00:00+00:00', tts: false,
});
const ready = {application: {id: '4', flags: 0}, guilds: [], resume_gateway_url: 'wss://gateway.discord.gg',
  session_id: 'offline', user: {id: '9', username: 'fixture', discriminator: '0', mfa_enabled: false}, v: 10};
const provider = `import readline from 'node:readline';
const emit=v=>process.stdout.write(JSON.stringify(v)+'\\n');let turn=null;
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(m.id===undefined)return;let result={};
 if(m.method==='model/list')result={data:[]};
 if(m.method==='thread/read'||m.method==='thread/resume')result={thread:{id:'fixture-thread',turns:turn?[turn]:[]}};
 if(m.method==='turn/start'){
  turn={id:'fixture-turn',status:'inProgress',items:[]};emit({id:m.id,result:{turn}});
  emit({method:'turn/started',params:{threadId:'fixture-thread',turn}});
  setTimeout(()=>{turn={id:'fixture-turn',status:'completed',items:[{id:'answer',type:'agentMessage',phase:'final_answer',text:'WINDOWS_FINAL_OK'}]};
   emit({method:'item/completed',params:{threadId:'fixture-thread',turnId:turn.id,item:turn.items[0]}});
   emit({method:'turn/completed',params:{threadId:'fixture-thread',turn}});},100);return;
 }
 emit({id:m.id,result});
});`;

test('Windows application receives Discord commands, delivers a final and releases native owners',
  {skip: process.platform !== 'win32', timeout: 45000}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'cdr-windows-app-')), state = join(root, 'state.sqlite');
  await mkdir(join(root, 'project'));
  const db = new DatabaseSync(state);
  try {
    db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,updated_at INTEGER,rollout_path TEXT,model TEXT,reasoning_effort TEXT,tokens_used INTEGER,archived INTEGER,archived_at INTEGER)');
    db.prepare("INSERT INTO threads(id,title,cwd,updated_at,archived) VALUES('fixture-thread','Fixture',?,1,0)").run(join(root, 'project'));
  } finally { db.close(); }
  await writeFile(join(root, 'bridge.json'), JSON.stringify({selected_thread_id: 'fixture-thread'}));
  const sent: string[] = [], calls: string[] = [], processes: OwnedPortableAppServerProcess[] = [];
  let registered = false, sequence = 1, reply = 1000, peer: WebSocket | undefined;
  const http = createServer((req, res) => {
    assert.equal(req.headers.authorization, undefined); let raw = '';
    req.on('data', chunk => { raw += chunk; }); req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url?.endsWith('/gateway/bot')) {
        res.end(JSON.stringify({shards: 1, url: 'ignored', session_start_limit: {max_concurrency: 1, remaining: 100, total: 100, reset_after: 0}}));
      } else if (req.method === 'PUT' && req.url?.endsWith('/commands')) { registered = true; res.end('[]'); }
      else if (req.method === 'POST' && req.url?.endsWith('/messages')) {
        const body = JSON.parse(raw); sent.push(body.content); res.end(JSON.stringify(message(String(reply++), body.content, '9')));
      } else if (req.method === 'GET' && req.url?.includes('/messages')) res.end('[]');
      else { res.statusCode = 204; res.end(); }
    });
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const ws = new WebSocketServer({host: '127.0.0.1', port: 0}); await once(ws, 'listening');
  ws.on('connection', socket => {
    peer = socket; socket.on('message', raw => {
      const value = JSON.parse(raw.toString());
      if (value.op === 2) socket.send(JSON.stringify({op: 0, t: 'READY', s: sequence++, d: ready}));
      if (value.op === 1) socket.send('{"op":11}');
    }); socket.send('{"op":10,"d":{"heartbeat_interval":60000}}');
  });
  const stop = new AbortController();
  t.mock.method(RuntimeStopSignal, 'install', () => ({signal: stop.signal, dispose() {}} as unknown as RuntimeStopSignal));
  t.mock.method(RecommendedGateway, 'startPaused', () => RecommendedGateway.startPausedForTest({
    httpOrigin: `http://127.0.0.1:${(http.address() as {port: number}).port}/api/v10/`,
    gatewayUrl: `ws://127.0.0.1:${(ws.address() as {port: number}).port}/`, messageContent: true, jitter: () => 0n,
    reportReceiveErrorDrop() {}, reportTriggerFailure() {}, reportHttpError() {},
  }));
  const spawn = OwnedPortableAppServerProcess.spawn;
  t.mock.method(OwnedPortableAppServerProcess, 'spawn', async (config: Parameters<typeof spawn>[0]) => {
    assert.equal(config.executable, process.execPath); calls.push(...config.arguments);
    const child = await spawn.call(OwnedPortableAppServerProcess, {...config, arguments: ['--input-type=module', '-e', provider]});
    processes.push(child); return child;
  });
  const config = loadRuntimeConfig(new Map([
    ['DISCORD_BOT_TOKEN', 'synthetic-only'], ['DISCORD_ALLOWED_CHANNEL_IDS', '7'], ['DISCORD_ALLOWED_USER_IDS', '2'],
    ['DISCORD_SESSION_MIRROR', '0'], ['DISCORD_STARTUP_NOTIFY', '0'], ['DISCORD_ENABLE_MESSAGE_CONTENT', '1'],
  ]));
  let failed: unknown, finished = false;
  const running = runLocalRuntimeApplication(config, {HOME: root, CODEX_EXE: process.execPath, CODEX_HOME: root,
    CODEX_STATE_DB: state, CODEX_BRIDGE_STATE: join(root, 'bridge.json')}, root, 'windows-fixture')
    .then(() => {finished = true;}, error => {failed = error; finished = true;});
  const until = async (condition: () => boolean, label: string) => {
    const end = performance.now() + 20000;
    while (!condition()) {
      if (failed !== undefined) throw failed;
      assert.ok(!finished, `Runtime exited before ${label}`);
      assert.ok(performance.now() < end, `${label}: ${JSON.stringify(sent)}`); await delay(10);
    }
  };
  const send = (id: string, content: string) => peer!.send(JSON.stringify({op: 0, t: 'MESSAGE_CREATE', s: sequence++, d: message(id, content)}));
  try {
    const startedAt = performance.now();
    await until(() => registered, 'command registration');
    const registeredAt = performance.now();
    send('101', '!help'); await until(() => sent.length > 0, 'help response');
    const promptAt = performance.now();
    send('102', 'fixture prompt'); await until(() => sent.some(text => text.includes('WINDOWS_FINAL_OK')), 'final delivery');
    const finalAt = performance.now();
    assert.ok(calls.includes('app-server'));
    stop.abort(); await running; assert.equal(failed, undefined);
    t.diagnostic(JSON.stringify({startupMs: Math.round(registeredAt - startedAt), finalMs: Math.round(finalAt - promptAt), shutdownMs: Math.round(performance.now() - finalAt)}));
    assert.equal(processes.length, 1); assert.equal(processes[0]!.exitConfirmed, true);
    assert.ok(Object.values(ownedWorkerUsage()).every(count => count === 0));
    const instance = await WindowsRuntimeInstance.acquire(root); await instance.release();
    assert.ok(!(await readdir(root)).some(name => name.endsWith('.runtime.lock') || name.endsWith('.heartbeat') || name.endsWith('.drain.identity')));
  } finally {
    stop.abort(); await running;
    for (const child of processes) await child.forceDispose();
    for (const socket of ws.clients) socket.terminate(); await new Promise<void>(resolve => ws.close(() => resolve()));
    http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve()));
    await rm(root, {recursive: true, force: true});
  }
});
