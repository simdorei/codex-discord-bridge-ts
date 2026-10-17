import {QueueForkCoordinator} from '../../../src/runtime/queue-runner/fork-coordinator.ts';
import {StateAccessFacade as stateAccess} from '../../../src/store/state-access-facade.ts';
import {setTimeout as sleep} from 'node:timers/promises';
import {mirrorQueueFixture} from '../../helpers/mirror-queue-fixture.ts';
import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {writeFile,appendFile} from 'node:fs/promises';import {join,dirname} from 'node:path';
import {storeFixture} from '../../helpers/store-fixture.ts';import {openInitialized} from '../../../src/store/owned-driver.ts';import {captureMirrorCursorAnchor} from '../../../src/runtime/session-mirror/continuity-observation.ts';import {NativeMirrorCursorStore} from '../../../src/runtime/session-mirror/cursor-store.ts';
import type {BoundMirrorWorkerConfig} from '../../../src/runtime/session-mirror/bound-poll.ts';import {ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';import {mirrorRunnerBusy} from '../../../src/runtime/session-mirror/runner.ts';
import {startSessionMirrorRuntimeWorker,MirrorShutdownReportError} from '../../../src/runtime/discord-runtime/session-mirror-start.ts';import {RuntimeWorkerExitChannel} from '../../../src/runtime/discord-runtime/monitored-worker.ts';import {MirrorBatchExecutionError} from '../../../src/runtime/session-mirror/observed-batch-executor.ts';
import {createServer} from 'node:http';import {DiscordChannelClient} from '../../../src/discord/channel-client.ts';import {createSessionMirrorHttpTransport} from '../../../src/runtime/discord-runtime/session-mirror-http.ts';import type {RuntimeMirrorObservation} from '../../../src/runtime/discord-runtime/session-mirror-start.ts';
import {DeliveryFailure} from '../../../src/discord/delivery.ts';import {CompletionDeliveryError} from '../../../src/runtime/completion/receipt-sender.ts';
async function fixture(run:(config:BoundMirrorWorkerConfig,cursor:NativeMirrorCursorStore,queue:ReturnType<typeof mirrorQueueFixture>)=>Promise<void>){await storeFixture(async bridge=>{
 const file=join(dirname(bridge),'rollout.jsonl'),state=join(dirname(bridge),'state.sqlite');await writeFile(file,'');let db=await openInitialized(bridge);try{db.prepare('INSERT INTO mirror_threads VALUES(?,?,?,?,?,?)').run('thread','project','title',1n,42n,1)}finally{db.close()}
 db=new DatabaseSync(state);try{db.exec('CREATE TABLE threads(id TEXT,title TEXT,cwd TEXT,updated_at INTEGER,rollout_path TEXT,model TEXT,reasoning_effort TEXT,tokens_used INTEGER,archived INTEGER,archived_at INTEGER)');db.prepare('INSERT INTO threads(id,rollout_path,archived)VALUES(?,?,0)').run('thread',file)}finally{db.close()}
 const cursor=new NativeMirrorCursorStore(bridge);try{await cursor.initializeSchema();await cursor.initializeFresh('thread',(await captureMirrorCursorAnchor(file,0n)).anchor,'turn',1,'init');await appendFile(file,JSON.stringify({type:'event_msg',payload:{type:'agent_message',message:'runner'}})+'\n');
 await run({stateDatabasePath:state,bridgeDatabasePath:bridge,discovery:{threads:{maxRows:32n,maxValueBytes:1048576n,maxOutputBytes:1048576,timeoutMs:5000},store:{maxTargets:32n,maxJobs:32n,maxValueBytes:1048576n,maxOutputBytes:1048576,timeoutMs:5000}},ready:{maxTargets:32,maxBytes:1048576},poll:{read:{maxWindowBytes:65536,maxRecordBytes:32768,maxRecords:20,decodeTimeoutMs:5000},ownership:{maxJobs:32n,maxValueBytes:1048576n,timeoutMs:5000}}},cursor,mirrorQueueFixture(bridge));
 }finally{await cursor.close()}
})}
test('disabled source branch creates no worker or subscriptions and inspects no configuration',()=>{
 let hooks=0;const trap=new Proxy({},{get(){hooks++;throw Error('hook')},getOwnPropertyDescriptor(){hooks++;throw Error('hook')}}) as never;
 assert.equal(startSessionMirrorRuntimeWorker(false,trap,trap,trap,trap,trap,trap,trap),null);assert.equal(hooks,0);assert.equal(mirrorRunnerBusy(),false);
});
test('forced mirror cancellation reaches the original receipt operation and joins it without app shutdown',{timeout:15000},async()=>fixture(async(config,cursor,queue)=>{
 const appStop=new AbortController(),notifier=new RuntimeWorkerExitChannel();let entered!:()=>void,operation:AbortSignal|undefined;
 const started=new Promise<void>(resolve=>entered=resolve),transport={sendValidated:async(_request:unknown,signal?:AbortSignal):Promise<bigint>=>{
  operation=signal;entered();assert.ok(signal);return new Promise((_resolve,reject)=>{const aborted=()=>reject(signal.reason);signal.addEventListener('abort',aborted,{once:true});if(signal.aborted)aborted();});
 }};
 const worker=startSessionMirrorRuntimeWorker(true,config,transport,appStop.signal,notifier,()=> 'cancelled',()=>{},queue)!;notifier.close();
 try{await started;assert.equal(operation!.aborted,false);assert.equal(queue.locks.tryAcquire('thread'),undefined);worker.abort();
  assert.deepEqual(await worker.join(),{kind:'Returned',result:{ok:true}});assert.equal(operation!.aborted,true);assert.equal(appStop.signal.aborted,false);assert.equal((await cursor.read('thread'))!.revision,1n);assert.equal(queue.locks.activeTargetCount,0);assert.equal(ownedWorkerUsage().Background,0);
 }finally{worker.abort();await worker.join();}
}));
test('monitored native mirror captures config and transport before scheduling and announces joined exit',async()=>fixture(async(config,cursor,queue)=>{
 const stop=new AbortController(),notifier=new RuntimeWorkerExitChannel(),receiver=notifier.receiver();let calls=0;const transport={async sendValidated(){calls++;return 123n;}};
 const worker=startSessionMirrorRuntimeWorker(true,config,transport,stop.signal,notifier,()=> 'bounded failure',event=>{if(event.kind==='Targets')stop.abort('done');},queue)!;notifier.close();
 Object.assign(config,{bridgeDatabasePath:config.bridgeDatabasePath+'.wrong'});Object.assign(config.poll.read,{maxRecords:0});transport.sendValidated=async()=>{assert.fail('replacement HTTP');};
 try{assert.equal(worker.name,'session-mirror');assert.deepEqual(await worker.join(),{kind:'Returned',result:{ok:true}});assert.equal(await receiver.receive(),'session-mirror');assert.equal(await receiver.receive(),null);assert.equal(calls,1);assert.equal((await cursor.read('thread'))!.revision,2n);assert.equal(ownedWorkerUsage().Background,0);}finally{stop.abort('cleanup');worker.abort();await worker.join();receiver.dispose();}
}));
test('forced monitored shutdown retains joined late-acceptance packet when final evidence reporter fails',async()=>fixture(async(config,cursor,queue)=>{
 const stop=new AbortController(),notifier=new RuntimeWorkerExitChannel();let started!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>started=r),wait=new Promise<void>(r=>release=r);const reporting={failure:true};let calls=0;
 const worker=startSessionMirrorRuntimeWorker(true,config,{async sendValidated(){calls++;started();await wait;return 123n;}},stop.signal,notifier,()=> 'bounded failure',event=>{if(event.kind==='Shutdown')throw reporting;},queue)!;notifier.close();
 try{await entered;worker.abort();assert.equal(worker.peek(),undefined);assert.equal(queue.locks.tryAcquire('thread'),undefined);assert.equal(queue.locks.tryAcquire('mirror-sync-operation'),undefined);release();const result=await worker.join();assert.equal(result.kind,'Returned');if(result.kind!=='Returned'||result.result.ok)assert.fail('shutdown evidence error expected');const error=result.result.error;assert.ok(error instanceof MirrorShutdownReportError);assert.equal(error.cause,reporting);assert.equal(error.settled.length,1);const outcome=error.settled[0]!.outcome;assert.equal(outcome.kind,'Cancelled');if(outcome.kind!=='Cancelled'||outcome.settled.kind!=='Failed')assert.fail('cancelled joined error expected');assert.ok(outcome.settled.error instanceof MirrorBatchExecutionError);assert.notEqual(outcome.settled.error.packet,null);assert.equal((await cursor.read('thread'))!.revision,1n);assert.equal(calls,1);const db=await openInitialized(config.bridgeDatabasePath);try{assert.equal(db.prepare('SELECT message_id AS id FROM codex_delivery_receipts').get()!.id,'123');}finally{db.close();}assert.equal(ownedWorkerUsage().Background,0);assert.equal(mirrorRunnerBusy(),false);assert.equal(queue.locks.activeTargetCount,0);
 }finally{release();stop.abort('cleanup');worker.abort();await worker.join();}
}));
test('invalid active startup diagnostics fail before a monitored sender lease is acquired',async()=>fixture(async(config,_cursor,queue)=>{
 const notifier=new RuntimeWorkerExitChannel(),receiver=notifier.receiver(),signal=new AbortController().signal;const transport={async sendValidated(){assert.fail('HTTP');return 1n;}};
 assert.throws(()=>startSessionMirrorRuntimeWorker(true,config,transport,signal,notifier,()=>'',async()=>{},queue),TypeError);
 notifier.close();assert.equal(await receiver.receive(),null);receiver.dispose();assert.equal(mirrorRunnerBusy(),false);assert.equal(ownedWorkerUsage().Background,0);
}));

