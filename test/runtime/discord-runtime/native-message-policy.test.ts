import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {renameSync,existsSync} from 'node:fs';
import {gatewayPolicyFixture as fixture,fillBackground,occupyPolicy,consume,publish,message,rawMessage,messageId,identity,limits,signal,sql,until,workerName} from '../../helpers/gateway-policy-fixture.ts';
import {instrumentStoreWorker,waitTrace,releaseTrace} from '../../helpers/store-authority-worker-fixture.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {DrainFenceKey} from '../../../src/admission/drain-gate.ts';
import {createGatewayMessageHandler,messagePolicyCapacityRetryDelay} from '../../../src/runtime/discord-runtime/message-handler.ts';
import {prepareGatewayMessage,takeGatewayMessagePolicyCapacityRefusal,type MessageCreateOptions} from '../../../src/runtime/discord-runtime/message-create.ts';
import {createPreparedMessageHandler} from '../../../src/runtime/discord-runtime/message-bootstrap.ts';
import {createNativeMirrorPolicyRefresh,refreshMirrorPolicyOffThread,takeMirrorPolicyCapacityRefusal,NativeMirrorPolicyError} from '../../../src/runtime/discord-runtime/native-mirror-policy.ts';
import {OwnedWorkerSlot,OwnedWorkerBudgetError,OwnedWorkerTimeoutError,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
import {RUNTIME_HELP} from '../../../src/runtime/action-executor/help.ts';
import {splitDeliveryChunks} from '../../../src/discord/text.ts';
import {RuntimeGatewayIdentityConflictError} from '../../../src/runtime/discord-runtime/identity-wait.ts';
import {HistoryPollState} from '../../../src/runtime/history-poll/state.ts';
import {pollDiscordHistoryChannel,recoverDiscordHistoryChannel} from '../../../src/runtime/history-poll/discord-gap.ts';
import {isAcceptedGatewayMessageDeferral} from '../../../src/discord/gateway/message-custody.ts';
import {capturePreparedTypedIngressOptions} from '../../../src/runtime/discord-runtime/prepared-typed-ingress.ts';
import {createInteractionWorkQueue} from '../../../src/runtime/discord-dispatch/interaction-work.ts';
import {AutocompleteCatalog} from '../../../src/runtime/discord-dispatch/autocomplete.ts';
const posts=(seen:readonly {method:string}[])=>seen.filter(r=>r.method==='POST').length;
const preparation=(c:Parameters<Parameters<typeof fixture>[0]>[0]):MessageCreateOptions=>({database:c.f.path,config:c.direct.classification,basePolicy:c.f.startup.policy,gate:c.f.gate,allowDrainControl:false,resolver:c.direct.resolver,observedAt:102,custody:{messageJournal:c.direct.context.messageJournal,now:()=>102,report:()=>{}},refreshPolicy:c.direct.refreshPolicy!});

for(const kind of ['singleton','Background'] as const)for(const lane of ['messages','emergencyMessages'] as const)test(`installed ${lane} retries the exact original after real ${kind} release without another event`,async()=>fixture(async c=>{
 const busy=kind==='singleton'?await occupyPolicy(c.f):fillBackground(),event=message(messageId,lane==='messages'?'!help':'!force_restart',{...(lane==='emergencyMessages'?{author:{id:'77',username:'denied',discriminator:'0',bot:false}}:{})});publish(c.owner,event);const consumer=consume(c.owner,c.handler,lane);
 try{await until(()=>c.clock.active===1);assert.equal(c.owner.acceptedMessageView().size,1);assert.equal(posts(c.seen),0);assert.equal(await state.getIngress(c.f.path,`message:${messageId}`),null);assert.deepEqual(c.clock.deadlines,[1000]);
  const fence=DrainFenceKey.create('retry','1|2','fixture');c.f.gate.seal(fence);assert.equal(c.f.gate.isDrainedFor(fence),true);c.f.gate.release(fence);c.now.value=999;
  await busy.release();assert.equal(ownedWorkerUsage().Background,0);c.clock.advance(1000);await until(()=>c.owner.acceptedMessageView().size===0);
  if(lane==='messages'){const row=(await state.getIngress(c.f.path,`message:${messageId}`))!;assert.equal(row.eventId,messageId);assert.equal(row.channelId,1n);assert.equal(row.createdAt,102);assert.equal(row.confirmationDelivered,true);assert.equal((row.payload as Record<string,unknown>).content,event.content);assert.equal(posts(c.seen),splitDeliveryChunks(RUNTIME_HELP,true).length);}
  else{assert.equal(await state.isProcessedMessage(c.f.path,messageId),false);assert.deepEqual(c.f.reports,['ignored_message']);}
  assert.equal(c.clock.maximum,1);assert.equal(c.clock.active,0);const gaps=c.owner.subscribeMessageGaps();assert.deepEqual(gaps.snapshot(),[]);gaps.dispose();
 }finally{await busy.release();await consumer.close();}
}));

test('shared installed handler preserves same-lane order while the other lane progresses during retry',async t=>fixture(async c=>{
 const admissions:string[]=[],run=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const data=args[1] as {operation?:string;id?:string};if(String(args[0]).includes('/native-journal-worker.')&&data.operation==='Admit')admissions.push(data.id!);return run.apply(this,args);});
 const busy=fillBackground(),first=message(),second=message(messageId+1n),emergency=message(messageId+2n,'!repair',{author:{id:'77',username:'denied',discriminator:'0',bot:false}});publish(c.owner,first);publish(c.owner,second);const normal=consume(c.owner,c.handler);
 try{await until(()=>c.clock.active===1);assert.equal(c.owner.receivers.messages.length,1);await busy.release();publish(c.owner,emergency);const other=consume(c.owner,c.handler,'emergencyMessages');try{await until(()=>c.f.reports.includes('ignored_message'));assert.equal(c.owner.acceptedMessageView().size,2);assert.equal(await state.isProcessedMessage(c.f.path,messageId),false);assert.equal(await state.isProcessedMessage(c.f.path,messageId+1n),false);c.clock.advance(1000);await until(()=>c.owner.acceptedMessageView().size===0);assert.deepEqual(admissions,[`message:${messageId}`,`message:${messageId+1n}`]);assert.equal(posts(c.seen),2*splitDeliveryChunks(RUNTIME_HELP,true).length);}finally{await other.close();}}
 finally{await busy.release();await normal.close();}
}));

