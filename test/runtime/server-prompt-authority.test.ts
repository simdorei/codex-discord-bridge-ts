import {promptFixture as fixture, callPromptFixture as call, editPromptFixture as edit} from '../helpers/server-prompt-fixture.ts';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {existsSync} from 'node:fs';
import {queueJob} from '../helpers/queue-job.ts';
import {StateAccessFacade as state} from '../../src/store/state-access-facade.ts';
import {openInitialized} from '../../src/store/owned-driver.ts';
import type {PendingServerRequest} from '../../src/app-server/server-request-state.ts';
import {ServerRequestOccurrence} from '../../src/protocol/ids.ts';
import {verifyPromptAuthority, PromptAuthority, PromptAuthorityError} from '../../src/runtime/server-prompt-authority.ts';
test('actual native pending request plus running DB owner yields immutable actor-scoped authority', {timeout: 10000}, async () => {
  await fixture(async (path, server, request) => {
    const authority = await verifyPromptAuthority(path, server, request, 1n);
    assert.deepEqual({thread: authority.threadId, turn: authority.turnId, channel: authority.channelId, user: authority.userId, generation: authority.generation}, {thread: 't', turn: 'v', channel: 1n, user: 2n, generation: 1n});
    authority.requireActor(1n, 2n); assert.throws(() => authority.requireActor(1n, 3n), /original user or channel/); assert.throws(() => authority.requireActor(3n, 2n), /original user or channel/);
    assert.ok(Object.isFrozen(authority)); assert.throws(() => PromptAuthority.prototype.requireActor.call(Object.create(PromptAuthority.prototype), 1n, 2n), TypeError);
    const copied = server.pendingServerRequests('t'); copied.length = 0; assert.equal(server.pendingServerRequests('t').length, 1); assert.equal(server.pendingServerRequests('other').length, 0);
  });
});
test('secret, missing thread and missing top-level turn fail before opening an absent database', {timeout: 10000}, async () => {
  await fixture(async (path, server, request) => {
    const absent = path + '.absent';
    const cases: [PendingServerRequest, RegExp][] = [
      [{...request, method: 'item/tool/requestUserInput', params: {questions: [{isSecret: true}]}}, /secret input/],
      [{...request, params: {turnId: 'v'}}, /missing original thread/],
      [{...request, params: {threadId: 't', id: 'v'}}, /missing original turn/],
      [{...request, params: {threadId: 't', turn: {id: 'v'}}}, /missing original turn/],
      [{...request, params: {threadId: 't', turnId: ' v '}}, /missing original turn/],
    ];
    for (const [input, error] of cases) await assert.rejects(verifyPromptAuthority(absent, server, input, 1n), error);
    assert.equal(existsSync(absent), false); assert.equal(server.pendingServerRequests('t').length, 1);
  });
});
test('generation mismatch and restart-pending lifecycle reject before store access', {timeout: 10000}, async () => {
  await fixture(async (path, server, request) => {
    const absent = path + '.absent'; await assert.rejects(verifyPromptAuthority(absent, server, request, 2n), /connection changed/);
    server.requestRestart(); await assert.rejects(verifyPromptAuthority(absent, server, request, 1n), /connection changed/); assert.equal(existsSync(absent), false);
  });
});
test('inactive original turn short-circuits database access', {timeout: 10000}, async () => {
  await fixture(async (path, server, request) => {await call(server, 'finish'); const absent = path + '.absent';
    await assert.rejects(verifyPromptAuthority(absent, server, request, 1n), /turn is no longer active/); assert.equal(existsSync(absent), false);
  });
});
test('persisted observed completion disallows still-active native turn', {timeout: 10000}, async () => {
  await fixture(async (path, server, request) => {
    const db = await openInitialized(path); try {db.prepare("INSERT INTO codex_observed_completions(thread_id,turn_id,generation,payload) VALUES ('t','v',1,'{}')").run();
    } finally {db.close();}
    await assert.rejects(verifyPromptAuthority(path, server, request, 1n), /turn is no longer active/);
  });
});
test('missing, ambiguous and non-running ownership never grants a prompt', {timeout: 10000}, async () => {
  await fixture(async (path, server, request) => {
    for (const sql of ["state='pending'", "goal_waiting=1", "app_server_generation=2"]) {
      await edit(path, "UPDATE codex_turn_queue SET state='running',goal_waiting=0,app_server_generation=1"); await edit(path, 'UPDATE codex_turn_queue SET ' + sql);
      await assert.rejects(verifyPromptAuthority(path, server, request, 1n), /ownership is uncertain/);
    }
    await edit(path, "UPDATE codex_turn_queue SET state='running',goal_waiting=0,app_server_generation=1");
    await state.enqueue(path, queueJob({jobId: 'other', targetThreadId: 't', channelId: 1n, ownerUserId: 2n}));
    await edit(path, "UPDATE codex_turn_queue SET state='running',turn_id='v'"); await assert.rejects(verifyPromptAuthority(path, server, request, 1n), /ownership is uncertain/);
    await edit(path, "DELETE FROM codex_turn_queue"); await assert.rejects(verifyPromptAuthority(path, server, request, 1n), /owner is unknown/);
  });
});
test('invalid original identities and remapped channel reject; no mirror mapping is permitted by source', {timeout: 10000}, async () => {
  await fixture(async (path, server, request) => {
    await edit(path, 'UPDATE codex_turn_queue SET channel_id=0'); await assert.rejects(verifyPromptAuthority(path, server, request, 1n), /invalid original channel/);
    await edit(path, 'UPDATE codex_turn_queue SET channel_id=1,owner_user_id=NULL'); await assert.rejects(verifyPromptAuthority(path, server, request, 1n), /original Discord user is unknown/);
    await edit(path, "UPDATE codex_turn_queue SET owner_user_id=2; UPDATE mirror_threads SET codex_thread_id='other'"); await assert.rejects(verifyPromptAuthority(path, server, request, 1n), /mapping changed/);
    await edit(path, 'DELETE FROM mirror_threads'); assert.ok(await verifyPromptAuthority(path, server, request, 1n));
  });
});
test('exact pending occurrence, ID, method and params are rechecked after store ownership reads', {timeout: 10000}, async () => {
  await fixture(async (path, server, request) => {
    for (const changed of [{...request, id: 'other'}, {...request, method: 'other'}, {...request, occurrence: ServerRequestOccurrence.fromBytes(new Uint8Array(16))}, {...request, params: {...request.params as object, reason: 'changed'}}]) {
      await assert.rejects(verifyPromptAuthority(path, server, changed, 1n), /request expired or changed/);
    }
  });
});
test('malformed unrelated queue rows propagate store failure rather than being filtered away', {timeout: 10000}, async () => {
  await fixture(async (path, server, request) => {
    await state.enqueue(path, queueJob({jobId: 'other', targetThreadId: 'unrelated'})); await edit(path, "UPDATE codex_turn_queue SET channel_id=1.5 WHERE job_id='other'");
    await assert.rejects(verifyPromptAuthority(path, server, request, 1n), error => !(error instanceof PromptAuthorityError));
  });
});
test('original signed storage IDs reject negatives and preserve positive i64 extremes losslessly', {timeout: 10000}, async () => {
  await fixture(async (path, server, request) => {
    await edit(path, 'UPDATE codex_turn_queue SET channel_id=-1'); await assert.rejects(verifyPromptAuthority(path, server, request, 1n), /invalid original channel/);
    await edit(path, 'UPDATE codex_turn_queue SET channel_id=1,owner_user_id=-1'); await assert.rejects(verifyPromptAuthority(path, server, request, 1n), /original Discord user is unknown/);
    await edit(path, 'UPDATE codex_turn_queue SET channel_id=9223372036854775807,owner_user_id=9223372036854775807');
    const authority = await verifyPromptAuthority(path, server, request, 1n); assert.equal(authority.channelId, (1n << 63n) - 1n);
    authority.requireActor((1n << 63n) - 1n, (1n << 63n) - 1n); assert.equal(server.pendingServerRequests('t').length, 1);
  });
});
