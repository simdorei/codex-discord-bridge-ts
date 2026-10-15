import {GatewayIngress} from '../../../src/discord/gateway/ingress.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,writeFileSync,renameSync,existsSync} from 'node:fs';
import {setupPromptRuntime} from '../../helpers/native-server-prompt-runtime-fixture.ts';
import {promptFixture} from '../../helpers/server-prompt-fixture.ts';
import {promptHttpFixture,promptHttpMessage,type PromptHttpRequest} from '../../helpers/server-prompt-http-fixture.ts';
import {historyRetryClock,waitHistoryCondition as until} from '../../helpers/history-retry-clock.ts';
import {instrumentStoreWorker,waitTrace,releaseTrace} from '../../helpers/store-authority-worker-fixture.ts';
import {createPreparedHistoryOperations} from '../../../src/runtime/discord-runtime/history-bootstrap.ts';
import {capturePreparedMessageOptions} from '../../../src/runtime/discord-runtime/message-bootstrap.ts';
import {createDiscordHistoryOperations} from '../../../src/runtime/discord-runtime/history-operations.ts';
import {runHistoryConsumer} from '../../../src/runtime/discord-runtime/history-consumer.ts';
import {recoverPendingDiscordHistory} from '../../../src/runtime/discord-runtime/gap-recovery.ts';
import {recoverDiscordHistoryChannel,pollDiscordHistoryChannel,takeHistoryPolicyCapacityRefusal,type DiscordHistoryGapOptions} from '../../../src/runtime/history-poll/discord-gap.ts';
import {createNativeMirrorPolicyRefresh,refreshMirrorPolicyOffThread,type NativeMirrorPolicyLimits} from '../../../src/runtime/discord-runtime/native-mirror-policy.ts';
import {OwnedWorkerSlot,OwnedWorkerBudgetError,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
import {GatewayIdentityTracker} from '../../../src/discord/gateway/identity.ts';
import {MessageGapTracker} from '../../../src/discord/gateway/message-gaps.ts';
import {HistoryPollState} from '../../../src/runtime/history-poll/state.ts';
import {DrainFenceKey} from '../../../src/admission/drain-gate.ts';
import {RUNTIME_HELP} from '../../../src/runtime/action-executor/help.ts';
import {splitDeliveryChunks} from '../../../src/discord/text.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
const identity={applicationId:4n,userId:9n},floor={micros:1577836800000000n,messageId:1n},limits={maxRows:100n,maxValueBytes:65536n,maxOutputIds:200,timeoutMs:5000},messageId=9007199254740993n;
const workerName='discord-runtime/mirror-policy-worker'+(import.meta.url.endsWith('.js')?'.js':'.ts');
const message=(id=messageId,channel=1n)=>({...promptHttpMessage(String(id),'!help'),channel_id:String(channel)});
const signal=()=>new AbortController().signal;
function sql(path:string,query:string){const db=new DatabaseSync(path);try{db.exec(query);}finally{db.close();}}
const waitingWorker=new URL('data:text/javascript,'+encodeURIComponent("import {parentPort,workerData} from 'node:worker_threads';Atomics.wait(new Int32Array(workerData),0,0,15000);parentPort.postMessage(true);"));
function fillBackground(){const shared=new SharedArrayBuffer(4),slots=[new OwnedWorkerSlot(),new OwnedWorkerSlot(),new OwnedWorkerSlot()],tasks=slots.map(s=>s.run(waitingWorker,shared,10000));return {async release(){Atomics.store(new Int32Array(shared),0,1);Atomics.notify(new Int32Array(shared),0);await Promise.all(tasks);await Promise.all(slots.map(s=>s.join()));}};}
async function fixture(run:(c:{f:ReturnType<typeof setupPromptRuntime>;http:Parameters<typeof createPreparedHistoryOperations>[2];seen:PromptHttpRequest[];tracker:MessageGapTracker;gaps:ReturnType<MessageGapTracker['subscribe']>;history:ReturnType<typeof createPreparedHistoryOperations>;direct:DiscordHistoryGapOptions;page:unknown[];install:(bounds?:NativeMirrorPolicyLimits)=>ReturnType<typeof createPreparedHistoryOperations>})=>Promise<void>,bounds=limits){
 await promptFixture(async(path,server)=>{const f=setupPromptRuntime(path,server),tracker=new MessageGapTracker(),gaps=tracker.subscribe(),page:unknown[]=[message()];
  try{await promptHttpFixture(async(http,seen)=>{const install=(historyPolicyLimits:NativeMirrorPolicyLimits=bounds)=>createPreparedHistoryOperations(f.startup,f.gate,http,gaps,{...f.options,historyPolicyLimits,allowedChannelIds:new Set([1n]),startupChannelId:null,historyTargetLimits:{maxRows:100,timeoutMs:5000}}),history=install(),direct={...capturePreparedMessageOptions(f.startup,f.gate,http,f.options),applicationId:4n,botUserId:9n,refreshPolicy:createNativeMirrorPolicyRefresh(path,bounds)};
   await run({f,http,seen,tracker,gaps,history,direct,page,install});assert.equal(ownedWorkerUsage().Background,0);
  },(request,_count,response)=>{if(request.method==='GET')response.end(JSON.stringify(page));});}finally{gaps.dispose();tracker.close();}
 });
}
const record=(c:{tracker:MessageGapTracker},channel=1n,id=1n,micros=floor.micros)=>c.tracker.record(channel,{timestampMicros:micros,messageId:id},'Full');

for(const kind of ['singleton','Background'] as const)test(`period-null installed history recovers original gap after real ${kind} capacity frees without another message`,async()=>fixture(async c=>{
 const clock=historyRetryClock(),ids=new GatewayIdentityTracker(),id=ids.subscribeIdentity(),conflict=ids.subscribeConflict(),stop=new AbortController(),force=new AbortController();ids.observe(identity);record(c);c.gaps.tryChanged();
 let release!:()=>Promise<void>,restore=()=>{};
 if(kind==='Background'){const busy=fillBackground();release=()=>busy.release();}
 else{const trace=new SharedArrayBuffer(8);restore=instrumentStoreWorker({match:workerName,trace});const busy=refreshMirrorPolicyOffThread(c.f.startup.policy,c.f.path,limits);await waitTrace(trace);release=async()=>{restore();releaseTrace(trace);await busy;};}
 const pending=runHistoryConsumer(c.gaps,id,conflict,stop.signal,force.signal,null,c.history,clock.clock);
 try{await until(()=>clock.active===1);assert.equal(c.gaps.snapshot().length,1);assert.equal(c.seen.length,0);assert.equal(c.f.reports.at(-1),'discord_message_gap_deferred');assert.equal(await state.getIngress(c.f.path,`message:${messageId}`),null);
  const drained=DrainFenceKey.create('retry-delay','1|2','fixture');c.f.gate.seal(drained);assert.equal(c.f.gate.isDrainedFor(drained),true);assert.equal(c.f.gate.release(drained),true);
  await release();assert.equal(ownedWorkerUsage().Background,0);assert.equal(clock.deadlines.at(-1),1000);clock.advance(1000);await until(()=>c.f.reports.includes('discord_message_gap_recovered'));assert.equal(c.gaps.snapshot().length,0);assert.equal((await state.getIngress(c.f.path,`message:${messageId}`))!.eventId,messageId);assert.equal((await state.getIngress(c.f.path,`message:${messageId}`))!.confirmationDelivered,true);assert.equal(c.seen.filter(v=>v.method==='POST').length,splitDeliveryChunks(RUNTIME_HELP,true).length);await until(()=>clock.active===0);
 }finally{restore();await release();stop.abort();await pending;id.dispose();conflict.dispose();ids.close();}
}));

test('installed history policy uses native complete policy and exact bigints while legacy policy facade is poisoned',async t=>fixture(async c=>{
 const channel=9007199254740995n;sql(c.f.path,`INSERT INTO mirror_threads VALUES ('fresh','p','Fresh',10,${channel},1)`);c.page.splice(0,c.page.length,message(messageId,channel));record(c,channel);
 for(const key of ['remainingDiscordIds','mirrorTargets'] as const)t.mock.method(state,key,()=>assert.fail(`legacy policy ${key}`));
 const prepare=DatabaseSync.prototype.prepare;t.mock.method(DatabaseSync.prototype,'prepare',function(this:DatabaseSync,...args:Parameters<typeof prepare>){assert.ok(!/SELECT discord_thread_id AS id FROM mirror_threads|SELECT discord_channel_id AS id FROM mirror_projects|FROM mirror_threads ORDER BY updated_at DESC LIMIT/i.test(args[0]),'main-thread policy query');return prepare.apply(this,args);});
 assert.deepEqual(await c.history.recover(identity,signal()),{retryCapacity:false});assert.equal(c.gaps.snapshot().length,0);const row=(await state.getIngress(c.f.path,`message:${messageId}`))!;assert.equal(row.channelId,channel);assert.equal(row.eventId,messageId);assert.ok(row.payload);record(c,channel);await c.history.recover(identity,signal());assert.equal(c.seen.filter(v=>v.method==='POST').length,splitDeliveryChunks(RUNTIME_HELP,true).length);
 sql(c.f.path,"DELETE FROM mirror_threads WHERE codex_thread_id='fresh'");record(c,channel);c.page.splice(0,c.page.length,message(messageId+1n,channel));await c.history.recover(identity,signal());assert.equal(await state.getIngress(c.f.path,`message:${messageId+1n}`),null);
}));

test('capacity refusal on an earlier channel does not skip later notices in the same pass',async()=>fixture(async c=>{
 const busy=fillBackground();record(c,1n);record(c,2n);c.page.splice(0);let attempts=0;
 const refresh=createNativeMirrorPolicyRefresh(c.f.path,limits),options={...c.direct,refreshPolicy:(...args:Parameters<typeof refresh>)=>{attempts++;if(attempts===2)return busy.release().then(()=>refresh(...args));return refresh(...args);}};
 try{const out=await recoverPendingDiscordHistory(c.gaps,options,signal());assert.equal(Object.isFrozen(out),true);assert.deepEqual(out,{retryCapacity:true});assert.equal(attempts,2);assert.deepEqual(c.gaps.snapshot().map(n=>n.snapshot().channelId),[1n]);assert.equal(c.seen.filter(r=>r.method==='GET').length,1);assert.deepEqual(c.f.reports,['discord_message_gap_deferred','discord_message_gap_recovered']);}finally{await busy.release();}
}));

for(const mode of ['rows','values','output','malformed','incompatible','missing'] as const)test(`installed ${mode} policy failure retains gap without arming a capacity timer`,async()=>fixture(async c=>{
 if(mode==='rows')sql(c.f.path,"INSERT INTO mirror_threads VALUES ('other','p','Other',10,2,2)");if(mode==='malformed')sql(c.f.path,'UPDATE mirror_threads SET discord_thread_id=1.5');if(mode==='incompatible')sql(c.f.path,'DROP TABLE mirror_projects');if(mode==='missing')renameSync(c.f.path,c.f.path+'.saved');
 record(c);c.gaps.tryChanged();const ids=new GatewayIdentityTracker(),id=ids.subscribeIdentity(),conflict=ids.subscribeConflict(),stop=new AbortController(),clock=historyRetryClock();ids.observe(identity);
 const pending=runHistoryConsumer(c.gaps,id,conflict,stop.signal,signal(),null,c.history,clock.clock);
 try{await until(()=>c.f.reports.includes('discord_message_gap_failed'));await new Promise(r=>setTimeout(r,15));assert.equal(clock.active,0);assert.deepEqual(clock.deadlines,[]);assert.equal(c.seen.length,0);assert.equal(c.gaps.snapshot().length,1);if(mode==='missing')assert.equal(existsSync(c.f.path),false);}finally{stop.abort();await pending;id.dispose();conflict.dispose();ids.close();if(mode==='missing')renameSync(c.f.path+'.saved',c.f.path);}
},mode==='rows'?{...limits,maxRows:1n}:mode==='values'?{...limits,maxValueBytes:1n}:mode==='output'?{...limits,maxOutputIds:1}:limits));

for(const output of ['{ok:true,ids:[1]}','{ok:true,ids:[2n,1n]}','{ok:true,ids:[1n,1n]}','{ok:true,ids:[1n<<63n]}','{ok:false,detail:"fixture SQL failure"}'])test(`malformed native response cannot mint history capacity: ${output}`,async()=>fixture(async c=>{
 record(c);const trace=new SharedArrayBuffer(8),restore=instrumentStoreWorker({match:workerName,trace,before:`parentPort.postMessage=()=>post(${output});`,after:''});try{assert.deepEqual(await c.history.recover(identity,signal()),{retryCapacity:false});assert.equal(c.gaps.snapshot().length,1);assert.equal(c.seen.length,0);assert.deepEqual(c.f.reports,['discord_message_gap_failed']);}finally{restore();}
}));

for(const mode of ['public','forged','admitted'] as const)test(`${mode} worker error is an ordinary history failure, never a retry proof`,async t=>fixture(async c=>{
 const original=OwnedWorkerSlot.prototype.run,error=mode==='forged'?Object.assign(Error('capacity'),{name:'NativeMirrorPolicyCapacityError'}):new OwnedWorkerBudgetError();
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof original>){if(!String(args[0]).includes('/mirror-policy-worker.'))return original.apply(this,args);return mode==='admitted'?original.apply(this,args).then(()=>{throw error;}):Promise.reject(error);});
 record(c);assert.deepEqual(await c.history.recover(identity,signal()),{retryCapacity:false});assert.equal(c.gaps.snapshot().length,1);assert.equal(c.seen.length,0);assert.deepEqual(c.f.reports,['discord_message_gap_failed']);
}));