test('capacity retries are serial, monotonic, capped and unbounded without holding admission',async()=>fixture(async c=>{
 const busy=fillBackground();publish(c.owner);const consumer=consume(c.owner,c.handler);let at=0;
 try{for(const delay of [1000,2000,4000,8000,16000,30000,30000,30000]){await until(()=>c.clock.active===1);assert.equal(c.clock.deadlines.at(-1),at+delay);const key=DrainFenceKey.create('bounded','1|2','fixture');c.f.gate.seal(key);assert.equal(c.f.gate.isDrainedFor(key),true);c.f.gate.release(key);at+=delay;c.clock.advance(at);}await until(()=>c.clock.active===1);await busy.release();c.clock.advance(c.clock.deadlines.at(-1)!);await until(()=>c.owner.acceptedMessageView().size===0);assert.equal(c.clock.maximum,1);assert.equal(posts(c.seen),splitDeliveryChunks(RUNTIME_HELP,true).length);assert.equal(messagePolicyCapacityRetryDelay(Number.MAX_SAFE_INTEGER),30000);for(const n of [-1,0.5,NaN])assert.throws(()=>messagePolicyCapacityRetryDelay(n),TypeError);}
 finally{await busy.release();await consumer.close();}
}));

test('periodic discard cannot consume active or queued originals during capacity sleep and commits no cursor',async()=>fixture(async c=>{
 const busy=fillBackground(),first=message(),second=message(messageId+1n),gaps=c.owner.subscribeMessageGaps();publish(c.owner,first);publish(c.owner,second);const consumer=consume(c.owner,c.handler),history=new HistoryPollState();
 try{await until(()=>c.clock.active===1);await busy.release();const options={...c.direct,context:{...c.direct.context,now:()=>1577836801000},applicationId:4n,botUserId:9n,acceptedMessages:c.owner.acceptedMessageView()};
  for(const id of [messageId,messageId+1n]){c.page.splice(0,c.page.length,rawMessage(id));await assert.rejects(pollDiscordHistoryChannel(options,history,gaps,1n,signal()),error=>error instanceof Error&&isAcceptedGatewayMessageDeferral(error.cause));assert.equal(history.watermark(1n),null);assert.equal(history.isPrimed(1n),false);assert.equal(await state.isProcessedMessage(c.f.path,id),false);assert.equal(await state.getIngress(c.f.path,`message:${id}`),null);assert.deepEqual(gaps.snapshot(),[]);gaps.withCurrentFence(gaps.captureClearFence(1n)!,()=>{});}
  assert.equal(c.owner.acceptedMessageView().size,2);c.clock.advance(1000);await until(()=>c.owner.acceptedMessageView().size===0);assert.equal(posts(c.seen),2*splitDeliveryChunks(RUNTIME_HELP,true).length);c.page.splice(0,c.page.length,rawMessage(messageId+1n),rawMessage());await pollDiscordHistoryChannel(options,history,gaps,1n,signal());assert.equal(history.isPrimed(1n),true);
 }finally{await busy.release();await consumer.close();gaps.dispose();}
}));

