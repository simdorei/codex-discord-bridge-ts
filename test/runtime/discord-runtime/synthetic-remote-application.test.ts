import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {existsSync,writeFileSync,readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {remoteRuntimeInput,remoteInput,remoteSocket,gatewaySocket,deferred,until,change,command} from '../../helpers/remote-runtime-fixture.ts';
import {createSyntheticRuntimeRemoteProfile,syntheticRuntimeRemoteSnapshot} from '../../../src/runtime/discord-runtime/remote-start.ts';
import {runLocalRuntimeApplication,LocalRuntimeOwnershipRetainedError} from '../../../src/runtime/discord-runtime/local-application.ts';
import {loadRuntimeConfig} from '../../../src/config/runtime.ts';
import {PosixRuntimeInstance} from '../../../src/runtime/runtime-instance.ts';
import {RuntimeStopSignal} from '../../../src/runtime/discord-runtime/stop-signal.ts';
import {RuntimeWorkerExitChannel} from '../../../src/runtime/discord-runtime/monitored-worker.ts';
import {RecommendedGateway} from '../../../src/discord/gateway/recommended.ts';
import {DRAIN_MARKER_NAMES} from '../../../src/runtime/restart-readiness/drain-marker.ts';
import type {RemoteOperationContext} from '../../../src/remote-agent/dispatcher-ports.ts';

/** The known UNIX bind restriction is not retried. This explicitly fake singleton
 * tests application custody only; it does not qualify POSIX lock exclusion. */
function rootSeam(t:TestContext,input:ReturnType<typeof remoteRuntimeInput>){
 const stop=new AbortController();let acquires=0,releases=0,disposed=0,ready=false;
 const instance={release:async()=>{releases++;}} as unknown as PosixRuntimeInstance;
 t.mock.method(PosixRuntimeInstance,'acquire',async(root:string)=>{assert.equal(root,input.paths.root);acquires++;return instance;});
 t.mock.method(RuntimeStopSignal,'install',()=>({signal:stop.signal,dispose:()=>{disposed++;}} as unknown as RuntimeStopSignal));
 const close=RuntimeWorkerExitChannel.prototype.close;t.mock.method(RuntimeWorkerExitChannel.prototype,'close',function(this:RuntimeWorkerExitChannel){ready=true;return close.call(this);});
 const config={...loadRuntimeConfig(new Map([['DISCORD_BOT_TOKEN','synthetic-root-bot'],['DISCORD_ALLOW_ALL_CHANNELS','1']])),sessionMirror:false};
 const env={HOME:input.paths.root,CODEX_HOME:input.paths.root,CODEX_STATE_DB:input.paths.stateDb,CODEX_EXE:input.executor.pro.executable,CODEX_DISCORD_MIRROR_DB:input.paths.mirrorDb};
 return {stop,config,env,counts:()=>({acquires,releases,disposed,ready})};
}

test('synthetic singleton seam proves restore failure precedes gateway exposure and releases only after joined initialization cleanup',{timeout:15000},async t=>storeFixture(async path=>{
 const input=remoteRuntimeInput(path),ports=remoteInput(),root=rootSeam(t,input),primary=Error('restore fixture failed'),entered=deferred(),release=deferred();let projects=0,gatewayCalls=0,settled=false;
 change(ports.input.handoff,'restore',async()=>Object.freeze(['a','b'].map(threadId=>Object.freeze({threadId,root:'/synthetic',expiresAt:Object.freeze({seconds:300n,nanosecond:0n})}))));change(ports.input.dispatcher,'openProject',async()=>{if(++projects===2)throw primary;return ports.backend;});change(ports.backend,'close',async()=>{entered.resolve();await release.promise;});
 t.mock.method(RecommendedGateway,'startPaused',async()=>{gatewayCalls++;throw Error('unexpected gateway');});
 const profile=createSyntheticRuntimeRemoteProfile(ports.input);
 try{const pending=assert.rejects(runLocalRuntimeApplication(root.config,root.env,input.paths.root,'fixture',undefined,undefined,profile),e=>e===primary).then(()=>{settled=true;});await entered.promise;await delay(5);assert.equal(settled,false);assert.equal(gatewayCalls,0);assert.equal(root.counts().releases,0);assert.equal(existsSync(join(input.paths.root,DRAIN_MARKER_NAMES.identity)),true);release.resolve();await pending;assert.equal(root.counts().releases,1);assert.equal(root.counts().disposed,1);assert.equal(existsSync(join(input.paths.root,DRAIN_MARKER_NAMES.identity)),false);}
 finally{release.resolve();t.mock.restoreAll();}
}));

test('synthetic singleton seam joins prepared remote cleanup after gateway construction failure',{timeout:15000},async t=>storeFixture(async path=>{
 const input=remoteRuntimeInput(path),ports=remoteInput(),root=rootSeam(t,input),primary=Error('gateway fixture failed'),entered=deferred(),release=deferred();let settled=false;
 change(ports.backend,'close',async()=>{entered.resolve();await release.promise;});t.mock.method(RecommendedGateway,'startPaused',async()=>{assert.deepEqual(ports.events,['restore','open']);throw primary;});const profile=createSyntheticRuntimeRemoteProfile(ports.input);
 try{const pending=assert.rejects(runLocalRuntimeApplication(root.config,root.env,input.paths.root,'fixture',undefined,undefined,profile),e=>e===primary).then(()=>{settled=true;});await entered.promise;assert.equal(settled,false);assert.equal(root.counts().releases,0);assert.equal(existsSync(join(input.paths.root,DRAIN_MARKER_NAMES.identity)),true);release.resolve();await pending;assert.equal(root.counts().releases,1);assert.equal(existsSync(join(input.paths.root,DRAIN_MARKER_NAMES.identity)),false);}
 finally{release.resolve();t.mock.restoreAll();}
}));

test('synthetic root retains singleton and identity while accepted remote command drains, then releases after protected join',{timeout:20000},async t=>storeFixture(async path=>{
 const input=remoteRuntimeInput(path),root=rootSeam(t,input),entered=deferred(),release=deferred();let accepted:RemoteOperationContext|undefined,settled=false;
 const ws=await remoteSocket(peer=>peer.once('message',()=>{peer.send('{"type":"hello_ack"}');peer.send(command('project_session'));peer.once('message',()=>peer.send(command('write_file',{request_id:'held'})));})),ports=remoteInput(ws.url),socket=await gatewaySocket();
 change(ports.backend,'writeFile',async(c,context)=>{accepted=context;entered.resolve();await release.promise;return Object.freeze({path:c.path,sha256:'a'.repeat(64),bytes_written:1n,created:true});});
 t.mock.method(RecommendedGateway,'startPaused',async()=>{assert.equal(ports.events.filter(e=>e==='restore').length,1);assert.equal(ws.count(),0);return RecommendedGateway.startPausedForTest(socket);});const profile=createSyntheticRuntimeRemoteProfile(ports.input);
 try{const pending=runLocalRuntimeApplication(root.config,root.env,input.paths.root,'fixture',undefined,undefined,profile).then(()=>{settled=true;});await entered.promise;await until(()=>root.counts().ready);writeFileSync(join(input.paths.root,DRAIN_MARKER_NAMES.restart),'restart');root.stop.abort();await until(()=>accepted!.signal.aborted);
  assert.equal(syntheticRuntimeRemoteSnapshot(profile).handoffRequested,true);assert.equal(ports.counts().protects,0);assert.equal(root.counts().releases,0);assert.equal(settled,false);assert.equal(existsSync(join(input.paths.root,DRAIN_MARKER_NAMES.identity)),true);process.kill(Number(readFileSync(join(input.paths.root,'pid'),'utf8')),0);release.resolve();await pending;assert.equal(ports.counts().protects,1);assert.equal(root.counts().releases,1);assert.equal(root.counts().disposed,1);assert.equal(existsSync(join(input.paths.root,DRAIN_MARKER_NAMES.identity)),false);
 }finally{release.resolve();root.stop.abort();t.mock.restoreAll();await ws.close();await socket.close();}
}));

test('synthetic root retains singleton and all runtime owners when prepared remote cleanup is unconfirmed',{timeout:15000},async t=>storeFixture(async path=>{
 const input=remoteRuntimeInput(path),ports=remoteInput(),root=rootSeam(t,input);let retained:LocalRuntimeOwnershipRetainedError|undefined;
 change(ports.backend,'close',async()=>{throw Error('synthetic cleanup failure');});t.mock.method(RecommendedGateway,'startPaused',async()=>{throw Error('gateway fixture failed');});const profile=createSyntheticRuntimeRemoteProfile(ports.input);
 try{await assert.rejects(runLocalRuntimeApplication(root.config,root.env,input.paths.root,'fixture',undefined,undefined,profile),e=>{assert.ok(e instanceof LocalRuntimeOwnershipRetainedError);retained=e;return true;});assert.equal(root.counts().releases,0);assert.equal(root.counts().disposed,0);assert.equal(existsSync(join(input.paths.root,DRAIN_MARKER_NAMES.identity)),true);}
 finally{t.mock.restoreAll();if(retained!==undefined){const owners=retained.owners as {context:{disposeBeforeWorkers:()=>Promise<void>};controller:{dispose:()=>Promise<void>};instance:{release:()=>Promise<void>};stop:{dispose:()=>void}};await owners.context.disposeBeforeWorkers();await owners.controller.dispose();await owners.instance.release();owners.stop.dispose();}}
}));