test('history capacity proof is exact Promise and one-use; old native and channel errors do not rebrand a later attempt',async()=>fixture(async c=>{
 const busy=fillBackground();let nativeError:unknown,channelError:unknown;const prior=refreshMirrorPolicyOffThread(c.f.startup.policy,c.f.path,limits);try{await prior;}catch(error){nativeError=error;}
 const pending=recoverDiscordHistoryChannel(c.direct,1n,floor,signal());try{await pending;}catch(error){channelError=error;}
 try{assert.equal(takeHistoryPolicyCapacityRefusal(Promise.resolve({coverage:'Reached',fetched:0,noClaim:0,claimAttempted:0,claimWon:0,processed:0}),channelError),false);assert.equal(takeHistoryPolicyCapacityRefusal(pending,new OwnedWorkerBudgetError()),false);
  for(const error of [nativeError,channelError]){record(c);assert.deepEqual(await recoverPendingDiscordHistory(c.gaps,{...c.direct,refreshPolicy:async()=>{throw error;}},signal()),{retryCapacity:false});}
  assert.equal(takeHistoryPolicyCapacityRefusal(pending,channelError),true);assert.equal(takeHistoryPolicyCapacityRefusal(pending,channelError),false);assert.equal(c.seen.length,0);
 }finally{await busy.release();}
}));