test('history Process may win during capacity sleep and the retained original deduplicates once',async()=>fixture(async c=>{
 const busy=fillBackground();publish(c.owner);const consumer=consume(c.owner,c.handler);try{await until(()=>c.clock.active===1);await busy.release();c.page.push(rawMessage());const options={...c.direct,applicationId:4n,botUserId:9n,acceptedMessages:c.owner.acceptedMessageView()},out=await recoverDiscordHistoryChannel(options,1n,{micros:1577836799000000n,messageId:1n},signal());assert.equal(out.processed,1);assert.equal(c.owner.acceptedMessageView().size,1);const count=posts(c.seen);c.clock.advance(1000);await until(()=>c.owner.acceptedMessageView().size===0);assert.equal(posts(c.seen),count);assert.equal((await state.getIngress(c.f.path,`message:${messageId}`))!.confirmationDelivered,true);}finally{await busy.release();await consumer.close();}
}));

for(const mode of ['shutdown','force','conflict'] as const)test(`${mode} cancels retry sleep, joins it and releases active plus queued originals`,async()=>fixture(async c=>{
 const busy=fillBackground();publish(c.owner);publish(c.owner,message(messageId+1n));const consumer=consume(c.owner,c.handler),reason=Error('force retry');try{await until(()=>c.clock.active===1);if(mode==='shutdown')consumer.stop.abort();else if(mode==='force')consumer.force.abort(reason);else c.owner.publish({kind:'Ready',identity:{userId:19n,applicationId:14n}},2);if(mode==='shutdown')await consumer.pending;else await assert.rejects(consumer.pending,e=>mode==='force'?e===reason:e instanceof RuntimeGatewayIdentityConflictError);assert.equal(c.clock.active,0);assert.equal(c.owner.acceptedMessageView().size,0);assert.equal(c.owner.receivers.messages.length,0);assert.equal(posts(c.seen),0);assert.equal(await state.isProcessedMessage(c.f.path,messageId),false);}finally{await busy.release();consumer.dispose();}
}));

for(const mode of ['shutdown','force','conflict'] as const)test(`${mode} during locked installed native refresh retains original custody until actual exit`,async()=>fixture(async c=>{
 const lock=new DatabaseSync(c.f.path);lock.exec('PRAGMA journal_mode=DELETE;BEGIN EXCLUSIVE');const trace=new SharedArrayBuffer(12),restore=instrumentStoreWorker({match:workerName,trace,before:'Atomics.store(trace,0,1);',after:'Atomics.store(trace,2,1);Atomics.wait(trace,1,0,15000);'});publish(c.owner);publish(c.owner,message(messageId+1n));const consumer=consume(c.owner,c.handler),reason=Error('force native');let settled=false;void consumer.pending.then(()=>settled=true,()=>settled=true);
 try{await waitTrace(trace);if(mode==='shutdown')consumer.stop.abort();else if(mode==='force')consumer.force.abort(reason);else c.owner.publish({kind:'Ready',identity:{userId:19n,applicationId:14n}},2);await new Promise(r=>setTimeout(r,50));assert.equal(settled,false);assert.equal(c.owner.acceptedMessageView().size,2);assert.equal(ownedWorkerUsage().Background,1);const key=DrainFenceKey.create('native-policy','1|2','fixture');c.f.gate.seal(key);assert.equal(c.f.gate.isDrainedFor(key),true);lock.exec('ROLLBACK');await waitTrace(trace,2);assert.equal(settled,false);assert.equal(c.owner.acceptedMessageView().size,2);restore();releaseTrace(trace);if(mode==='shutdown')await consumer.pending;else await assert.rejects(consumer.pending,e=>mode==='force'?e===reason:e instanceof RuntimeGatewayIdentityConflictError);assert.equal(c.owner.acceptedMessageView().size,0);assert.equal(ownedWorkerUsage().Background,0);assert.deepEqual(c.clock.deadlines,[]);assert.equal(posts(c.seen),0);}
 finally{if(lock.isTransaction)lock.exec('ROLLBACK');lock.close();restore();releaseTrace(trace);await consumer.pending.catch(()=>{});consumer.dispose();}
}));

for(const mode of ['public','forged','admitted'] as const)test(`${mode} capacity-looking failure never retries preparation`,async t=>fixture(async c=>{
 const run=OwnedWorkerSlot.prototype.run,error=mode==='forged'?Object.assign(Error('capacity'),{name:'NativeMirrorPolicyCapacityError'}):new OwnedWorkerBudgetError();let calls=0;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){if(!String(args[0]).includes('/mirror-policy-worker.'))return run.apply(this,args);calls++;return mode==='admitted'?run.apply(this,args).then(()=>{throw error;}):Promise.reject(error);});await assert.rejects(c.handler(message(),identity,signal()),e=>e===error);assert.equal(calls,1);assert.deepEqual(c.clock.deadlines,[]);assert.equal(posts(c.seen),0);assert.equal(await state.getIngress(c.f.path,`message:${messageId}`),null);
}));

