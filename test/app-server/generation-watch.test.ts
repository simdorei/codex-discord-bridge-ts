import assert from "node:assert/strict";
import {test} from "node:test";
import {GenerationWatch,GenerationWatchClosedError} from "../../src/app-server/generation-watch.ts";
test("subscribe-before-read avoids lost lifecycle wakeup and same-value replacement still wakes",async()=>{
  const watch=new GenerationWatch(),receiver=watch.subscribe();assert.equal(receiver.borrow(),null);assert.equal(watch.replace(null),null);await receiver.changed();assert.equal(receiver.borrow(),null);receiver.dispose();assert.equal(watch.receiverCount,0);
});
test("watch coalesces to latest value and has independent seen cursors",async()=>{
  const watch=new GenerationWatch(),a=watch.subscribe(),b=watch.subscribe();watch.replace(1n);watch.replace(2n);await a.changed();assert.equal(a.borrow(),2n);await b.changed();assert.equal(b.borrow(),2n);
  const waiting=a.changed();assert.equal(watch.pendingWaiters,1);watch.replace(3n);await waiting;assert.equal(a.borrow(),3n);await b.changed();a.dispose();b.dispose();
});
test("borrow does not mark seen but borrowAndUpdate does",async()=>{
  const watch=new GenerationWatch(),r=watch.subscribe();watch.replace(1n);assert.equal(r.borrow(),1n);await r.changed();watch.replace(2n);assert.equal(r.borrowAndUpdate(),2n);const waiting=r.changed();assert.equal(watch.pendingWaiters,1);watch.replace(null);await waiting;r.dispose();
});
test("new subscriber starts at current version while clone preserves unseen value",async()=>{
  const watch=new GenerationWatch(),original=watch.subscribe();watch.replace(7n);const clone=original.clone(),fresh=watch.subscribe();await clone.changed();await original.changed();const waiting=fresh.changed();assert.equal(watch.pendingWaiters,1);watch.replace(8n);await waiting;original.dispose();clone.dispose();fresh.dispose();
});
test("unseen final value is observed once before sender-close error",async()=>{
  const watch=new GenerationWatch(),r=watch.subscribe();watch.replace(9n);watch.close();await r.changed();assert.equal(r.borrow(),9n);await assert.rejects(r.changed(),GenerationWatchClosedError);const clone=r.clone();assert.equal(clone.borrow(),9n);await assert.rejects(clone.changed(),GenerationWatchClosedError);r.dispose();clone.dispose();assert.throws(()=>watch.replace(10n),GenerationWatchClosedError);
});
test("cancelled change wait does not consume the next publication",async()=>{
  const watch=new GenerationWatch(),r=watch.subscribe(),abort=new AbortController(),reason={};const waiting=r.changed(abort.signal),rejected=assert.rejects(waiting,e=>e===reason);abort.abort(reason);watch.replace(5n);await rejected;assert.equal(watch.pendingWaiters,0);await r.changed();assert.equal(r.borrow(),5n);r.dispose();
});
test("disposal wakes pending receiver and does not disturb another receiver",async()=>{
  const watch=new GenerationWatch(),a=watch.subscribe(),b=watch.subscribe(),waiting=a.changed(),closed=assert.rejects(waiting,GenerationWatchClosedError);a.dispose();a.dispose();await closed;assert.equal(watch.receiverCount,1);watch.replace(4n);await b.changed();b.dispose();assert.equal(watch.pendingWaiters,0);
});
test("concurrent receiver operations fail without stealing the active waiter",async()=>{
  const watch=new GenerationWatch(),r=watch.subscribe(),waiting=r.changed();await assert.rejects(r.changed(),/Concurrent/);assert.throws(()=>r.borrowAndUpdate(),/Concurrent/);assert.throws(()=>r.clone(),/Concurrent/);watch.replace(2n);await waiting;r.dispose();
});
test("last value is retained with no receivers and optional u64 boundaries are strict",async()=>{
  const watch=new GenerationWatch();assert.equal(watch.replace((1n<<64n)-1n),null);const r=watch.subscribe();assert.equal(r.borrow(),(1n<<64n)-1n);assert.throws(()=>watch.replace(1n<<64n),TypeError);assert.throws(()=>watch.replace(-1n),TypeError);assert.throws(()=>watch.replace(1 as never),TypeError);watch.replace(0n);await r.changed();assert.equal(r.borrow(),0n);r.dispose();
});
