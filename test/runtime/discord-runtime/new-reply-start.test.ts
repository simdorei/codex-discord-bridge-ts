import test from 'node:test';import assert from 'node:assert/strict';
import {storeFixture} from '../../helpers/store-fixture.ts';import {httpFixture} from '../../helpers/interaction-worker-fixture.ts';import {newReply} from '../../helpers/delivery-custody.ts';
import {usingInitializedStore} from '../../../src/store/owned-scope.ts';import {getIn} from '../../../src/store/new-reply-read.ts';
import {startNewReplyRuntimeWorker,NewReplyWorkerError} from '../../../src/runtime/discord-runtime/new-reply-start.ts';
import {RuntimeWorkerExitChannel} from '../../../src/runtime/discord-runtime/monitored-worker.ts';import {QueueStartCoordinator} from '../../../src/runtime/queue-runner/start-coordinator.ts';import type {TickSource} from '../../../src/runtime/delayed-ticks.ts';
const flush=()=>new Promise<void>(r=>setImmediate(r));
class Ticks implements TickSource{wake:(()=>void)|undefined;closed=false;wait(){return new Promise<void>(r=>{this.wake=r;});}fire(){assert.ok(this.wake);const r=this.wake;this.wake=undefined;r();}close(){this.closed=true;this.wake?.();}}
function queue(path:string,notify:()=>void){return new QueueStartCoordinator(path,{generation:()=>1n,residentInstanceId:()=> 'fixture',activeTurnId:async()=>null,resumeThread:async()=>{},readTurns:async()=>[],startClaimedTurn:async()=>{throw new Error('Must not start turns');}},{notifyDeliveryReady:notify});}
async function settled(ticks:Ticks,worker:ReturnType<typeof startNewReplyRuntimeWorker>){const end=Date.now()+10000;while(ticks.wake===undefined&&worker.peek()===undefined){assert.ok(Date.now()<end,'worker did not reach next delayed tick');await flush();}}
test('immediate batch uses original queue DB and HTTP, wakes before/after, next tick does not duplicate receipt',async()=>storeFixture(path=>httpFixture(async(http,seen)=>{
 await newReply(path);await usingInitializedStore(path,d=>d.exec('UPDATE codex_new_first_replies SET ack_recovery_allowed=1,warning_due=0'));
 const ticks=new Ticks(),stop=new AbortController(),exits=new RuntimeWorkerExitChannel(),errors:unknown[]=[],wakeCounts:number[]=[];
 const worker=startNewReplyRuntimeWorker(queue(path,()=>{wakeCounts.push(seen.length);}),http,stop.signal,exits,e=>{errors.push(e);},()=>ticks);
 try{await settled(ticks,worker);assert.deepEqual(seen,['POST']);assert.deepEqual(wakeCounts,[0,1]);assert.equal(await usingInitializedStore(path,d=>getIn(d,'job')!.confirmationDelivered),true);ticks.fire();await settled(ticks,worker);assert.deepEqual(seen,['POST']);assert.deepEqual(wakeCounts,[0,1]);assert.deepEqual(errors,[]);}
 finally{stop.abort();await worker.join();exits.close();}assert.equal(ticks.closed,true);assert.deepEqual(await worker.join(),{kind:'Returned',result:{ok:true}});
})));
test('native verification error reports once per serial tick, worker remains alive without sending',async()=>storeFixture(path=>httpFixture(async(http,seen)=>{
 await newReply(path);await usingInitializedStore(path,d=>d.exec("UPDATE codex_new_first_replies SET scan_json='broken'"));
 const ticks=new Ticks(),stop=new AbortController(),exits=new RuntimeWorkerExitChannel(),errors:unknown[]=[];const worker=startNewReplyRuntimeWorker(queue(path,()=>{}),http,stop.signal,exits,e=>{errors.push(e);},()=>ticks);
 try{await settled(ticks,worker);assert.equal(errors.length,1);assert.ok(errors[0] instanceof NewReplyWorkerError);ticks.fire();await settled(ticks,worker);assert.equal(errors.length,2);assert.deepEqual(seen,[]);assert.equal(worker.peek(),undefined);}finally{stop.abort();await worker.join();exits.close();}
})));
test('pre-entry force and already stopped shutdown allocate no scheduler or native work',async()=>storeFixture(path=>httpFixture(async(http,seen)=>{
 let allocated=0;const exits=new RuntimeWorkerExitChannel(),stop=new AbortController(),q=queue(path,()=>{}),factory=()=>{allocated++;return new Ticks();};const a=startNewReplyRuntimeWorker(q,http,stop.signal,exits,()=>{},factory);a.abort();await a.join();stop.abort();const b=startNewReplyRuntimeWorker(q,http,stop.signal,exits,()=>{},factory);await b.join();exits.close();assert.equal(allocated,0);assert.deepEqual(seen,[]);
})));
test('forged queue private brand fails before inherited getter can substitute database',async()=>httpFixture(async http=>{
 let reads=0;const fake=Object.create(QueueStartCoordinator.prototype);Object.defineProperty(fake,'dbPath',{get(){reads++;return '/wrong';}});const exits=new RuntimeWorkerExitChannel();try{assert.throws(()=>startNewReplyRuntimeWorker(fake,http,new AbortController().signal,exits,()=>{}),TypeError);assert.equal(reads,0);}finally{exits.close();}
}));
test('shutdown during accepted HTTP joins cancellation and leaves unknown original receipt without retransmission',async()=>{
 const {createServer}=await import('node:http'),{DiscordChannelClient}=await import('../../../src/discord/channel-client.ts');
 let enter!:()=>void;const entered=new Promise<void>(r=>enter=r);let posts=0;const server=createServer((req,_res)=>{req.resume();req.on('end',()=>{posts++;enter();});});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const http=await DiscordChannelClient.create({token:null,testOrigin:`http://127.0.0.1:${(server.address() as {port:number}).port}/api/v10/`,report:()=>{}});
 try{await storeFixture(async path=>{await newReply(path);await usingInitializedStore(path,d=>d.exec('UPDATE codex_new_first_replies SET ack_recovery_allowed=1,warning_due=0'));
  const stop=new AbortController(),exits=new RuntimeWorkerExitChannel(),ticks=new Ticks(),q=queue(path,()=>{}),worker=startNewReplyRuntimeWorker(q,http,stop.signal,exits,()=>{},()=>ticks);
  try{await entered;assert.equal(posts,1);stop.abort();await worker.join();assert.equal(http.activeRequests,0);assert.equal(await usingInitializedStore(path,d=>getIn(d,'job')!.confirmationDelivered),false);
   const nextStop=new AbortController(),nextTicks=new Ticks(),next=startNewReplyRuntimeWorker(q,http,nextStop.signal,exits,()=>{},()=>nextTicks);try{await settled(nextTicks,next);assert.equal(posts,1);}finally{nextStop.abort();await next.join();}
  }finally{stop.abort();await worker.join();exits.close();}
 });}finally{await http.close();server.closeAllConnections();await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));}
});

