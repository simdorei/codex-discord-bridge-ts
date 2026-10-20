import assert from "node:assert/strict";
import { test } from "node:test";
import { TargetLocks, TargetLeaseMismatchError } from "../../../src/runtime/queue-runner/target-locks.ts";

test("same target is FIFO and tryAcquire cannot bypass waiting work", async () => {
  const locks = new TargetLocks(); const owner = locks.tryAcquire("t")!;
  const order: number[] = [];
  const a = locks.run("t", () => { order.push(1); });
  const b = locks.run("t", () => { order.push(2); });
  await Promise.resolve(); assert.deepEqual(order, []);
  assert.equal(locks.tryAcquire("t"), undefined);
  owner.release();
  assert.equal(locks.tryAcquire("t"), undefined);
  await Promise.all([a, b]);
  assert.deepEqual(order, [1, 2]); assert.equal(locks.activeTargetCount, 0);
});

test("unrelated targets run while one target is held", async () => {
  const locks = new TargetLocks(); const owner = locks.tryAcquire("blocked")!;
  let blockedRan = false;
  const pending = locks.run("blocked", () => { blockedRan = true; });
  assert.equal(await locks.run("other", () => 42), 42);
  assert.equal(blockedRan, false); owner.release(); await pending;
  assert.equal(blockedRan, true); assert.equal(locks.activeTargetCount, 0);
});

test("pruning historical targets never replaces an active owner or waiter", async () => {
  const locks = new TargetLocks(); const owner = locks.tryAcquire("active")!;
  const waiting = locks.acquire("active");
  for (let i = 0; i < 1000; i++) locks.tryAcquire(`finished-${i}`)!.release();
  assert.equal(locks.activeTargetCount, 1);
  assert.equal(locks.tryAcquire("active"), undefined);
  owner.release(); const next = await waiting;
  owner.release(); // A stale release must not unlock the new owner.
  assert.equal(locks.tryAcquire("active"), undefined);
  next.release(); assert.equal(locks.activeTargetCount, 0);
});

test("queued cancellation preserves owner and remaining FIFO waiters", async () => {
  const locks = new TargetLocks(); const owner = locks.tryAcquire("t")!;
  const cancellation = new AbortController(); const reason = new Error("cancelled");
  const cancelled = locks.acquire("t", cancellation.signal);
  const rejection = assert.rejects(cancelled, error => error === reason);
  const pending = locks.acquire("t"); cancellation.abort(reason); await rejection;
  assert.equal(locks.tryAcquire("t"), undefined);
  owner.release(); const next = await pending;
  assert.equal(locks.tryAcquire("t"), undefined); next.release();
  assert.equal(locks.activeTargetCount, 0);
});

test("already-cancelled acquisition does not allocate a lock or run work", async () => {
  const locks = new TargetLocks(); const control = new AbortController(); control.abort();
  await assert.rejects(locks.run("t", () => assert.fail("must not run"), control.signal));
  assert.equal(locks.activeTargetCount, 0);
});

test("cancellation after grant does not release the owner's lease", async () => {
  const locks = new TargetLocks(); const control = new AbortController();
  const first = locks.tryAcquire("t")!; const promise = locks.acquire("t", control.signal);
  first.release(); control.abort(); const second = await promise;
  assert.equal(locks.tryAcquire("t"), undefined); second.release();
  assert.equal(locks.activeTargetCount, 0);
});

test("synchronous and asynchronous failures release ownership and preserve error identity", async () => {
  const locks = new TargetLocks(); const error = new Error("sentinel");
  await assert.rejects(locks.run("t", () => { throw error; }), value => value === error);
  await assert.rejects(locks.run("t", async () => { throw error; }), value => value === error);
  assert.equal(await locks.run("t", () => "ready"), "ready");
  assert.equal(locks.activeTargetCount, 0);
});

test("lease checks exact target and rejects use after release", () => {
  const locks = new TargetLocks(); const lease = locks.tryAcquire("Target")!;
  lease.requireTarget("Target");
  assert.throws(() => lease.requireTarget("target"), TargetLeaseMismatchError);
  lease.release();
  assert.throws(() => lease.requireTarget("Target"), TargetLeaseMismatchError);
  assert.equal(locks.activeTargetCount, 0);
});

test("empty and astral keys are valid, malformed text rejected", () => {
  const locks = new TargetLocks();
  for (const target of ["", "🌟"]) locks.tryAcquire(target)!.release();
  for (const target of ["\ud800", "\udfff", null, 1])
    assert.throws(() => locks.tryAcquire(target as string), TypeError);
  assert.equal(locks.activeTargetCount, 0);
});
