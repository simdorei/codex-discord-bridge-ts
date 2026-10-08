import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setImmediate as tick} from 'node:timers/promises';
import {GatewayTypedActivation} from '../../src/discord/gateway/activation.ts';
import {GatewayPublication} from '../../src/discord/gateway/publication.ts';
import {GatewayIngress} from '../../src/discord/gateway/ingress.ts';
import {GatewayIngressLane} from '../../src/discord/gateway/lane.ts';
import {runGatewayShard,type GatewayShardPort,type GatewayShardItem} from '../../src/discord/gateway/shard-task.ts';
import {decodeGatewayMessage} from '../../src/discord/gateway/decoded-message.ts';
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
type Interaction=Readonly<{id:bigint}>;type Item=GatewayShardItem<Interaction>;
const closed=():Item=>({kind:'Event',event:{kind:'GatewayClose'}});
const ignored=():Item=>({kind:'Event',event:{kind:'Ignored'}});
class Port implements GatewayShardPort<Interaction>{
 readonly shardId:number;readonly entered=deferred();readonly closeEntered=deferred();readonly disposed=deferred();items:(Item|null)[];nextCalls=0;closeCalls=0;disposeCalls=0;activeReads=0;onClose:()=>void=()=>{};failure:unknown;disposeFailure:unknown;hasFailure=false;hasDisposeFailure=false;
 pending:((value:Item|null)=>void)|null=null;
 constructor(items:(Item|null)[]=[],shardId=7){this.items=items;this.shardId=shardId;}
 nextEvent(signal:AbortSignal):Promise<Item|null>{
  assert.equal(this.activeReads,0);signal.throwIfAborted();this.nextCalls++;this.entered.resolve();if(this.hasFailure)return Promise.reject(this.failure);if(this.items.length!==0)return Promise.resolve(this.items.shift()!);
  this.activeReads++;return new Promise((resolve,reject)=>{const clean=()=>{this.activeReads--;signal.removeEventListener('abort',abort);this.pending=null;};const abort=()=>{clean();reject(signal.reason);};this.pending=value=>{clean();resolve(value);};signal.addEventListener('abort',abort,{once:true});});
 }
 push(value:Item|null):void{if(this.pending!==null)this.pending(value);else this.items.push(value);}
 requestNormalClose():void{this.closeCalls++;this.closeEntered.resolve();this.onClose();}
 async dispose():Promise<void>{this.disposeCalls++;this.push(null);this.disposed.resolve();if(this.hasDisposeFailure)throw this.disposeFailure;}
}
function setup(port=new Port(),activated=true){
 const ingress=new GatewayIngress<Interaction>({interactionCapacity:1,reservedInteractionCapacity:1,messageCapacity:1,receiveErrorCapacity:1}),drops:unknown[]=[],publication=new GatewayPublication(ingress,d=>{drops.push(d);}),activation=new GatewayTypedActivation(ingress.receivers),exits=new GatewayIngressLane<number>(1),exit=exits.receiver(),shutdown=new AbortController(),force=new AbortController();
 if(activated){activation.takeReceivers();activation.activate();}
 return {ingress,drops,publication,activation,exits,exit,shutdown,force,port,run:()=>runGatewayShard({port,activation,publication,shutdown:shutdown.signal,force:force.signal,exits,now:()=>12.5}),close:()=>{activation.stop();ingress.close();exits.close();exit.dispose();}};
}
test('stopped-before-activation shard performs no read but joins disposal and publishes exit',{timeout:5000},async()=>{
 const f=setup(new Port(),false);try{const running=f.run();assert.equal(f.port.nextCalls,0);f.activation.stop();await running;assert.equal(f.port.nextCalls,0);assert.equal(f.port.disposeCalls,1);assert.deepEqual(f.exit.tryReceive(),{kind:'Value',value:7});}finally{f.close();}
});
test('active shard publishes complete typed events with original receive clock and bounded errors',{timeout:5000},async()=>{
 const message=decodeGatewayMessage(JSON.stringify({attachments:[],author:{id:'1',username:'u',discriminator:'0'},channel_id:'2',content:'',embeds:[],id:'3',type:0,mention_everyone:false,mention_roles:[],mentions:[],pinned:false,timestamp:'2020-01-01T00:00:00+00:00',tts:false}));
 const port=new Port([{kind:'Event',event:{kind:'Ready',identity:{userId:1n,applicationId:2n}}},{kind:'Event',event:{kind:'Interaction',event:Object.freeze({id:9n})}},{kind:'Event',event:{kind:'Message',event:message}},{kind:'ReceiveError',message:'receive failed'},null]),f=setup(port);
 try{await f.run();assert.equal(port.nextCalls,5);assert.equal(port.closeCalls,0);assert.equal(port.disposeCalls,1);const received=f.ingress.receivers.normalInteractions.tryReceive();assert.ok(received.kind==='Value');assert.equal(received.value.receivedAtMs,12.5);assert.equal(f.publication.snapshot().messagesAccepted,1n);assert.equal(f.publication.snapshot().receiveErrorsAccepted,1n);assert.deepEqual(f.exit.tryReceive(),{kind:'Value',value:7});}finally{f.close();}
});
test('normal shutdown retains one losing read, requests NORMAL once and drains the terminal close',{timeout:5000},async()=>{
 const f=setup();try{const task=f.run();await f.port.entered.promise;f.shutdown.abort();await f.port.closeEntered.promise;assert.equal(f.port.closeCalls,1);assert.equal(f.port.nextCalls,1);assert.equal(f.port.activeReads,1);f.port.push(closed());await task;assert.equal(f.port.nextCalls,1);assert.equal(f.publication.snapshot().ignored,1n);assert.equal(f.port.activeReads,0);}finally{f.force.abort();f.close();}
});
test('unsolicited close while running is published but does not itself terminate the reader',{timeout:5000},async()=>{
 const f=setup(new Port([closed(),ignored(),null]));try{await f.run();assert.equal(f.port.nextCalls,3);assert.equal(f.port.closeCalls,0);assert.equal(f.publication.snapshot().ignored,2n);}finally{f.close();}
});
test('pre-requested normal shutdown sends close before its first active read',{timeout:5000},async()=>{
 const f=setup();f.port.onClose=()=>f.port.push(closed());f.shutdown.abort();try{await f.run();assert.equal(f.port.closeCalls,1);assert.equal(f.port.nextCalls,1);assert.equal(f.publication.snapshot().ignored,1n);}finally{f.close();}
});
test('receive errors during normal drain stay in the error lane before a close completes',{timeout:5000},async()=>{
 const f=setup();f.port.onClose=()=>{f.port.push({kind:'ReceiveError',message:'during close'});f.port.push(closed());};try{const task=f.run();await f.port.entered.promise;f.shutdown.abort();await task;assert.equal(f.publication.snapshot().receiveErrorsAccepted,1n);assert.equal(f.publication.snapshot().ignored,1n);assert.equal(f.port.closeCalls,1);}finally{f.close();}
});
test('force cancellation retains exact reason, joins current read and emits no fabricated receive error',{timeout:5000},async()=>{
 const f=setup(),reason=new Error('force');try{const task=f.run(),rejected=assert.rejects(task,e=>e===reason);await f.port.entered.promise;f.force.abort(reason);await rejected;assert.equal(f.port.activeReads,0);assert.equal(f.port.disposeCalls,1);assert.equal(f.publication.snapshot().receiveErrorsAccepted,0n);assert.deepEqual(f.exit.tryReceive(),{kind:'Value',value:7});}finally{f.close();}
});
test('force starts real disposal even when the pending read needs disposal to unblock, and waits for both',{timeout:5000},async()=>{
 const entered=deferred(),disposing=deferred(),release=deferred();let resolveRead!:(value:Item|null)=>void,disposed=false;
 const port:GatewayShardPort<Interaction>={shardId:7,nextEvent:async()=>{entered.resolve();return await new Promise(resolve=>{resolveRead=resolve;});},requestNormalClose(){},dispose:async()=>{disposing.resolve();await release.promise;resolveRead(null);disposed=true;}};
 const f=setup(),reason=new Error('force owned'),task=runGatewayShard({port,activation:f.activation,publication:f.publication,shutdown:f.shutdown.signal,force:f.force.signal,exits:f.exits});let settled=false;const rejected=assert.rejects(task,e=>e===reason).then(()=>{settled=true;});
 try{await entered.promise;f.force.abort(reason);await disposing.promise;await tick();assert.equal(settled,false);assert.equal(disposed,false);release.resolve();await rejected;assert.equal(disposed,true);assert.deepEqual(f.exit.tryReceive(),{kind:'Value',value:7});}finally{release.resolve();f.force.abort(reason);await rejected;f.close();}
});
test('unexpected reader rejection preserves task failure and still disposes and reports exit',{timeout:5000},async()=>{
 const port=new Port(),reason=new Error('reader');port.hasFailure=true;port.failure=reason;const f=setup(port);try{await assert.rejects(f.run(),e=>e===reason);assert.equal(port.disposeCalls,1);assert.equal(f.publication.snapshot().receiveErrorsAccepted,0n);assert.equal(f.exit.tryReceive().kind,'Value');}finally{f.close();}
});
test('cleanup failure is distinct and primary failure is retained first if both fail',{timeout:5000},async()=>{
 const cleanup=new Error('cleanup'),primary=new Error('primary');for(const both of [false,true]){const port=new Port([null]);port.hasDisposeFailure=true;port.disposeFailure=cleanup;port.hasFailure=both;port.failure=primary;const f=setup(port);try{await assert.rejects(f.run(),e=>both?e instanceof AggregateError&&e.errors[0]===primary&&e.errors[1]===cleanup:e===cleanup);assert.equal(f.exit.tryReceive().kind,'Value');}finally{f.close();}}
});
test('bounded exit lane cannot block two independently completed shard tasks',{timeout:5000},async()=>{
 const f=setup(new Port([null],7)),other=new Port([null],8);try{await Promise.all([f.run(),runGatewayShard({port:other,activation:f.activation,publication:f.publication,shutdown:f.shutdown.signal,exits:f.exits})]);assert.equal(f.exit.length,1);const exit=f.exit.tryReceive();assert.ok(exit.kind==='Value'&&(exit.value===7||exit.value===8));assert.equal(f.port.disposeCalls,1);assert.equal(other.disposeCalls,1);}finally{f.close();}
});
test('burst of immediately ready items yields IO so normal shutdown cannot starve',{timeout:5000},async()=>{
 const f=setup(new Port(Array.from({length:200},ignored)));f.port.onClose=()=>f.port.push(closed());let observed=0n;const stop=tick().then(()=>{observed=f.publication.snapshot().ignored;f.shutdown.abort();});try{await f.run();await stop;assert.ok(observed>0n&&observed<=64n);assert.equal(f.port.closeCalls,1);assert.equal(f.publication.snapshot().ignored,201n);}finally{f.close();}
});
test('shutdown request alone is not completion while the adapter is still waiting for its terminal event',{timeout:5000},async()=>{
 const f=setup();let settled=false;try{const task=f.run().then(()=>{settled=true;});await f.port.entered.promise;f.shutdown.abort();await f.port.closeEntered.promise;await tick();assert.equal(settled,false);f.port.push(null);await task;assert.equal(settled,true);assert.equal(f.port.disposeCalls,1);}finally{f.close();}
});
test('invalid adapter items fail the task without recording a successful publication',{timeout:5000},async()=>{
 const f=setup(new Port([{kind:'Unknown'} as never]));try{await assert.rejects(f.run(),/Unknown gateway shard item/);assert.equal(f.publication.snapshot().ignored,0n);assert.equal(f.port.disposeCalls,1);}finally{f.close();}
});