for(const mode of ['cancel','timeout'] as const)test(`history SQLite lock ${mode} keeps permit and native slot until actual exit`,async()=>fixture(async c=>{
 const lock=new DatabaseSync(c.f.path);lock.exec('PRAGMA journal_mode=DELETE;BEGIN EXCLUSIVE');const trace=new SharedArrayBuffer(12),restore=instrumentStoreWorker({match:workerName,trace,before:'Atomics.store(trace,0,1);',after:'Atomics.store(trace,2,1);Atomics.wait(trace,1,0,15000);'}),abort=new AbortController(),reason=Error('cancel history policy');record(c);let settled=false;
 const pending=c.history.recover(identity,abort.signal);void pending.then(()=>settled=true,()=>settled=true);
 try{await waitTrace(trace);if(mode==='cancel')abort.abort(reason);const fence=DrainFenceKey.create('history-lock','1|2','fixture');c.f.gate.seal(fence);await new Promise(r=>setTimeout(r,60));assert.equal(settled,false);assert.equal(c.f.gate.isDrainedFor(fence),false);assert.equal(ownedWorkerUsage().Background,1);assert.equal(c.seen.length,0);lock.exec('ROLLBACK');await new Promise(r=>setTimeout(r,80));assert.equal(settled,false);restore();releaseTrace(trace);
  if(mode==='cancel')await assert.rejects(pending,e=>e===reason);else assert.deepEqual(await pending,{retryCapacity:false});assert.equal(c.f.gate.isDrainedFor(fence),true);assert.equal(ownedWorkerUsage().Background,0);assert.equal(c.gaps.snapshot().length,1);assert.equal(c.seen.length,0);
 }finally{if(lock.isTransaction)lock.exec('ROLLBACK');lock.close();restore();releaseTrace(trace);await pending.catch(()=>{});}
},mode==='timeout'?{...limits,timeoutMs:25}:limits));

