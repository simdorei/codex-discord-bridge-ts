import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {componentDeliveryKey, componentClaimIdentity, interactionDeliveryKey, INTERACTION_FOLLOWUP_DOMAIN, INTERACTION_ERROR_DOMAIN, COMPONENT_CONFIRMATION_DOMAIN, BUSY_CONFIRMATION_DOMAIN, COMPONENT_ERROR_DOMAIN} from '../../../src/runtime/discord-dispatch/delivery-identity.ts';
import type {ComponentId} from '../../../src/discord/components.ts';
const key = (component: string) => `v1;source-none;interaction=1:9;component=${Buffer.byteLength(component)}:${component};claim-none;`;
test('all source domains and ordinary interaction identity are exact', () => {
  assert.deepEqual([INTERACTION_FOLLOWUP_DOMAIN, INTERACTION_ERROR_DOMAIN, COMPONENT_CONFIRMATION_DOMAIN, BUSY_CONFIRMATION_DOMAIN, COMPONENT_ERROR_DOMAIN],
    ['interaction/followup/v1', 'interaction/error/v1', 'component/confirmation/v1', 'component/busy-confirmation/v1', 'interaction/error-component/v1']);
  assert.equal(interactionDeliveryKey((1n << 64n) - 1n), 'interaction:18446744073709551615'); assert.throws(() => interactionDeliveryKey(0n));
});
test('eight component variant identity golden strings preserve source formatting', () => {
  const cases: [ComponentId, string][] = [
    [{RecoveryAbandonDecision: {proposal_id: 'p', revision: -1n, decision: 'AbandonOnly'}}, 'abandonment-decision-v1;proposal=1:p;revision=2:-1;decision=11:AbandonOnly;'],
    [{RecoveryPublicationDecision: {proposal_id: 'p', revision: 2n, decision: 'ApproveExact'}}, 'publication-intent-v1;proposal=1:p;revision=1:2;decision=12:ApproveExact;'],
    [{AsyncChoice: {question_id: 'q', option: 24n}}, 'async-question:q:24'],
    [{Busy: {choice_id: 'c', action: 'Queue'}}, 'busy;choice=1:c;action=5:queue;'],
    [{Approval: {thread_id: 't', answer: 'ApproveSession'}}, 'approval;thread=1:t;answer=1:2;'],
    [{BoundApproval: {thread_fingerprint: 't', request_fingerprint: 'r', answer: 'Cancel'}}, 'approval-v2;thread=1:t;request=1:r;answer=6:cancel;'],
    [{Input: {thread_id: 't', value: 'v'}}, 'input;thread=1:t;value=1:v;'],
    [{BoundInput: {thread_fingerprint: 't', request_fingerprint: 'r', value: 'v'}}, 'input-v2;thread=1:t;request=1:r;value=1:v;'],
  ];
  for (const [value, identity] of cases) assert.equal(componentDeliveryKey(9n, null, value, null), key(identity));
});
test('length prefixes count UTF8 bytes and preserve delimiter-heavy field boundaries', () => {
  const c: ComponentId = {Input: {thread_id: '한😀', value: ';=:x'}};
  assert.equal(componentDeliveryKey(9n, null, c, null), key('input;thread=7:한😀;value=4:;=:x;'));
  const a = componentDeliveryKey(9n, 1n, c, ''), b = componentDeliveryKey(9n, null, c, null);
  assert.ok(a.startsWith('v1;source-some=1:1;')); assert.ok(a.endsWith('claim-some=0:;')); assert.notEqual(a, b);
  const values = ['a;b', 'a', '', '한😀', ':;=']; const keys = new Set<string>();
  for (const thread of values) for (const value of values) keys.add(componentDeliveryKey(9n, null, {Input: {thread_id: thread, value}}, null));
  assert.equal(keys.size, values.length ** 2);
});
test('claim identity follows source recovery/async/busy/standard branches', () => {
  assert.equal(componentClaimIdentity(3n, {RecoveryPublicationDecision: {proposal_id: 'p', revision: 1n, decision: 'KeepHeld'}}), null);
  assert.equal(componentClaimIdentity(3n, {RecoveryAbandonDecision: {proposal_id: 'p', revision: 1n, decision: 'KeepHeld'}}), null);
  assert.equal(componentClaimIdentity(null, {AsyncChoice: {question_id: 'q', option: 1n}}), 'q');
  assert.equal(componentClaimIdentity(null, {Busy: {choice_id: 'c', action: 'Stop'}}), 'c');
  assert.equal(componentClaimIdentity(null, {Approval: {thread_id: 't', answer: 'Approve'}}), null);
  assert.equal(componentClaimIdentity(3n, {Approval: {thread_id: 't', answer: 'Approve'}}), createHash('sha256').update('codex_approval:3').digest('hex'));
  const a = componentClaimIdentity(3n, {BoundInput: {thread_fingerprint: 't', request_fingerprint: 'r', value: '1'}});
  assert.equal(a, componentClaimIdentity(3n, {BoundInput: {thread_fingerprint: 't', request_fingerprint: 'r', value: '2'}}));
  assert.notEqual(a, componentClaimIdentity(3n, {BoundInput: {thread_fingerprint: 't', request_fingerprint: 'other', value: '1'}}));
});
test('internal integer enum fields retain signed/unsigned widths rather than UI parser constraints', () => {
  assert.ok(componentDeliveryKey(9n, null, {AsyncChoice: {question_id: 'q', option: (1n << 64n) - 1n}}, null).includes('18446744073709551615'));
  assert.ok(componentDeliveryKey(9n, null, {RecoveryAbandonDecision: {proposal_id: '', revision: -(1n << 63n), decision: 'KeepHeld'}}, null).includes('-9223372036854775808'));
  assert.throws(() => componentDeliveryKey(9n, null, {AsyncChoice: {question_id: 'q', option: -1n}}, null));
});
test('ambiguous/invalid component structures and active fields cannot manufacture keys', () => {
  for (const value of [{}, {Input: {thread_id: 't'}}, {Input: {thread_id: 't', value: 'v'}, Busy: {choice_id: 'c', action: 'Stop'}}, {Busy: {choice_id: 'c', action: 'unknown'}}]) assert.throws(() => componentDeliveryKey(9n, null, value as ComponentId, null));
  let calls = 0; assert.throws(() => componentDeliveryKey(9n, null, {get Input() {calls++; return {thread_id: 't', value: 'v'};}}, null)); assert.equal(calls, 0);
});
test('inherited component variants cannot execute getters or replace owned variant identity', () => {
  const value: ComponentId = {Input: {thread_id: 't', value: 'v'}}, expected = componentDeliveryKey(9n, null, value, null);
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'Busy'); let calls = 0, actual: string | undefined, claim: string | null | undefined;
  const descriptor = Object.assign(Object.create(null), {configurable: true, get() {calls++; return {choice_id: 'poison', action: 'Stop'};}});
  try {Object.defineProperty(Object.prototype, 'Busy', descriptor); actual = componentDeliveryKey(9n, null, value, null); claim = componentClaimIdentity(3n, value);}
  finally {if (previous) Object.defineProperty(Object.prototype, 'Busy', previous); else Reflect.deleteProperty(Object.prototype, 'Busy');}
  assert.equal(calls, 0); assert.equal(actual, expected); assert.equal(claim, createHash('sha256').update('codex_input:3').digest('hex'));
});