test('five-second recovery deadline waits for real cancellation then retains unknown receipt',async()=>{
 const {createServer}=await import('node:http'),{DiscordChannelClient}=await import('../../../src/discord/channel-client.ts');
 let enter!:()=>void;const entered=new Promise<void>(r=>enter=r);let posts=0;const server=createServer((req,_res)=>{req.resume();req.on('end',()=>{posts++;enter();});});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const http=await DiscordChannelClient.create({token:null,testOrigin:`http://127.0.0.1:${(server.address() as {port:number}).port}/api/v10/`,report:()=>{}});
 try{await storeFixture(async path=>{await newReply(path);await usingInitializedStore(path,d=>d.exec('UPDATE codex_new_first_replies SET ack_recovery_allowed=1,warning_due=0'));
  const stop=new AbortController(),exits=new RuntimeWorkerExitChannel(),ticks=new Ticks(),q=queue(path,()=>{}),errors:unknown[]=[],worker=startNewReplyRuntimeWorker(q,http,stop.signal,exits,e=>{errors.push(e);},()=>ticks);
  try{await entered;assert.equal(posts,1);await settled(ticks,worker);assert.equal(errors.length,1);assert.ok(errors[0] instanceof NewReplyWorkerError);assert.equal((errors[0] as NewReplyWorkerError).phase,'recovery');stop.abort();await worker.join();assert.equal(http.activeRequests,0);assert.equal(await usingInitializedStore(path,d=>getIn(d,'job')!.confirmationDelivered),false);
   const nextStop=new AbortController(),nextTicks=new Ticks(),next=startNewReplyRuntimeWorker(q,http,nextStop.signal,exits,()=>{},()=>nextTicks);try{await settled(nextTicks,next);assert.equal(posts,1);}finally{nextStop.abort();await next.join();}
  }finally{stop.abort();await worker.join();exits.close();}
 });}finally{await http.close();server.closeAllConnections();await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));}
});