test('failed native periodic policy preserves the original Prime boundary',async()=>fixture(async c=>{
 const history=new HistoryPollState();let now=1577836801000;const options={...c.direct,context:{...c.direct.context,now:()=>now}},original=readFileSync(c.f.path);c.page.splice(0,c.page.length,{...message(),timestamp:'2020-01-01T00:00:02+00:00'});
 writeFileSync(c.f.path,'not sqlite');await assert.rejects(pollDiscordHistoryChannel(options,history,c.gaps,1n,signal()),/policy/);assert.equal(c.seen.length,0);writeFileSync(c.f.path,original);now=1577836803000;const out=await pollDiscordHistoryChannel(options,history,c.gaps,1n,signal());assert.equal(out!.phase,'Prime');assert.equal(out!.processed,1);assert.equal((await state.getIngress(c.f.path,`message:${messageId}`))!.confirmationDelivered,true);
}));

test('ten-message incomplete coverage remains sticky after capacity recovery and does not arm another timer',async()=>fixture(async c=>{
 const busy=fillBackground();record(c);try{assert.deepEqual(await c.history.recover(identity,signal()),{retryCapacity:true});}finally{await busy.release();}c.page.splice(0,c.page.length,...Array.from({length:10},(_,i)=>({...message(messageId+BigInt(10-i)),author:{...message().author,bot:true}})));
 assert.deepEqual(await c.history.recover(identity,signal()),{retryCapacity:false});assert.equal(c.gaps.snapshot().length,1);assert.equal(c.f.reports.at(-1),'discord_message_gap_degraded');assert.equal(c.seen.filter(r=>r.method==='POST').length,0);
}));

