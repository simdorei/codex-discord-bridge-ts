import assert from 'node:assert/strict';
import {test} from 'node:test';
import {GatewayIngress,DEFAULT_GATEWAY_INGRESS_CONFIG,GatewayIngressConfigError,nextGatewaySequence,type DecodedGatewayEvent,type GatewayIngressConfig,type GatewayPublishOutcome} from '../../src/discord/gateway/ingress.ts';
import {GatewayIngressLane} from '../../src/discord/gateway/lane.ts';
import {decodeGatewayMessage} from '../../src/discord/gateway/decoded-message.ts';
import {isEmergencyMessage,isForceRestartMessage} from '../../src/discord/gateway/routing.ts';
import {BroadcastLaggedError} from '../../src/app-server/broadcast.ts';
const config=(normal=1,reserved=1,messages=1,errors=1):GatewayIngressConfig=>({interactionCapacity:normal,reservedInteractionCapacity:reserved,messageCapacity:messages,receiveErrorCapacity:errors});
type Interaction=Readonly<{id:bigint}>;
const interaction=(id=1n):DecodedGatewayEvent<Interaction>=>({kind:'Interaction',event:Object.freeze({id})});
const message=(id=1,content='hello',channel='7'):DecodedGatewayEvent<Interaction>=>({kind:'Message',event:decodeGatewayMessage(JSON.stringify({attachments:[],author:{id:'3',username:'u',discriminator:'1'},channel_id:channel,content,embeds:[],id:String(id),type:0,mention_everyone:false,mention_roles:[],mentions:[],pinned:false,timestamp:'2020-02-02T02:02:02.020000+00:00',tts:false}))});
function seq(outcome:GatewayPublishOutcome):bigint{if(outcome.kind!=='MessageAccepted'&&outcome.kind!=='InteractionAccepted')throw new Error('Expected accepted event');return outcome.sequence;}
test('lane bounded FIFO offers never await and a second receiver cannot be taken',async()=>{
 const lane=new GatewayIngressLane<number>(2),receiver=lane.receiver();assert.throws(()=>lane.receiver(),/already taken/);assert.equal(lane.trySend(1),'Accepted');assert.equal(lane.trySend(2),'Accepted');assert.equal(lane.trySend(3),'Full');assert.equal(receiver.length,2);assert.deepEqual(receiver.tryReceive(),{kind:'Value',value:1});assert.equal(await receiver.receive(),2);assert.equal(receiver.tryReceive().kind,'Empty');receiver.dispose();assert.equal(lane.trySend(4),'Closed');
});
test('lane close drains accepted items, dispose drops them and pending waits cancel without consuming',async()=>{
 const lane=new GatewayIngressLane<number>(2),r=lane.receiver();lane.trySend(1);r.close();assert.equal(lane.trySend(2),'Closed');assert.equal(await r.receive(),1);assert.equal(await r.receive(),null);r.dispose();
 const next=new GatewayIngressLane<number>(1),receiver=next.receiver(),abort=new AbortController(),reason=new Error('cancel'),pending=receiver.receive(abort.signal),rejected=assert.rejects(pending,e=>e===reason);assert.throws(()=>receiver.tryReceive(),/Concurrent/);abort.abort(reason);await rejected;next.trySend(7);assert.equal(await receiver.receive(),7);const stopped=receiver.receive();receiver.dispose();assert.equal(await stopped,null);
});
test('exact source capacities are used and zero/unsupported capacity is rejected without coercion',()=>{
 assert.deepEqual(DEFAULT_GATEWAY_INGRESS_CONFIG,{interactionCapacity:64,reservedInteractionCapacity:4,messageCapacity:1024,receiveErrorCapacity:16});
 for(const key of Object.keys(config()) as (keyof GatewayIngressConfig)[])assert.throws(()=>new GatewayIngress({...config(),[key]:0}),GatewayIngressConfigError);
 for(const value of [-1,1.5,'1',1048577])assert.throws(()=>new GatewayIngress({...config(),messageCapacity:value} as never),RangeError);
});
test('normal interaction overflow uses exact reserved capacity with Busy tag then hard-drops',()=>{
 const ingress=new GatewayIngress<Interaction>(config(1,2,1)),diagnostics=ingress.subscribeDiagnostics();assert.equal(ingress.publish(interaction(10n),1).kind,'InteractionAccepted');for(const id of [11n,12n]){const r=ingress.publish(interaction(id),2);assert.equal(r.kind,'InteractionAccepted');if(r.kind==='InteractionAccepted')assert.equal(r.tag,'Busy');}
 assert.deepEqual(ingress.publish(interaction(13n),3),{kind:'InteractionHardDropped',reason:'Full'});const a=ingress.receivers.normalInteractions.tryReceive(),b=ingress.receivers.reservedInteractions.tryReceive(),c=ingress.receivers.reservedInteractions.tryReceive();assert.equal(a.kind==='Value'&&a.value.tag,'Normal');assert.equal(b.kind==='Value'&&b.value.tag,'Busy');assert.equal(c.kind==='Value'&&c.value.tag,'Busy');assert.equal(diagnostics.snapshot().hardDroppedInteractions,1n);diagnostics.dispose();ingress.close();
});
test('closed normal interaction receiver still routes Busy to an open reserve',()=>{
 const ingress=new GatewayIngress<Interaction>(config());ingress.receivers.normalInteractions.dispose();const value=ingress.publish(interaction(),12.25);assert.equal(value.kind,'InteractionAccepted');const result=ingress.receivers.reservedInteractions.tryReceive();assert.ok(result.kind==='Value');assert.equal(result.value.tag,'Busy');assert.equal(result.value.receivedAtMs,12.25);ingress.close();
});
test('both closed interaction lanes and closed message receiver retain matching diagnostics',()=>{
 const ingress=new GatewayIngress<Interaction>(config()),diagnostics=ingress.subscribeDiagnostics(),gaps=ingress.subscribeMessageGaps();ingress.receivers.normalInteractions.dispose();ingress.receivers.reservedInteractions.dispose();ingress.receivers.messages.dispose();assert.deepEqual(ingress.publish(interaction(),0),{kind:'InteractionHardDropped',reason:'Closed'});assert.deepEqual(ingress.publish(message(),0),{kind:'MessageRecoverableGap',reason:'Closed',tracking:{ok:true}});assert.deepEqual(diagnostics.snapshot(),{hardDroppedInteractions:1n,recoverableMessageGaps:1n});assert.equal(gaps.snapshot()[0]!.snapshot().channelId,7n);diagnostics.dispose();gaps.dispose();ingress.close();
});
test('full normal messages do not block interactions or any of four emergency messages',()=>{
 const ingress=new GatewayIngress<Interaction>(config()),gaps=ingress.subscribeMessageGaps();ingress.publish(message(1),0);assert.equal(ingress.publish(message(2),0).kind,'MessageRecoverableGap');assert.equal(ingress.publish(interaction(),0).kind,'InteractionAccepted');
 for(const [i,content] of ['!repair a','!recover a','!force_restart','!restart_codex force'].entries())assert.equal(ingress.publish(message(i+3,content),0).kind,'MessageAccepted');assert.equal(ingress.receivers.emergencyMessages.length,4);assert.deepEqual(ingress.publish(message(8,'!복구'),0),{kind:'MessageRecoverableGap',reason:'Full',tracking:{ok:true}});assert.equal(ingress.receivers.messages.length,1);assert.equal(gaps.snapshot()[0]!.snapshot().observationCount,2n);gaps.dispose();ingress.close();
});
test('source emergency routing is exact, ASCII case-insensitive and uses Rust whitespace',()=>{
 for(const text of ['!force_restart',' !FORCE_RESTART\n','! restart_codex --FORCE','!restart_codex FORCE'])assert.equal(isForceRestartMessage(text),true,text);
 for(const text of ['!force_restart x','!restart_codex','!restart_codex force x','force_restart','!force_restart\ufeff'])assert.equal(isForceRestartMessage(text),false,text);
 for(const text of ['!recover','!RECOVER a','!복구 a','!repair a','!도구복구','\u0085!repair\u0085a\u0085'])assert.equal(isEmergencyMessage(text),true,text);
 for(const text of ['!recover a b','!repair a b','\ufeff!recover','!recover\ufeff','hello'])assert.equal(isEmergencyMessage(text),false,text);
});
test('stopping interactions use reserve while all messages, including emergency, become recoverable gaps',()=>{
 const ingress=new GatewayIngress<Interaction>(config(2,1,1)),gaps=ingress.subscribeMessageGaps();ingress.stopAccepting();const accepted=ingress.publish(interaction(),0);assert.ok(accepted.kind==='InteractionAccepted');assert.equal(accepted.tag,'Stopping');assert.deepEqual(ingress.publish(interaction(2n),0),{kind:'InteractionHardDropped',reason:'Full'});for(const content of ['hello','!force_restart'])assert.deepEqual(ingress.publish(message(3,content),0),{kind:'MessageRecoverableGap',reason:'Stopping',tracking:{ok:true}});assert.equal(ingress.receivers.normalInteractions.length,0);assert.equal(ingress.receivers.emergencyMessages.length,0);assert.equal(gaps.snapshot()[0]!.snapshot().reasonBits,4);gaps.dispose();ingress.close();
});
test('READY identity is published even when all lanes are full and after stop acceptance',()=>{
 const ingress=new GatewayIngress<Interaction>(config()),identity=ingress.subscribeIdentity(),conflicts=ingress.subscribeIdentityConflict();ingress.publish(message(),0);ingress.publish(interaction(),0);ingress.publish(interaction(2n),0);ingress.stopAccepting();assert.deepEqual(ingress.publish({kind:'Ready',identity:{userId:1n,applicationId:2n}},0),{kind:'Ignored'});assert.deepEqual(identity.snapshot(),{userId:1n,applicationId:2n});ingress.publish({kind:'Ready',identity:{userId:1n,applicationId:3n}},0);assert.equal(conflicts.snapshot()?.observed.applicationId,3n);identity.dispose();conflicts.dispose();ingress.close();
});
test('process sequence is shared across instances; Ignored/READY/stopped Message allocate none',()=>{
 const a=new GatewayIngress<Interaction>(config(2,1,2)),b=new GatewayIngress<Interaction>(config(2,2,2));const before=seq(a.publish(message(),0));b.publish({kind:'Ignored'},0);b.publish({kind:'Ready',identity:{userId:1n,applicationId:2n}},0);b.stopAccepting();b.publish(message(2),0);const after=seq(b.publish(interaction(),5));assert.equal(after,before+1n);a.close();b.close();
});
test('a failed full-queue publication consumes its allocated sequence but an invalid DTO does not',()=>{
 const ingress=new GatewayIngress<Interaction>(config());const before=seq(ingress.publish(message(),0));ingress.publish(message(2),0);assert.throws(()=>ingress.publish({kind:'Message',event:{} as never},0),/complete Gateway Message/);const after=seq(ingress.publish(interaction(),0));assert.equal(after,before+2n);ingress.close();
});
test('decoded Message brand, deep immutable payload and single move cannot be forged by copied envelope reuse',()=>{
 const ingress=new GatewayIngress<Interaction>(config()),input=message();assert.ok(input.kind==='Message');assert.ok(Object.isFrozen(input.event));assert.ok(Object.isFrozen(input.event.author));ingress.publish(input,0);assert.throws(()=>ingress.publish(input,0),/already moved/);assert.throws(()=>ingress.publish({kind:'Message',event:{...input.event}},0),/complete Gateway Message/);assert.throws(()=>decodeGatewayMessage('{"id":"1"}'),SyntaxError);ingress.close();
});
test('receive errors are bounded separately and acceptance stop does not hide them',async()=>{
 const ingress=new GatewayIngress<Interaction>(config());ingress.stopAccepting();assert.deepEqual(ingress.publishReceiveError(3,'broken'),{kind:'Accepted'});assert.deepEqual(ingress.publishReceiveError(4,'next'),{kind:'Dropped',reason:'Full'});assert.deepEqual(await ingress.receivers.receiveErrors.receive(),{shard:3,message:'broken'});ingress.receivers.receiveErrors.dispose();assert.deepEqual(ingress.publishReceiveError(5,'closed'),{kind:'Dropped',reason:'Closed'});ingress.close();
});
test('slow diagnostic receiver recovers exact sticky counters after notification lag',async()=>{
 const ingress=new GatewayIngress<Interaction>(config()),diagnostics=ingress.subscribeDiagnostics();ingress.receivers.messages.dispose();for(let i=0;i<20;i++)ingress.publish(message(i+1),0);await assert.rejects(diagnostics.changed(),e=>e instanceof BroadcastLaggedError&&e.missed===4n);assert.equal(diagnostics.snapshot().recoverableMessageGaps,20n);diagnostics.dispose();ingress.close();
});
test('gap publication invalidates an earlier same-channel clear fence before publish returns',()=>{
 const ingress=new GatewayIngress<Interaction>(config()),gaps=ingress.subscribeMessageGaps(),fence=gaps.captureClearFence(7n)!;ingress.receivers.messages.dispose();ingress.publish(message(),0);let ran=false;assert.throws(()=>gaps.withCurrentFence(fence,()=>{ran=true;}),/advanced/);assert.equal(ran,false);gaps.dispose();ingress.close();
});
test('ingress close drains prior accepted envelopes and wakes pending empty receivers',async()=>{
 const ingress=new GatewayIngress<Interaction>(config());ingress.publish(message(),0);const pending=ingress.receivers.normalInteractions.receive();ingress.close();assert.equal(await pending,null);assert.ok(await ingress.receivers.messages.receive());assert.equal(await ingress.receivers.messages.receive(),null);assert.throws(()=>ingress.publish(interaction(),0),/closed/);ingress.close();
});
test('deep immutable interaction contract refuses active or mutable descendants without hooks',()=>{
 const ingress=new GatewayIngress<object>(config());let hooks=0;for(const value of [Object.freeze({nested:{x:1}}),Object.freeze({get nested(){hooks++;return 1;}}),new Proxy(Object.freeze({id:1n}),{getPrototypeOf(){hooks++;return null;}}),Object.freeze({fn:()=>{}})])assert.throws(()=>ingress.publish({kind:'Interaction',event:value},0),TypeError);assert.equal(hooks,0);ingress.close();
});
test('sequence arithmetic fails closed before u64 wrap',()=>{const max=(1n<<64n)-1n;assert.equal(nextGatewaySequence(max-1n),max);assert.equal(nextGatewaySequence(max),null);assert.throws(()=>nextGatewaySequence(max+1n),TypeError);});
test('poisoned publication gate prevents even a successful message enqueue and sequence allocation',()=>{
 const ingress=new GatewayIngress<Interaction>(config()),gaps=ingress.subscribeMessageGaps(),fence=gaps.captureClearFence(7n)!;assert.throws(()=>gaps.withCurrentFence(fence,()=>{throw new Error('poison publication');}));
 assert.throws(()=>ingress.publish(message(),0),/poisoned/);assert.equal(ingress.receivers.messages.length,0);gaps.dispose();ingress.close();
});
