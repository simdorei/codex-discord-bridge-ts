import assert from "node:assert/strict";
import {test} from "node:test";
import {BoundedBroadcast,BroadcastClosedError,BroadcastLaggedError} from "../../src/app-server/broadcast.ts";
import {ClientLifecycle} from "../../src/app-server/client-lifecycle.ts";
test("app-server capacities follow pinned Tokio power-of-two rounding",()=>{assert.equal(new BoundedBroadcast(1000).capacity,1024);assert.equal(new BoundedBroadcast(500).capacity,512);assert.equal(new BoundedBroadcast(3).capacity,4);assert.throws(()=>new BoundedBroadcast(0),RangeError);});
test("no receivers means send failure/no retention; later subscriber gets future values only",async()=>{
  const channel=new BoundedBroadcast<number>(2);assert.equal(channel.send(1),0);assert.equal(channel.retainedCount,0);const a=channel.subscribe();assert.deepEqual(a.tryReceive(),{kind:"Empty"});channel.send(2);const b=channel.subscribe();assert.equal(await a.receive(),2);assert.deepEqual(b.tryReceive(),{kind:"Empty"});channel.send(3);assert.equal(await a.receive(),3);assert.equal(await b.receive(),3);a.dispose();b.dispose();assert.equal(channel.retainedCount,0);
});
test("all current subscribers receive immutable data and last read releases its slot",async()=>{
  const channel=new BoundedBroadcast<object>(2),a=channel.subscribe(),b=channel.subscribe(),value=Object.freeze({n:1});assert.equal(channel.send(value),2);assert.equal(await a.receive(),value);assert.equal(channel.retainedCount,1);assert.equal(await b.receive(),value);assert.equal(channel.retainedCount,0);a.dispose();b.dispose();
});
test("lag is explicit and next receive resumes at oldest retained sequence",async()=>{
  const channel=new BoundedBroadcast<number>(2),a=channel.subscribe();channel.send(1);channel.send(2);channel.send(3);await assert.rejects(a.receive(),error=>error instanceof BroadcastLaggedError&&error.missed===1n);assert.equal(await a.receive(),2);assert.equal(await a.receive(),3);a.dispose();assert.equal(channel.retainedCount,0);
});
test("fast receiver does not steal a slow receiver's events",async()=>{
  const channel=new BoundedBroadcast<number>(2),fast=channel.subscribe(),slow=channel.subscribe();for(let n=0;n<5;n++){channel.send(n);assert.equal(await fast.receive(),n);}assert.deepEqual(slow.tryReceive(),{kind:"Lagged",missed:3n});assert.equal(await slow.receive(),3);assert.equal(await slow.receive(),4);fast.dispose();slow.dispose();assert.equal(channel.retainedCount,0);
});
test("dispose releases unread values and last receiver can be replaced while sender lives",async()=>{
  const channel=new BoundedBroadcast<number>(2),a=channel.subscribe(),b=channel.subscribe();channel.send(1);a.dispose();assert.equal(channel.receiverCount,1);assert.equal(channel.retainedCount,1);b.dispose();assert.equal(channel.retainedCount,0);assert.equal(channel.send(2),0);const c=channel.subscribe();channel.send(3);assert.equal(await c.receive(),3);c.dispose();
});
test("sender close drains buffered values before Closed and cannot be reopened",async()=>{
  const channel=new BoundedBroadcast<number>(2),a=channel.subscribe();channel.send(1);channel.close();assert.equal(await a.receive(),1);await assert.rejects(a.receive(),BroadcastClosedError);assert.throws(()=>channel.send(2),BroadcastClosedError);assert.throws(()=>channel.subscribe(),BroadcastClosedError);a.dispose();
});
test("canceling a blocked receive removes waiter without consuming future value",async()=>{
  const channel=new BoundedBroadcast<number>(2),a=channel.subscribe(),abort=new AbortController(),reason={},pending=a.receive(abort.signal),rejected=assert.rejects(pending,error=>error===reason);assert.equal(channel.pendingWaiters,1);abort.abort(reason);await rejected;assert.equal(channel.pendingWaiters,0);channel.send(7);assert.equal(await a.receive(),7);a.dispose();
});
test("close/dispose wake blocked readers and concurrent receive is rejected",async()=>{
  for(const action of ["close","dispose"]){const channel=new BoundedBroadcast<number>(2),a=channel.subscribe(),pending=a.receive(),rejected=assert.rejects(pending,BroadcastClosedError);await assert.rejects(a.receive(),/Concurrent/);assert.throws(()=>a.tryReceive(),/Concurrent/);if(action==="close")channel.close();else a.dispose();await rejected;assert.equal(channel.pendingWaiters,0);a.dispose();}
});
test("send under lifecycle gate schedules consumers only after gate exits",async()=>{
  const channel=new BoundedBroadcast<number>(2),a=channel.subscribe(),gate=new ClientLifecycle();let observed=false;const receive=a.receive().then(value=>{const permit=gate.admit();permit.release();observed=true;return value;});gate.withOpen(()=>{channel.send(42);assert.equal(observed,false);});assert.equal(await receive,42);assert.equal(gate.snapshot().poisoned,false);a.dispose();
});
test("mutable or proxy payloads cannot cross immutable broadcaster contract",()=>{
  const channel=new BoundedBroadcast<object>(2),a=channel.subscribe();let traps=0;assert.throws(()=>channel.send({n:1}),TypeError);assert.throws(()=>channel.send(new Proxy({}, {isExtensible(){traps++;return true;}})),TypeError);assert.equal(traps,0);assert.equal(channel.retainedCount,0);a.dispose();
});
test("deterministic subscribe/send/read/dispose schedules match independent per-receiver queues",()=>{
  for(const initial of [1,42,2026]){
    let seed=initial,nextId=0,sequence=0;const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed;};
    const channel=new BoundedBroadcast<Readonly<{sequence:number}>>(3),receivers=new Map<number,{actual:ReturnType<typeof channel.subscribe>;items:Readonly<{sequence:number}>[];missed:bigint}>();
    for(let step=0;step<1200;step++){
      const action=random()%10;
      if(action<5){const value=Object.freeze({sequence:sequence++});assert.equal(channel.send(value),receivers.size);for(const receiver of receivers.values()){receiver.items.push(value);if(receiver.items.length>channel.capacity){receiver.items.shift();receiver.missed++;}}}
      else if(action<7&&receivers.size<4){receivers.set(nextId++,{actual:channel.subscribe(),items:[],missed:0n});}
      else if(receivers.size!==0){const ids=[...receivers.keys()],id=ids[random()%ids.length]!,receiver=receivers.get(id)!;
        if(action===9){receiver.actual.dispose();receivers.delete(id);}
        else{const actual=receiver.actual.tryReceive();if(receiver.missed!==0n){assert.deepEqual(actual,{kind:"Lagged",missed:receiver.missed});receiver.missed=0n;}else if(receiver.items.length!==0)assert.deepEqual(actual,{kind:"Value",value:receiver.items.shift()});else assert.deepEqual(actual,{kind:"Empty"});}
      }
      const pending=new Set([...receivers.values()].flatMap(receiver=>receiver.items.map(value=>value.sequence)));assert.equal(channel.retainedCount,pending.size);assert.equal(channel.receiverCount,receivers.size);
    }
    for(const receiver of receivers.values())receiver.actual.dispose();assert.equal(channel.retainedCount,0);assert.equal(channel.receiverCount,0);
  }
});