test('installed limits and direct operations capture original path and callback before mutation',async()=>fixture(async c=>{
 const bounds={...limits,maxOutputIds:1},installed=c.install(bounds);bounds.maxOutputIds=200;record(c);assert.deepEqual(await installed.recover(identity,signal()),{retryCapacity:false});assert.equal(c.seen.length,0);assert.equal(c.f.reports.at(-1),'discord_message_gap_failed');
 const context={...c.direct.context},options={...c.direct,context,allowedChannelIds:new Set([1n]),startupChannelId:null},history=createDiscordHistoryOperations(c.gaps,options);context.database='/unrelated/not-created';options.refreshPolicy=async()=>assert.fail('replaced callback');await history.recover(identity,signal());assert.equal(c.gaps.snapshot().length,0);assert.equal((await state.getIngress(c.f.path,`message:${messageId}`))!.confirmationDelivered,true);
 let hooks=0;for(const key of ['refreshPolicy'])assert.throws(()=>createDiscordHistoryOperations(c.gaps,Object.defineProperty({...options},key,{get(){hooks++;throw Error('active option');}})),TypeError);assert.equal(hooks,0);assert.throws(()=>createDiscordHistoryOperations(c.gaps,{...options,refreshPolicy:null as never}),TypeError);
}));

test('retry takes a fresh revision and source floor while an in-flight newer gap makes the original ACK stale',async()=>fixture(async c=>{
 const busy=fillBackground();record(c,1n,messageId+2n);try{assert.deepEqual(await c.history.recover(identity,signal()),{retryCapacity:true});}finally{await busy.release();}
 c.page.splice(0,c.page.length,message(messageId+2n),message(messageId));let changed=false;const refresh=createNativeMirrorPolicyRefresh(c.f.path,limits);
 const options={...c.direct,refreshPolicy:(...args:Parameters<typeof refresh>)=>refresh(...args).then(policy=>{if(!changed){changed=true;record(c,1n,messageId);}return policy;})};
 assert.deepEqual(await recoverPendingDiscordHistory(c.gaps,options,signal()),{retryCapacity:false});assert.equal(c.f.reports.at(-1),'discord_message_gap_ack_stale');assert.equal(c.gaps.snapshot()[0]!.snapshot().revision,2n);assert.equal(c.gaps.snapshot()[0]!.snapshot().earliest.messageId,messageId);assert.equal(await state.getIngress(c.f.path,`message:${messageId}`),null);
 const first=(await state.getIngress(c.f.path,`message:${messageId+2n}`))!,posts=c.seen.filter(r=>r.method==='POST').length;assert.equal((first.payload as Record<string,unknown>).content,'!help');assert.deepEqual((first.payload as Record<string,unknown>).plan,{Execute:'Help'});
 await c.history.recover(identity,signal());assert.equal(c.gaps.snapshot().length,0);assert.equal((await state.getIngress(c.f.path,`message:${messageId}`))!.eventId,messageId);assert.equal(c.seen.filter(r=>r.method==='POST').length,posts*2);
}));

