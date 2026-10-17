import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setImmediate as tick} from 'node:timers/promises';
import {GatewayIngress,type MessageIngress} from '../../../src/discord/gateway/ingress.ts';
import {decodeGatewayMessage} from '../../../src/discord/gateway/decoded-message.ts';
import {captureAcceptedGatewayMessages,GatewayAcceptedMessageView,isAcceptedGatewayMessageDeferral} from '../../../src/discord/gateway/message-custody.ts';
import {runMessageConsumer} from '../../../src/runtime/discord-runtime/message-consumer.ts';
import {RuntimeGatewayIdentityConflictError} from '../../../src/runtime/discord-runtime/identity-wait.ts';
const message=(id='9007199254740993',content='!help',channel='9007199254740995')=>decodeGatewayMessage(JSON.stringify({attachments:[],author:{id:'3',username:'u',discriminator:'1'},channel_id:channel,content,embeds:[],id,type:0,mention_everyone:false,mention_roles:[],mentions:[],pinned:false,timestamp:'2020-02-02T02:02:02.020001+00:00',tts:false}));
const ingress=()=>new GatewayIngress({interactionCapacity:1,reservedInteractionCapacity:1,messageCapacity:2,receiveErrorCapacity:1});
const publish=(owner:GatewayIngress<object>,event=message())=>owner.publish({kind:'Message',event},17);
const cleanup=(owner:GatewayIngress<object>)=>{for(const receiver of Object.values(owner.receivers))receiver.dispose();owner.close();};
async function turns(){for(let i=0;i<8;i++)await tick();}
function veto(view:GatewayAcceptedMessageView,event:ReturnType<typeof message>){assert.throws(()=>view.assertDiscardable(event.channel_id,event.id),isAcceptedGatewayMessageDeferral);}
test('successful publication retains exact large identities, original envelope and timestamp until completion',async()=>{
 const owner=ingress(),event=message(),view=owner.acceptedMessageView();try{assert.equal(view.size,0);const outcome=publish(owner,event);assert.equal(outcome.kind,'MessageAccepted');assert.equal(view.size,1);veto(view,event);view.assertDiscardable(event.channel_id+1n,event.id);view.assertDiscardable(event.channel_id,event.id+1n);
  const original=(await owner.receivers.messages.receive())!;assert.equal(original.event,event);assert.equal(original.sequence,outcome.kind==='MessageAccepted'?outcome.sequence:null);assert.equal(original.event.timestamp,event.timestamp);assert.ok(Object.isFrozen(original));assert.equal(view.size,1);veto(view,event);
  assert.throws(()=>owner.receivers.messages.tryReceive(),/still owned/);await assert.rejects(owner.receivers.messages.receive(),/still owned/);assert.throws(()=>owner.receivers.emergencyMessages.complete(original),/another receiver/);assert.throws(()=>owner.receivers.messages.complete(Object.freeze({...original})),/another receiver/);assert.equal(view.size,1);
  owner.receivers.messages.complete(original);owner.receivers.messages.complete(original);assert.equal(view.size,0);view.assertDiscardable(event.channel_id,event.id);
 }finally{cleanup(owner);}
});
test('both original lanes bound accepted membership to configured queues plus their two active operations',async()=>{
 const owner=ingress(),view=owner.acceptedMessageView(),normal=owner.receivers.messages,emergency=owner.receivers.emergencyMessages;
 try{publish(owner,message('1'));publish(owner,message('2','!repair t'));const a=(await normal.receive())!,b=(await emergency.receive())!;
  for(const id of ['3','4'])assert.equal(publish(owner,message(id)).kind,'MessageAccepted');for(const id of ['5','6','7','8'])assert.equal(publish(owner,message(id,'!recover t')).kind,'MessageAccepted');assert.equal(view.size,8);assert.equal(normal.length,2);assert.equal(emergency.length,4);
  assert.equal(publish(owner,message('9')).kind,'MessageRecoverableGap');assert.equal(publish(owner,message('10','!force_restart')).kind,'MessageRecoverableGap');assert.equal(view.size,8);
  normal.dispose();emergency.dispose();assert.equal(view.size,2);veto(view,a.event);veto(view,b.event);normal.complete(a);emergency.complete(b);assert.equal(view.size,0);
 }finally{cleanup(owner);}
});
test('duplicate message identities have distinct exact receipts and release only their own count',async()=>{
 const owner=ingress(),event=message(),view=owner.acceptedMessageView(),rx=owner.receivers.messages;try{publish(owner,event);publish(owner,event);assert.equal(view.size,2);const first=(await rx.receive())!;rx.complete(first);assert.equal(view.size,1);veto(view,event);const second=(await rx.receive())!;assert.notEqual(second,first);assert.notEqual(second.sequence,first.sequence);rx.complete(first);assert.equal(view.size,1);rx.complete(second);assert.equal(view.size,0);}finally{cleanup(owner);}
});
test('Full, Closed and Stopping never acquire custody or change exact gap floor semantics',()=>{
 const owner=ingress(),view=owner.acceptedMessageView(),gaps=owner.subscribeMessageGaps();try{publish(owner,message('1'));publish(owner,message('2'));const full=message('3');assert.equal(publish(owner,full).kind,'MessageRecoverableGap');assert.equal(view.size,2);view.assertDiscardable(full.channel_id,full.id);const floor=gaps.snapshot()[0]!.snapshot();assert.equal(floor.earliest.messageId,3n);
  owner.receivers.messages.dispose();assert.equal(view.size,0);assert.equal(publish(owner,message('4')).kind,'MessageRecoverableGap');owner.stopAccepting();assert.equal(publish(owner,message('5','!repair t')).kind,'MessageRecoverableGap');assert.equal(view.size,0);assert.equal(gaps.snapshot()[0]!.snapshot().observationCount,3n);
 }finally{gaps.dispose();cleanup(owner);}
});
test('lane disposal during removed-value receive releases queued custody but retains the original receive result',async()=>{
 const owner=ingress(),rx=owner.receivers.messages,view=owner.acceptedMessageView();try{publish(owner,message('1'));publish(owner,message('2'));const pending=rx.receive();rx.dispose();assert.equal(view.size,1);const original=(await pending)!;assert.equal(original.event.id,1n);veto(view,original.event);rx.complete(original);assert.equal(view.size,0);}finally{cleanup(owner);}
});
test('close keeps queued originals and disposal releases them; foreign or forged views cannot be installed',()=>{
 const owner=ingress(),event=message(),view=owner.acceptedMessageView();publish(owner,event);owner.close();assert.equal(view.size,1);veto(view,event);owner.receivers.messages.dispose();assert.equal(view.size,0);assert.equal(captureAcceptedGatewayMessages(view),view);assert.equal(captureAcceptedGatewayMessages(undefined),null);assert.throws(()=>captureAcceptedGatewayMessages({...view}),TypeError);assert.throws(()=>captureAcceptedGatewayMessages(new Proxy(view,{})),TypeError);assert.throws(()=>new GatewayAcceptedMessageView(Symbol(),()=>{},()=>0),TypeError);assert.equal(isAcceptedGatewayMessageDeferral(new Error('Accepted Gateway message still owns its original disposition')),false);cleanup(owner);
});
for(const mode of ['shutdown','force','conflict'] as const)test(`${mode} winning after receive consumption completes that exact original without invoking handler`,async()=>{
 const owner=ingress(),rx=owner.receivers.messages,identity=owner.subscribeIdentity(),conflict=owner.subscribeIdentityConflict(),stop=new AbortController(),force=new AbortController(),reason=new Error('forced receive');let calls=0;
 try{owner.publish({kind:'Ready',identity:{userId:11n,applicationId:22n}},1);publish(owner,message('1'));publish(owner,message('2'));const receiver={...rx,receive:async(signal?:AbortSignal)=>{const original=await rx.receive(signal);if(mode==='shutdown')stop.abort();else if(mode==='force')force.abort(reason);else owner.publish({kind:'Ready',identity:{userId:33n,applicationId:44n}},2);return original;}};
  const pending=runMessageConsumer(receiver,identity,conflict,stop.signal,force.signal,async()=>{calls++;});if(mode==='shutdown')await pending;else await assert.rejects(pending,error=>mode==='force'?error===reason:error instanceof RuntimeGatewayIdentityConflictError);assert.equal(calls,0);assert.equal(owner.acceptedMessageView().size,0);assert.equal(rx.length,0);
 }finally{stop.abort();identity.dispose();conflict.dispose();cleanup(owner);}
});
for(const mode of ['shutdown','force','conflict'] as const)test(`${mode} retains active and queued originals until actual cancelled handler exit joins`,async()=>{
 const owner=ingress(),rx=owner.receivers.messages,identity=owner.subscribeIdentity(),conflict=owner.subscribeIdentityConflict(),stop=new AbortController(),force=new AbortController(),reason=new Error('forced handler');let finish!:()=>void,started!:()=>void,aborted=false,settled=false;const exit=new Promise<void>(r=>finish=r),entered=new Promise<void>(r=>started=r);
 try{owner.publish({kind:'Ready',identity:{userId:11n,applicationId:22n}},1);const a=message('1'),b=message('2');publish(owner,a);publish(owner,b);const pending=runMessageConsumer(rx,identity,conflict,stop.signal,force.signal,async(_event,_id,signal)=>{started();try{await new Promise<void>((_r,j)=>signal.addEventListener('abort',()=>{aborted=true;j(signal.reason);},{once:true}));}finally{await exit;}});const observed=mode==='shutdown'?pending:assert.rejects(pending,error=>mode==='force'?error===reason:error instanceof RuntimeGatewayIdentityConflictError);void observed.then(()=>settled=true);await entered;if(mode==='shutdown')stop.abort();else if(mode==='force')force.abort(reason);else owner.publish({kind:'Ready',identity:{userId:33n,applicationId:44n}},2);await turns();assert.equal(aborted,true);assert.equal(settled,false);assert.equal(owner.acceptedMessageView().size,2);veto(owner.acceptedMessageView(),a);veto(owner.acceptedMessageView(),b);finish();await observed;assert.equal(owner.acceptedMessageView().size,0);assert.equal(rx.length,0);
 }finally{finish();stop.abort();identity.dispose();conflict.dispose();cleanup(owner);}
});
