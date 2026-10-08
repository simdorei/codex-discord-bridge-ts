import assert from 'node:assert/strict';
import {test} from 'node:test';
import {AdmissionGate, DrainFenceKey, DrainGateError} from '../../../src/admission/drain-gate.ts';
import {drainGateErrorInfo} from '../../../src/admission/owned-key.ts';
import {decodeGatewayInteraction} from '../../../src/discord/gateway/decoded-interaction.ts';
import {routeGatewayCommand, routeGatewayComponent, type RoutedInteractionWork} from '../../../src/discord/interaction-routing.ts';
import {admitInteraction, isInteractionDrainControl} from '../../../src/runtime/discord-dispatch/admission.ts';
import {InteractionDispatchError, interactionDispatchErrorInfo} from '../../../src/runtime/discord-dispatch/errors.ts';
import {reportInteractionEventResult} from '../../../src/runtime/discord-runtime/interaction-failure.ts';

const key = () => DrainFenceKey.create('runtime-a', '42|99', 'controls');
function work(customId?: string, autocomplete = false, name = 'help'): RoutedInteractionWork {
  const interaction = decodeGatewayInteraction(JSON.stringify({
    application_id: '2', authorizing_integration_owners: {}, channel_id: '10', id: '4',
    token: 'offline-token', type: customId ? 3 : autocomplete ? 4 : 2,
    user: {id: '20', username: 'tester', discriminator: '0001'},
    data: customId ? {custom_id: customId, component_type: 2} : {
      id: '3', name: autocomplete ? 'settings' : name, type: 1,
      ...(autocomplete ? {options: [{name: 'model', type: 3, value: 'gpt', focused: true}]} : {}),
    },
  }));
  return customId ? routeGatewayComponent(interaction).work : routeGatewayCommand(interaction, false).work;
}
const controls = [
  'codex_approval:thread:1',
  'codex_approval:v2:' + 'a'.repeat(16) + ':' + 'b'.repeat(32) + ':cancel',
  'codex_input:thread:yes',
  'codex_input:v2:' + 'a'.repeat(16) + ':' + 'b'.repeat(32) + ':no',
  'codex_busy:' + 'c'.repeat(24) + ':stop',
];
const ordinary = [
  'codex_busy:' + 'c'.repeat(24) + ':steer',
  'codex_busy:' + 'c'.repeat(24) + ':queue',
  'codex_busy:' + 'c'.repeat(24) + ':ignore',
  'codex_async:' + 'd'.repeat(64) + ':0',
  'codex_pub:v1:' + 'e'.repeat(32) + ':1:a',
  'codex_discard:v1:' + 'e'.repeat(32) + ':1:a',
];