import {RuntimeGatewayIdentityConflictError} from '../../../src/runtime/discord-runtime/identity-wait.ts';
for(const mode of ['shutdown','force','conflict'] as const)test(`consumer ${mode} joins a genuinely locked native policy operation before releasing its permit`,async()=>fixture(async c=>{
 const lock=new DatabaseSync(c.f.path);lock.exec('PRAGMA journal_mode=DELETE;BEGIN EXCLUSIVE');const trace=new SharedArrayBuffer(8),restore=instrumentStoreWorker({match:workerName,trace,before:'Atomics.store(trace,0,1);'}),ids=new GatewayIdentityTracker(),id=ids.subscribeIdentity(),conflict=ids.subscribeConflict(),stop=new AbortController(),force=new AbortController(),reason=Error('forced native history');ids.observe(identity);record(c);c.gaps.tryChanged();let settled=false;
 const pending=runHistoryConsumer(c.gaps,id,conflict,stop.signal,force.signal,null,c.history);void pending.then(()=>settled=true,()=>settled=true);const check=mode==='shutdown'?pending:assert.rejects(pending,mode==='force'?(e:unknown)=>e===reason:RuntimeGatewayIdentityConflictError);
 try{await waitTrace(trace);const fence=DrainFenceKey.create('history-consumer','1|2','fixture');c.f.gate.seal(fence);if(mode==='shutdown')stop.abort();else if(mode==='force')force.abort(reason);else ids.observe({userId:10n,applicationId:5n});await new Promise(r=>setTimeout(r,60));assert.equal(settled,false);assert.equal(c.f.gate.isDrainedFor(fence),false);assert.equal(ownedWorkerUsage().Background,1);lock.exec('ROLLBACK');await new Promise(r=>setTimeout(r,80));assert.equal(settled,false);restore();releaseTrace(trace);await check;assert.equal(c.f.gate.isDrainedFor(fence),true);assert.equal(ownedWorkerUsage().Background,0);assert.equal(c.seen.length,0);assert.throws(()=>c.gaps.snapshot(),/disposed/);
 }finally{if(lock.isTransaction)lock.exec('ROLLBACK');lock.close();restore();releaseTrace(trace);stop.abort();await check;id.dispose();conflict.dispose();ids.close();}
}));

