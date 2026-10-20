import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import {capturePromptAuthorityReads, createNativePromptAuthorityReads, type PromptAuthorityReads} from '../../src/runtime/server-prompt-authority-reads.ts';
import {verifyPromptAuthority, PromptAuthorityError} from '../../src/runtime/server-prompt-authority.ts';
import {OwnedWorkerSlot, OwnedWorkerBudgetError, ownedWorkerUsage} from '../../src/runtime/owned-worker-slot.ts';
import {NativeStoreReadError} from '../../src/runtime/native-store-read-diagnostic.ts';
import {StateAccessFacade as state} from '../../src/store/state-access-facade.ts';
import {queueJob} from '../helpers/queue-job.ts';
import {storeFixture} from '../helpers/store-fixture.ts';
import {promptFixture, editPromptFixture} from '../helpers/server-prompt-fixture.ts';
const key = (url: URL, q: any): string | undefined => String(url).endsWith('/control-evidence-native-worker.ts') ? 'Completed' : String(url).endsWith('/native-read-state-worker.ts') && q.operation === 'List' ? 'Jobs' : String(url).endsWith('/native-state-worker.ts') && q.operation === 'MirrorTarget' ? 'Mapping' : undefined;
test('passive prompt reads capture own functions, reject accessors/proxies/thenables, bind path, and preserve errors', async () => {
  let invoked = 0;
  const original = {hasObservedCompletion: async () => false, listQueueJobs: async () => [], mirroredThreadId: async () => {invoked++; return 't';}};
  const reads = capturePromptAuthorityReads('/original', original);
  original.mirroredThreadId = async () => 'replaced';
  assert.ok(Object.isFrozen(reads)); assert.equal(await reads.mirroredThreadId('/original', 1n), 't'); assert.equal(invoked, 1);
  assert.throws(() => reads.mirroredThreadId('/other', 1n), TypeError); assert.equal(invoked, 1);
  const accessor = {...original}; Object.defineProperty(accessor, 'listQueueJobs', {get() {assert.fail('getter invoked');}});
  assert.throws(() => capturePromptAuthorityReads('/original', accessor), TypeError);
  assert.throws(() => capturePromptAuthorityReads('/original', new Proxy(original, {})), TypeError);
  assert.throws(() => capturePromptAuthorityReads('/original', {...original, listQueueJobs: new Proxy(original.listQueueJobs, {})}), TypeError);
  assert.throws(() => capturePromptAuthorityReads('/original', {...original, listQueueJobs: (function* () {}) as any}), TypeError);
  const thenable = capturePromptAuthorityReads('/original', {...original, listQueueJobs: (() => ({then() {assert.fail('then invoked');}})) as any});
  assert.throws(() => thenable.listQueueJobs('/original'), TypeError);
  const failure = Error('original passive failure'), failed = capturePromptAuthorityReads('/original', {...original, listQueueJobs: async () => {throw failure;}});
  await assert.rejects(failed.listQueueJobs('/original'), e => e === failure);
});
test('native prompt authority uses three fresh sequential existing adapters and unfiltered source queue decoding', async t => {
  const calls: string[] = [], run = OwnedWorkerSlot.prototype.run;
  t.mock.method(OwnedWorkerSlot.prototype, 'run', function(this: OwnedWorkerSlot, ...args: Parameters<typeof run>) {const op = key(args[0], args[1]); if (op !== undefined) {calls.push(op); if (op === 'Jobs') assert.deepEqual(args[1], {path: (args[1] as any).path, operation: 'List', target: null, generation: null});} return run.apply(this, args);});
  await promptFixture(async (path, server, request) => {
    const reads = createNativePromptAuthorityReads(path);
    for (const name of ['hasObservedCompletion', 'listQueueJobs', 'listFiltered', 'mirroredThreadId'] as const) t.mock.method(state, name, () => assert.fail(`synchronous ${name}`));
    (await verifyPromptAuthority(path, server, request, 1n, reads)).requireActor(1n, 2n);
    assert.deepEqual(calls, ['Completed', 'Jobs', 'Mapping']);
    await editPromptFixture(path, "UPDATE mirror_threads SET codex_thread_id='other'");
    await assert.rejects(verifyPromptAuthority(path, server, request, 1n, reads), /mapping changed/);
    assert.deepEqual(calls, ['Completed', 'Jobs', 'Mapping', 'Completed', 'Jobs', 'Mapping']);
    assert.throws(() => reads.listQueueJobs(path + '.other'), TypeError); assert.equal(ownedWorkerUsage().Control, 0);
  });
});
test('native unfiltered authority keeps malformed unrelated rows as native errors rather than an empty owner', async () => promptFixture(async (path, server, request) => {
  await state.enqueue(path, queueJob({jobId: 'unrelated', targetThreadId: 'unrelated'}));
  await editPromptFixture(path, "UPDATE codex_turn_queue SET channel_id=1.5 WHERE job_id='unrelated'");
  await assert.rejects(verifyPromptAuthority(path, server, request, 1n, createNativePromptAuthorityReads(path)), e => e instanceof NativeStoreReadError && e.diagnostic.kind==='Integrity' && !(e instanceof PromptAuthorityError));
}));
test('native missing databases and catalogs are not created, initialized, repaired or interpreted as empty authority', async () => storeFixture(async path => {
  const reads = createNativePromptAuthorityReads(path);
  for (const exists of [false, true]) {
    if (exists) new DatabaseSync(path).close();
    await assert.rejects(reads.hasObservedCompletion(path, 't', 'v'), NativeStoreReadError);
    await assert.rejects(reads.listQueueJobs(path), NativeStoreReadError);
    await assert.rejects(reads.mirroredThreadId(path, 1n), NativeStoreReadError);
    assert.equal(existsSync(path), exists);
    if (exists) {const db = new DatabaseSync(path); try {assert.deepEqual(db.prepare('SELECT name FROM sqlite_master').all(), []);} finally {db.close();}}
  }
}));
test('passive verifier short circuits and preserves separate-read observation order without refreshing original request', async () => promptFixture(async (path, server, request) => {
  const calls: string[] = [], native = createNativePromptAuthorityReads(path);
  let completed!: (value: boolean) => void;
  const held = new Promise<boolean>(resolve => {completed = resolve;}), input = {...request};
  const reads: PromptAuthorityReads = {hasObservedCompletion: async () => {calls.push('Completed'); return held;}, listQueueJobs: async p => {calls.push('Jobs'); return native.listQueueJobs(p);}, mirroredThreadId: async (p, c) => {calls.push('Mapping'); return native.mirroredThreadId(p, c);}};
  const pending = verifyPromptAuthority(path, server, input, 1n, reads); input.params = {threadId: 'changed', turnId: 'changed'};
  assert.deepEqual(calls, ['Completed']); completed(false); (await pending).requireActor(1n, 2n); assert.deepEqual(calls, ['Completed', 'Jobs', 'Mapping']);
  calls.length = 0; await assert.rejects(verifyPromptAuthority(path, server, request, 1n, {...reads, hasObservedCompletion: async () => true}), /no longer active/); assert.deepEqual(calls, []);
}));
test('Control saturation rejects a prompt read without queueing and no fallback is attempted', async () => promptFixture(async (path, server, request) => {
  const db = new DatabaseSync(path); db.exec('BEGIN EXCLUSIVE'); const reads = createNativePromptAuthorityReads(path), pending = reads.hasObservedCompletion(path, 't', 'v');
  try {await assert.rejects(verifyPromptAuthority(path, server, request, 1n, createNativePromptAuthorityReads(path)), OwnedWorkerBudgetError); assert.equal(ownedWorkerUsage().Control, 1); db.exec('ROLLBACK'); assert.equal(await pending, false); assert.equal(ownedWorkerUsage().Control, 0);} finally {if (db.isTransaction) db.exec('ROLLBACK'); await pending.catch(() => {}); db.close();}
}));