test('exact preparation Promise and error consume capacity proof once; stale, wrapped and consumed evidence refuses retry',async()=>fixture(async c=>{
 const busy=fillBackground(),options=preparation(c),native=refreshMirrorPolicyOffThread(c.f.startup.policy,c.f.path,limits);let nativeError:unknown,prepareError:unknown;try{await native;}catch(e){nativeError=e;}const pending=prepareGatewayMessage(message(),9n,options,signal());try{await pending;}catch(e){prepareError=e;}
 try{assert.equal(takeGatewayMessagePolicyCapacityRefusal(Promise.resolve(undefined as never),prepareError),false);assert.equal(takeGatewayMessagePolicyCapacityRefusal(pending,nativeError),false);
  for(const old of [nativeError,prepareError]){await assert.rejects(createGatewayMessageHandler({...c.direct,refreshPolicy:async()=>{throw old;}})(message(),identity,signal()),e=>e===old);assert.deepEqual(c.clock.deadlines,[]);}
  assert.equal(takeGatewayMessagePolicyCapacityRefusal(pending,prepareError),true);assert.equal(takeGatewayMessagePolicyCapacityRefusal(pending,prepareError),false);assert.equal(takeMirrorPolicyCapacityRefusal(native,nativeError),true);await assert.rejects(createGatewayMessageHandler({...c.direct,refreshPolicy:()=>native})(message(),identity,signal()),e=>e===nativeError);assert.deepEqual(c.clock.deadlines,[]);
  const refresh=createNativeMirrorPolicyRefresh(c.f.path,limits);await assert.rejects(createGatewayMessageHandler({...c.direct,refreshPolicy:async(...args)=>refresh(...args)})(message(),identity,signal()));assert.deepEqual(c.clock.deadlines,[]);
 }finally{await busy.release();}
}));

for(const mode of ['rows','values','output','malformed','incompatible','missing'] as const)test(`installed ${mode} policy failure is fatal without retry or partial admission`,async()=>fixture(async c=>{
 if(mode==='rows')sql(c.f.path,"INSERT INTO mirror_threads VALUES ('extra','p','Extra',10,2,2)");if(mode==='malformed')sql(c.f.path,'UPDATE mirror_threads SET discord_thread_id=1.5');if(mode==='incompatible')sql(c.f.path,'DROP TABLE mirror_projects');if(mode==='missing')renameSync(c.f.path,c.f.path+'.saved');
 try{await assert.rejects(c.handler(message(),identity,signal()),NativeMirrorPolicyError);assert.deepEqual(c.clock.deadlines,[]);assert.equal(posts(c.seen),0);if(mode==='missing')assert.equal(existsSync(c.f.path),false);}finally{if(mode==='missing')renameSync(c.f.path+'.saved',c.f.path);}
},mode==='rows'?{...limits,maxRows:1n}:mode==='values'?{...limits,maxValueBytes:1n}:mode==='output'?{...limits,maxOutputIds:1}:limits));

test('policy timeout joins locked worker exit and never arms original retry',async()=>fixture(async c=>{
 const lock=new DatabaseSync(c.f.path);lock.exec('PRAGMA journal_mode=DELETE;BEGIN EXCLUSIVE');const trace=new SharedArrayBuffer(12),restore=instrumentStoreWorker({match:workerName,trace,before:'Atomics.store(trace,0,1);',after:'Atomics.store(trace,2,1);Atomics.wait(trace,1,0,15000);'}),pending=c.handler(message(),identity,signal());let settled=false;void pending.then(()=>settled=true,()=>settled=true);
 try{await waitTrace(trace);await new Promise(r=>setTimeout(r,60));assert.equal(settled,false);assert.equal(ownedWorkerUsage().Background,1);lock.exec('ROLLBACK');await waitTrace(trace,2);assert.equal(settled,false);restore();releaseTrace(trace);await assert.rejects(pending,OwnedWorkerTimeoutError);assert.deepEqual(c.clock.deadlines,[]);assert.equal(posts(c.seen),0);}finally{if(lock.isTransaction)lock.exec('ROLLBACK');lock.close();restore();releaseTrace(trace);await pending.catch(()=>{});}
},{...limits,timeoutMs:25}));

test('native policy reads bypass poisoned legacy facade and replace removed exact-bigint dynamic channels',async t=>fixture(async c=>{
 const channel=9007199254740995n;sql(c.f.path,`INSERT INTO mirror_threads VALUES ('fresh','p','Fresh',10,${channel},1)`);for(const name of ['remainingDiscordIds','mirrorTargets'] as const)t.mock.method(state,name,()=>assert.fail('legacy policy'));const prepare=DatabaseSync.prototype.prepare;t.mock.method(DatabaseSync.prototype,'prepare',function(this:DatabaseSync,...args:Parameters<typeof prepare>){assert.ok(!/SELECT discord_thread_id AS id FROM mirror_threads|SELECT discord_channel_id AS id FROM mirror_projects|FROM mirror_threads ORDER BY updated_at DESC LIMIT/i.test(args[0]),'main-thread policy query');return prepare.apply(this,args);});
 await c.handler(message(messageId,'!help',{channel_id:String(channel)}),identity,signal());assert.equal((await state.getIngress(c.f.path,`message:${messageId}`))!.channelId,channel);const count=posts(c.seen);sql(c.f.path,"DELETE FROM mirror_threads WHERE codex_thread_id='fresh'");await c.handler(message(messageId+1n,'!help',{channel_id:String(channel)}),identity,signal());assert.equal(posts(c.seen),count);assert.equal(await state.isProcessedMessage(c.f.path,messageId+1n),false);
}));

