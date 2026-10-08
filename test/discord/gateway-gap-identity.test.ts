import assert from 'node:assert/strict';
import {test} from 'node:test';
import {GatewayIdentityTracker} from '../../src/discord/gateway/identity.ts';
import {MessageGapTracker,MessageGapStateError,MessageGapAckError,MessageGapFenceError,saturatingGatewayIncrement,type MessageGapNotice,type MessageGapFence} from '../../src/discord/gateway/message-gaps.ts';
import {BroadcastClosedError,BroadcastLaggedError} from '../../src/app-server/broadcast.ts';
const position=(timestampMicros=0n,messageId=1n)=>({timestampMicros,messageId});
test('gateway READY identity is sticky, immutable and visible to a late subscriber',()=>{
 const tracker=new GatewayIdentityTracker(),early=tracker.subscribeIdentity(),input={userId:1n,applicationId:2n};assert.equal(early.snapshot(),null);tracker.observe(input);input.userId=9n;assert.deepEqual(early.snapshot(),{userId:1n,applicationId:2n});assert.ok(Object.isFrozen(early.snapshot()));assert.equal(early.tryChanged().kind,'Value');tracker.observe({userId:1n,applicationId:2n});assert.equal(early.tryChanged().kind,'Empty');const late=tracker.subscribeIdentity();assert.deepEqual(late.snapshot(),early.snapshot());assert.equal(late.tryChanged().kind,'Empty');early.dispose();late.dispose();tracker.close();
});
test('only first differing READY is retained while established identity never changes',()=>{
 const tracker=new GatewayIdentityTracker(),identity=tracker.subscribeIdentity(),conflict=tracker.subscribeConflict();tracker.observe({userId:1n,applicationId:2n});tracker.observe({userId:1n,applicationId:3n});tracker.observe({userId:4n,applicationId:5n});assert.deepEqual(identity.snapshot(),{userId:1n,applicationId:2n});assert.deepEqual(conflict.snapshot(),{established:{userId:1n,applicationId:2n},observed:{userId:1n,applicationId:3n}});assert.equal(conflict.tryChanged().kind,'Value');assert.equal(conflict.tryChanged().kind,'Empty');const late=tracker.subscribeConflict();assert.deepEqual(late.snapshot(),conflict.snapshot());identity.dispose();conflict.dispose();late.dispose();tracker.close();
});
test('identity changed wait cancels without consuming later publication and close wakes it',async()=>{
 const tracker=new GatewayIdentityTracker(),receiver=tracker.subscribeIdentity(),abort=new AbortController(),reason=new Error('cancel');const pending=receiver.changed(abort.signal),rejected=assert.rejects(pending,e=>e===reason);abort.abort(reason);await rejected;tracker.observe({userId:1n,applicationId:2n});assert.deepEqual(await receiver.changed(),{userId:1n,applicationId:2n});const closed=assert.rejects(receiver.changed(),BroadcastClosedError);tracker.close();await closed;receiver.dispose();assert.throws(()=>tracker.observe({userId:1n,applicationId:2n}),/closed/);
});
test('invalid gateway identities cannot initialize sticky state',()=>{
 const tracker=new GatewayIdentityTracker(),receiver=tracker.subscribeIdentity();for(const input of [{userId:0n,applicationId:1n},{userId:1n,applicationId:1n<<64n}])assert.throws(()=>tracker.observe(input),TypeError);assert.equal(receiver.snapshot(),null);receiver.dispose();tracker.close();
});
test('gap snapshots sort channels and preserve earliest timestamp/id with merged reasons',()=>{
 const tracker=new MessageGapTracker(),receiver=tracker.subscribe();tracker.record(9n,position(10n,5n),'Full');tracker.record(2n,position(1n,1n),'Stopping');tracker.record(9n,position(10n,3n),'Closed');tracker.record(9n,position(9n,8n),'SequenceExhausted');const list=receiver.snapshot();assert.deepEqual(list.map(n=>n.snapshot().channelId),[2n,9n]);assert.deepEqual(list[1]!.snapshot(),{channelId:9n,earliest:position(9n,8n),reasonBits:11,observationCount:3n,revision:3n});assert.ok(Object.isFrozen(list[1]!.snapshot().earliest));receiver.dispose();tracker.close();
});
test('gap notice binds one immutable revision and cannot clear a later observation',()=>{
 const tracker=new MessageGapTracker(),receiver=tracker.subscribe();tracker.record(1n,position(5n),'Full');const old=receiver.snapshot()[0]!;tracker.record(1n,position(4n),'Closed');assert.equal(old.snapshot().revision,1n);assert.equal(receiver.acknowledge(old),'Stale');assert.equal(receiver.snapshot()[0]!.snapshot().revision,2n);assert.throws(()=>receiver.acknowledge(old),e=>e instanceof MessageGapAckError&&e.kind==='ConsumedNotice');assert.throws(()=>old.snapshot(),/consumed/);receiver.dispose();tracker.close();
});
test('clear acknowledgement consumes its notice while another same-revision token becomes stale',()=>{
 const tracker=new MessageGapTracker(),receiver=tracker.subscribe();tracker.record(1n,position(),'Full');const a=receiver.snapshot()[0]!,b=receiver.snapshot()[0]!;assert.equal(receiver.acknowledge(a),'Cleared');assert.equal(receiver.acknowledge(b),'Stale');assert.deepEqual(receiver.snapshot(),[]);tracker.record(1n,position(8n),'Closed');const v=receiver.snapshot()[0]!.snapshot();assert.equal(v.revision,2n);assert.equal(v.observationCount,1n);assert.equal(v.reasonBits,2);receiver.dispose();tracker.close();
});
test('foreign acknowledgement consumes the moved notice and forged copies never authorize a clear',()=>{
 const a=new MessageGapTracker(),b=new MessageGapTracker(),ra=a.subscribe(),rb=b.subscribe();a.record(1n,position(),'Full');const notice=ra.snapshot()[0]!;assert.throws(()=>rb.acknowledge(notice),e=>e instanceof MessageGapAckError&&e.kind==='ForeignTracker');assert.throws(()=>ra.acknowledge(notice),/consumed/);const original=ra.snapshot()[0]!;assert.throws(()=>ra.acknowledge({...original} as MessageGapNotice),/another tracker/);assert.equal(ra.acknowledge(original),'Cleared');ra.dispose();rb.dispose();a.close();b.close();
});
test('active gap prevents capture and original clean fence remains invalid after clear',()=>{
 const tracker=new MessageGapTracker(),receiver=tracker.subscribe(),fence=receiver.captureClearFence(1n)!;assert.equal(receiver.withCurrentFence(fence,()=>42),42);tracker.record(1n,position(),'Full');assert.equal(receiver.captureClearFence(1n),null);assert.throws(()=>receiver.withCurrentFence(fence,()=>99),e=>e instanceof MessageGapFenceError&&e.kind==='Advanced');receiver.acknowledge(receiver.snapshot()[0]!);assert.throws(()=>receiver.withCurrentFence(fence,()=>99),/advanced/);const next=receiver.captureClearFence(1n)!;assert.equal(receiver.withCurrentFence(next,()=>43),43);receiver.dispose();tracker.close();
});
test('different channel gap cannot invalidate a matching channel fence',()=>{
 const tracker=new MessageGapTracker(),receiver=tracker.subscribe(),fence=receiver.captureClearFence(1n)!;tracker.record(2n,position(),'Full');assert.equal(receiver.withCurrentFence(fence,()=>true),true);receiver.dispose();tracker.close();
});
test('foreign or copied fences invoke no callback and reveal no writable authority fields',()=>{
 const a=new MessageGapTracker(),b=new MessageGapTracker(),ra=a.subscribe(),rb=b.subscribe(),fence=ra.captureClearFence(1n)!;let calls=0;for(const [receiver,value] of [[rb,fence],[ra,{...fence} as MessageGapFence]] as const)assert.throws(()=>receiver.withCurrentFence(value,()=>calls++),/another tracker/);assert.equal(calls,0);assert.deepEqual(Object.keys(fence),[]);ra.dispose();rb.dispose();a.close();b.close();
});
test('bounded gap hints may lag while authoritative counters and earliest position remain intact',async()=>{
 const tracker=new MessageGapTracker(),receiver=tracker.subscribe();for(let i=0;i<20;i++)tracker.record(1n,position(BigInt(20-i),BigInt(i+1)),'Full');await assert.rejects(receiver.changed(),e=>e instanceof BroadcastLaggedError&&e.missed===4n);const v=receiver.snapshot()[0]!.snapshot();assert.equal(v.observationCount,20n);assert.equal(v.revision,20n);assert.equal(v.earliest.timestampMicros,1n);await receiver.changed();receiver.dispose();tracker.close();
});
test('gap receiver cancellation preserves the next hint and closure joins a pending wait',async()=>{
 const tracker=new MessageGapTracker(),receiver=tracker.subscribe(),abort=new AbortController(),reason=new Error('cancel'),pending=receiver.changed(abort.signal),rejected=assert.rejects(pending,e=>e===reason);abort.abort(reason);await rejected;tracker.record(1n,position(),'Full');await receiver.changed();const closed=assert.rejects(receiver.changed(),BroadcastClosedError);tracker.close();await closed;assert.equal(receiver.snapshot().length,1);receiver.dispose();
});
test('synchronous fenced action blocks reentrant gap mutation and poisons on thrown work',()=>{
 const tracker=new MessageGapTracker(),receiver=tracker.subscribe(),fence=receiver.captureClearFence(1n)!;assert.throws(()=>receiver.withCurrentFence(fence,()=>tracker.record(1n,position(),'Full')),/reentered/);assert.throws(()=>receiver.snapshot(),MessageGapStateError);assert.throws(()=>receiver.captureClearFence(1n),MessageGapStateError);receiver.dispose();tracker.close();
});
test('callback exception identity is retained and cleanup remains possible after poisoning',async()=>{
 const tracker=new MessageGapTracker(),receiver=tracker.subscribe(),fence=receiver.captureClearFence(1n)!,reason=new Error('callback failure');assert.throws(()=>receiver.withCurrentFence(fence,()=>{throw reason;}),e=>e===reason);const closed=assert.rejects(receiver.changed(),BroadcastClosedError);tracker.close();await closed;receiver.dispose();
});
test('native async/generator/proxy callbacks are refused without invocation or poisoning',()=>{
 const tracker=new MessageGapTracker(),receiver=tracker.subscribe(),fence=receiver.captureClearFence(1n)!;let calls=0;const callbacks=[async()=>{calls++;},function*(){calls++;},new Proxy(()=>{}, {apply(){calls++;}})];for(const action of callbacks)assert.throws(()=>receiver.withCurrentFence(fence,action),/synchronous/);assert.equal(calls,0);assert.equal(receiver.withCurrentFence(fence,()=>1),1);receiver.dispose();tracker.close();
});
test('disguised Promise-returning callback is drained and poisons the unsafe action',async()=>{
 const tracker=new MessageGapTracker(),receiver=tracker.subscribe(),fence=receiver.captureClearFence(1n)!;assert.throws(()=>receiver.withCurrentFence(fence,()=>Promise.reject(new Error('owned rejection'))),/Promise/);await Promise.resolve();assert.throws(()=>receiver.snapshot(),MessageGapStateError);receiver.dispose();tracker.close();
});
test('u64 diagnostic/revision increment saturates rather than wrapping',()=>{
 const max=(1n<<64n)-1n;assert.equal(saturatingGatewayIncrement(0n),1n);assert.equal(saturatingGatewayIncrement(max-1n),max);assert.equal(saturatingGatewayIncrement(max),max);assert.throws(()=>saturatingGatewayIncrement(max+1n),TypeError);
});
test('invalid gap identity, timestamp and reason cannot alter the authoritative map',()=>{
 const tracker=new MessageGapTracker(),receiver=tracker.subscribe();assert.throws(()=>tracker.record(0n,position(),'Full'));assert.throws(()=>tracker.record(1n,position(1n<<63n),'Full'));assert.throws(()=>tracker.record(1n,position(0n,0n),'Full'));assert.throws(()=>tracker.record(1n,position(),'unknown' as never));assert.deepEqual(receiver.snapshot(),[]);receiver.dispose();tracker.close();
});
test('thenable/proxy fence results are rejected without running result accessors',()=>{
 for(const kind of ['getter','proxy','inherited'] as const){const tracker=new MessageGapTracker(),receiver=tracker.subscribe(),fence=receiver.captureClearFence(1n)!;let hooks=0;
  const value=kind==='proxy'?new Proxy({}, {getPrototypeOf(){hooks++;return null;}}):kind==='inherited'?Object.create({then(){hooks++;}}):Object.defineProperty({},'then',{get(){hooks++;return()=>{};}});
  assert.throws(()=>receiver.withCurrentFence(fence,()=>value),/thenable|Proxy/);assert.equal(hooks,0);assert.throws(()=>receiver.withCurrentFence(fence,()=>1),e=>e instanceof MessageGapFenceError&&e.kind==='StatePoisoned');receiver.dispose();tracker.close();}
});
test('poisoned acknowledgement reports its own StatePoisoned error family',()=>{
 const tracker=new MessageGapTracker(),receiver=tracker.subscribe(),fence=receiver.captureClearFence(2n)!;tracker.record(1n,position(),'Full');const notice=receiver.snapshot()[0]!;
 assert.throws(()=>receiver.withCurrentFence(fence,()=>{throw new Error('poison');}));assert.throws(()=>receiver.acknowledge(notice),e=>e instanceof MessageGapAckError&&e.kind==='StatePoisoned');receiver.dispose();tracker.close();
});
test('disposed receivers lose snapshot/action access while cancellation wakes their waiter',async()=>{
 const tracker=new MessageGapTracker(),receiver=tracker.subscribe(),fence=receiver.captureClearFence(1n)!;const pending=assert.rejects(receiver.changed(),BroadcastClosedError);receiver.dispose();await pending;assert.equal(receiver.tryChanged().kind,'Closed');assert.throws(()=>receiver.snapshot(),/disposed/);assert.throws(()=>receiver.withCurrentFence(fence,()=>1),/disposed/);tracker.close();
 const identity=new GatewayIdentityTracker(),r=identity.subscribeIdentity();r.dispose();assert.throws(()=>r.snapshot(),/disposed/);identity.close();
});
test('gateway data records reject accessors, proxies and coercion without invoking them',()=>{
 let hooks=0;const identity=new GatewayIdentityTracker(),gaps=new MessageGapTracker(),receiver=gaps.subscribe();
 const input=Object.defineProperty({applicationId:2n},'userId',{get(){hooks++;return 1n;}});assert.throws(()=>identity.observe(input as never),TypeError);
 assert.throws(()=>identity.observe(new Proxy({userId:1n,applicationId:2n},{getOwnPropertyDescriptor(){hooks++;return undefined;}})),TypeError);
 assert.throws(()=>gaps.record(1n,Object.defineProperty({messageId:1n},'timestampMicros',{get(){hooks++;return 0n;}}) as never,'Full'),TypeError);
 assert.throws(()=>gaps.record(1n,position(),{[Symbol.toPrimitive](){hooks++;return 'Full';}} as never),TypeError);assert.equal(hooks,0);assert.deepEqual(receiver.snapshot(),[]);receiver.dispose();gaps.close();identity.close();
});
