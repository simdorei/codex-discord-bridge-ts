import {it} from 'node:test';import assert from 'node:assert/strict';import {setImmediate as tick} from 'node:timers/promises';
import {GatewayRuntime} from '../../../src/discord/gateway/runtime.ts';import type {GatewayShardPort,GatewayShardItem} from '../../../src/discord/gateway/shard-task.ts';import {decodeGatewayInteraction,type DecodedGatewayInteraction} from '../../../src/discord/gateway/decoded-interaction.ts';import {decodeGatewayMessage} from '../../../src/discord/gateway/decoded-message.ts';
import {startTypedIngressWorkers,type TypedIngressStartOptions} from '../../../src/runtime/discord-runtime/typed-ingress-start.ts';import {RuntimeWorkerExitChannel,type RuntimeMonitoredWorker} from '../../../src/runtime/discord-runtime/monitored-worker.ts';
class Port implements GatewayShardPort<DecodedGatewayInteraction>{
 shardId=0;polls=0;disposed=0;items:GatewayShardItem<DecodedGatewayInteraction>[]=[];deliver:((item:GatewayShardItem<DecodedGatewayInteraction>|null)=>void)|undefined;
 push(item:GatewayShardItem<DecodedGatewayInteraction>){if(this.deliver)this.deliver(item);else this.items.push(item);}
 async nextEvent(signal:AbortSignal){this.polls++;if(this.items.length)return this.items.shift()!;return new Promise<GatewayShardItem<DecodedGatewayInteraction>|null>((resolve,reject)=>{const abort=()=>{this.deliver=undefined;reject(signal.reason);};this.deliver=item=>{signal.removeEventListener('abort',abort);this.deliver=undefined;resolve(item);};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});}
 requestNormalClose(){this.deliver?.({kind:'Event',event:{kind:'GatewayClose'}});}
 async dispose(){this.disposed++;this.deliver?.(null);}
}
function setup(){const port=new Port(),gateway=GatewayRuntime.fromOwnedPorts([port],{reportReceiveErrorDrop(){},reportTriggerFailure(){}}),shutdown=new AbortController(),notifier=new RuntimeWorkerExitChannel(),seen:string[]=[],waiters=new Map<string,(()=>void)[]>();const mark=(key:string)=>{seen.push(key);for(const resolve of waiters.get(key)??[])resolve();waiters.delete(key);};const waitFor=async(key:string)=>{if(seen.includes(key))return;let timer:ReturnType<typeof setTimeout>|undefined;try{await new Promise<void>((resolve,reject)=>{waiters.set(key,[...(waiters.get(key)??[]),resolve]);timer=setTimeout(()=>reject(new Error('Missing consumer event '+key)),5000);});}finally{clearTimeout(timer);}};
 const options:TypedIngressStartOptions={ready:{port:{async register(){mark('register');},async sendNotice(){assert.fail();}},guildId:null,qaCommands:false,startupNotify:false,startupChannelId:null,report(){}},message:async(message)=>{mark(message.content);},history:()=>({async recover(){mark('history');},async poll(){assert.fail();}}),historyPeriodMs:null,interaction:async(item)=>{mark(item.tag);},reportInteraction(){},reportReceiveError(){mark('error');}};
 return {port,gateway,shutdown,notifier,seen,options,waitFor,async close(workers:RuntimeMonitoredWorker[]=[]){shutdown.abort();await gateway.shutdown(performance.now()+2000);await Promise.all(workers.map(w=>w.join()));notifier.close();}};
}
const ready=():GatewayShardItem<DecodedGatewayInteraction>=>({kind:'Event',event:{kind:'Ready',identity:{userId:9n,applicationId:4n}}});
const msg=(content:string)=>decodeGatewayMessage(JSON.stringify({attachments:[],author:{id:'2',username:'u',discriminator:'0'},channel_id:'1',content,embeds:[],id:'3',type:0,mention_everyone:false,mention_roles:[],mentions:[],pinned:false,timestamp:'2020-01-01T00:00:00+00:00',tts:false}));
const interaction=()=>decodeGatewayInteraction(JSON.stringify({application_id:'4',authorizing_integration_owners:{},id:'5',token:'offline',type:2,data:{id:'6',name:'help',type:1}}));
it('all seven real consumers start before paused gateway activation and share actual decoded ingress',async()=>{
 const f=setup();let workers:RuntimeMonitoredWorker[]=[];try{await tick();assert.equal(f.port.polls,0);workers=await startTypedIngressWorkers(f.gateway,f.shutdown.signal,f.notifier,f.options);assert.deepEqual(workers.map(w=>w.name),['ready','message-emergency','message','history','interaction-normal','interaction-reserved','receive-error']);
 f.port.push(ready());f.port.push({kind:'Event',event:{kind:'Message',event:msg('!help')}});f.port.push({kind:'Event',event:{kind:'Message',event:msg('!force_restart')}});f.port.push({kind:'Event',event:{kind:'Interaction',event:interaction()}});f.port.push({kind:'ReceiveError',message:'fixture'});
 await Promise.all(['register','history','!help','!force_restart','Normal','error'].map(key=>f.waitFor(key)));for(const key of ['register','history','!help','!force_restart','Normal','error'])assert.ok(f.seen.includes(key),key);
 f.gateway.beginStopping();f.port.push({kind:'Event',event:{kind:'Interaction',event:interaction()}});await f.waitFor('Stopping');assert.ok(f.seen.includes('Stopping'));
 }finally{await f.close(workers);}for(const w of workers){const result=await w.join();assert.equal(result.kind,'Returned');if(result.kind==='Returned')assert.equal(result.result.ok,true);}assert.equal(f.port.disposed,1);
});
it('pre-aborted startup takes no receivers and starts no shard reads',async()=>{
 const f=setup(),reason=new Error('already stopped');try{f.shutdown.abort(reason);await assert.rejects(startTypedIngressWorkers(f.gateway,f.shutdown.signal,f.notifier,f.options),e=>e===reason);assert.equal(f.port.polls,0);const receivers=f.gateway.takeIngressReceivers();for(const receiver of Object.values(receivers))receiver.dispose();}finally{await f.close();}
});
it('invalid callback refuses before receiver ownership transfer',async()=>{
 const f=setup();try{await assert.rejects(startTypedIngressWorkers(f.gateway,f.shutdown.signal,f.notifier,{...f.options,message:42 as never}),TypeError);assert.equal(f.port.polls,0);for(const receiver of Object.values(f.gateway.takeIngressReceivers()))receiver.dispose();}finally{await f.close();}
});
it('shutdown winning readiness aborts and joins consumers without activating shards',async()=>{
 const f=setup();try{const pending=startTypedIngressWorkers(f.gateway,f.shutdown.signal,f.notifier,f.options);queueMicrotask(()=>f.shutdown.abort(new Error('stop before activation')));await assert.rejects(pending,/stop before activation/);assert.equal(f.port.polls,0);}finally{await f.close();}
});
it('second start cannot retake receivers or disturb the first seven owners',async()=>{
 const f=setup();let workers:RuntimeMonitoredWorker[]=[];try{workers=await startTypedIngressWorkers(f.gateway,f.shutdown.signal,f.notifier,f.options);await assert.rejects(startTypedIngressWorkers(f.gateway,f.shutdown.signal,f.notifier,f.options),/already been taken/);f.port.push(ready());await f.waitFor('register');assert.ok(f.seen.includes('register'));}finally{await f.close(workers);}
});
it('history factory receives exact consumer-owned receiver and it is disposed on shutdown',async()=>{
 const f=setup();let owned:import('../../../src/discord/gateway/message-gaps.ts').MessageGapReceiver|undefined;let entered!:()=>void;const ran=new Promise<void>(r=>entered=r);let workers:RuntimeMonitoredWorker[]=[];
 try{workers=await startTypedIngressWorkers(f.gateway,f.shutdown.signal,f.notifier,{...f.options,history:gaps=>{owned=gaps;return {async recover(){assert.deepEqual(gaps.snapshot(),[]);entered();},async poll(){assert.fail();}};}});f.port.push(ready());await ran;assert.ok(owned);assert.deepEqual(owned.snapshot(),[]);}finally{await f.close(workers);}assert.throws(()=>owned!.snapshot(),/disposed/);
});
it('invalid history factory result is rejected before receiver take and shard activation',async()=>{
 const f=setup();try{await assert.rejects(startTypedIngressWorkers(f.gateway,f.shutdown.signal,f.notifier,{...f.options,history:()=>({recover:1,poll:2}) as never}),TypeError);assert.equal(f.port.polls,0);for(const receiver of Object.values(f.gateway.takeIngressReceivers()))receiver.dispose();}finally{await f.close();}
});
