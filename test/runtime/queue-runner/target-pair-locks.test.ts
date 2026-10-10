import assert from "node:assert/strict";
import {test} from "node:test";
import {TargetLocks} from "../../../src/runtime/queue-runner/target-locks.ts";
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
test("opposite pair requests serialize in deterministic order without AB/BA waiting cycle",async()=>{
  const locks=new TargetLocks(),events:string[]=[];let release!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;});
  const first=locks.runPair("b","a",async()=>{events.push("first");await wait;});
  const second=locks.runPair("a","b",()=>{events.push("second");});
  await tick();assert.deepEqual(events,["first"]);await locks.run("unrelated",()=>events.push("unrelated"));release();await Promise.all([first,second]);
  assert.deepEqual(events,["first","unrelated","second"]);assert.equal(locks.activeTargetCount,0);
});
test("self pair is acquired once, and thrown work always releases ownership",async()=>{
  const locks=new TargetLocks();await locks.runPair("same","same",()=>{assert.equal(locks.activeTargetCount,1);});
  const failure=new Error("work");await assert.rejects(()=>locks.runPair("a","b",()=>{throw failure;}),e=>e===failure);assert.equal(locks.activeTargetCount,0);
});
test("cancellation while second acquisition waits releases the first but not the foreign owner",async()=>{
  const locks=new TargetLocks(),foreign=await locks.acquire("b"),abort=new AbortController(),reason=new Error("cancelled");
  const pending=locks.runPair("a","b",()=>assert.fail("cancelled waiter must not execute"),abort.signal);await tick();abort.abort(reason);
  await assert.rejects(pending,e=>e===reason);assert.equal(locks.activeTargetCount,1);const first=locks.tryAcquire("a");assert.ok(first);assert.equal(locks.tryAcquire("b"),undefined);first.release();foreign.release();assert.equal(locks.activeTargetCount,0);
});