import {capturePreparedTypedIngressOptions} from '../../../src/runtime/discord-runtime/prepared-typed-ingress.ts';
import {createInteractionWorkQueue} from '../../../src/runtime/discord-dispatch/interaction-work.ts';
import {AutocompleteCatalog} from '../../../src/runtime/discord-dispatch/autocomplete.ts';
test('prepared typed ingress independently captures and installs the history policy bounds',async t=>fixture(async c=>{
 const queue=createInteractionWorkQueue(),bounds={...limits,maxOutputIds:1},options={...c.f.options,allowedChannelIds:new Set([1n]),startupChannelId:null,historyTargetLimits:{maxRows:100,timeoutMs:5000},historyPolicyLimits:bounds,interactionPolicyLimits:limits,guildId:null,qaCommands:false,startupNotify:false,historyPeriodMs:null,reportReady:()=>{},reportDispatch:()=>{},reportInteraction:()=>{},reportReceiveError:()=>{}};
 try{const captured=capturePreparedTypedIngressOptions(c.f.startup,c.f.gate,c.http,queue,new AutocompleteCatalog(),options);bounds.maxOutputIds=200;options.historyPolicyLimits={...limits};for(const key of ['remainingDiscordIds','mirrorTargets'] as const)t.mock.method(state,key,()=>assert.fail(`legacy policy ${key}`));record(c);assert.deepEqual(await captured.history(c.gaps,new GatewayIngress().acceptedMessageView()).recover(identity,signal()),{retryCapacity:false});assert.equal(c.f.reports.at(-1),'discord_message_gap_failed');assert.equal(c.seen.length,0);assert.equal(c.gaps.snapshot().length,1);
 }finally{queue.sender.dispose();queue.receiver.dispose();}
}));

import {decodeGatewayMessage} from '../../../src/discord/gateway/decoded-message.ts';
test('prepared typed history captures the supplied exact accepted-original view before asynchronous polling',async()=>fixture(async c=>{
 const queue=createInteractionWorkQueue(),owner=new GatewayIngress(),view=owner.acceptedMessageView(),history=new HistoryPollState(),options={...c.f.options,now:()=>1577836801000,allowedChannelIds:new Set([1n]),startupChannelId:null,historyTargetLimits:{maxRows:100,timeoutMs:5000},historyPolicyLimits:limits,interactionPolicyLimits:limits,guildId:null,qaCommands:false,startupNotify:false,historyPeriodMs:null,reportReady:()=>{},reportDispatch:()=>{},reportInteraction:()=>{},reportReceiveError:()=>{}};
 try{const captured=capturePreparedTypedIngressOptions(c.f.startup,c.f.gate,c.http,queue,new AutocompleteCatalog(),options),installed=captured.history(c.gaps,view);owner.publish({kind:'Message',event:decodeGatewayMessage(JSON.stringify(message()))},1);await installed.poll(history,identity,signal());assert.equal(history.isPrimed(1n),false);assert.equal(await state.isProcessedMessage(c.f.path,messageId),false);assert.equal(await state.getIngress(c.f.path,`message:${messageId}`),null);assert.equal(c.f.reports.at(-1),'discord_history_poll_skipped');assert.equal(view.size,1);assert.notEqual(c.gaps.captureClearFence(1n),null);owner.receivers.messages.dispose();await installed.poll(history,identity,signal());assert.equal(history.isPrimed(1n),true);assert.equal(await state.isProcessedMessage(c.f.path,messageId),true);assert.equal(c.seen.filter(r=>r.method==='POST').length,0);
 }finally{for(const receiver of Object.values(owner.receivers))receiver.dispose();owner.close();queue.sender.dispose();queue.receiver.dispose();}
}));
