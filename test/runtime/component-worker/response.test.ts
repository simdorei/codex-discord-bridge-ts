import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildComponentResponse, prepareComponentResponse, isApprovalMethod} from '../../../src/runtime/component-worker/response.ts';
import {ComponentWorkerError, componentWorkerErrorInfo, actionCompletedBeforeFailure} from '../../../src/runtime/component-worker/errors.ts';
import {ConfirmationError} from '../../../src/runtime/component-worker/confirmation.ts';
import {BusyComponentError} from '../../../src/runtime/component-worker/busy-errors.ts';
import {threadFingerprint, requestFingerprint, type ComponentId} from '../../../src/discord/components.ts';
import {ServerRequestOccurrence} from '../../../src/protocol/ids.ts';
import type {PendingServerRequest} from '../../../src/app-server/server-request-state.ts';
import {promptFixture} from '../../helpers/server-prompt-fixture.ts';
const request = (id: string | bigint = 'r', method = 'execCommandApproval', thread = 't', byte = 1): PendingServerRequest => ({id, method, params: {threadId: thread, questions: [{id: 'q', options: [{label: 'One'}]}]}, occurrence: ServerRequestOccurrence.fromBytes(new Uint8Array(16).fill(byte))});
const legacy: ComponentId = {Approval: {thread_id: 't', answer: 'Approve'}};
const bound = (r: PendingServerRequest, generation = 7n, input = false): ComponentId => {
  const fields = {thread_fingerprint: threadFingerprint('t'), request_fingerprint: requestFingerprint(generation, r.occurrence.asBytes(), r.id)};
  return input ? {BoundInput: {...fields, value: '1'}} : {BoundApproval: {...fields, answer: 'ApproveSession'}};
};
const kind = (expected: string) => (error: unknown) => componentWorkerErrorInfo(error)?.kind === expected;
test('legacy selection filters exact thread and request method before uniqueness', () => {
  const r = request(); const result = buildComponentResponse(legacy, [request('other', 'execCommandApproval', 'other'), request('input', 'item/tool/requestUserInput'), r], 7n);
  assert.equal(result.requestId, 'r'); assert.equal(result.confirmation, 'Approval response submitted: approved'); assert.deepEqual(result.payload, {decision: 'approved'});
  assert.equal(result.generation, 7n); assert.deepEqual(result.occurrence.asBytes(), r.occurrence.asBytes()); assert.ok(Object.isFrozen(result));
  assert.throws(() => buildComponentResponse(legacy, [], 7n), kind('NoPendingRequest'));
  assert.throws(() => buildComponentResponse(legacy, [r, request('r2')], 7n), kind('AmbiguousPendingRequest'));
});
test('all approval enum answers preserve exact modern and legacy response payloads', () => {
  const cases = [['Approve', 'accept'], ['ApproveSession', 'acceptForSession'], ['Reject', 'decline'], ['Cancel', 'cancel']] as const;
  for (const [answer, decision] of cases) assert.deepEqual(buildComponentResponse({Approval: {thread_id: 't', answer}}, [request('r', 'item/commandExecution/requestApproval')], 7n).payload, {decision});
});
test('bound fingerprints distinguish same request id by occurrence and generation and string/integer id kind', () => {
  const r = request('1'), newer = request('1', 'execCommandApproval', 't', 2);
  assert.equal(buildComponentResponse(bound(r), [request(1n), newer, r], 7n).confirmation, 'Approval response submitted: approved_for_session');
  assert.throws(() => buildComponentResponse(bound(r), [newer], 7n), kind('NoPendingRequest'));
  assert.throws(() => buildComponentResponse(bound(r), [r], 8n), kind('NoPendingRequest'));
  assert.throws(() => buildComponentResponse(bound(r), [request('1', 'execCommandApproval', 'other')], 7n), kind('NoPendingRequest'));
});
test('bound selection checks exact identity uniqueness before request method kind', () => {
  const r = request('r', 'item/tool/requestUserInput');
  assert.throws(() => buildComponentResponse(bound(r), [r], 7n), kind('NoPendingRequest'));
  assert.throws(() => buildComponentResponse(bound(r), [r, request()], 7n), kind('AmbiguousPendingRequest'));
  assert.throws(() => buildComponentResponse(bound(request(), 7n, true), [request()], 7n), kind('NoPendingRequest'));
});
test('URL elicitation is approval-compatible; form/absent modes are not', () => {
  for (const method of ['execCommandApproval', 'applyPatchApproval', 'item/permissions/requestApproval', 'item/fileChange/requestApproval', 'item/commandExecution/requestApproval']) assert.equal(isApprovalMethod(method, {}), true);
  const r = {...request(), method: 'mcpServer/elicitation/request', params: {threadId: 't', mode: 'url'}};
  assert.deepEqual(buildComponentResponse(legacy, [r], 7n).payload, {action: 'accept', content: {}, _meta: null});
  for (const mode of ['form', null, 'URL']) assert.throws(() => buildComponentResponse(legacy, [{...r, params: {threadId: 't', mode}}], 7n), kind('NoPendingRequest'));
});
test('legacy and bound input use shared grammar, retaining source AppServer error nesting', () => {
  const r = request('r', 'item/tool/requestUserInput');
  for (const component of [{Input: {thread_id: 't', value: '1'}} as ComponentId, bound(r, 7n, true)]) {
    const result = buildComponentResponse(component, [r], 7n); assert.deepEqual(result.payload, {answers: {q: {answers: ['One']}}}); assert.equal(result.confirmation, 'Codex input choice submitted.');
  }
  assert.throws(() => buildComponentResponse({Input: {thread_id: 't', value: ''}}, [r], 7n), e => kind('AppServer')(e) && String(e).includes('Answer text was empty'));
});
test('busy and recovery variants are rejected before inspecting pending requests', () => {
  const variants: [ComponentId, string][] = [[{Busy: {choice_id: 'x', action: 'Queue'}}, 'BusyChoice'], [{AsyncChoice: {question_id: 'q', option: 0n}}, 'InvalidComponent'], [{RecoveryPublicationDecision: {proposal_id: 'p', revision: 1n, decision: 'KeepHeld'}}, 'InvalidComponent'], [{RecoveryAbandonDecision: {proposal_id: 'p', revision: 1n, decision: 'KeepHeld'}}, 'InvalidComponent']];
  for (const [component, error] of variants) assert.throws(() => buildComponentResponse(component, null as any, 7n), kind(error));
});
test('request and component accessors are rejected without hooks; output is detached', () => {
  let hooks = 0; const a: any[] = []; Object.defineProperty(a, '0', {get() {hooks++; return request();}});
  assert.throws(() => buildComponentResponse(legacy, a, 7n), TypeError); assert.equal(hooks, 0);
  const r = request('r', 'item/permissions/requestApproval'); const params = {threadId: 't', permissions: {network: {enabled: true}}};
  const result = buildComponentResponse(legacy, [{...r, params}], 7n); params.permissions.network.enabled = false;
  assert.deepEqual(result.payload, {permissions: {network: {enabled: true}}, scope: 'turn'});
  assert.throws(() => buildComponentResponse(legacy, [r], -1n), TypeError);
});
test('completed-before-failure recognizes only owned recovery errors directly or through Busy confirmation', () => {
  const recovery = new ConfirmationError('Recovery', 'fixture');
  assert.equal(actionCompletedBeforeFailure(new ComponentWorkerError('Confirmation', recovery)), true);
  assert.equal(actionCompletedBeforeFailure(new ComponentWorkerError('Busy', new BusyComponentError('Confirmation', recovery))), true);
  for (const source of [new ConfirmationError('Delivery', 'x'), new ConfirmationError('Clear', 'x'), Object.create(ConfirmationError.prototype)]) assert.equal(actionCompletedBeforeFailure(new ComponentWorkerError('Confirmation', source)), false);
  assert.equal(actionCompletedBeforeFailure(Object.create(ComponentWorkerError.prototype)), false);
  let hooks = 0; const e = new ComponentWorkerError('Clear', {get message() {hooks++; return 'secret';}}); assert.equal(hooks, 0); assert.match(e.message, /^could not clear handled Discord buttons: component action failed$/);
});
test('native helper pending snapshot prepares response without submitting or removing the request', async () => {
  await promptFixture(async (_db, server, r) => {
    const result = prepareComponentResponse(bound(r, server.generation()), server);
    assert.equal(result.requestId, r.id); assert.equal(result.generation, server.generation()); assert.equal(server.pendingServerRequests(null).length, 1);
    assert.throws(() => prepareComponentResponse({Busy: {choice_id: 'x', action: 'Queue'}}, null as any), kind('BusyChoice'));
  });
});
