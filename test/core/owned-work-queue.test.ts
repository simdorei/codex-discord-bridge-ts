import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setImmediate as tick} from 'node:timers/promises';
import {createOwnedWorkQueue, isOwnedWorkSender, type OwnedWorkSender} from '../../src/core/owned-work-queue.ts';
import {AdmissionGate, AdmissionPermit, DrainFenceKey} from '../../src/admission/drain-gate.ts';
function reserve<T>(sender: OwnedWorkSender<T>) {
  const result = sender.tryReserve(); assert.equal(result.kind, 'Reserved');
  if (result.kind !== 'Reserved') throw new Error('fixture');
  return result.reservation;
}
test('runtime capacity 64 counts queued items and outstanding reservations together', () => {
  const q = createOwnedWorkQueue<number>(64, () => {});
  const held = Array.from({length: 64}, () => reserve(q.sender));
  assert.deepEqual(q.sender.tryReserve(), {kind: 'Full'});
  held[0]!.send(1); assert.deepEqual(q.sender.tryReserve(), {kind: 'Full'});
  assert.deepEqual(q.receiver.tryReceive(), {kind: 'Value', value: 1});
  const replacement = reserve(q.sender); replacement.release();
  for (const p of held) p.release();
  assert.equal(q.snapshot().reserved, 0); q.receiver.dispose(); q.sender.dispose();
});
test('reservation owns space but FIFO ordering follows actual send order', () => {
  const q = createOwnedWorkQueue<string>(2, () => {}), first = reserve(q.sender), second = reserve(q.sender);
  assert.deepEqual(q.receiver.tryReceive(), {kind: 'Empty'});
  second.send('second'); first.send('first');
  assert.deepEqual(q.receiver.tryReceive(), {kind: 'Value', value: 'second'});
  assert.deepEqual(q.receiver.tryReceive(), {kind: 'Value', value: 'first'});
  q.sender.dispose(); assert.deepEqual(q.receiver.tryReceive(), {kind: 'Closed'});
});
test('release and send consume a reservation exactly once without capacity inflation', () => {
  const q = createOwnedWorkQueue<number>(1, () => {}), p = reserve(q.sender);
  assert.equal(p.release(), true); assert.equal(p.release(), false);
  assert.throws(() => p.send(1), /already consumed/);
  const next = reserve(q.sender); next.send(2); assert.equal(next.release(), false);
  assert.throws(() => next.send(3), /already consumed/);
  assert.deepEqual(q.sender.tryReserve(), {kind: 'Full'}); q.receiver.dispose(); q.sender.dispose();
});
test('graceful close rejects new reservations but accepts and drains previously reserved sends', async () => {
  const q = createOwnedWorkQueue<number>(2, () => {}), first = reserve(q.sender), second = reserve(q.sender);
  q.receiver.close(); assert.deepEqual(q.sender.tryReserve(), {kind: 'Closed'});
  assert.deepEqual(q.receiver.tryReceive(), {kind: 'Empty'});
  first.send(7); assert.deepEqual(await q.receiver.receive(), {kind: 'Value', value: 7});
  let ended = false; const pending = q.receiver.receive().then(value => {ended = true; return value;});
  await tick(); assert.equal(ended, false);
  second.release(); assert.deepEqual(await pending, {kind: 'Closed'}); q.sender.dispose();
});
test('last sender disposal waits for an outstanding reservation before end of stream', async () => {
  const q = createOwnedWorkQueue<number>(1, () => {}), permit = reserve(q.sender);
  q.sender.dispose();
  assert.deepEqual(q.receiver.tryReceive(), {kind: 'Empty'});
  const pending = q.receiver.receive(); permit.send(3);
  assert.deepEqual(await pending, {kind: 'Value', value: 3});
  assert.deepEqual(await q.receiver.receive(), {kind: 'Closed'});
  assert.throws(() => q.sender.clone(), /disposed/);
});
test('receiver disposal drops current values but late sends remain owned until all senders disappear', () => {
  const dropped: string[] = [], q = createOwnedWorkQueue<string>(2, value => {dropped.push(value);});
  const clone = q.sender.clone(), late = reserve(q.sender); reserve(q.sender).send('old');
  q.receiver.dispose(); assert.deepEqual(dropped, ['old']);
  late.send('late'); assert.deepEqual(dropped, ['old']);
  assert.deepEqual(q.receiver.tryReceive(), {kind: 'Closed'});
  q.sender.dispose(); assert.deepEqual(dropped, ['old']);
  clone.dispose(); assert.deepEqual(dropped, ['old', 'late']);
  assert.equal(q.snapshot().queued, 0);
});
test('late send drops immediately when its reservation is the final remaining sender owner', () => {
  const dropped: number[] = [], q = createOwnedWorkQueue<number>(1, value => {dropped.push(value);});
  const p = reserve(q.sender); q.sender.dispose(); q.receiver.dispose(); p.send(1);
  assert.deepEqual(dropped, [1]); assert.equal(q.snapshot().senders, 0); assert.equal(q.snapshot().reserved, 0);
});
test('cancelled pending read does not consume a same-turn ready item', async () => {
  const q = createOwnedWorkQueue<number>(1, () => {}), controller = new AbortController(), reason = new Error('cancel');
  const pending = q.receiver.receive(controller.signal), checked = assert.rejects(pending, e => e === reason);
  reserve(q.sender).send(1); controller.abort(reason); await checked;
  assert.deepEqual(q.receiver.tryReceive(), {kind: 'Value', value: 1});
  q.receiver.dispose(); q.sender.dispose();
});
test('single receiver borrowing rejects concurrent reads and clears ownership after close', async () => {
  const q = createOwnedWorkQueue<number>(1, () => {}), pending = q.receiver.receive();
  assert.throws(() => q.receiver.tryReceive(), /Concurrent/);
  await assert.rejects(q.receiver.receive(), /Concurrent/);
  q.receiver.close(); assert.deepEqual(await pending, {kind: 'Closed'});
  assert.deepEqual(q.receiver.tryReceive(), {kind: 'Closed'}); q.sender.dispose();
});
test('cleanup failure still disposes every queued value and releases all admission permits', () => {
  const gate = new AdmissionGate(), fence = DrainFenceKey.create('runtime', '1|2', 'queue'), failure = new Error('cleanup');
  const a = gate.tryEnter(), b = gate.tryEnter(); gate.seal(fence);
  const q = createOwnedWorkQueue<AdmissionPermit>(2, value => {value.release(); if (value === a) throw failure;});
  reserve(q.sender).send(a); reserve(q.sender).send(b);
  assert.throws(() => q.receiver.dispose(), e => e === failure);
  assert.equal(gate.isDrainedFor(fence), true); assert.equal(q.snapshot().queued, 0);
  q.receiver.dispose(); q.sender.dispose();
});
test('late abandoned item keeps its real admission permit until source channel ownership ends', () => {
  const gate = new AdmissionGate(), fence = DrainFenceKey.create('runtime', '1|2', 'late'), value = gate.tryEnter();
  gate.seal(fence);
  const q = createOwnedWorkQueue<AdmissionPermit>(1, value => {value.release();}), p = reserve(q.sender);
  q.receiver.dispose(); p.send(value);
  assert.equal(gate.isDrainedFor(fence), false);
  q.sender.dispose(); assert.equal(gate.isDrainedFor(fence), true);
});
test('receiving transfers the value; queue cleanup cannot release the consumer-owned permit', () => {
  const gate = new AdmissionGate(), fence = DrainFenceKey.create('runtime', '1|2', 'consumer'), value = gate.tryEnter();
  gate.seal(fence); const q = createOwnedWorkQueue<AdmissionPermit>(1, value => {value.release();});
  reserve(q.sender).send(value);
  const item = q.receiver.tryReceive(); assert.equal(item.kind, 'Value');
  q.receiver.dispose(); q.sender.dispose(); assert.equal(gate.isDrainedFor(fence), false);
  if (item.kind === 'Value') item.value.release();
  assert.equal(gate.isDrainedFor(fence), true);
});
test('null, undefined and false payloads are distinct from empty or closed polls', async () => {
  const q = createOwnedWorkQueue<unknown>(3, () => {});
  for (const value of [null, undefined, false]) reserve(q.sender).send(value);
  for (const value of [null, undefined, false]) assert.deepEqual(await q.receiver.receive(), {kind: 'Value', value});
  q.sender.dispose(); assert.deepEqual(await q.receiver.receive(), {kind: 'Closed'});
});
test('invalid capacity and active async/proxy disposers are refused before ownership exists', () => {
  for (const capacity of [0, -1, 1.5, Infinity]) assert.throws(() => createOwnedWorkQueue(capacity, () => {}), RangeError);
  let hooks = 0;
  assert.throws(() => createOwnedWorkQueue(1, async () => {}), TypeError);
  assert.throws(() => createOwnedWorkQueue(1, new Proxy(() => {}, {apply() {hooks++;}})), TypeError);
  assert.equal(hooks, 0);
});
test('promise-returning cleanup is rejected and drained without unhandled rejection', async () => {
  const q = createOwnedWorkQueue<number>(1, (() => Promise.reject(new Error('invalid async cleanup'))) as () => void);
  reserve(q.sender).send(1);
  assert.throws(() => q.receiver.dispose(), TypeError);
  q.sender.dispose(); await tick(); assert.equal(q.snapshot().queued, 0);
});
test('repeated transfer/release cycles preserve one sender and zero leaked reservations', () => {
  const q = createOwnedWorkQueue<number>(2, () => {});
  for (let i = 0; i < 5000; i++) {
    const p = reserve(q.sender); if (i % 2) p.release(); else {p.send(i); assert.deepEqual(q.receiver.tryReceive(), {kind: 'Value', value: i});}
  }
  assert.deepEqual(q.snapshot(), {capacity: 2, queued: 0, reserved: 0, senders: 1, receiverClosed: false, receiverDisposed: false});
  q.receiver.dispose(); q.sender.dispose();
});
test('only factory-produced sender handles pass passive ownership checks', () => {
  const q = createOwnedWorkQueue(1, () => {}); let calls = 0;
  assert.equal(isOwnedWorkSender(q.sender), true); assert.equal(isOwnedWorkSender({}), false);
  assert.equal(isOwnedWorkSender(new Proxy(q.sender, {get() {calls++; throw new Error('get');}})), false);
  assert.equal(calls, 0); q.receiver.dispose(); q.sender.dispose();
});