test('classification failure after native policy success remains fatal without capacity retry',async t=>fixture(async c=>{
 const failure=new OwnedWorkerBudgetError();let calls=0;t.mock.method(state,'newThreadOrigin',async()=>{calls++;throw failure;});await assert.rejects(createGatewayMessageHandler(c.direct)(message(),identity,signal()),e=>e===failure);assert.equal(calls,1);assert.deepEqual(c.clock.deadlines,[]);assert.equal(posts(c.seen),0);
}));

test('handler captures path, refresh callback, report, first clock and retry clock methods before await',async()=>fixture(async c=>{
 const busy=fillBackground(),context={...c.direct.context},clock={...c.clock.clock},options={...c.direct,context,policyRetryClock:clock};const handler=createGatewayMessageHandler(options),pending=handler(message(),identity,signal());
 try{await until(()=>c.clock.active===1);context.database='/never-created';context.now=()=>9999;options.refreshPolicy=async()=>assert.fail('replaced refresh');options.report=()=>assert.fail('replaced reporter');clock.now=()=>-1;clock.sleepUntil=async()=>assert.fail('replaced sleep');c.now.value=888;await busy.release();c.clock.advance(1000);await pending;assert.equal((await state.getIngress(c.f.path,`message:${messageId}`))!.createdAt,102);assert.equal(posts(c.seen),splitDeliveryChunks(RUNTIME_HELP,true).length);}finally{await busy.release();await pending.catch(()=>{});}
}));

test('explicit native message bounds are captured independently in prepared and typed installation',async()=>fixture(async c=>{
 const bounds={...limits,maxOutputIds:1},options={...c.f.options,messagePolicyLimits:bounds},handler=createPreparedMessageHandler(c.f.startup,c.f.gate,c.http,options);bounds.maxOutputIds=200;options.messagePolicyLimits={...limits};await assert.rejects(handler(message(),identity,signal()),NativeMirrorPolicyError);
 const queue=createInteractionWorkQueue(),typedBounds={...limits,maxOutputIds:1},typedOptions={...c.f.options,messagePolicyLimits:typedBounds,historyPolicyLimits:limits,interactionPolicyLimits:limits,historyTargetLimits:{maxRows:100,timeoutMs:5000},allowedChannelIds:new Set([1n]),startupChannelId:null,guildId:null,qaCommands:false,startupNotify:false,historyPeriodMs:null,reportReady:()=>{},reportDispatch:()=>{},reportInteraction:()=>{},reportReceiveError:()=>{}};
 try{const typed=capturePreparedTypedIngressOptions(c.f.startup,c.f.gate,c.http,queue,new AutocompleteCatalog(),typedOptions);typedBounds.maxOutputIds=200;typedOptions.messagePolicyLimits={...limits};await assert.rejects(typed.message(message(),identity,signal()),NativeMirrorPolicyError);assert.equal(posts(c.seen),0);const missing={...options};delete (missing as {messagePolicyLimits?:unknown}).messagePolicyLimits;assert.throws(()=>createPreparedMessageHandler(c.f.startup,c.f.gate,c.http,missing),TypeError);}finally{queue.sender.dispose();queue.receiver.dispose();}
}));

test('active callback or clock properties and invalid refresh results are rejected without invoking getters',async()=>fixture(async c=>{
 let hooks=0;for(const key of ['refreshPolicy','policyRetryClock'])assert.throws(()=>createGatewayMessageHandler(Object.defineProperty({...c.direct},key,{get(){hooks++;throw Error('getter');}})),TypeError);assert.equal(hooks,0);for(const value of [null,{},new Proxy(()=>Promise.resolve(c.f.startup.policy),{})])assert.throws(()=>createGatewayMessageHandler({...c.direct,refreshPolicy:value as never}),TypeError);for(const value of [c.f.startup.policy,{then(){assert.fail('thenable');}}])await assert.rejects(createGatewayMessageHandler({...c.direct,refreshPolicy:(()=>value) as never})(message(),identity,signal()),TypeError);assert.equal(posts(c.seen),0);assert.deepEqual(c.clock.deadlines,[]);
}));

test('processor validation precedes policy refresh and durable admission',async()=>fixture(async c=>{
 let calls=0;const handler=createGatewayMessageHandler({...c.direct,context:{...c.direct.context,attachmentRoot:123 as never},refreshPolicy:async()=>{calls++;return c.f.startup.policy;}});await assert.rejects(handler(message(),identity,signal()),TypeError);assert.equal(calls,0);assert.equal(await state.isProcessedMessage(c.f.path,messageId),false);assert.equal(await state.getIngress(c.f.path,`message:${messageId}`),null);assert.equal(posts(c.seen),0);
}));

