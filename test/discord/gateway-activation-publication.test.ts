import assert from 'node:assert/strict';
import {test} from 'node:test';
import {GatewayTypedActivation,GatewayActivationError,GatewayIngressReceiversError} from '../../src/discord/gateway/activation.ts';
import {GatewayPublication,type GatewayReceiveErrorDrop} from '../../src/discord/gateway/publication.ts';
import {GatewayIngress,type DecodedGatewayEvent} from '../../src/discord/gateway/ingress.ts';
import {decodeGatewayMessage} from '../../src/discord/gateway/decoded-message.ts';
const config={interactionCapacity:1,reservedInteractionCapacity:1,messageCapacity:1,receiveErrorCapacity:1};
type Interaction=Readonly<{id:bigint}>;
const interaction=():DecodedGatewayEvent<Interaction>=>({kind:'Interaction',event:Object.freeze({id:1n})});
const message=():DecodedGatewayEvent<Interaction>=>({kind:'Message',event:decodeGatewayMessage(JSON.stringify({attachments:[],author:{id:'3',username:'u',discriminator:'1'},channel_id:'7',content:'hello',embeds:[],id:'1',type:0,mention_everyone:false,mention_roles:[],mentions:[],pinned:false,timestamp:'2020-01-01T00:00:00+00:00',tts:false}))});
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
test('typed receivers transfer exactly once and activation is refused before transfer',()=>{
 const receivers=Object.freeze({token:1}),gate=new GatewayTypedActivation(receivers);assert.throws(()=>gate.activate(),e=>e instanceof GatewayActivationError&&e.kind==='IngressReceiversNotTaken');assert.equal(gate.takeReceivers(),receivers);assert.throws(()=>gate.takeReceivers(),GatewayIngressReceiversError);gate.activate();assert.throws(()=>gate.activate(),e=>e instanceof GatewayActivationError&&e.kind==='AlreadyActivated');assert.equal(gate.stop(),'StoppedAfterActivation');assert.equal(gate.stop(),'AlreadyStopped');
});
test('stop wins before activation and every late activation fails without polling',async()=>{
 const gate=new GatewayTypedActivation({}),running=gate.runAfterActivation(async()=>{assert.fail('must not poll');});assert.equal(gate.pendingWaiters,1);assert.equal(gate.stop(),'StoppedBeforeActivation');await running;assert.equal(gate.pendingWaiters,0);gate.takeReceivers();assert.throws(()=>gate.activate(),e=>e instanceof GatewayActivationError&&e.kind==='Stopped');assert.equal(await gate.wait(),'Stopped');
});
test('receiver-not-taken precedence remains before the stopped activation error',()=>{
 const gate=new GatewayTypedActivation({});gate.stop();assert.throws(()=>gate.activate(),e=>e instanceof GatewayActivationError&&e.kind==='IngressReceiversNotTaken');gate.takeReceivers();assert.throws(()=>gate.activate(),e=>e instanceof GatewayActivationError&&e.kind==='Stopped');
});
test('multiple paused shard waiters wake and enter only after explicit activation',async()=>{
 const gate=new GatewayTypedActivation({});let entered=0;const tasks=Array.from({length:4},()=>gate.runAfterActivation(async()=>{entered++;}));assert.equal(gate.pendingWaiters,4);await Promise.resolve();assert.equal(entered,0);gate.takeReceivers();assert.equal(entered,0);gate.activate();await Promise.all(tasks);assert.equal(entered,4);assert.equal(gate.pendingWaiters,0);gate.stop();
});
test('stop following activate before a waiter resumes suppresses that pending shard',async()=>{
 const gate=new GatewayTypedActivation({});gate.takeReceivers();let entered=0;const running=gate.runAfterActivation(async()=>{entered++;});gate.activate();gate.stop();await running;assert.equal(entered,0);assert.equal(gate.pendingWaiters,0);
});
test('activation immediately before waiting is not a lost notification',async()=>{
 const gate=new GatewayTypedActivation({});gate.takeReceivers();gate.activate();assert.equal(await gate.wait(),'Activated');let calls=0;await gate.runAfterActivation(async()=>{calls++;});assert.equal(calls,1);gate.stop();
});
test('cancelled gate waiter removes only itself and preserves other active waiters',async()=>{
 const gate=new GatewayTypedActivation({}),abort=new AbortController(),reason=new Error('cancel'),a=gate.wait(abort.signal),b=gate.wait(),rejected=assert.rejects(a,e=>e===reason);assert.equal(gate.pendingWaiters,2);abort.abort(reason);await rejected;assert.equal(gate.pendingWaiters,1);gate.takeReceivers();gate.activate();assert.equal(await b,'Activated');assert.equal(gate.pendingWaiters,0);gate.stop();
});
test('stop after active entry does not falsely complete the caller-owned shard promise',async()=>{
 const gate=new GatewayTypedActivation({}),entered=deferred(),release=deferred();gate.takeReceivers();gate.activate();let settled=false;const task=gate.runAfterActivation(async()=>{entered.resolve();await release.promise;}).then(()=>{settled=true;});await entered.promise;gate.stop();await Promise.resolve();assert.equal(settled,false);release.resolve();await task;assert.equal(settled,true);
});
test('active task failure propagates exact identity instead of becoming activation success',async()=>{
 const gate=new GatewayTypedActivation({}),reason=new Error('active failed');gate.takeReceivers();gate.activate();await assert.rejects(gate.runAfterActivation(async()=>{throw reason;}),e=>e===reason);gate.stop();
});
test('pre-aborted gate wait executes no active callback and registers no waiter',async()=>{
 const gate=new GatewayTypedActivation({}),abort=new AbortController(),reason=new Error('pre');abort.abort(reason);await assert.rejects(gate.runAfterActivation(async()=>{assert.fail('no callback');},abort.signal),e=>e===reason);assert.equal(gate.pendingWaiters,0);gate.stop();
});
test('publication ordering exposes READY identity before observer and counts only after observer',()=>{
 const ingress=new GatewayIngress<Interaction>(config),identity=ingress.subscribeIdentity(),publication=new GatewayPublication(ingress,()=>{});let ran=false;publication.publish({kind:'Ready',identity:{userId:1n,applicationId:2n}},1,()=>{ran=true;assert.deepEqual(identity.snapshot(),{userId:1n,applicationId:2n});assert.equal(publication.snapshot().ignored,0n);});assert.equal(ran,true);assert.equal(publication.snapshot().ignored,1n);identity.dispose();ingress.close();
});
test('typed observer precedes queue publication and its stop changes this interaction tag',()=>{
 const ingress=new GatewayIngress<Interaction>(config),publication=new GatewayPublication(ingress,()=>{});const outcome=publication.publish(interaction(),1,()=>{assert.equal(ingress.receivers.normalInteractions.length,0);assert.equal(publication.snapshot().interactionsAccepted,0n);ingress.stopAccepting();});assert.ok(outcome.kind==='InteractionAccepted');assert.equal(outcome.tag,'Stopping');assert.equal(publication.snapshot().interactionsAccepted,1n);assert.equal(ingress.receivers.normalInteractions.length,0);assert.equal(ingress.receivers.reservedInteractions.length,1);ingress.close();
});
test('all seven publication counters remain independent and old snapshots do not mutate',()=>{
 const ingress=new GatewayIngress<Interaction>(config),drops:GatewayReceiveErrorDrop[]=[],publication=new GatewayPublication(ingress,d=>{drops.push(d);}),before=publication.snapshot();publication.publish({kind:'Ignored'},0);publication.publish(interaction(),0);publication.publish(interaction(),0);publication.publish(interaction(),0);publication.publish(message(),0);publication.publish(message(),0);publication.publishReceiveError(1,'one');publication.publishReceiveError(2,'two');assert.deepEqual(publication.snapshot(),{ignored:1n,interactionsAccepted:2n,hardDroppedInteractions:1n,messagesAccepted:1n,recoverableMessageGaps:1n,receiveErrorsAccepted:1n,receiveErrorsDropped:1n});assert.equal(before.ignored,0n);assert.deepEqual(drops,[{shard:2,message:'two',reason:'Full'}]);assert.ok(Object.isFrozen(drops[0]));ingress.close();
});
test('receive-error drop reaches the one diagnostic sink before its outcome count',()=>{
 const ingress=new GatewayIngress<Interaction>(config);let publication:GatewayPublication<Interaction>;publication=new GatewayPublication(ingress,drop=>{assert.equal(drop.reason,'Closed');assert.equal(publication.snapshot().receiveErrorsDropped,0n);});ingress.receivers.receiveErrors.dispose();publication.publishReceiveError(7,'closed');assert.equal(publication.snapshot().receiveErrorsDropped,1n);ingress.close();
});
test('throwing observer consumes its owned event but never routes or increments outcomes',()=>{
 const ingress=new GatewayIngress<Interaction>(config),publication=new GatewayPublication(ingress,()=>{}),input=interaction(),reason=new Error('observer');assert.throws(()=>publication.publish(input,0,()=>{throw reason;}),e=>e===reason);assert.equal(ingress.receivers.normalInteractions.length,0);assert.equal(publication.snapshot().interactionsAccepted,0n);assert.throws(()=>publication.publish(input,0),/already moved/);ingress.close();
});
test('async typed observer and diagnostic sink cannot be silently detached',()=>{
 const ingress=new GatewayIngress<Interaction>(config),publication=new GatewayPublication(ingress,async()=>{});assert.throws(()=>publication.publish(interaction(),0,async()=>{}),/synchronous/);assert.equal(ingress.receivers.normalInteractions.length,0);ingress.receivers.receiveErrors.dispose();assert.throws(()=>publication.publishReceiveError(1,'error'),/synchronous/);assert.equal(publication.snapshot().receiveErrorsDropped,0n);ingress.close();
});
test('real typed receivers and publication remain idle until transfer plus activation',async()=>{
 const ingress=new GatewayIngress<Interaction>(config),publication=new GatewayPublication(ingress,()=>{}),gate=new GatewayTypedActivation(ingress.receivers);let polls=0;const task=gate.runAfterActivation(async()=>{polls++;publication.publish(message(),1);});await Promise.resolve();assert.equal(polls,0);const receivers=gate.takeReceivers();gate.activate();await task;assert.equal(polls,1);const value=await receivers.messages.receive();assert.equal(value?.event.id,1n);assert.equal(publication.snapshot().messagesAccepted,1n);gate.stop();ingress.close();
});