for(const valid of [true,false])test(`runtime mirror with prebound synthetic cursor ${valid?'commits a full HTTP receipt and advances':'holds a malformed HTTP receipt without advancing'} before joined shutdown`,{timeout:20000},async()=>fixture(async(config,cursor,queue)=>{
 const seen:{method:string;path:string;body:string}[]=[],events:RuntimeMirrorObservation[]=[];
 const message={attachments:[],author:{id:'1',username:'fixture',discriminator:'0'},channel_id:'42',content:'In progress\n\nrunner',embeds:[],id:'123',type:0,mention_everyone:false,mention_roles:[],mentions:[],pinned:false,timestamp:'2020-01-01T00:00:00+00:00',tts:false};
 const server=createServer((req,res)=>{
  assert.equal(req.headers.authorization,undefined);let body='';req.on('data',part=>body+=String(part));
  req.on('end',()=>{seen.push({method:req.method!,path:req.url!,body});if(req.url?.endsWith('/typing')){res.writeHead(204);res.end();}else res.end(valid?JSON.stringify(message):'{"id":"123"}');});
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');
 const client=await DiscordChannelClient.create({token:null,testOrigin:`http://127.0.0.1:${address.port}/api/v10/`,report:()=>{}});
 try{
  const before=await cursor.read('thread');assert.ok(before);assert.equal(before.revision,1n);assert.equal(before.anchor.offset,0n);
  const stop=new AbortController(),notifier=new RuntimeWorkerExitChannel(),receiver=notifier.receiver();
  const worker=startSessionMirrorRuntimeWorker(true,config,createSessionMirrorHttpTransport(client,stop.signal),stop.signal,notifier,()=> 'bounded failure',event=>{events.push(event);if(event.kind!=='Shutdown')stop.abort('observed target');},queue)!;notifier.close();
  try{
   assert.deepEqual(await worker.join(),{kind:'Returned',result:{ok:true}});assert.equal(await receiver.receive(),'session-mirror');assert.equal(await receiver.receive(),null);
   assert.equal(events.length,1);const event=events[0]!;assert.equal(event.kind,'Targets');if(event.kind!=='Targets')assert.fail('Expected observed target');assert.equal(event.rows.length,1);
   const outcome=event.rows[0]!.finished.outcome;
   if(valid){assert.deepEqual(outcome,{kind:'Completed',progress:{targets:1n,events:1n,sent:1n}});}else{
    assert.equal(outcome.kind,'Failed');if(outcome.kind!=='Failed')assert.fail('Expected held receipt failure');assert.ok(outcome.error instanceof MirrorBatchExecutionError);assert.ok(outcome.error.cause instanceof DeliveryFailure);assert.ok(outcome.error.cause.source instanceof CompletionDeliveryError);assert.match(outcome.error.cause.source.message,/send outcome unconfirmed.*receipt decode failed/);
   }
   assert.equal(seen.length,1);assert.equal(seen[0]!.method,'POST');assert.equal(seen[0]!.path,'/api/v10/channels/42/messages');assert.equal(JSON.parse(seen[0]!.body).content,'In progress\n\nrunner');assert.equal(JSON.parse(seen[0]!.body).enforce_nonce,true);
   const after=await cursor.read('thread');assert.ok(after);
   if(valid){assert.equal(after.revision,2n);assert.ok(after.anchor.offset>before.anchor.offset);assert.equal(after.anchor.path,before.anchor.path);}else assert.deepEqual(after,before);
   const db=await openInitialized(config.bridgeDatabasePath);try{
    const receipts=db.prepare('SELECT message_id,retryable,blocked_reason FROM codex_delivery_receipts').all();assert.equal(receipts.length,1);assert.equal(receipts[0]!.message_id,valid?'123':null);assert.equal(receipts[0]!.retryable,0);assert.equal(receipts[0]!.blocked_reason,null);
   }finally{db.close();}
   assert.equal(client.activeRequests,0);assert.equal(ownedWorkerUsage().Background,0);assert.equal(mirrorRunnerBusy(),false);
   await client.createTyping(42n,new AbortController().signal);assert.equal(client.activeRequests,0);assert.equal(seen.length,2);assert.equal(seen[1]!.path,'/api/v10/channels/42/typing');
  }finally{stop.abort('cleanup');worker.abort();await worker.join();receiver.dispose();}
 }finally{await client.close();assert.equal(client.ownedSockets,0);server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
}));


test('actual fork finalization cannot retarget a mapping until mirror HTTP receipt and cursor work join',async()=>fixture(async(config,cursor,queue)=>{
 const stop=new AbortController(),notifier=new RuntimeWorkerExitChannel();let entered!:()=>void,release!:()=>void,calls=0;const started=new Promise<void>(r=>entered=r),held=new Promise<void>(r=>release=r);
 const worker=startSessionMirrorRuntimeWorker(true,config,{async sendValidated(){entered();await held;return 123n;}},stop.signal,notifier,String,event=>{if(event.kind==='Targets')stop.abort('one poll');},queue)!;notifier.close();
 const fork=new QueueForkCoordinator(config.bridgeDatabasePath,{generation:()=>1n,requiresAppServerFork:()=>true,forkThread:async()=>{calls++;assert.equal((await cursor.read('thread'))!.revision,2n,'Fork can dispatch only after mirror cursor settlement');return 'forked-thread';}},stateAccess,queue.locks);
 let pending:ReturnType<QueueForkCoordinator['ensureTarget']>|undefined;
 try{await started;pending=fork.ensureTarget('thread');await sleep(20);assert.equal(calls,0);assert.equal(await stateAccess.unresolvedAppServerForkHandoffForSource(config.bridgeDatabasePath,'thread'),null);assert.equal(await stateAccess.mirroredThreadId(config.bridgeDatabasePath,42n),'thread');
  release();assert.deepEqual(await worker.join(),{kind:'Returned',result:{ok:true}});assert.equal((await pending).threadId,'forked-thread');assert.equal(calls,1);assert.equal(await stateAccess.mirroredThreadId(config.bridgeDatabasePath,42n),'forked-thread');assert.equal(queue.locks.activeTargetCount,0);
 }finally{release();stop.abort('cleanup');worker.abort();await worker.join();await pending;}
}));
