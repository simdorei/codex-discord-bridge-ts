import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parsePromptTextBinding, promptTextFingerprint} from '../../../src/runtime/server-prompt-text-binding.ts';
import {handlePendingTextReply, pendingTextReplyAvailable, selectPendingTextReply} from '../../../src/runtime/component-worker/text-reply.ts';
import {componentWorkerErrorInfo} from '../../../src/runtime/component-worker/errors.ts';
import {ServerRequestOccurrence} from '../../../src/protocol/ids.ts';
import type {PendingServerRequest} from '../../../src/app-server/server-request-state.ts';
import {promptFixture, callPromptFixture, editPromptFixture} from '../../helpers/server-prompt-fixture.ts';
const kind = (name: string) => (e: unknown) => componentWorkerErrorInfo(e)?.kind === name;
const req = (id: string | bigint, method = 'execCommandApproval', byte = 1): PendingServerRequest => ({id, method, params: {threadId: 't'}, occurrence: ServerRequestOccurrence.fromBytes(new Uint8Array(16).fill(byte))});
const bind = (r: PendingServerRequest, body = '1', generation = 1n) => `[codex-reply:${promptTextFingerprint(r, generation)}] ${body}`;
test('binding requires exact prefix,32 ASCII hex bytes, whitespace separator and nonempty Rust-trimmed body', () => {
  const token = 'A'.repeat(32); assert.deepEqual(parsePromptTextBinding(`\u0085[codex-reply:${token}]\u0085 yes \n`), {token, body: 'yes'});
  for (const text of [`[codex-reply:${token}`, `[codex-reply:${token}]yes`, `[codex-reply:${token}] `, `[codex-reply:${'a'.repeat(31)}] yes`, `[codex-reply:${'ａ'.repeat(32)}] yes`, `[codex-reply:${token}]\ufeffyes`]) assert.throws(() => parsePromptTextBinding(text), kind('NoPendingRequest'));
  for (const text of ['ordinary reply', `[CODEX-REPLY:${token}] yes`, `\ufeff[codex-reply:${token}] yes`]) assert.equal(parsePromptTextBinding(text), null);
});
test('unbound mixed eligible requests are ambiguous and unsupported requests are ignored', () => {
  const a = req('a'), b = req('b', 'item/tool/requestUserInput');
  assert.throws(() => selectPendingTextReply([a, b], '1', 1n), kind('AmbiguousPendingRequest'));
  assert.equal(selectPendingTextReply([req('u', 'unsupported')], '1', 1n), null);
  assert.equal(selectPendingTextReply([req('u', 'unsupported'), a], ' 1 ', 1n)?.answer, ' 1 ');
});
test('exact prefix selects occurrence and typed id; stale generation and uppercase hash never silently fall back', () => {
  const a = req('1'), b = req('1', 'execCommandApproval', 2), c = req(1n);
  assert.equal(selectPendingTextReply([a, b, c], bind(b, '3'), 1n)?.request.occurrence.asBytes()[0], 2);
  assert.throws(() => selectPendingTextReply([a], bind(a, '1', 2n), 1n), kind('NoPendingRequest'));
  const fingerprint = promptTextFingerprint(a, 1n); assert.notEqual(fingerprint, fingerprint.toUpperCase());
  assert.throws(() => selectPendingTextReply([a], `[codex-reply:${fingerprint.toUpperCase()}] 1`, 1n), kind('NoPendingRequest'));
  assert.throws(() => selectPendingTextReply([], bind(a), 1n), kind('NoPendingRequest'));
  assert.throws(() => selectPendingTextReply([a, a], bind(a), 1n), kind('AmbiguousPendingRequest'));
});
test('native approval reply verifies actor, emits one exact response, settles occurrence and never repeats', async () => {
  await promptFixture(async (db, server, r) => {
    assert.equal(pendingTextReplyAvailable('t', server), true); assert.equal(pendingTextReplyAvailable('other', server), false);
    assert.equal(await handlePendingTextReply('t', bind(r, '2'), server, db, 1n, 2n), 'Approval response submitted: acceptForSession');
    assert.equal(pendingTextReplyAvailable('t', server), false);
    assert.deepEqual(await callPromptFixture(server, 'answers'), [{id: 'approval', result: {decision: 'acceptForSession'}}]);
    await assert.rejects(handlePendingTextReply('t', bind(r), server, db, 1n, 2n), kind('NoPendingRequest'));
    assert.equal(await handlePendingTextReply('t', '1', server, db, 1n, 2n), null);
    assert.equal((await callPromptFixture(server, 'answers') as unknown[]).length, 1);
  }, {enableResponses: true});
});
test('native input reply preserves multi answers and confirms only after response flush', async () => {
  await promptFixture(async (db, server, r) => {
    assert.equal(await handlePendingTextReply('t', bind(r, '1|two'), server, db, 1n, 2n), 'Codex input reply submitted.');
    assert.deepEqual(await callPromptFixture(server, 'answers'), [{id: 'approval', result: {answers: {q: {answers: ['One', 'Two']}}}}]);
  }, {enableResponses: true, method: 'item/tool/requestUserInput', params: {threadId: 't', turnId: 'v', questions: [{id: 'q', options: [{label: 'One'}, {label: 'Two'}]}]}});
});
test('wrong actor and wrong channel fail before interpreting answer, with zero responses', async () => {
  await promptFixture(async (db, server) => {
    for (const [channel, user] of [[1n, 3n], [9n, 2n]]) await assert.rejects(handlePendingTextReply('t', 'not an approval', server, db, channel!, user!), kind('Authority'));
    assert.deepEqual(await callPromptFixture(server, 'answers'), []); assert.equal(server.pendingServerRequests('t').length, 1);
  }, {enableResponses: true});
});
test('completed original turn and remapped Discord channel remain held without responses', async () => {
  await promptFixture(async (db, server) => {
    await editPromptFixture(db, "UPDATE mirror_threads SET codex_thread_id='other'");
    await assert.rejects(handlePendingTextReply('t', '1', server, db, 1n, 2n), kind('Authority'));
    await editPromptFixture(db, "UPDATE mirror_threads SET codex_thread_id='t'"); await callPromptFixture(server, 'finish');
    await assert.rejects(handlePendingTextReply('t', '1', server, db, 1n, 2n), kind('Authority')); assert.deepEqual(await callPromptFixture(server, 'answers'), []);
  }, {enableResponses: true});
});
test('secret input is unavailable to chat even with valid original actor', async () => {
  await promptFixture(async (db, server) => {
    await assert.rejects(handlePendingTextReply('t', 'test-only', server, db, 1n, 2n), kind('Authority')); assert.deepEqual(await callPromptFixture(server, 'answers'), []);
  }, {enableResponses: true, method: 'item/tool/requestUserInput', params: {threadId: 't', turnId: 'v', questions: [{id: 'q', isSecret: true}]}});
});
test('invalid answer and missing resident response adapter retain pending request without false confirmation', async () => {
  await promptFixture(async (db, server) => {
    await assert.rejects(handlePendingTextReply('t', 'wrong', server, db, 1n, 2n), kind('AppServer'));
    await assert.rejects(handlePendingTextReply('t', '1', server, db, 1n, 2n), e => kind('AppServer')(e) && String(e).includes('adapter is not installed'));
    assert.deepEqual(await callPromptFixture(server, 'answers'), []); assert.equal(server.pendingServerRequests('t').length, 1);
  });
});
test('pre-cancelled reply does not begin authority or write and retains exact cancellation reason', async () => {
  await promptFixture(async (db, server) => {
    const controller = new AbortController(), reason = new Error('cancel fixture'); controller.abort(reason);
    await assert.rejects(handlePendingTextReply('t', '1', server, db, 1n, 2n, controller.signal), e => e === reason);
    assert.deepEqual(await callPromptFixture(server, 'answers'), []);
  }, {enableResponses: true});
});
