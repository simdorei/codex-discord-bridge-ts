import assert from 'node:assert/strict';
import {test} from 'node:test';
import {promptFixture, editPromptFixture} from '../helpers/server-prompt-fixture.ts';
import {prepareOneServerPrompt, prepareServerPrompts, preparedPromptEqual, isPreparedPrompt, PromptRedisplayChangedError} from '../../src/runtime/server-prompt-redisplay.ts';
import {pendingServerRequestEqual} from '../../src/app-server/server-request-state.ts';
import {ServerRequestOccurrence} from '../../src/protocol/ids.ts';
import {renderActionUi} from '../../src/runtime/action-ui.ts';
test('rebuilds exact native pending occurrence with immutable authorized UI and no response submission', {timeout: 10000}, async () => {
  await promptFixture(async (path, server, request) => {
    const one = await prepareOneServerPrompt(path, server, request, 1n, 1n, 2n), all = await prepareServerPrompts(path, server, 't', 1n, 2n);
    assert.equal(one.unavailable, false); assert.equal(isPreparedPrompt(one), true); assert.ok(Object.isFrozen(one)); assert.ok(Object.isFrozen(all));
    assert.equal(all.length, 1); assert.equal(preparedPromptEqual(one, all[0]!), true);
    assert.equal(renderActionUi({kind: 'ServerPrompts', prompts: all}).length, 1); assert.equal(server.pendingServerRequests('t').length, 1);
    assert.deepEqual(await prepareServerPrompts(path, server, 'other', 1n, 2n), []);
  });
});
test('wrong actor receives only fixed diagnostic without command/reason contents or components', {timeout: 10000}, async () => {
  await promptFixture(async (path, server, request) => {
    const value = await prepareOneServerPrompt(path, server, request, 1n, 1n, 99n);
    assert.equal(value.unavailable, true); assert.deepEqual(value.prompt.components, []);
    assert.equal(value.prompt.text, 'Cannot display this pending request: approval/input request authority is unavailable: original user or channel does not match; no response was submitted');
    assert.equal(value.prompt.text.includes('PRIVATE_COMMAND'), false);
  }, {params: {threadId: 't', turnId: 'v', reason: 'PRIVATE_COMMAND'}});
});
test('unsupported methods are sanitized and never copied into unavailable diagnostic', {timeout: 10000}, async () => {
  await promptFixture(async (path, server, request) => {
    const value = await prepareOneServerPrompt(path, server, request, 1n, 1n, 2n);
    assert.equal(value.unavailable, true); assert.equal(value.prompt.text, 'Cannot display this pending request: unsupported app-server request method');
    assert.deepEqual(value.prompt.components, []); assert.equal(value.prompt.text.includes('PRIVATE_METHOD'), false);
  }, {method: 'PRIVATE_METHOD'});
});
test('secret input and malformed questions stay unavailable without copying question contents', {timeout: 10000}, async () => {
  for (const questions of [[{id: 'q', question: 'PRIVATE_QUESTION', isSecret: true}], [{id: '', question: 'PRIVATE_QUESTION'}]]) {
    await promptFixture(async (path, server, request) => {
      const value = await prepareOneServerPrompt(path, server, request, 1n, 1n, 2n);
      assert.equal(value.unavailable, true); assert.equal(value.prompt.text.includes('PRIVATE_QUESTION'), false); assert.deepEqual(value.prompt.components, []);
    }, {method: 'item/tool/requestUserInput', params: {threadId: 't', turnId: 'v', questions}});
  }
});
test('storage corruption is a fatal error, never downgraded into unavailable prompt', {timeout: 10000}, async () => {
  await promptFixture(async (path, server, request) => {
    await editPromptFixture(path, "UPDATE codex_turn_queue SET channel_id=1.5");
    await assert.rejects(prepareOneServerPrompt(path, server, request, 1n, 1n, 2n), /channel_id/);
  });
});
test('restart pending prevents redisplay and final readiness is checked after async authority reads', {timeout: 10000}, async () => {
  await promptFixture(async (path, server, request) => {
    const pending = prepareOneServerPrompt(path, server, request, 1n, 1n, 2n); server.requestRestart();
    await assert.rejects(pending, PromptRedisplayChangedError);
    await assert.rejects(prepareServerPrompts(path, server, 't', 1n, 2n), PromptRedisplayChangedError);
  });
});
test('expired exact occurrence becomes unavailable and is unequal to previously prepared UI', {timeout: 10000}, async () => {
  await promptFixture(async (path, server, request) => {
    const valid = await prepareOneServerPrompt(path, server, request, 1n, 1n, 2n);
    const stale = {...request, occurrence: ServerRequestOccurrence.fromBytes(new Uint8Array(16))};
    const unavailable = await prepareOneServerPrompt(path, server, stale, 1n, 1n, 2n);
    assert.equal(unavailable.unavailable, true); assert.equal(preparedPromptEqual(valid, unavailable), false);
    assert.equal(isPreparedPrompt({...valid}), false); assert.throws(() => preparedPromptEqual(valid, {...valid}), TypeError);
  });
});
test('full pending request equality includes ID occurrence method params and rejects active objects', {timeout: 10000}, async () => {
  await promptFixture(async (_path, _server, request) => {
    assert.equal(pendingServerRequestEqual(request, {...request}), true);
    for (const change of [{...request, id: 1n}, {...request, method: 'changed'}, {...request, params: {}}, {...request, occurrence: ServerRequestOccurrence.fromBytes(new Uint8Array(16))}]) assert.equal(pendingServerRequestEqual(request, change), false);
    let hooks = 0; assert.throws(() => pendingServerRequestEqual(request, {...request, get params() {hooks++; return {};}})); assert.equal(hooks, 0);
  });
});