test('a distinct classification failure concurrent with cancellation is preserved for the identity guard',async t=>fixture(async c=>{
 const abort=new AbortController(),failure=Error('distinct classification failure'),reason=Error('cancel');t.mock.method(state,'newThreadOrigin',async()=>{abort.abort(reason);throw failure;});await assert.rejects(createGatewayMessageHandler(c.direct)(message(),identity,abort.signal),e=>e===failure);assert.deepEqual(c.clock.deadlines,[]);assert.equal(posts(c.seen),0);assert.equal(await state.isProcessedMessage(c.f.path,messageId),false);
}));

test('a genuine old policy capacity error after an uncertain journal admission cannot retry',async()=>fixture(async c=>{
 const busy=fillBackground();let old:unknown;try{await refreshMirrorPolicyOffThread(c.f.startup.policy,c.f.path,limits);}catch(e){old=e;}await busy.release();let calls=0;const journal={...c.direct.context.messageJournal!,admitIngress:async(...args:Parameters<typeof state.admitIngress>)=>{calls++;await state.admitIngress(...args);throw old;}};
 await assert.rejects(createGatewayMessageHandler({...c.direct,context:{...c.direct.context,messageJournal:journal}})(message(),identity,signal()),e=>e===old);assert.equal(calls,1);assert.deepEqual(c.clock.deadlines,[]);assert.ok(await state.getIngress(c.f.path,`message:${messageId}`));assert.equal(posts(c.seen),0);
}));

test('retry re-probes current pending text state and preserves the first post-probe observation',async()=>fixture(async c=>{
 const busy=fillBackground(),fence=DrainFenceKey.create('probe','1|2','fixture');c.f.gate.seal(fence);let targets=0;const services={...c.direct.context.services,targetThreadId:async()=>{targets++;c.now.value=120;return targets===1?'t':'gone';}},handler=createGatewayMessageHandler({...c.direct,context:{...c.direct.context,services}}),pending=handler(message(messageId,'1'),identity,signal());
 try{await until(()=>c.clock.active===1);assert.equal(targets,1);c.now.value=999;await busy.release();c.clock.advance(1000);await pending;assert.equal(targets,2);assert.equal(await state.getIngress(c.f.path,`message:${messageId}`),null);assert.equal(c.f.gate.isDrainedFor(fence),true);assert.deepEqual(c.f.reports,['on_message_error']);assert.equal(posts(c.seen),1);}finally{await busy.release();await pending.catch(()=>{});}
}));

for(const content of ['!force_restart','!repair','!recover'])test(`authorized ${content} keeps emergency drain bypass after capacity retry and executes once`,async()=>fixture(async c=>{
 const fence=DrainFenceKey.create('emergency','1|2','fixture');c.f.gate.seal(fence);c.f.gate.closeControls(fence);const busy=fillBackground();let calls=0;const services={...c.direct.context.services,targetThreadId:async()=>assert.fail('emergency pending probe'),executeWithIngressContext:async()=>{calls++;return {text:'done',waitsForFinal:false,ui:null};}},handler=createGatewayMessageHandler({...c.direct,context:{...c.direct.context,services}}),pending=handler(message(messageId,content),identity,signal());
 try{await until(()=>c.clock.active===1);await busy.release();c.clock.advance(1000);await pending;await handler(message(messageId,content),identity,signal());assert.equal(calls,1);assert.equal(posts(c.seen),1);assert.equal(c.f.gate.isDrainedFor(fence),true);assert.equal((await state.getIngress(c.f.path,`message:${messageId}`))!.confirmationDelivered,true);}finally{await busy.release();await pending.catch(()=>{});}
}));

for(const mode of ['denied','bot','self'] as const)test(`${mode} original is freshly classified and ignored after capacity retry`,async()=>fixture(async c=>{
 const busy=fillBackground(),author=mode==='denied'?{id:'77',username:'denied',discriminator:'0',bot:false}:mode==='bot'?{id:'2',username:'bot',discriminator:'0',bot:true}:{id:'9',username:'self',discriminator:'0',bot:false},pending=c.handler(message(messageId,'!force_restart',{author}),identity,signal());try{await until(()=>c.clock.active===1);await busy.release();c.clock.advance(1000);await pending;assert.equal(await state.isProcessedMessage(c.f.path,messageId),false);assert.equal(posts(c.seen),0);assert.deepEqual(c.f.reports,['ignored_message']);}finally{await busy.release();await pending.catch(()=>{});}
}));