test('only the five source control variants pass a sealed gate with controls open', () => {
  for (const id of controls) {
    const gate = new AdmissionGate(), fence = key(); gate.seal(fence);
    const routed = work(id); assert.equal(isInteractionDrainControl(routed), true);
    const result = admitInteraction(gate, routed);
    assert.equal(result.sealed, false); assert.ok(result.permit);
    assert.equal(gate.isDrainedFor(fence), false);
    result.permit.release(); assert.equal(gate.isDrainedFor(fence), true);
  }
});
test('busy steer/queue/ignore, async and recovery decisions are ordinary admission', () => {
  for (const id of ordinary) {
    const gate = new AdmissionGate(), fence = key(); gate.seal(fence);
    assert.equal(isInteractionDrainControl(work(id)), false);
    assert.deepEqual(admitInteraction(gate, work(id)), {permit: null, sealed: true});
    assert.equal(gate.isDrainedFor(fence), true);
  }
});
test('ordinary slash and autocomplete are not existing-work component controls', () => {
  const gate = new AdmissionGate(), fence = key(); gate.seal(fence);
  for (const value of [work(), work(undefined, true)]) {
    assert.equal(isInteractionDrainControl(value), false);
    assert.deepEqual(admitInteraction(gate, value), {permit: null, sealed: true});
  }
});
test('closing controls rejects all five; reopening restores control admission only', () => {
  const gate = new AdmissionGate(), fence = key(); gate.seal(fence); gate.closeControls(fence);
  for (const id of controls) assert.deepEqual(admitInteraction(gate, work(id)), {permit: null, sealed: true});
  gate.openControls(fence);
  const result = admitInteraction(gate, work(controls[0]!)); assert.ok(result.permit);
  assert.equal(result.sealed, false); result.permit.release();
  assert.equal(admitInteraction(gate, work()).sealed, true);
});
test('unsealed gate accounts for both ordinary and control permits until last release', () => {
  const gate = new AdmissionGate(), fence = key();
  const normal = admitInteraction(gate, work()), control = admitInteraction(gate, work(controls[0]!));
  assert.ok(normal.permit && control.permit); gate.seal(fence);
  normal.permit.release(); normal.permit.release(); assert.equal(gate.isDrainedFor(fence), false);
  control.permit.release(); assert.equal(gate.isDrainedFor(fence), true);
  assert.equal(gate.release(fence), true);
});
test('missing gate or missing work short circuits without touching the other input', () => {
  let calls = 0; const hostile = new Proxy({}, {get() {calls++; throw new Error('get');}});
  assert.deepEqual(admitInteraction(null, hostile as RoutedInteractionWork), {permit: null, sealed: false});
  assert.deepEqual(admitInteraction(hostile as AdmissionGate, null), {permit: null, sealed: false});
  assert.equal(calls, 0);
});
test('borrowed gate uses owned entry methods, not overridable instance hooks', () => {
  const gate = new AdmissionGate(); let calls = 0;
  Object.defineProperties(gate, {
    tryEnter: {value() {calls++; throw new Error('override');}},
    tryEnterControlObserved: {value() {calls++; throw new Error('override');}},
  });
  for (const value of [work(), work(controls[0]!)]) {
    const result = admitInteraction(gate, value); assert.ok(result.permit); result.permit.release();
  }
  assert.equal(calls, 0);
});
test('unowned work is rejected before a real gate acquires any permit', () => {
  const gate = new AdmissionGate(), fence = key(); let calls = 0;
  const fake = new Proxy({}, {get() {calls++; throw new Error('get');}, ownKeys() {calls++; throw new Error('keys');}});
  for (const value of [fake, {Component: {Approval: {thread_id: 't', answer: 'Approve'}}}, {...work()}]) {
    assert.throws(() => admitInteraction(gate, value as RoutedInteractionWork), TypeError);
  }
  gate.seal(fence); assert.equal(gate.isDrainedFor(fence), true); assert.equal(calls, 0);
});
test('gate ownership failure is typed Admission and remains lane-fatal', () => {
  let error: unknown;
  try {admitInteraction(Object.create(AdmissionGate.prototype), work());} catch (value) {error = value;}
  assert.ok(error instanceof InteractionDispatchError); assert.equal(error.kind, 'Admission');
  assert.equal(error.message, 'restart admission gate lock is poisoned');
  assert.ok(error.cause instanceof DrainGateError); assert.equal(error.cause.kind, 'LockPoisoned');
  const result = {ok: false as const, error};
  assert.equal(reportInteractionEventResult('normal', 4n, 'offline-token', result, () => assert.fail('not event-local')), result);
});
test('admission diagnostics use private error records without invoking mutated or proxy fields', () => {
  let calls = 0; const cause = new DrainGateError('FenceMismatch');
  Object.defineProperties(cause, {
    kind: {get() {calls++; throw new Error('kind');}},
    message: {get() {calls++; throw new Error('message');}},
  });
  const failure = new InteractionDispatchError('Admission', cause);
  assert.equal(failure.cause, cause);
  assert.equal(interactionDispatchErrorInfo(failure)?.text, 'restart drain fence does not match the active runtime and nonce');
  const proxy = new Proxy(cause, {get() {calls++; throw new Error('get');}, getPrototypeOf() {calls++; throw new Error('proto');}});
  assert.equal(drainGateErrorInfo(proxy), null);
  assert.equal(new InteractionDispatchError('Admission', proxy).message, 'restart admission failed');
  assert.equal(calls, 0);
});
