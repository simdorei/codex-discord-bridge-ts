import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseApprovalAnswer, buildApprovalResponse} from '../../src/app-server/approval-replies.ts';
import {AppServerInvalidReplyError} from '../../src/app-server/client-errors.ts';
test('all source approval aliases map to exact modern/legacy/scope triples', () => {
  const groups = [
    [['1', 'approve', 'approved', 'accept', 'yes', 'y', 'ok', '예', '네', '승인'], {decision: 'accept', legacyDecision: 'approved', scope: 'turn'}],
    [['2', 'approve session', 'accept session', 'session', 'approve_for_session'], {decision: 'acceptForSession', legacyDecision: 'approved_for_session', scope: 'session'}],
    [['3', 'decline', 'reject', 'no', 'n', '아니요', '거절'], {decision: 'decline', legacyDecision: 'denied', scope: 'turn'}],
    [['cancel', 'skip', 'dismiss', '건너뛰기', '취소'], {decision: 'cancel', legacyDecision: 'abort', scope: 'turn'}],
  ] as const;
  for (const [inputs, expected] of groups) for (const input of inputs) assert.deepEqual(parseApprovalAnswer(input), expected);
});
test('Rust trim and Unicode lowercase apply without fuzzy or internal-space normalization', () => {
  assert.equal(parseApprovalAnswer('\u0085 APPROVE SESSION\n').decision, 'acceptForSession'); assert.equal(parseApprovalAnswer('oK').decision, 'accept');
  for (const input of ['', '\ufeff1', 'approve  session', '１', '1.0', 'sure', 'true']) assert.throws(() => parseApprovalAnswer(input), AppServerInvalidReplyError);
  assert.throws(() => parseApprovalAnswer('\ud800'), TypeError);
});
test('modern command/file approval and legacy methods use different exact decision names', () => {
  const modern = ['accept', 'acceptForSession', 'decline', 'cancel'], legacy = ['approved', 'approved_for_session', 'denied', 'abort'];
  for (const [i, answer] of ['1', '2', '3', 'cancel'].entries()) {
    for (const method of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval']) assert.deepEqual(buildApprovalResponse(method, null, answer), {payload: {decision: modern[i]}, action: modern[i]});
    for (const method of ['execCommandApproval', 'applyPatchApproval']) assert.deepEqual(buildApprovalResponse(method, null, answer), {payload: {decision: legacy[i]}, action: legacy[i]});
  }
});
test('elicitation session acceptance becomes accept with object content, other answers use null', () => {
  assert.deepEqual(buildApprovalResponse('mcpServer/elicitation/request', {}, '2'), {payload: {action: 'accept', content: {}, _meta: null}, action: 'accept'});
  for (const answer of ['3', 'cancel']) {const response = buildApprovalResponse('mcpServer/elicitation/request', {}, answer); assert.deepEqual(response.payload, {action: answer === '3' ? 'decline' : 'cancel', content: null, _meta: null});}
  // The pure builder does not enforce URL mode; request selection owns that gate.
  assert.equal(buildApprovalResponse('mcpServer/elicitation/request', {mode: 'form'}, '1').action, 'accept');
});
test('permission acceptance copies only requested object and preserves chosen scope', () => {
  const params = {permissions: {network: {enabled: true}, fileSystem: {paths: ['a']}, extension: 1n}};
  const response = buildApprovalResponse('item/permissions/requestApproval', params, '2');
  assert.deepEqual(response, {payload: {permissions: params.permissions, scope: 'session'}, action: 'acceptForSession'});
  params.permissions.fileSystem.paths[0] = 'changed'; assert.equal((response.payload as any).permissions.fileSystem.paths[0], 'a'); assert.ok(Object.isFrozen(response.payload));
  for (const permissions of [null, [], false, 'all', 1n]) assert.deepEqual(buildApprovalResponse('item/permissions/requestApproval', {permissions}, '1').payload, {permissions: {network: null, fileSystem: null}, scope: 'turn'});
});
test('permission decline/cancel emit exact denied payload without reading requested permissions', () => {
  let hooks = 0; const params = {get permissions() {hooks++; throw new Error('must not read');}};
  for (const answer of ['3', 'cancel']) assert.deepEqual(buildApprovalResponse('item/permissions/requestApproval', params, answer).payload, {permissions: {network: null, fileSystem: null}, scope: 'turn', strictAutoReview: false});
  assert.equal(hooks, 0); assert.throws(() => buildApprovalResponse('item/permissions/requestApproval', params, '1'), TypeError); assert.equal(hooks, 0);
});
test('invalid answer is diagnosed before unsupported method; no arbitrary coercion occurs', () => {
  assert.throws(() => buildApprovalResponse('unsupported', null, 'not recognized'), /Unrecognized approval reply/);
  assert.throws(() => buildApprovalResponse('unsupported', null, '1'), /Unsupported app-server approval request method: unsupported/);
  let hooks = 0; assert.throws(() => parseApprovalAnswer({toString() {hooks++; return '1';}} as unknown as string)); assert.equal(hooks, 0);
});