test('overflow while an original sleeps preserves the genuine source floor and retains no extra payload',async()=>fixture(async c=>{
 const busy=fillBackground();publish(c.owner);const consumer=consume(c.owner,c.handler),gaps=c.owner.subscribeMessageGaps();try{await until(()=>c.clock.active===1);for(const id of [messageId+1n,messageId+2n])assert.equal(publish(c.owner,message(id)).kind,'MessageAccepted');const overflow=message(messageId+3n);assert.equal(publish(c.owner,overflow).kind,'MessageRecoverableGap');const before=gaps.snapshot()[0]!.snapshot();assert.equal(before.earliest.messageId,overflow.id);assert.equal(before.earliest.timestampMicros,overflow.timestamp.unixNanoseconds/1000n);assert.equal(c.owner.acceptedMessageView().size,3);await busy.release();c.clock.advance(1000);await until(()=>c.owner.acceptedMessageView().size===0);const after=gaps.snapshot()[0]!.snapshot();assert.deepEqual(after,before);assert.equal(await state.isProcessedMessage(c.f.path,overflow.id),false);}finally{await busy.release();await consumer.close();gaps.dispose();}
}));

import {callPromptFixture} from '../../helpers/server-prompt-fixture.ts';
import {SettingsTargetResolver} from '../../../src/runtime/settings-binding.ts';
import {BridgeState} from '../../../src/runtime/bridge-state.ts';
import {dirname,join} from 'node:path';

test('pending reply appearing during capacity delay is probed on retry and confirms original identity once',async()=>fixture(async c=>{
 const busy=fillBackground(),services={...c.direct.context.services,targetThreadId:async()=>{c.now.value=120;return 't';},executeWithIngressContext:async()=>assert.fail('pending reply must not execute business command')},handler=createGatewayMessageHandler({...c.direct,context:{...c.direct.context,services}}),pending=handler(message(messageId,'1'),identity,signal());
 try{await until(()=>c.clock.active===1);const fence=DrainFenceKey.create('appeared','1|2','fixture');c.f.gate.seal(fence);c.now.value=999;await busy.release();c.clock.advance(1000);await pending;assert.deepEqual(await callPromptFixture(c.f.server,'answers'),[{id:'approval',result:{decision:'accept'}}]);const row=(await state.getIngress(c.f.path,`message:${messageId}`))!;assert.equal(row.createdAt,102);assert.equal(row.eventId,messageId);assert.equal(row.sourceMessageId,messageId);assert.equal(row.confirmationDelivered,true);assert.equal(posts(c.seen),1);assert.equal(c.f.gate.isDrainedFor(fence),true);}finally{await busy.release();await pending.catch(()=>{});}
}));

test('first observation occurs after the original drain probe and is reused on retry',async()=>fixture(async c=>{
 const busy=fillBackground(),fence=DrainFenceKey.create('timestamp','1|2','fixture');c.f.gate.seal(fence);let probes=0;const services={...c.direct.context.services,targetThreadId:async()=>{c.now.value=++probes===1?120:999;return 't';}},handler=createGatewayMessageHandler({...c.direct,context:{...c.direct.context,services}}),pending=handler(message(messageId,'1'),identity,signal());
 try{await until(()=>c.clock.active===1);await busy.release();c.clock.advance(1000);await pending;assert.ok(probes>=2);assert.equal((await state.getIngress(c.f.path,`message:${messageId}`))!.createdAt,120);assert.equal(posts(c.seen),1);}finally{await busy.release();await pending.catch(()=>{});}
}));

test('settings binding capacity-looking failure cannot arm policy retry',async()=>fixture(async c=>{
 let calls=0;const failure=new OwnedWorkerBudgetError(),resolver=new SettingsTargetResolver(join(dirname(c.f.path),'codex.sqlite'),c.f.path,new BridgeState(join(dirname(c.f.path),'bridge.json')),{openSelected:async()=>{calls++;throw failure;},resolve:async()=>assert.fail(),exact:async()=>assert.fail(),mapped:async()=>assert.fail()});await assert.rejects(createGatewayMessageHandler({...c.direct,resolver})(message(messageId,'!repair'),identity,signal()));assert.equal(calls,1);assert.deepEqual(c.clock.deadlines,[]);assert.equal(await state.isProcessedMessage(c.f.path,messageId),false);assert.equal(posts(c.seen),0);
}));

test('business failure after successful policy does not retry or duplicate its error receipt',async()=>fixture(async c=>{
 let calls=0;const handler=createGatewayMessageHandler({...c.direct,context:{...c.direct.context,services:{...c.direct.context.services,executeWithIngressContext:async()=>{calls++;throw new OwnedWorkerBudgetError();}}}});await handler(message(),identity,signal());await handler(message(),identity,signal());assert.equal(calls,1);assert.equal(posts(c.seen),1);assert.deepEqual(c.clock.deadlines,[]);assert.deepEqual(c.f.reports,['on_message_error']);
}));

