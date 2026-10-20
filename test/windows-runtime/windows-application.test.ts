import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp, mkdir, readdir, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {inspect} from 'node:util';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocketServer, type WebSocket} from 'ws';
import {OwnedPortableAppServerProcess} from '../../src/app-server/portable-process.ts';
import {PortableResidentLifecycle} from '../../src/app-server/portable-resident-lifecycle.ts';
import {loadRuntimeConfig} from '../../src/config/runtime.ts';
import {RecommendedGateway} from '../../src/discord/gateway/recommended.ts';
import {runLocalRuntimeApplication} from '../../src/runtime/discord-runtime/local-application.ts';
import {RuntimeStopSignal} from '../../src/runtime/discord-runtime/stop-signal.ts';
import {WindowsRuntimeInstance} from '../../src/runtime/windows/windows-runtime-instance.ts';
import {OwnedWorkerSlot,ownedWorkerUsage} from '../../src/runtime/owned-worker-slot.ts';
import {openInitialized} from '../../src/store/owned-driver.ts';
import {ControlTurnVerifier} from '../../src/runtime/action-executor/control-turn.ts';
import {StopControlWorker} from '../../src/runtime/action-executor/stop-worker.ts';

const message = (id: string, content: string, user = '2',channel='7') => ({
  attachments: [], author: {id: user, username: 'fixture', discriminator: '0', bot: user === '9'},
  channel_id: channel, content, embeds: [], id, type: 0, mention_everyone: false,
  mention_roles: [], mentions: [], pinned: false, timestamp: '2026-10-18T00:00:00+00:00', tts: false,
});
const ready = {application: {id: '4', flags: 0}, guilds: [], resume_gateway_url: 'wss://gateway.discord.gg',
  session_id: 'offline', user: {id: '9', username: 'fixture', discriminator: '0', mfa_enabled: false}, v: 10};
const provider = `import readline from 'node:readline';
const emit=v=>process.stdout.write(JSON.stringify(v)+'\\n');const turns=new Map();let next=0;
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(m.id===undefined)return;let result={};
 if(m.method==='model/list')result={data:[]};
 const thread=m.params?.threadId??'fixture-thread';let turn=turns.get(thread);
 if(m.method==='thread/read'||m.method==='thread/resume')result={thread:{id:thread,status:{type:turn?.status==='inProgress'?'active':'idle',activeFlags:[]},turns:turn?[turn]:[]}};
 if(m.method==='turn/start'){
  turn={id:'fixture-turn-'+(++next),status:'inProgress',items:[]};turns.set(thread,turn);emit({id:m.id,result:{turn}});
  emit({method:'turn/started',params:{threadId:thread,turn}});
  if(!JSON.stringify(m.params).includes('HOLD_FOR_STOP'))setTimeout(()=>{turn={id:turn.id,status:'completed',items:[{id:'answer',type:'agentMessage',phase:'final_answer',text:'WINDOWS_FINAL_OK '+thread+' '+turn.id}]};turns.set(thread,turn);
   emit({method:'item/completed',params:{threadId:thread,turnId:turn.id,item:turn.items[0]}});
   emit({method:'turn/completed',params:{threadId:thread,turn}});},100);return;
 }
 if(m.method==='turn/interrupt'&&turn){turn={...turn,status:'interrupted'};turns.set(thread,turn);emit({id:m.id,result:{}});emit({method:'turn/completed',params:{threadId:thread,turn}});return;}
 emit({id:m.id,result});
});`;

