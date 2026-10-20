import test from 'node:test';import assert from 'node:assert/strict';
import {promptFixture} from '../helpers/server-prompt-fixture.ts';
import {ServerRequestDelivery} from '../../src/runtime/server-request-delivery.ts';
import {runServerRequestWorker,ServerRequestRetrySchedule} from '../../src/runtime/server-request-worker.ts';
import {BoundedBroadcast} from '../../src/app-server/broadcast.ts';
import type {ResidentServerRequestEvent} from '../../src/app-server/resident-forwarders.ts';
import {DiscordTransportFault} from '../../src/discord/transport-fault.ts';
import {openInitialized} from '../../src/store/owned-driver.ts';
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};}
test('retry schedule preserves pending deadline and backs off 1/2/4/8/16/30 seconds then resets',()=>{
 const s=new ServerRequestRetrySchedule();assert.equal(s.deadline(),null);let at=10;for(const delay of [1000,2000,4000,8000,16000,30000,30000]){s.scheduleFailure(at);assert.equal(s.deadline(),at+delay);s.scheduleFailure(at+500);assert.equal(s.deadline(),at+delay);s.beginRetry();at+=40000;}s.clear();s.scheduleFailure(0);assert.equal(s.deadline(),1000);for(const x of [-1,Infinity,NaN,Number.MAX_SAFE_INTEGER])assert.throws(()=>s.scheduleFailure(x));
});
test('startup pending recovery uses the exact receiver, sends once and joins durable confirmation on stop',async()=>promptFixture(async(path,server,request)=>{
 const bus=new BoundedBroadcast<ResidentServerRequestEvent>(8),receiver=bus.subscribe(),stop=new AbortController();let sends=0;
 bus.send(Object.freeze({kind:'Request',generation:1n,request}));const delivery=new ServerRequestDelivery(path,server,{sendValidated:async()=>{sends++;stop.abort('done');return 81n;}});
 await runServerRequestWorker(receiver,server,delivery,stop.signal,()=>{});assert.equal(sends,1);assert.equal(bus.receiverCount,0);assert.equal(bus.pendingWaiters,0);
 await delivery.recover();assert.equal(sends,1);const db=await openInitialized(path);try{assert.equal(db.prepare('SELECT message_id FROM codex_delivery_receipts').get()!.message_id,'81');}finally{db.close();}
}));
test('authoritative HTTP rejection retries after deadline while one pending receive is retained',async()=>promptFixture(async(path,server)=>{
 const bus=new BoundedBroadcast<ResidentServerRequestEvent>(8),receiver=bus.subscribe(),stop=new AbortController();let sends=0,errors=0;const at=performance.now();
 const delivery=new ServerRequestDelivery(path,server,{sendValidated:async()=>{sends++;if(sends===1)throw new DiscordTransportFault('Response','fixture rejected',429);stop.abort('done');return 82n;}});
 await runServerRequestWorker(receiver,server,delivery,stop.signal,()=>{errors++;});assert.equal(sends,2);assert.equal(errors,1);assert.ok(performance.now()-at>=1000);assert.equal(bus.pendingWaiters,0);assert.equal(bus.receiverCount,0);
}));
test('uncertain transport acceptance retries reconciliation without repeating the HTTP send',async()=>promptFixture(async(path,server)=>{
 const bus=new BoundedBroadcast<ResidentServerRequestEvent>(8),stop=new AbortController();let sends=0,errors=0;
 const delivery=new ServerRequestDelivery(path,server,{sendValidated:async()=>{sends++;throw new DiscordTransportFault('Transport','acceptance unknown');}});
 await runServerRequestWorker(bus.subscribe(),server,delivery,stop.signal,()=>{if(++errors===2)stop.abort('done');});assert.equal(errors,2);assert.equal(sends,1);assert.equal(bus.receiverCount,0);
}));
test('lag and explicit gap reconcile pending requests without resending confirmed receipt',async()=>promptFixture(async(path,server,request)=>{
 const bus=new BoundedBroadcast<ResidentServerRequestEvent>(1),stop=new AbortController(),receiver=bus.subscribe();let sends=0;const gaps:bigint[]=[];
 bus.send(Object.freeze({kind:'Request',generation:1n,request}));bus.send(Object.freeze({kind:'Gap',generation:1n,skipped:7n}));
 const delivery=new ServerRequestDelivery(path,server,{sendValidated:async()=>{sends++;return 83n;}});
 await runServerRequestWorker(receiver,server,delivery,stop.signal,e=>{if(e.kind==='Gap'){gaps.push(e.skipped);if(gaps.length===2)stop.abort('done');}});assert.deepEqual(gaps,[1n,7n]);assert.equal(sends,1);assert.equal(bus.receiverCount,0);
}));
test('worker holds exclusive delivery ownership through in-flight shutdown and releases only after receipt join',async()=>promptFixture(async(path,server,request)=>{
 const bus=new BoundedBroadcast<ResidentServerRequestEvent>(8),stop=new AbortController(),entered=deferred(),release=deferred();let ended=false;
 const delivery=new ServerRequestDelivery(path,server,{sendValidated:async()=>{entered.resolve();await release.promise;return 84n;}}),running=runServerRequestWorker(bus.subscribe(),server,delivery,stop.signal,()=>{}).finally(()=>{ended=true;});
 try{await entered.promise;stop.abort('done');await assert.rejects(delivery.recover(),/already owned/);await assert.rejects(delivery.process(1n,request),/already owned/);assert.throws(()=>delivery.claimWorker(server),/already owned/);await new Promise(r=>setImmediate(r));assert.equal(ended,false);assert.equal(bus.receiverCount,1);}finally{release.resolve();await running;}
 assert.equal(bus.receiverCount,0);await delivery.recover();
}));
test('pre-aborted worker disposes startup receiver without transport and refuses receiver reuse',async()=>promptFixture(async(path,server)=>{
 const bus=new BoundedBroadcast<ResidentServerRequestEvent>(8),receiver=bus.subscribe(),stop=new AbortController();stop.abort('done');let sends=0;const delivery=new ServerRequestDelivery(path,server,{sendValidated:async()=>{sends++;return 85n;}});
 await runServerRequestWorker(receiver,server,delivery,stop.signal,()=>{});assert.equal(sends,0);assert.equal(bus.receiverCount,0);await assert.rejects(runServerRequestWorker(receiver,server,delivery,stop.signal,()=>{}),/already consumed/);const owner=delivery.claimWorker(server);owner.dispose();assert.throws(()=>owner.recover(),/released/);
}));
test('diagnostic failure closes owned receiver and releases delivery ownership without hiding exact error',async()=>promptFixture(async(path,server)=>{
 const bus=new BoundedBroadcast<ResidentServerRequestEvent>(8),stop=new AbortController(),sentinel=new Error('diagnostic fixture');let sends=0;const delivery=new ServerRequestDelivery(path,server,{sendValidated:async()=>{sends++;throw new DiscordTransportFault('Response','fixture',429);}});
 await assert.rejects(runServerRequestWorker(bus.subscribe(),server,delivery,stop.signal,()=>{throw sentinel;}),e=>e===sentinel);assert.equal(bus.receiverCount,0);assert.equal(sends,1);delivery.claimWorker(server).dispose();
}));
test('buffered stale generation reports error without replacing subscription or duplicating confirmed pending prompt',async()=>promptFixture(async(path,server,request)=>{
 const bus=new BoundedBroadcast<ResidentServerRequestEvent>(8),receiver=bus.subscribe(),stop=new AbortController();let sends=0,errors=0;bus.send(Object.freeze({kind:'Request',generation:2n,request}));
 const delivery=new ServerRequestDelivery(path,server,{sendValidated:async()=>{sends++;return 86n;}});
 await runServerRequestWorker(receiver,server,delivery,stop.signal,e=>{assert.equal(e.kind,'Error');if(e.kind==='Error')assert.match(String(e.error),/generation changed/);errors++;stop.abort('done');});assert.equal(sends,1);assert.equal(errors,1);assert.equal(bus.receiverCount,0);
}));
test('event resolving in the losing receive while retry runs is retained and processed afterwards',async()=>promptFixture(async(path,server,request)=>{
 const bus=new BoundedBroadcast<ResidentServerRequestEvent>(8),stop=new AbortController();let sends=0,errors=0;
 const delivery=new ServerRequestDelivery(path,server,{sendValidated:async()=>{sends++;if(sends===1)throw new DiscordTransportFault('Response','fixture',429);bus.send(Object.freeze({kind:'Request',generation:2n,request}));await new Promise(r=>setImmediate(r));return 87n;}});
 await runServerRequestWorker(bus.subscribe(),server,delivery,stop.signal,e=>{assert.equal(e.kind,'Error');if(++errors===2){if(e.kind==='Error')assert.match(String(e.error),/generation changed/);stop.abort('done');}});assert.equal(sends,2);assert.equal(errors,2);assert.equal(bus.receiverCount,0);assert.equal(bus.pendingWaiters,0);
}));
