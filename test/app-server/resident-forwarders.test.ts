import assert from "node:assert/strict";
import {test} from "node:test";
import {BoundedBroadcast} from "../../src/app-server/broadcast.ts";
import {GenerationWatch} from "../../src/app-server/generation-watch.ts";
import {ClientLifecycle} from "../../src/app-server/client-lifecycle.ts";
import {ResidentForwarders,type ResidentNotificationEvent,type ResidentServerRequestEvent} from "../../src/app-server/resident-forwarders.ts";
import type {AppNotification} from "../../src/app-server/notification-state.ts";
import type {PendingServerRequest} from "../../src/app-server/server-request-state.ts";
import {ServerRequestOccurrence} from "../../src/protocol/ids.ts";
const notification=(method:string):AppNotification=>Object.freeze({method,params:Object.freeze({})});
const request=(id:string):PendingServerRequest=>Object.freeze({id,occurrence:Object.freeze(ServerRequestOccurrence.fromBytes(Buffer.alloc(16))) as ServerRequestOccurrence,method:"approval",params:Object.freeze({})});
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
function fixture(capacity=8){
  const notifications=new BoundedBroadcast<AppNotification>(capacity),requests=new BoundedBroadcast<PendingServerRequest>(capacity),notificationTarget=new BoundedBroadcast<ResidentNotificationEvent>(32),requestTarget=new BoundedBroadcast<ResidentServerRequestEvent>(32),watch=new GenerationWatch(1n),gate=new ClientLifecycle();let deaths=0;
  const nr=notificationTarget.subscribe(),rr=requestTarget.subscribe();
  const forwarders=new ResidentForwarders({subscribeNotifications:()=>notifications.subscribe(),subscribeServerRequests:()=>requests.subscribe()},1n,notificationTarget,requestTarget,watch.subscribe(),{waitClosed:signal=>gate.waitClosed(signal),onClosed(){deaths++;}});
  return {notifications,requests,notificationTarget,requestTarget,watch,gate,nr,rr,forwarders,get deaths(){return deaths;},close(){gate.seal();gate.publishClosed("fixture closed");}};
}
test("unactivated close and queued events never propagate; join releases every subscription",{timeout:3000},async()=>{
  const f=fixture();f.notifications.send(notification("queued"));f.requests.send(request("r"));f.close();await f.forwarders.join();assert.equal(f.deaths,0);assert.equal(f.nr.tryReceive().kind,"Empty");assert.equal(f.rr.tryReceive().kind,"Empty");assert.equal(f.notifications.receiverCount,0);assert.equal(f.requests.receiverCount,0);assert.equal(f.watch.receiverCount,0);assert.equal(f.gate.pendingCloseWaiters,0);f.forwarders.activate();await f.forwarders.join();assert.equal(f.deaths,0);f.nr.dispose();f.rr.dispose();
});
test("queued old events drain with original generation after replacement before activation",{timeout:3000},async()=>{
  const f=fixture();f.notifications.send(notification("old"));f.requests.send(request("old-request"));f.watch.replace(2n);f.forwarders.activate();await f.forwarders.join();const n=f.nr.tryReceive(),r=f.rr.tryReceive();assert.equal(n.kind,"Value");if(n.kind==="Value"){assert.equal(n.value.generation,1n);assert.equal(n.value.kind,"Notification");}assert.equal(r.kind,"Value");if(r.kind==="Value")assert.equal(r.value.generation,1n);assert.equal(f.nr.tryReceive().kind,"Empty");assert.equal(f.rr.tryReceive().kind,"Empty");assert.equal(f.deaths,0);f.nr.dispose();f.rr.dispose();
});
test("lag becomes an explicit gap followed by retained events in each stream",{timeout:3000},async()=>{
  const f=fixture(2);for(let i=0;i<5;i++){f.notifications.send(notification(String(i)));f.requests.send(request(String(i)));}f.watch.replace(0n);f.forwarders.activate();await f.forwarders.join();
  for(const receiver of [f.nr,f.rr]){const gap=receiver.tryReceive();assert.equal(gap.kind,"Value");if(gap.kind==="Value")assert.deepEqual(gap.value,{kind:"Gap",generation:1n,skipped:3n});assert.equal(receiver.tryReceive().kind,"Value");assert.equal(receiver.tryReceive().kind,"Value");assert.equal(receiver.tryReceive().kind,"Empty");receiver.dispose();}
});
test("activated delivery and death monitor are owned until generation change joins them",{timeout:3000},async t=>{
  const f=fixture();f.forwarders.activate();f.notifications.send(notification("live"));f.requests.send(request("live"));assert.equal((await f.nr.receive(t.signal)).kind,"Notification");assert.equal((await f.rr.receive(t.signal)).kind,"Request");f.close();await tick();assert.equal(f.deaths,1);f.watch.replace(0n);await f.forwarders.join();assert.equal(f.watch.pendingWaiters,0);assert.equal(f.gate.pendingCloseWaiters,0);assert.equal(f.notifications.pendingWaiters,0);f.nr.dispose();f.rr.dispose();
});
test("stale activated death monitor exits before old client closes",{timeout:3000},async()=>{
  const f=fixture();f.forwarders.activate();await tick();assert.equal(f.gate.pendingCloseWaiters,1);f.watch.replace(2n);await f.forwarders.join();assert.equal(f.gate.pendingCloseWaiters,0);f.close();await tick();assert.equal(f.deaths,0);f.nr.dispose();f.rr.dispose();
});
test("same-generation notification does not end forwarding or consume events",{timeout:3000},async t=>{
  const f=fixture();f.forwarders.activate();await tick();f.watch.replace(1n);await tick();f.notifications.send(notification("after-repeat"));const item=await f.nr.receive(t.signal);assert.equal(item.kind,"Notification");f.watch.close();await f.forwarders.join();assert.equal(f.watch.receiverCount,0);f.nr.dispose();f.rr.dispose();
});
test("co-ready source and generation changes neither lose nor duplicate an old event",{timeout:5000},async()=>{
  for(let i=0;i<40;i++){
    const f=fixture();f.forwarders.activate();await tick();if(i%2===0){f.notifications.send(notification(String(i)));f.watch.replace(0n);}else{f.watch.replace(0n);f.notifications.send(notification(String(i)));}await f.forwarders.join();const first=f.nr.tryReceive();assert.equal(first.kind,"Value");if(first.kind==="Value"){assert.equal(first.value.generation,1n);assert.equal(first.value.kind,"Notification");if(first.value.kind==="Notification")assert.equal(first.value.notification.method,String(i));}assert.equal(f.nr.tryReceive().kind,"Empty");assert.equal(f.notifications.pendingWaiters,0);f.nr.dispose();f.rr.dispose();
  }
});
test("target closure is ignored while owned input subscriptions still cleanly join",{timeout:3000},async()=>{
  const f=fixture();f.notificationTarget.close();f.requestTarget.close();f.notifications.send(notification("ignored"));f.requests.send(request("ignored"));f.watch.replace(0n);f.forwarders.activate();await f.forwarders.join();assert.equal(f.notifications.receiverCount,0);assert.equal(f.requests.receiverCount,0);f.nr.dispose();f.rr.dispose();
});
test("partial subscription acquisition failure releases already acquired ownership",()=>{
  const notifications=new BoundedBroadcast<AppNotification>(8),watch=new GenerationWatch(1n),sentinel={};assert.throws(()=>new ResidentForwarders({subscribeNotifications:()=>notifications.subscribe(),subscribeServerRequests(){throw sentinel;}},1n,new BoundedBroadcast(8),new BoundedBroadcast(8),watch.subscribe()),e=>e===sentinel);assert.equal(notifications.receiverCount,0);assert.equal(watch.receiverCount,0);
});
test("death monitor captures original callback identity before caller object mutation",{timeout:3000},async()=>{
  const ns=new BoundedBroadcast<AppNotification>(8),rs=new BoundedBroadcast<PendingServerRequest>(8),watch=new GenerationWatch(1n),gate=new ClientLifecycle();let original=0,replaced=0;
  const monitor={waitClosed:(signal:AbortSignal)=>gate.waitClosed(signal),onClosed(){original++;}};
  const forwarders=new ResidentForwarders({subscribeNotifications:()=>ns.subscribe(),subscribeServerRequests:()=>rs.subscribe()},1n,new BoundedBroadcast(8),new BoundedBroadcast(8),watch.subscribe(),monitor);
  monitor.onClosed=()=>{replaced++;};forwarders.activate();gate.seal();gate.publishClosed("closed");await tick();watch.replace(0n);await forwarders.join();assert.equal(original,1);assert.equal(replaced,0);
});
test("async death callbacks are refused before subscriptions or activation",{timeout:3000},async t=>{
  const ns=new BoundedBroadcast<AppNotification>(8),rs=new BoundedBroadcast<PendingServerRequest>(8),watch=new GenerationWatch(1n);let forwarders:ResidentForwarders|undefined,calls=0;t.after(async()=>{watch.replace(0n);await forwarders?.join();});
  assert.throws(()=>{forwarders=new ResidentForwarders({subscribeNotifications:()=>ns.subscribe(),subscribeServerRequests:()=>rs.subscribe()},1n,new BoundedBroadcast(8),new BoundedBroadcast(8),watch.subscribe(),{waitClosed:async()=>"closed",async onClosed(){calls++;}});},/synchronous/);assert.equal(calls,0);assert.equal(ns.receiverCount,0);assert.equal(rs.receiverCount,0);assert.equal(watch.receiverCount,0);
});