for(const parallel of [false,true])test(parallel?'three simultaneous threads deliver repeated finals, stop one turn and resume without leaked owners':'Windows application receives Discord commands, delivers a final and releases native owners',
  {skip: process.platform !== 'win32', timeout: parallel?120000:45000}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'cdr-windows-app-')), state = join(root, 'state.sqlite');
  await mkdir(join(root, 'project'));
  const db = new DatabaseSync(state);
  try {
    db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,updated_at INTEGER,rollout_path TEXT,model TEXT,reasoning_effort TEXT,tokens_used INTEGER,archived INTEGER,archived_at INTEGER)');
    db.prepare("INSERT INTO threads(id,title,cwd,updated_at,archived) VALUES('fixture-thread','Fixture',?,1,0)").run(join(root, 'project'));
    if(parallel)for(const id of ['fixture-thread-8','fixture-thread-9'])db.prepare('INSERT INTO threads(id,title,cwd,updated_at,archived) VALUES(?,?,?,1,0)').run(id,id,join(root,'project'));
  } finally { db.close(); }
  await writeFile(join(root, 'bridge.json'), JSON.stringify({selected_thread_id: 'fixture-thread'}));
  const channels=parallel?['7','8','9']:['7'],threadFor=(c:string)=>c==='7'?'fixture-thread':'fixture-thread-'+c;
  if(parallel){const mirror=await openInitialized(join(root,'discord_mirror.sqlite'));for(const c of channels)mirror.prepare('INSERT INTO mirror_threads VALUES(?,?,?,?,?,?)').run(threadFor(c),'project','Fixture',BigInt(c),BigInt(c),1);mirror.close();}
  const sent: string[] = [], calls: string[] = [], processes: OwnedPortableAppServerProcess[] = [];
  const refusals=new Set<string>(),runWorker=OwnedWorkerSlot.prototype.run;
  for(const method of ['process','processRecoveries'] as const){const original=StopControlWorker.prototype[method];t.mock.method(StopControlWorker.prototype,method,function(this:StopControlWorker,...args:Parameters<typeof original>){const pending=original.apply(this,args);void pending.catch(error=>refusals.add('STOP '+method+' '+inspect(error,{depth:5})));return pending;});}
  const verifyControl=ControlTurnVerifier.prototype.owned;
  t.mock.method(ControlTurnVerifier.prototype,'owned',function(this:ControlTurnVerifier,...args:Parameters<typeof verifyControl>){const pending=verifyControl.apply(this,args);void pending.catch(error=>refusals.add('STOP VERIFY '+inspect(error,{depth:5})));return pending;});
  const executeStop=PortableResidentLifecycle.prototype.executeStopControl;
  t.mock.method(PortableResidentLifecycle.prototype,'executeStopControl',function(this:PortableResidentLifecycle,...args:Parameters<typeof executeStop>){const pending=executeStop.apply(this,args);void pending.catch(error=>refusals.add('STOP EXECUTE '+inspect(error,{depth:5})));return pending;});
  t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof runWorker>){
    const origin=new Error().stack,pending=runWorker.apply(this,args);
    void pending.catch(error=>{refusals.add(String(error)+' '+args[0].pathname+'\n'+origin);});return pending;
  });
  const executeQueueTurn=PortableResidentLifecycle.prototype.executeQueueTurn;
  t.mock.method(PortableResidentLifecycle.prototype,'executeQueueTurn',function(this:PortableResidentLifecycle,...args:Parameters<typeof executeQueueTurn>){const pending=executeQueueTurn.apply(this,args);void pending.catch(error=>{refusals.add('QUEUE START '+String(error)+'\n'+(error?.stack??'')+'\nCAUSE: '+String(error?.cause));});return pending;});
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
    ['DISCORD_BOT_TOKEN', 'synthetic-only'], ['DISCORD_ALLOWED_CHANNEL_IDS', channels.join(',')], ['DISCORD_ALLOWED_USER_IDS', '2'],
    ['DISCORD_SESSION_MIRROR', '1'], ['DISCORD_ENABLE_HOST_COMMANDS', '1'], ['DISCORD_STARTUP_NOTIFY', '0'], ['DISCORD_ENABLE_MESSAGE_CONTENT', '1'],
  ]));
  let failed: unknown, finished = false;
  const running = runLocalRuntimeApplication(config, {HOME: root, CODEX_EXE: process.execPath, CODEX_HOME: root,
    CODEX_STATE_DB: state, CODEX_BRIDGE_STATE: join(root, 'bridge.json')}, root, 'windows-fixture')
    .then(() => {finished = true;}, error => {failed = error; finished = true;});
  const until = async (condition: () => boolean, label: string) => {
    const end = performance.now() + (parallel?35000:20000);
    while (!condition()) {
      if (failed !== undefined) throw failed;
      assert.ok(!finished, `Runtime exited before ${label}`);
      if(performance.now()>=end){const evidence=`${label}: ${JSON.stringify(sent.filter(s=>!s.includes('Codex Discord Remote')&&!s.startsWith('[2/2]')))}\n${[...refusals].join('\n')}`;process.stderr.write(evidence+'\n');assert.fail(evidence);}await delay(10);
    }
  };
  const send = (id: string, content: string,channel='7') => peer!.send(JSON.stringify({op: 0, t: 'MESSAGE_CREATE', s: sequence++, d: message(id, content,'2',channel)}));
  const queueMatches=(sql:string,expected:boolean)=>{let db:DatabaseSync|undefined;try{db=new DatabaseSync(join(root,'discord_mirror.sqlite'),{readOnly:true});return (db.prepare(sql).get()!==undefined)===expected;}catch(error){if((error as {errcode?:number}).errcode===5)return false;throw error;}finally{db?.close();}};
  try {
    const startedAt = performance.now();
    await until(() => registered, 'command registration');
    const registeredAt = performance.now();
    send('101', '!help'); await until(() => sent.length > 0, 'help response');
    const promptAt = performance.now();
    const rssStart=process.memoryUsage().rss;let peakRss=rssStart;const sample=setInterval(()=>{peakRss=Math.max(peakRss,process.memoryUsage().rss);},100);
    try{
    const rounds=parallel?3:1;
    for(let round=0;round<rounds;round++){
      for(const channel of channels)send(String(102+round*10+Number(channel)),'fixture prompt '+round,channel);
      await until(()=>channels.every(c=>sent.filter(text=>text.includes('WINDOWS_FINAL_OK '+threadFor(c)+' ')).length===round+1),'all finals round '+round);
    }
    if(parallel){
      send('500','HOLD_FOR_STOP','7');
      await until(()=>queueMatches("SELECT 1 FROM codex_turn_queue WHERE target_thread_id='fixture-thread' AND state='running'",true),'held fixture turn starts');
      for(const channel of ['8','9'])send(String(600+Number(channel)),'fixture while another target is held',channel);
      await until(()=>['8','9'].every(c=>sent.filter(text=>text.includes('WINDOWS_FINAL_OK '+threadFor(c)+' ')).length===4),'other targets finish while first target is held');
      assert.ok(queueMatches("SELECT 1 FROM codex_turn_queue WHERE target_thread_id='fixture-thread' AND state='running'",true));
      send('501','!stop','7');await until(()=>sent.some(text=>/Stop request|Stop accepted|stop request|정지|중지/.test(text)),'stop acknowledgement');
      await until(()=>queueMatches("SELECT 1 FROM codex_turn_queue WHERE target_thread_id='fixture-thread' AND state IN ('running','starting')",false),'stopped job leaves active queue');
      send('502','fixture after stop','7');await until(()=>sent.filter(text=>text.includes('WINDOWS_FINAL_OK fixture-thread ')).length===4,'final after stop');
    }
    }finally{clearInterval(sample);}
    const finalAt = performance.now();
    assert.ok(calls.includes('app-server'));
    stop.abort(); await running; assert.equal(failed, undefined);
    t.diagnostic(JSON.stringify({parallel,threads:channels.length,startupMs: Math.round(registeredAt - startedAt), workMs: Math.round(finalAt - promptAt), shutdownMs: Math.round(performance.now() - finalAt),rssStart,rssPeak:peakRss,rssEnd:process.memoryUsage().rss}));
    if(parallel)t.diagnostic(JSON.stringify({stopDiagnostics:[...refusals].filter(value=>value.startsWith('STOP '))}));
    // The automatic mirror owns a separate reader session in addition to the
    // turn provider. Both native owners must really exit before root release.
    assert.equal(processes.length, 2); assert.ok(processes.every(child => child.exitConfirmed));
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
