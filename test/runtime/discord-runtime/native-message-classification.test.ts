import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {gatewayPolicyFixture as fixture,consume,publish,message,rawMessage,messageId,identity,signal,sql,until} from '../../helpers/gateway-policy-fixture.ts';
import {instrumentStoreWorker,waitTrace,releaseTrace} from '../../helpers/store-authority-worker-fixture.ts';
import {createNativeMessageClassifier,takeMessageClassificationCapacityRefusal,type MessageClassifier} from '../../../src/runtime/message-worker/classification.ts';
import {createGatewayMessageHandler} from '../../../src/runtime/discord-runtime/message-handler.ts';
import {prepareGatewayMessage,takeGatewayMessageClassificationCapacityRefusal,type MessageCreateOptions} from '../../../src/runtime/discord-runtime/message-create.ts';
import {createPreparedHistoryOperations} from '../../../src/runtime/discord-runtime/history-bootstrap.ts';
import {createDiscordHistoryOperations} from '../../../src/runtime/discord-runtime/history-operations.ts';
import {recoverPendingDiscordHistory} from '../../../src/runtime/discord-runtime/gap-recovery.ts';
import {recoverDiscordHistoryChannel,pollDiscordHistoryChannel,takeHistoryClassificationCapacityRefusal} from '../../../src/runtime/history-poll/discord-gap.ts';
import {HistoryPollRunError} from '../../../src/runtime/history-poll/runner.ts';
import {HistoryPollState} from '../../../src/runtime/history-poll/state.ts';
import {MessageGapTracker} from '../../../src/discord/gateway/message-gaps.ts';
import {isAcceptedGatewayMessageDeferral} from '../../../src/discord/gateway/message-custody.ts';
import {OwnedWorkerSlot,OwnedWorkerBudgetError,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
import {DrainFenceKey} from '../../../src/admission/drain-gate.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
const bounds={maxRows:100n,maxValueBytes:65536n,maxOutputBytes:65536,timeoutMs:5000};
const workerName='message-worker/native-classification-worker'+(import.meta.url.endsWith('.js')?'.js':'.ts');
const floor={micros:1577836800000000n,messageId:1n};
const posts=(seen:readonly {method:string}[])=>seen.filter(r=>r.method==='POST').length;
function fillControl(){const gate=new SharedArrayBuffer(4),slot=new OwnedWorkerSlot('Control'),pending=slot.run(new URL('data:text/javascript,'+encodeURIComponent("import {parentPort,workerData} from 'node:worker_threads';Atomics.wait(new Int32Array(workerData),0,0,15000);parentPort.postMessage(true);")),gate,10000);let released:Promise<void>|undefined;return {release:()=>released??=(async()=>{Atomics.store(new Int32Array(gate),0,1);Atomics.notify(new Int32Array(gate),0);await pending;await slot.join();})()};}
function prep(c:Parameters<Parameters<typeof fixture>[0]>[0],classifyMessage:MessageClassifier):MessageCreateOptions{return {database:c.f.path,config:c.direct.classification,basePolicy:c.f.startup.policy,gate:c.f.gate,allowDrainControl:false,resolver:c.direct.resolver,observedAt:102,custody:{messageJournal:c.direct.context.messageJournal,now:()=>102,report:()=>{}},refreshPolicy:c.direct.refreshPolicy!,classifyMessage};}
function historyOptions(c:Parameters<Parameters<typeof fixture>[0]>[0]){return {...c.direct,classifyMessage:createNativeMessageClassifier(c.f.path,bounds),applicationId:4n,botUserId:9n,acceptedMessages:c.owner.acceptedMessageView()};}

for(const lane of ['messages','emergencyMessages'] as const)test(`installed ${lane} classification Control refusal after successful policy recovers original without another event`,async t=>fixture(async c=>{
 let policy=0,classification=0;const run=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){if(String(args[0]).includes('/mirror-policy-worker.'))policy++;if(String(args[0]).includes('/native-classification-worker.'))classification++;return run.apply(this,args);});
 const busy=fillControl(),event=message(messageId,lane==='messages'?'!help':'!force_restart',lane==='messages'?{}:{author:{id:'77',username:'u',discriminator:'0',bot:false}});publish(c.owner,event);const consumer=consume(c.owner,c.handler,lane);
 try{await until(()=>c.clock.active===1);assert.equal(policy,1);assert.equal(classification,1);assert.equal(ownedWorkerUsage().Background,0);assert.equal(c.owner.acceptedMessageView().size,1);assert.equal(posts(c.seen),0);const fence=DrainFenceKey.create('classification','1|2','fixture');c.f.gate.seal(fence);assert.ok(c.f.gate.isDrainedFor(fence));c.f.gate.release(fence);c.now.value=999;await busy.release();c.clock.advance(1000);await until(()=>c.owner.acceptedMessageView().size===0);assert.equal(policy,2);assert.equal(classification,2);if(lane==='messages'){const row=(await state.getIngress(c.f.path,`message:${messageId}`))!;assert.equal(row.createdAt,102);assert.equal(row.eventId,messageId);assert.equal((row.payload as {content:string}).content,event.content);}else assert.equal(await state.isProcessedMessage(c.f.path,messageId),false);assert.equal(c.clock.maximum,1);}finally{await busy.release();await consumer.close();}
}));
test('installed Gateway and history never call three legacy classification reads or main-thread classification SQL',async t=>fixture(async c=>{
 for(const name of ['newThreadOrigin','pendingNewPrompt','abandonmentCommandTarget'] as const)t.mock.method(state,name,()=>assert.fail('legacy classification '+name));
 const prepare=DatabaseSync.prototype.prepare;t.mock.method(DatabaseSync.prototype,'prepare',function(this:DatabaseSync,...args:Parameters<typeof prepare>){assert.ok(!/SELECT COUNT\(\*\) AS n FROM mirror_threads|project_key,CAST\(project_key AS BLOB\)|new_prompt_arm.consumed_by.*AS pending/i.test(args[0]),'main-thread classification query');return prepare.apply(this,args);});
 await c.handler(message(),identity,signal());const first=posts(c.seen),tracker=new MessageGapTracker(),gaps=tracker.subscribe();try{c.page.push(rawMessage(messageId+1n));tracker.record(1n,{timestampMicros:floor.micros,messageId:1n},'Full');const history=createPreparedHistoryOperations(c.f.startup,c.f.gate,c.http,gaps,{...c.f.options,historyPolicyLimits:{maxRows:100n,maxValueBytes:65536n,maxOutputIds:200,timeoutMs:5000},historyTargetLimits:{maxRows:100,timeoutMs:5000},allowedChannelIds:new Set([1n]),startupChannelId:null});assert.deepEqual(await history.recover(identity,signal()),{retryCapacity:false});assert.equal(gaps.snapshot().length,0);assert.equal(posts(c.seen),first*2);}finally{gaps.dispose();tracker.close();}
}));
for(const downstream of ['settings','journal','admitted-classifier'] as const)test(`${downstream} capacity-looking failure never retries an installed Gateway original`,async t=>fixture(async c=>{
 const error=new OwnedWorkerBudgetError(),run=OwnedWorkerSlot.prototype.run;let busy:ReturnType<typeof fillControl>|undefined,hits=0;
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){
  const name=String(args[0]),operation=(args[1] as {operation?:string}).operation;
  if(downstream==='journal'&&name.includes('/native-journal-worker.')&&operation==='Admit'||downstream==='settings'&&name.includes('/prompt-intake/native-state-worker.')&&operation==='MirrorTarget'){hits++;busy=fillControl();return run.apply(this,args);}
  if(downstream==='admitted-classifier'&&name.includes('/native-classification-worker.')){hits++;return run.apply(this,args).then(()=>{throw error;});}return run.apply(this,args);
 });
 try{await assert.rejects(c.handler(message(messageId,downstream==='settings'?'!settings --model x':'!help'),identity,signal()));assert.equal(hits,1);assert.deepEqual(c.clock.deadlines,[]);assert.equal(posts(c.seen),0);assert.equal(await state.getIngress(c.f.path,`message:${messageId}`),null);}finally{await busy?.release();}
}));
test('Gateway binds classifier refusal only to its exact preparation Promise and classifier await',()=>fixture(async c=>{
 const busy=fillControl(),native=createNativeMessageClassifier(c.f.path,bounds),options=prep(c,native),pending=prepareGatewayMessage(message(),9n,options,signal());let error:unknown;try{await pending;}catch(e){error=e;}
 try{assert.equal(takeGatewayMessageClassificationCapacityRefusal(Promise.resolve(undefined as never),error),false);assert.equal(takeGatewayMessageClassificationCapacityRefusal(pending,new OwnedWorkerBudgetError()),false);await busy.release();await assert.rejects(createGatewayMessageHandler({...c.direct,classifyMessage:async()=>{throw error;}})(message(),identity,signal()),e=>e===error);assert.deepEqual(c.clock.deadlines,[]);assert.equal(takeGatewayMessageClassificationCapacityRefusal(pending,error),true);assert.equal(takeGatewayMessageClassificationCapacityRefusal(pending,error),false);}finally{await busy.release();}
}));
test('replayed native refusal from settings cannot authorize preparation retry',async t=>fixture(async c=>{
 const busy=fillControl(),native=createNativeMessageClassifier(c.f.path,bounds),prior=native(message(),c.f.path,c.direct.classification,c.f.startup.policy,9n);let error:unknown;try{await prior;}catch(e){error=e;}await busy.release();const run=OwnedWorkerSlot.prototype.run;
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){return String(args[0]).includes('/prompt-intake/native-state-worker.')&&(args[1] as {operation:string}).operation==='MirrorTarget'?Promise.reject(error):run.apply(this,args);});
 await assert.rejects(c.handler(message(messageId,'!settings --model x'),identity,signal()));assert.deepEqual(c.clock.deadlines,[]);assert.equal(takeMessageClassificationCapacityRefusal(prior,error),true);
}));
test('non-Promise classifier is fatal and callback/path installation remains captured',()=>fixture(async c=>{
 const options={...c.direct,classifyMessage:(()=>({kind:'Ignore'})) as unknown as MessageClassifier};await assert.rejects(createGatewayMessageHandler(options)(message(),identity,signal()),/classifier Promise/);assert.deepEqual(c.clock.deadlines,[]);
 const native=createNativeMessageClassifier(c.f.path,bounds),source={...c.direct,classifyMessage:native},handler=createGatewayMessageHandler(source);source.classifyMessage=async()=>{throw Error('mutated');};await handler(message(),identity,signal());assert.ok(posts(c.seen)>0);
}));
for(const mode of ['shutdown','force'] as const)test(`${mode} joins actual classification exit before releasing accepted original custody`,()=>fixture(async c=>{
 const trace=new SharedArrayBuffer(8),restore=instrumentStoreWorker({match:workerName,trace}),consumer=consume(c.owner,c.handler),reason=Error('cancel native classifier');publish(c.owner);
 try{await waitTrace(trace);consumer[mode==='shutdown'?'stop':'force'].abort(reason);await new Promise(r=>setTimeout(r,40));assert.equal(c.owner.acceptedMessageView().size,1);assert.equal(ownedWorkerUsage().Control,1);restore();releaseTrace(trace);if(mode==='shutdown')await consumer.pending;else await assert.rejects(consumer.pending,e=>e===reason);assert.equal(c.owner.acceptedMessageView().size,0);assert.equal(ownedWorkerUsage().Control,0);assert.equal(posts(c.seen),0);}finally{restore();releaseTrace(trace);await consumer.pending.catch(()=>{});consumer.dispose();}
}));
test('periodic discard cannot steal classification-sleep originals; History Process wins only canonical admission',()=>fixture(async c=>{
 const busy=fillControl(),gaps=c.owner.subscribeMessageGaps(),history=new HistoryPollState();publish(c.owner);const consumer=consume(c.owner,c.handler);
 try{await until(()=>c.clock.active===1);await busy.release();c.page.push(rawMessage());const options={...historyOptions(c),context:{...c.direct.context,now:()=>1577836801000}};await assert.rejects(pollDiscordHistoryChannel(options,history,gaps,1n,signal()),e=>e instanceof HistoryPollRunError&&isAcceptedGatewayMessageDeferral(e.source));assert.equal(history.watermark(1n),null);assert.equal(history.isPrimed(1n),false);assert.equal(await state.isProcessedMessage(c.f.path,messageId),false);assert.equal(c.owner.acceptedMessageView().size,1);await recoverDiscordHistoryChannel(options,1n,floor,signal());const count=posts(c.seen);c.clock.advance(1000);await until(()=>c.owner.acceptedMessageView().size===0);assert.equal(posts(c.seen),count);}finally{await busy.release();await consumer.close();gaps.dispose();}
}));
test('history partial success then classifier refusal keeps revision and retries fresh without replay',async t=>fixture(async c=>{
 const tracker=new MessageGapTracker(),gaps=tracker.subscribe(),options=historyOptions(c);c.page.push(rawMessage(messageId+1n),rawMessage());tracker.record(1n,{timestampMicros:floor.micros,messageId:1n},'Full');let calls=0,busy:ReturnType<typeof fillControl>|undefined;const run=OwnedWorkerSlot.prototype.run;
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){if(String(args[0]).includes('/native-classification-worker.')&&++calls===2){tracker.record(1n,{timestampMicros:floor.micros-1n,messageId:1n},'Full');busy=fillControl();}return run.apply(this,args);});
 try{assert.deepEqual(await recoverPendingDiscordHistory(gaps,options,signal()),{retryCapacity:true});assert.equal(gaps.snapshot()[0]!.snapshot().revision,2n);assert.notEqual(await state.getIngress(c.f.path,`message:${messageId}`),null);assert.equal(await state.getIngress(c.f.path,`message:${messageId+1n}`),null);const first=posts(c.seen);await busy!.release();assert.deepEqual(await recoverPendingDiscordHistory(gaps,options,signal()),{retryCapacity:false});assert.equal(gaps.snapshot().length,0);assert.equal(posts(c.seen),2*first);}finally{await busy?.release();gaps.dispose();tracker.close();}
}));
test('history classifier refusal is exact channel Promise and immediate Claim source, never recursive or replayable',()=>fixture(async c=>{
 const busy=fillControl(),options=historyOptions(c);c.page.push(rawMessage());const pending=recoverDiscordHistoryChannel(options,1n,floor,signal());let error:unknown;try{await pending;}catch(e){error=e;}try{assert.ok(error instanceof HistoryPollRunError&&error.stage==='Claim');assert.equal(takeHistoryClassificationCapacityRefusal(Promise.resolve(undefined as never),error),false);await busy.release();const tracker=new MessageGapTracker(),gaps=tracker.subscribe();try{for(const bad of [error,new HistoryPollRunError('Claim',error),new OwnedWorkerBudgetError()]){tracker.record(1n,{timestampMicros:floor.micros,messageId:1n},'Full');assert.deepEqual(await recoverPendingDiscordHistory(gaps,{...options,classifyMessage:async()=>{throw bad;}},signal()),{retryCapacity:false});}assert.equal(takeHistoryClassificationCapacityRefusal(pending,error),true);assert.equal(takeHistoryClassificationCapacityRefusal(pending,error),false);}finally{gaps.dispose();tracker.close();}}finally{await busy.release();}
}));
test('history fixed-field options retain captured classifier and periodic refusal never commits Prime cursor',()=>fixture(async c=>{
 const tracker=new MessageGapTracker(),gaps=tracker.subscribe(),options={...historyOptions(c),allowedChannelIds:new Set([1n]),startupChannelId:null},operations=createDiscordHistoryOperations(gaps,options),native=options.classifyMessage;options.classifyMessage=async()=>{throw Error('mutated callback');};c.page.push(rawMessage());const busy=fillControl(),history=new HistoryPollState();try{await operations.poll(history,identity,signal());assert.equal(history.isPrimed(1n),false);assert.equal(history.watermark(1n),null);await busy.release();tracker.record(1n,{timestampMicros:floor.micros,messageId:1n},'Full');assert.deepEqual(await operations.recover(identity,signal()),{retryCapacity:false});assert.equal(gaps.snapshot().length,0);assert.equal(typeof native,'function');}finally{await busy.release();gaps.dispose();tracker.close();}
}));

