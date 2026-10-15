import {SecretToken} from '../../../src/config/remote.ts';
import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {existsSync,writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import type {WebSocket} from 'ws';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {remoteRuntimeInput,runtimeOptions,remoteInput,remoteSocket,gatewaySocket,deferred,until,change,command} from '../../helpers/remote-runtime-fixture.ts';
import {createSyntheticRuntimeRemoteProfile,prepareSyntheticRuntimeRemote,claimPreparedRuntimeRemote,closePreparedRuntimeRemote,requestPreparedRuntimeRemoteStop,startPreparedRuntimeRemote,preparedRuntimeRemoteSnapshot,syntheticRuntimeRemoteSnapshot,requestPreparedRuntimeRemoteHandoff,assertPreparedRuntimeRemoteReleased,RuntimeRemoteOwnershipRetainedError,type PreparedRuntimeRemote} from '../../../src/runtime/discord-runtime/remote-start.ts';
import {prepareRuntimeProContext} from '../../../src/runtime/discord-runtime/startup-context.ts';
import {startPreparedRuntimeWorkers,PreparedRuntimeWorkerStartError,type PreparedRuntimeWorkerOwner} from '../../../src/runtime/discord-runtime/prepared-workers.ts';
import {RuntimeMonitoredWorker,RuntimeWorkerExitChannel} from '../../../src/runtime/discord-runtime/monitored-worker.ts';
import {runPreparedRuntimeLifetime,closePreparedRuntimeOuter} from '../../../src/runtime/discord-runtime/prepared-lifetime.ts';
import {RuntimeEarlyExitError} from '../../../src/runtime/discord-runtime/shutdown-policy.ts';
import {loadRuntimeAutocomplete} from '../../../src/runtime/discord-runtime/autocomplete-bootstrap.ts';
import {RuntimeDrainController,posixDrainMarkerPort} from '../../../src/runtime/restart-readiness/drain-controller.ts';
import {PosixDrainMarkerStore,DRAIN_MARKER_NAMES} from '../../../src/runtime/restart-readiness/drain-marker.ts';
import {RecommendedGateway} from '../../../src/discord/gateway/recommended.ts';
import {AdmissionGate} from '../../../src/admission/drain-gate.ts';

async function preparedFixture(run:(f:{input:ReturnType<typeof remoteRuntimeInput>;profile:ReturnType<typeof createSyntheticRuntimeRemoteProfile>;remote:PreparedRuntimeRemote;context:Awaited<ReturnType<typeof prepareRuntimeProContext>>;controller:RuntimeDrainController;markers:PosixDrainMarkerStore;stop:AbortController;ports:ReturnType<typeof remoteInput>})=>Promise<void>,configure?:(ports:ReturnType<typeof remoteInput>)=>void,url?:string){await storeFixture(async path=>{
 const input=remoteRuntimeInput(path),ports=remoteInput(url);configure?.(ports);const profile=createSyntheticRuntimeRemoteProfile(ports.input),markers=new PosixDrainMarkerStore(input.paths.root),controller=await RuntimeDrainController.initialize(posixDrainMarkerPort(markers),{runtimeId:'runtime',processId:123}),stop=new AbortController();change(input,'admission',controller.admissionGate);
 let context:Awaited<ReturnType<typeof prepareRuntimeProContext>>|undefined,remote:PreparedRuntimeRemote|undefined;
 try{context=await prepareRuntimeProContext(input,stop.signal,profile);remote=await prepareSyntheticRuntimeRemote(profile,context,stop.signal);await run({input,profile,remote,context,controller,markers,stop,ports});}
 finally{stop.abort();if(remote!==undefined){requestPreparedRuntimeRemoteStop(remote);try{await closePreparedRuntimeRemote(remote);}catch{}}await context?.disposeBeforeWorkers();await controller.dispose();}
});}
async function startFixture(f:Parameters<Parameters<typeof preparedFixture>[0]>[0]){
 const socket=await gatewaySocket();let gateway:RecommendedGateway|undefined,workers:PreparedRuntimeWorkerOwner|undefined;
 try{gateway=await RecommendedGateway.startPausedForTest(socket);workers=await startPreparedRuntimeWorkers(f.context,gateway.runtime,f.controller.admissionGate,gateway.http,await loadRuntimeAutocomplete(f.context.owner),f.stop.signal,{...runtimeOptions(f.input.paths.root),remote:f.remote});return {gateway,workers,close:async()=>{workers!.requestStop();await workers!.close();workers!.heartbeat.requestStop();await workers!.heartbeat.worker.join();workers!.disposeMonitor();await gateway!.close();await socket.close();}};}
 catch(error){await gateway?.close();await socket.close();throw error;}
}
const lifetimeOptions=(f:Parameters<Parameters<typeof preparedFixture>[0]>[0])=>({stopRequested:()=>f.markers.stopRequested(),reportControl:()=>{},reportTransition:()=>{},shutdown:{report:()=>{}}});

test('profile capture rejects active or operational input without hooks or allocations; disabled branch does not inspect callbacks',()=>{
 const f=remoteInput();let hooks=0;const bad=Object.defineProperty({...f.input},'socket',{get(){hooks++;throw Error('hook');}});assert.throws(()=>createSyntheticRuntimeRemoteProfile(bad));assert.throws(()=>createSyntheticRuntimeRemoteProfile(new Proxy(f.input,{get(){hooks++;throw Error('hook');}})));
 for(const url of ['wss://example.com','ws://localhost:3','ws://127.0.0.1:3/#'])assert.throws(()=>createSyntheticRuntimeRemoteProfile({...f.input,socket:{...f.input.socket,bridgeUrl:url}}));
 const activeSecret=Object.defineProperty({},'startsWith',{get(){hooks++;throw Error('secret hook');}});for(const value of [activeSecret,new Proxy(activeSecret,{get(){hooks++;throw Error('secret proxy');}})])assert.throws(()=>createSyntheticRuntimeRemoteProfile({...f.input,socket:{...f.input.socket,deviceToken:new SecretToken(value as never)}}),/synthetic token/);
 assert.equal(claimPreparedRuntimeRemote({kind:'DisabledRemote',get owner(){hooks++;throw Error('hook');}} as never,{} as never,{} as never),null);assert.equal(hooks,0);assert.deepEqual(f.events,[]);
});

test('copied and reused profiles reject before native startup; exact context is required and prepared close is single-use',async()=>storeFixture(async path=>{
 const input=remoteRuntimeInput(path),f=remoteInput(),profile=createSyntheticRuntimeRemoteProfile(f.input),stop=new AbortController();let hooks=0;
 for(const forged of [{...profile},new Proxy(profile,{get(){hooks++;throw Error('hook');}})])await assert.rejects(prepareRuntimeProContext(input,stop.signal,forged),/authentic/);
 assert.equal(hooks,0);assert.equal(existsSync(path),false);assert.equal(existsSync(join(input.paths.root,'pid')),false);
 const context=await prepareRuntimeProContext(input,stop.signal,profile);try{
  await assert.rejects(prepareRuntimeProContext(input,stop.signal,profile),/consumed/);await assert.rejects(prepareSyntheticRuntimeRemote(profile,{...context},stop.signal),/exact remote Pro/);assert.deepEqual(f.events,[]);
  const remote=await prepareSyntheticRuntimeRemote(profile,context,stop.signal);await assert.rejects(prepareSyntheticRuntimeRemote(profile,context,stop.signal),/already consumed/);
  for(const fake of [{...remote},new Proxy(remote,{})])assert.throws(()=>claimPreparedRuntimeRemote(fake,context,input.admission),TypeError);
  assert.throws(()=>claimPreparedRuntimeRemote(remote,{...context},input.admission),/context differs/);assert.throws(()=>claimPreparedRuntimeRemote(remote,context,new AdmissionGate()),/context differs/);
  const a=closePreparedRuntimeRemote(remote);assert.equal(closePreparedRuntimeRemote(remote),a);await a;assert.throws(()=>claimPreparedRuntimeRemote(remote,context,input.admission),/already claimed/);assertPreparedRuntimeRemoteReleased(remote);assert.deepEqual(f.events,['restore','open','project']);
 }finally{await context.disposeBeforeWorkers();}
}));

test('exact shared Pro readiness stays false until hello ACK and across disconnect, with one owner and restore over reconnect',{timeout:20000},async()=>{
 const hello=[deferred(),deferred()],reconnect=deferred();let second:WebSocket|undefined;
 const ws=await remoteSocket((peer,index)=>{peer.once('message',()=>{if(index===2)second=peer;hello[index-1]?.resolve();});});
 try{await preparedFixture(async f=>{
  assert.equal(syntheticRuntimeRemoteSnapshot(f.profile).status.connected,false);await assert.rejects(f.context.pro!.prepare('!pro inspect','original'),/did not become ready/);assert.equal(ws.count(),0);
  const running=await startFixture(f);try{
   assert.deepEqual(running.workers.startupOrder.map(w=>w.name),['ready','message-emergency','message','history','interaction-normal','interaction-reserved','receive-error','interaction','remote-mcp','app-server-supervisor','heartbeat','completion','new-first-reply-verification','stop-control','prompt-intake-recovery','server-request']);assert.equal(running.workers.workers.filter(w=>w.name==='remote-mcp').length,1);
   await hello[0]!.promise;assert.equal(syntheticRuntimeRemoteSnapshot(f.profile).status.connected,false);ws.peers[0]!.send('{"type":"hello_ack"}');await until(()=>syntheticRuntimeRemoteSnapshot(f.profile).status.connected);assert.match(await f.context.pro!.prepare('!pro inspect','original'),/exact-synthetic-device/);
   ws.peers[0]!.close();await until(()=>f.ports.events.includes('disconnect'));assert.equal(syntheticRuntimeRemoteSnapshot(f.profile).status.connected,false);await assert.rejects(f.context.pro!.prepare('!pro inspect','original'),/did not become ready/);reconnect.resolve();await hello[1]!.promise;assert.equal(syntheticRuntimeRemoteSnapshot(f.profile).status.connected,false);second!.send('{"type":"hello_ack"}');await until(()=>syntheticRuntimeRemoteSnapshot(f.profile).status.connected);
   assert.equal(f.ports.counts().opens,1);assert.equal(f.ports.events.filter(e=>e==='restore').length,1);assert.equal(syntheticRuntimeRemoteSnapshot(f.profile).status.generation,2n);
  }finally{reconnect.resolve();await running.close();}assert.ok(f.ports.receivers.every(r=>r===undefined));
 },ports=>change(ports.input,'disconnected',async function(this:unknown){ports.receivers.push(this);ports.events.push('disconnect');await reconnect.promise;}),ws.url);}finally{await ws.close();}
});

test('monitored pre-entry cancellation joins abandoned prepared ownership before announcing exit',{timeout:15000},async()=>{
 const entered=deferred(),release=deferred(),notifier=new RuntimeWorkerExitChannel(),exits=notifier.receiver();let started=0,done=false;
 const worker=new RuntimeMonitoredWorker('remote-mcp',notifier,async()=>{started++;return {ok:true};},async()=>{entered.resolve();await release.promise;done=true;});worker.abort();notifier.close();await entered.promise;assert.equal(worker.peek(),undefined);assert.equal(exits.tryReceive().kind,'Empty');assert.equal(started,0);release.resolve();const joined=await worker.join();assert.equal(done,true);assert.equal(joined.kind,'TaskFailure');if(joined.kind==='TaskFailure')assert.equal(joined.cancelled,true);assert.equal(exits.tryReceive().kind,'Closed');exits.dispose();
});

test('restore rejection joins accepted cleanup before a runtime remote receipt or gateway can exist',{timeout:15000},async()=>storeFixture(async path=>{
 const input=remoteRuntimeInput(path),ports=remoteInput(),failure=Error('restore failed'),entered=deferred(),release=deferred();let opened=0,settled=false;
 change(ports.input.handoff,'restore',async()=>Object.freeze(['a','b'].map(threadId=>Object.freeze({threadId,root:'/synthetic',expiresAt:Object.freeze({seconds:300n,nanosecond:0n})}))));change(ports.input.dispatcher,'openProject',async()=>{if(++opened===2)throw failure;return ports.backend;});change(ports.backend,'close',async()=>{entered.resolve();await release.promise;});
 const profile=createSyntheticRuntimeRemoteProfile(ports.input),stop=new AbortController(),context=await prepareRuntimeProContext(input,stop.signal,profile);
 try{const check=assert.rejects(prepareSyntheticRuntimeRemote(profile,context,stop.signal),e=>e===failure).then(()=>{settled=true;});await entered.promise;await delay(5);assert.equal(settled,false);release.resolve();await check;assert.equal(syntheticRuntimeRemoteSnapshot(profile).phase,'failed');await assert.rejects(prepareSyntheticRuntimeRemote(profile,context,stop.signal),/already consumed/);}finally{release.resolve();await context.disposeBeforeWorkers();}
}));

for(const failureAt of [8,9,14])test(`startup allocation failure ${failureAt} joins remote prepared or active cleanup`,{timeout:15000},async t=>{
 const release=deferred(),entered=deferred();await preparedFixture(async f=>{
  const socket=await gatewaySocket(),gateway=await RecommendedGateway.startPausedForTest(socket),original=RuntimeWorkerExitChannel.prototype.acquire;let leases=0,settled=false;
  t.mock.method(RuntimeWorkerExitChannel.prototype,'acquire',function(this:RuntimeWorkerExitChannel){if(++leases===failureAt)throw Error('allocation failed');return original.call(this);});
  try{const check=assert.rejects(startPreparedRuntimeWorkers(f.context,gateway.runtime,f.controller.admissionGate,gateway.http,await loadRuntimeAutocomplete(f.context.owner),f.stop.signal,{...runtimeOptions(f.input.paths.root),remote:f.remote}),e=>{assert.ok(e instanceof PreparedRuntimeWorkerStartError);return true;}).then(()=>{settled=true;});await entered.promise;await delay(5);assert.equal(settled,false);assert.equal(f.context.owner.lifecycleSnapshot().healthy,true);release.resolve();await check;assertPreparedRuntimeRemoteReleased(f.remote);assert.equal(gateway.runtime.resourcesClosed,true);}
  finally{release.resolve();t.mock.restoreAll();await gateway.close();await socket.close();}
 },ports=>change(ports.backend,'close',async()=>{entered.resolve();await release.promise;}));
});

for(const fail of [false,true])test(`remote early ${fail?'failure':'normal exit'} is monitored and propagates exact shutdown cause`,{timeout:15000},async()=>{
 const primary=Error('remote fixture failure');const ws=await remoteSocket(peer=>peer.once('message',()=>{peer.send('{"type":"hello_ack"}');if(fail)peer.close();}));
 try{await preparedFixture(async f=>{const running=await startFixture(f);try{
  if(!fail){await until(()=>syntheticRuntimeRemoteSnapshot(f.profile).status.connected);requestPreparedRuntimeRemoteStop(f.remote);}
  const remoteWorker=running.workers.workers.find(w=>w.name==='remote-mcp')!;await remoteWorker.join();const result=await runPreparedRuntimeLifetime(running.workers,f.controller,f.stop.signal,lifetimeOptions(f));assert.deepEqual(result.selection.cause,{kind:'Worker',worker:'remote-mcp'});assert.equal(result.finalized.decision.result.ok,false);if(!result.finalized.decision.result.ok){if(fail)assert.equal(result.finalized.decision.result.error,primary);else{assert.ok(result.finalized.decision.result.error instanceof RuntimeEarlyExitError);assert.equal(result.finalized.decision.result.error.identity,'remote-mcp');}}await closePreparedRuntimeOuter(result,running.gateway,f.controller);
 }finally{await running.close();}},ports=>{if(fail)change(ports.input,'disconnected',async()=>{throw primary;});},ws.url);}finally{await ws.close();}
});

test('same-tick remote start reuse rejects before a second task allocation and cannot steal close custody',{timeout:15000},async()=>preparedFixture(async f=>{
 claimPreparedRuntimeRemote(f.remote,f.context,f.controller.admissionGate);const notifier=new RuntimeWorkerExitChannel();
 const started=startPreparedRuntimeRemote(f.remote,notifier);const second=assert.rejects(startPreparedRuntimeRemote(f.remote,notifier),/not claimed/);assert.throws(()=>closePreparedRuntimeRemote(f.remote),/Join active/);
 const worker=await started;await second;requestPreparedRuntimeRemoteStop(f.remote);await worker.join();notifier.close();assertPreparedRuntimeRemoteReleased(f.remote);assert.equal(preparedRuntimeRemoteSnapshot(f.remote).phase,'closed');
}));

for(const restart of [false,true])test(`root marker inspection precedes first remote stop on user abort; ${restart?'restart protects once':'normal stop does not protect'}`,{timeout:20000},async t=>{
 const markerEntered=deferred(),markerRelease=deferred(),writeEntered=deferred(),writeRelease=deferred(),cleanupEntered=deferred(),cleanupRelease=deferred();
 const ws=await remoteSocket(peer=>peer.once('message',()=>{peer.send('{"type":"hello_ack"}');peer.send(command('project_session'));peer.once('message',()=>peer.send(command('write_file',{request_id:'write'})));}));
 try{await preparedFixture(async f=>{
  const running=await startFixture(f);const original=PosixDrainMarkerStore.prototype.restartRequested;let settled=false,releaseOuter=0;
  try{await writeEntered.promise;if(restart)writeFileSync(join(f.input.paths.root,DRAIN_MARKER_NAMES.restart),'restart');
   t.mock.method(PosixDrainMarkerStore.prototype,'restartRequested',async function(this:PosixDrainMarkerStore){markerEntered.resolve();await markerRelease.promise;return original.call(this);});
   const pending=runPreparedRuntimeLifetime(running.workers,f.controller,f.stop.signal,lifetimeOptions(f)).then(async result=>{settled=true;await closePreparedRuntimeOuter(result,running.gateway,f.controller);releaseOuter++;return result;});f.stop.abort();await markerEntered.promise;
   await delay(5);assert.equal(syntheticRuntimeRemoteSnapshot(f.profile).status.connected,true);assert.equal(syntheticRuntimeRemoteSnapshot(f.profile).handoffRequested,false);assert.equal(settled,false);assert.equal(f.context.owner.lifecycleSnapshot().healthy,true);
   markerRelease.resolve();await until(()=>syntheticRuntimeRemoteSnapshot(f.profile).handoffRequested===restart&&preparedRuntimeRemoteSnapshot(f.remote).managed.phase==='running');await delay(10);
   assert.equal(settled,false);assert.equal(releaseOuter,0);assert.equal(existsSync(join(f.input.paths.root,DRAIN_MARKER_NAMES.identity)),true);assert.equal(f.ports.counts().protects,0);writeRelease.resolve();await cleanupEntered.promise;assert.equal(settled,false);assert.equal(f.context.owner.lifecycleSnapshot().healthy,true);cleanupRelease.resolve();const result=await pending;
   assert.equal(result.finalized.decision.result.ok,true);assert.equal(releaseOuter,1);assert.equal(existsSync(join(f.input.paths.root,DRAIN_MARKER_NAMES.identity)),false);assert.equal(f.ports.counts().protects,restart?1:0);assert.equal(preparedRuntimeRemoteSnapshot(f.remote).managed.handoffPrepared,restart);
  }finally{markerRelease.resolve();writeRelease.resolve();cleanupRelease.resolve();t.mock.restoreAll();await running.close();}
 },ports=>{change(ports.backend,'writeFile',async c=>{writeEntered.resolve();await writeRelease.promise;return Object.freeze({path:c.path,sha256:'a'.repeat(64),bytes_written:1n,created:true});});change(ports.session,'stopComputer',async()=>{cleanupEntered.resolve();await cleanupRelease.promise;});},ws.url);}finally{await ws.close();}
});

test('explicit stop marker overrides restart and failed synthetic protection propagates after real joins',{timeout:20000},async()=>{
 for(const stop of [true,false]){
  const primary=Error('synthetic protection failed'),ws=await remoteSocket(peer=>peer.once('message',()=>peer.send('{"type":"hello_ack"}')));
  try{await preparedFixture(async f=>{const running=await startFixture(f);try{await until(()=>syntheticRuntimeRemoteSnapshot(f.profile).status.connected);writeFileSync(join(f.input.paths.root,DRAIN_MARKER_NAMES.restart),'restart');if(stop)writeFileSync(join(f.input.paths.root,DRAIN_MARKER_NAMES.stop),'stop');f.stop.abort();const result=await runPreparedRuntimeLifetime(running.workers,f.controller,f.stop.signal,lifetimeOptions(f));assert.equal(result.finalized.decision.result.ok,stop);if(!result.finalized.decision.result.ok)assert.equal(result.finalized.decision.result.error,primary);assert.equal(preparedRuntimeRemoteSnapshot(f.remote).managed.handoffPrepared,false);assert.equal(syntheticRuntimeRemoteSnapshot(f.profile).handoffRequested,!stop);assertPreparedRuntimeRemoteReleased(f.remote);assert.equal(result.cleanup.serverClose.ok,true);await closePreparedRuntimeOuter(result,running.gateway,f.controller);}finally{await running.close();}},ports=>change(ports.input.handoff,'protect',async()=>{assert.ok(ports.events.includes('project'));throw primary;}),ws.url);}finally{await ws.close();}
 }
});

test('post-join drained restart sets only the sticky flag and never fabricates a protected handoff',{timeout:15000},async()=>{
 const ws=await remoteSocket(peer=>peer.once('message',()=>peer.send('{"type":"hello_ack"}')));
 try{await preparedFixture(async f=>{const running=await startFixture(f);try{
  await until(()=>syntheticRuntimeRemoteSnapshot(f.profile).status.connected);const marker='version=1\nruntime_id=runtime\nprocess_identity=123|456\nnonce=remote-test\n';writeFileSync(join(f.input.paths.root,DRAIN_MARKER_NAMES.prepare),marker);
  const pending=runPreparedRuntimeLifetime(running.workers,f.controller,f.stop.signal,lifetimeOptions(f));await until(()=>existsSync(join(f.input.paths.root,DRAIN_MARKER_NAMES.ack)));assert.equal(preparedRuntimeRemoteSnapshot(f.remote).managed.phase,'closed');assert.equal(syntheticRuntimeRemoteSnapshot(f.profile).handoffRequested,false);writeFileSync(join(f.input.paths.root,DRAIN_MARKER_NAMES.restart),marker);const result=await pending;
  assert.equal(result.finalized.transition,'Restart');assert.equal(result.finalized.decision.result.ok,true);assert.equal(syntheticRuntimeRemoteSnapshot(f.profile).handoffRequested,true);assert.equal(preparedRuntimeRemoteSnapshot(f.remote).managed.handoffPrepared,false);assert.equal(f.ports.counts().protects,0);await closePreparedRuntimeOuter(result,running.gateway,f.controller);
 }finally{await running.close();}},undefined,ws.url);}finally{await ws.close();}
});

test('failed remote resource cleanup withholds resident and outer release authority after exact worker joins',{timeout:15000},async()=>{
 const ws=await remoteSocket(peer=>peer.once('message',()=>peer.send('{"type":"hello_ack"}')));
 try{await preparedFixture(async f=>{const running=await startFixture(f);try{
  await until(()=>syntheticRuntimeRemoteSnapshot(f.profile).status.connected);f.stop.abort();await assert.rejects(runPreparedRuntimeLifetime(running.workers,f.controller,f.stop.signal,lifetimeOptions(f)),RuntimeRemoteOwnershipRetainedError);assert.equal(f.context.owner.lifecycleSnapshot().healthy,true);assert.equal(existsSync(join(f.input.paths.root,DRAIN_MARKER_NAMES.identity)),true);assert.equal(running.gateway.snapshot().closed,false);assert.throws(()=>closePreparedRuntimeOuter({},running.gateway,f.controller),/completed/);assert.throws(()=>assertPreparedRuntimeRemoteReleased(f.remote),RuntimeRemoteOwnershipRetainedError);assert.equal(preparedRuntimeRemoteSnapshot(f.remote).managed.phase,'retained');
 }finally{await running.close();}},ports=>change(ports.backend,'close',async()=>{throw Error('synthetic resource cleanup unconfirmed');}),ws.url);}finally{await ws.close();}
});

test('disposed authentic Pro context cannot restore or acquire remote projects',async()=>storeFixture(async path=>{
 const input=remoteRuntimeInput(path),ports=remoteInput(),profile=createSyntheticRuntimeRemoteProfile(ports.input),stop=new AbortController(),context=await prepareRuntimeProContext(input,stop.signal,profile);await context.disposeBeforeWorkers();await assert.rejects(prepareSyntheticRuntimeRemote(profile,context,stop.signal),/closed|available/i);assert.deepEqual(ports.events,[]);
}));

test('force deadline retains exact remote work, resident and identity until accepted command actually joins',{timeout:20000},async()=>{
 const writeEntered=deferred(),writeRelease=deferred();const ws=await remoteSocket(peer=>peer.once('message',()=>{peer.send('{"type":"hello_ack"}');peer.send(command('project_session'));peer.once('message',()=>peer.send(command('write_file',{request_id:'held'})));}));
 try{await preparedFixture(async f=>{const running=await startFixture(f),fatal=Error('synthetic force deadline');try{
  await writeEntered.promise;f.stop.abort();const clock={now:()=>performance.now(),sleepUntil:async(deadline:number,signal:AbortSignal)=>{if(deadline-performance.now()<20000)return;await new Promise<void>(resolve=>{signal.addEventListener('abort',()=>resolve(),{once:true});if(signal.aborted)resolve();});}};
  await assert.rejects(runPreparedRuntimeLifetime(running.workers,f.controller,f.stop.signal,{...lifetimeOptions(f),shutdown:{report:()=>{},clock,fatal:()=>{throw fatal;}}}),error=>{assert.ok(error instanceof AggregateError);assert.ok(error.errors.includes(fatal));return true;});
  const remoteWorker=running.workers.workers.find(w=>w.name==='remote-mcp')!;assert.equal(remoteWorker.peek(),undefined);assert.equal(f.context.owner.lifecycleSnapshot().healthy,true);assert.equal(existsSync(join(f.input.paths.root,DRAIN_MARKER_NAMES.identity)),true);assert.equal(running.gateway.snapshot().closed,false);assert.throws(()=>closePreparedRuntimeOuter({},running.gateway,f.controller),/completed/);
  writeRelease.resolve();await remoteWorker.join();assertPreparedRuntimeRemoteReleased(f.remote);
 }finally{writeRelease.resolve();await running.close();}},ports=>change(ports.backend,'writeFile',async c=>{writeEntered.resolve();await writeRelease.promise;return Object.freeze({path:c.path,sha256:'a'.repeat(64),bytes_written:1n,created:true});}),ws.url);}finally{await ws.close();}
});

test('second owned marker read preserves a stop that arrives after drained restart selection',{timeout:15000},async t=>{
 const ws=await remoteSocket(peer=>peer.once('message',()=>peer.send('{"type":"hello_ack"}')));
 try{await preparedFixture(async f=>{const running=await startFixture(f),original=RuntimeDrainController.prototype.waitForTransition;try{
  await until(()=>syntheticRuntimeRemoteSnapshot(f.profile).status.connected);const marker='version=1\nruntime_id=runtime\nprocess_identity=123|456\nnonce=late-stop\n';writeFileSync(join(f.input.paths.root,DRAIN_MARKER_NAMES.prepare),marker);
  t.mock.method(RuntimeDrainController.prototype,'waitForTransition',async function(this:RuntimeDrainController,...args:Parameters<RuntimeDrainController['waitForTransition']>){const result=await original.apply(this,args);writeFileSync(join(f.input.paths.root,DRAIN_MARKER_NAMES.stop),'stop');return result;});
  const pending=runPreparedRuntimeLifetime(running.workers,f.controller,f.stop.signal,lifetimeOptions(f));await until(()=>existsSync(join(f.input.paths.root,DRAIN_MARKER_NAMES.ack)));writeFileSync(join(f.input.paths.root,DRAIN_MARKER_NAMES.restart),marker);const result=await pending;assert.equal(result.finalized.transition,'Restart');assert.equal(syntheticRuntimeRemoteSnapshot(f.profile).handoffRequested,false);assert.equal(f.ports.counts().protects,0);await closePreparedRuntimeOuter(result,running.gateway,f.controller);
 }finally{t.mock.restoreAll();await running.close();}},undefined,ws.url);}finally{await ws.close();}
});

test('owned restart request arriving during actual remote drain is sampled once after command settlement',{timeout:15000},async()=>{
 const entered=deferred(),release=deferred();let aborted=false;const ws=await remoteSocket(peer=>peer.once('message',()=>{peer.send('{"type":"hello_ack"}');peer.send(command('project_session'));peer.once('message',()=>peer.send(command('write_file',{request_id:'during-drain'})));}));
 try{await preparedFixture(async f=>{const running=await startFixture(f);try{await entered.promise;f.stop.abort();const pending=runPreparedRuntimeLifetime(running.workers,f.controller,f.stop.signal,lifetimeOptions(f));await until(()=>aborted);assert.equal(syntheticRuntimeRemoteSnapshot(f.profile).handoffRequested,false);writeFileSync(join(f.input.paths.root,DRAIN_MARKER_NAMES.restart),'restart');await requestPreparedRuntimeRemoteHandoff(f.remote);assert.equal(f.ports.counts().protects,0);release.resolve();const result=await pending;assert.equal(f.ports.counts().protects,1);assert.equal(preparedRuntimeRemoteSnapshot(f.remote).managed.handoffPrepared,true);await closePreparedRuntimeOuter(result,running.gateway,f.controller);}finally{release.resolve();await running.close();}},ports=>change(ports.backend,'writeFile',async(c,context)=>{context.signal.addEventListener('abort',()=>{aborted=true;},{once:true});entered.resolve();await release.promise;return Object.freeze({path:c.path,sha256:'a'.repeat(64),bytes_written:1n,created:true});}),ws.url);}finally{await ws.close();}
});

test('same-tick stop joins the actual prepared remote resource without entering managed run',{timeout:15000},async()=>{
 const entered=deferred(),release=deferred();await preparedFixture(async f=>{
  claimPreparedRuntimeRemote(f.remote,f.context,f.controller.admissionGate);const notifier=new RuntimeWorkerExitChannel(),started=startPreparedRuntimeRemote(f.remote,notifier);requestPreparedRuntimeRemoteStop(f.remote);const worker=await started;await entered.promise;assert.equal(worker.peek(),undefined);assert.equal(preparedRuntimeRemoteSnapshot(f.remote).managed.phase,'closing');release.resolve();const result=await worker.join();assert.equal(result.kind,'TaskFailure');if(result.kind==='TaskFailure')assert.equal(result.cancelled,true);assertPreparedRuntimeRemoteReleased(f.remote);notifier.close();
 },ports=>change(ports.backend,'close',async()=>{entered.resolve();await release.promise;}));
});

test('context disposal during pending restore joins the accepted remote cleanup before preparation rejects',{timeout:15000},async()=>storeFixture(async path=>{
 const input=remoteRuntimeInput(path),ports=remoteInput(),restoreEntered=deferred(),restoreRelease=deferred(),closeEntered=deferred(),closeRelease=deferred();const restore=ports.input.handoff.restore;
 change(ports.input.handoff,'restore',async signal=>{restoreEntered.resolve();await restoreRelease.promise;return Reflect.apply(restore,undefined,[signal]);});change(ports.backend,'close',async()=>{closeEntered.resolve();await closeRelease.promise;});
 const profile=createSyntheticRuntimeRemoteProfile(ports.input),stop=new AbortController(),context=await prepareRuntimeProContext(input,stop.signal,profile);let settled=false;
 try{const pending=assert.rejects(prepareSyntheticRuntimeRemote(profile,context,stop.signal),/closed/).then(()=>{settled=true;});await restoreEntered.promise;await context.disposeBeforeWorkers();restoreRelease.resolve();await closeEntered.promise;assert.equal(settled,false);closeRelease.resolve();await pending;assert.equal(syntheticRuntimeRemoteSnapshot(profile).phase,'failed');}finally{restoreRelease.resolve();closeRelease.resolve();await context.disposeBeforeWorkers();}
}));