for(const operation of ['Begin','Result','Confirm'])test(`admitted ${operation} journal failure is joined and never retried as policy capacity`,async t=>fixture(async c=>{
 const run=OwnedWorkerSlot.prototype.run;let policyCalls=0,failures=0;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){if(String(args[0]).includes('/mirror-policy-worker.'))policyCalls++;const data=args[1] as {operation?:string};const pending=run.apply(this,args);return String(args[0]).includes('/native-journal-worker.')&&data.operation===operation?pending.then(()=>{failures++;throw new OwnedWorkerBudgetError();}):pending;});const completion=OwnedWorkerSlot.prototype.runControlCompletion;t.mock.method(OwnedWorkerSlot.prototype,'runControlCompletion',function(this:OwnedWorkerSlot,...args:Parameters<typeof completion>){const pending=completion.apply(this,args),data=args[1] as {operation?:string};return String(args[0]).includes('/native-journal-worker.')&&data.operation===operation?pending.then(()=>{failures++;throw new OwnedWorkerBudgetError();}):pending;});await c.handler(message(),identity,signal());assert.equal(policyCalls,1);assert.equal(failures,1);assert.deepEqual(c.clock.deadlines,[]);assert.ok(await state.getIngress(c.f.path,`message:${messageId}`));assert.equal(c.f.reports.filter(v=>v==='on_message_error').length,1);
}));

test('invalid monotonic clock or rounded-away positive retry delay refuses a busy loop',async()=>fixture(async c=>{
 const busy=fillBackground();try{for(const now of [()=>-1,()=>NaN,()=>Number.MAX_VALUE]){let sleeps=0;await assert.rejects(createGatewayMessageHandler({...c.direct,policyRetryClock:{now,sleepUntil:async()=>{sleeps++;}}})(message(),identity,signal()),TypeError);assert.equal(sleeps,0);}assert.equal(posts(c.seen),0);}finally{await busy.release();}
}));

import {runMessageConsumer} from '../../../src/runtime/discord-runtime/message-consumer.ts';
import {DiscordChannelClient} from '../../../src/discord/channel-client.ts';
for(const mode of ['shutdown','force','conflict'] as const)for(const lane of ['messages','emergencyMessages'] as const)test(`installed ${lane} ${mode} between receive and handling releases exact original without policy or admission`,async t=>fixture(async c=>{
 const run=OwnedWorkerSlot.prototype.run;let refreshes=0;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){if(String(args[0]).includes('/mirror-policy-worker.'))refreshes++;return run.apply(this,args);});const rx=c.owner.receivers[lane],id=c.owner.subscribeIdentity(),conflict=c.owner.subscribeIdentityConflict(),stop=new AbortController(),force=new AbortController(),reason=Error('force receive');c.owner.publish({kind:'Ready',identity},1);for(const value of [messageId,messageId+1n])publish(c.owner,message(value,lane==='messages'?'!help':'!force_restart'));const receiver={...rx,receive:async(ownedSignal?:AbortSignal)=>{const original=await rx.receive(ownedSignal);if(mode==='shutdown')stop.abort();else if(mode==='force')force.abort(reason);else c.owner.publish({kind:'Ready',identity:{userId:19n,applicationId:14n}},2);return original;}};
 try{const pending=runMessageConsumer(receiver,id,conflict,stop.signal,force.signal,c.handler);if(mode==='shutdown')await pending;else await assert.rejects(pending,e=>mode==='force'?e===reason:e instanceof RuntimeGatewayIdentityConflictError);assert.equal(c.owner.acceptedMessageView().size,0);assert.equal(refreshes,0);assert.equal(posts(c.seen),0);assert.equal(await state.isProcessedMessage(c.f.path,messageId),false);}finally{stop.abort();id.dispose();conflict.dispose();}
}));

for(const mode of ['HTTP','receipt'] as const)test(`uncertain ${mode} outcome after action never retries the original policy or effect`,async t=>fixture(async c=>{
 let refreshes=0,effects=0,failures=0;const failure=new OwnedWorkerBudgetError(),refresh=c.direct.refreshPolicy!,handler=createGatewayMessageHandler({...c.direct,refreshPolicy:(...args)=>{refreshes++;return refresh(...args);},context:{...c.direct.context,services:{...c.direct.context.services,executeWithIngressContext:async()=>{effects++;return {text:'done',waitsForFinal:false,ui:null};}}}});
 if(mode==='HTTP'){const send=DiscordChannelClient.prototype.sendValidated;t.mock.method(DiscordChannelClient.prototype,'sendValidated',function(this:DiscordChannelClient,...args:Parameters<typeof send>){if(failures++===0)return Promise.reject(failure);return send.apply(this,args);});}
 else{const confirm=state.confirmDeliveryReceipt;t.mock.method(state,'confirmDeliveryReceipt',async(...args:Parameters<typeof confirm>)=>{const committed=await confirm(...args);if(failures++===0)throw failure;return committed;});}
 await handler(message(),identity,signal());assert.equal(refreshes,1);assert.equal(effects,1);assert.deepEqual(c.clock.deadlines,[]);assert.equal(posts(c.seen),mode==='HTTP'?1:2);assert.deepEqual(c.f.reports,['on_message_error']);
}));