import {runHistoryConsumer} from '../../../src/runtime/discord-runtime/history-consumer.ts';
import {GatewayIdentityTracker} from '../../../src/discord/gateway/identity.ts';
import {createPreparedMessageHandler} from '../../../src/runtime/discord-runtime/message-bootstrap.ts';
test('period-null installed history wakes after classification Control release without a subsequent message',()=>fixture(async c=>{
 const tracker=new MessageGapTracker(),gaps=tracker.subscribe(),ids=new GatewayIdentityTracker(),id=ids.subscribeIdentity(),conflict=ids.subscribeConflict(),stop=new AbortController(),busy=fillControl();ids.observe(identity);c.page.push(rawMessage());tracker.record(1n,{timestampMicros:floor.micros,messageId:1n},'Full');gaps.tryChanged();
 const history=createPreparedHistoryOperations(c.f.startup,c.f.gate,c.http,gaps,{...c.f.options,historyPolicyLimits:{maxRows:100n,maxValueBytes:65536n,maxOutputIds:200,timeoutMs:5000},historyTargetLimits:{maxRows:100,timeoutMs:5000},allowedChannelIds:new Set([1n]),startupChannelId:null}),pending=runHistoryConsumer(gaps,id,conflict,stop.signal,signal(),null,history,c.clock.clock);
 try{await until(()=>c.clock.active===1);assert.equal(gaps.snapshot().length,1);assert.equal(c.seen.filter(r=>r.method==='GET').length,1);assert.equal(posts(c.seen),0);const fence=DrainFenceKey.create('history-classification','1|2','fixture');c.f.gate.seal(fence);assert.ok(c.f.gate.isDrainedFor(fence));c.f.gate.release(fence);await busy.release();c.clock.advance(1000);await until(()=>gaps.snapshot().length===0);assert.ok(posts(c.seen)>0);assert.equal((await state.getIngress(c.f.path,`message:${messageId}`))!.confirmationDelivered,true);}finally{await busy.release();stop.abort();await pending;id.dispose();conflict.dispose();ids.close();gaps.dispose();tracker.close();}
}));
test('prepared native classifier limits are explicit and snapshotted before caller mutation',()=>fixture(async c=>{
 const limits={...bounds,maxOutputBytes:1},options={...c.f.options,messageClassificationLimits:limits},handler=createPreparedMessageHandler(c.f.startup,c.f.gate,c.http,options);limits.maxOutputBytes=65536;options.messageClassificationLimits={...bounds};await assert.rejects(handler(message(),identity,signal()),/complete output/);assert.equal(posts(c.seen),0);
 const missing={...options};delete (missing as {messageClassificationLimits?:unknown}).messageClassificationLimits;assert.throws(()=>createPreparedMessageHandler(c.f.startup,c.f.gate,c.http,missing),TypeError);
}));

test('classification capacity refusal visits later history notices in the same fair pass',()=>fixture(async c=>{
 const tracker=new MessageGapTracker(),gaps=tracker.subscribe(),options=historyOptions(c),busy=fillControl();c.page.push(rawMessage());for(const channel of [1n,2n])tracker.record(channel,{timestampMicros:floor.micros,messageId:1n},'Full');let refreshes=0;
 const refresh=options.refreshPolicy!;
 try{assert.deepEqual(await recoverPendingDiscordHistory(gaps,{...options,refreshPolicy:(...args:Parameters<typeof refresh>)=>{if(++refreshes===2){c.page.splice(0);return busy.release().then(()=>refresh(...args));}return refresh(...args);}},signal()),{retryCapacity:true});assert.equal(refreshes,2);assert.deepEqual(gaps.snapshot().map(n=>n.snapshot().channelId),[1n]);assert.deepEqual(c.f.reports,['discord_message_gap_deferred','discord_message_gap_recovered']);assert.equal(posts(c.seen),0);}finally{await busy.release();gaps.dispose();tracker.close();}
}));
