import assert from 'node:assert/strict';
import {test} from 'node:test';
import {serializeSerdeValue} from '../../src/core/serde-json.ts';
import {decodeGatewayInteraction} from '../../src/discord/gateway/decoded-interaction.ts';
import {routeGatewayCommand, routeGatewayComponent, type RoutedInteractionWork} from '../../src/discord/interaction-routing.ts';
import {slashCommandNames} from '../../src/discord/commands.ts';
import {CommandPlanError, planSlash} from '../../src/runtime/command-plan.ts';

type Option = {name: string; type: bigint; value: string | bigint | boolean; focused?: boolean};
const s = (name: string, value: string): Option => ({name, type: 3n, value});
const i = (name: string, value: bigint): Option => ({name, type: 4n, value});
const b = (name: string, value: boolean): Option => ({name, type: 5n, value});
function routed(name: string, options: Option[] = [], qa = true) {
  return routeGatewayCommand(decodeGatewayInteraction(serializeSerdeValue({
    application_id: '2', authorizing_integration_owners: {}, channel_id: '10', id: '4',
    token: 'offline-token', type: 2n, user: {id: '20', username: 'u', discriminator: '0001'},
    data: {id: '3', name, type: 1n, options},
  })), qa).work;
}
const plan = (name: string, options: Option[] = []) => planSlash(routed(name, options));

test('all 19 registered slash commands produce source actions without extra inventory', () => {
  const cases = [
    ['help', [], 'Help'], ['list', [], {List: {limit: 10n}}], ['archived_list', [], {ArchivedList: {limit: 10n}}],
    ['use', [s('ref', 't')], {Use: {reference: 't'}}], ['status', [], {Status: {reference: null}}],
    ['settings', [], {Settings: {reference: null, model: null, effort: null, speed: null}}],
    ['where', [], 'Where'], ['context', [], {Context: {all_threads: false, refresh: false, limit: 10n}}],
    ['usage', [], {Usage: {days: 7n}}], ['new', [s('prompt', 'p')], {New: {prompt: 'p'}}],
    ['ask', [s('prompt', 'p')], {Ask: {prompt: 'p'}}], ['interview', [s('prompt', 'p')], {Interview: {prompt: 'p'}}],
    ['doctor', [], 'Doctor'], ['approval', [], 'Approval'], ['runners', [], 'Runners'],
    ['retract', [], {Retract: {reference: null}}], ['mirror_check', [], 'MirrorCheck'],
    ['bridge_sync', [], {BridgeSync: {limit: null}}], ['qa_buttons', [], 'QaButtons'],
  ] as const;
  assert.deepEqual(cases.map(([name]) => name), slashCommandNames(true));
  for (const [name, options, expected] of cases) assert.deepEqual(plan(name, [...options]), expected, name);
});
test('integer clamping matches exact defaults and u32 bounds without IEEE-754 conversion', () => {
  for (const [name, field, max] of [['list', 'limit', 30n], ['archived_list', 'limit', 50n], ['context', 'limit', 30n], ['usage', 'days', 30n]] as const) {
    for (const [value, expected] of [[-(1n << 63n), 1n], [0n, 1n], [1n, 1n], [max, max], [(1n << 63n) - 1n, max]]) {
      const action = plan(name, [i(field, value!)]);
      assert.notEqual(typeof action, 'string');
      const body = Object.values(action)[0] as Record<string, unknown>;
      assert.equal(body[field], expected);
    }
  }
});
test('bridge_sync preserves optional signed i64 rather than clamping', () => {
  for (const value of [-(1n << 63n), -1n, 0n, 9007199254740993n, (1n << 63n) - 1n]) {
    const action = plan('bridge_sync', [i('limit', value)]);
    assert.deepEqual(action, {BridgeSync: {limit: value}});
    assert.equal(serializeSerdeValue(action), '{"BridgeSync":{"limit":' + value + '}}');
  }
});
test('context keeps explicit false and true while independently clamping limit', () => {
  assert.deepEqual(plan('context', [b('all_threads', true), b('refresh', false), i('limit', 0n)]),
    {Context: {all_threads: true, refresh: false, limit: 1n}});
});
test('references, settings and prompts trim Rust whitespace without changing internal content', () => {
  assert.deepEqual(plan('use', [s('ref', '\u0085 t \u0085')]), {Use: {reference: 't'}});
  assert.deepEqual(plan('status', [s('ref', ' t ')]), {Status: {reference: 't'}});
  assert.deepEqual(plan('retract', [s('ref', ' t ')]), {Retract: {reference: 't'}});
  assert.deepEqual(plan('settings', [s('ref', ' t '), s('model', ' model '), s('effort', ' high '), s('speed', ' fast ')]),
    {Settings: {reference: 't', model: 'model', effort: 'high', speed: 'fast'}});
  for (const command of ['new', 'ask', 'interview']) {
    const action = plan(command, [s('prompt', ' \n first  line\nsecond \u0085')]);
    assert.deepEqual(Object.values(action)[0], {prompt: 'first  line\nsecond'});
  }
});
test('blank optional strings are errors in source field order; BOM is not whitespace', () => {
  for (const field of ['ref', 'model', 'effort', 'speed']) {
    assert.throws(() => plan('settings', [s(field, '\u0085 \n')]),
      e => e instanceof CommandPlanError && e.kind === 'BlankOption' && e.value === field
        && e.message === 'slash command option must not be blank: ' + field);
  }
  assert.throws(() => plan('settings', [s('speed', ''), s('model', ''), s('ref', '')]),
    e => e instanceof CommandPlanError && e.value === 'ref');
  assert.deepEqual(plan('use', [s('ref', '\ufeff')]), {Use: {reference: '\ufeff'}});
  for (const command of ['use', 'new', 'ask', 'interview']) {
    const field = command === 'use' ? 'ref' : 'prompt';
    assert.throws(() => plan(command, [s(field, ' ')]), e => e instanceof CommandPlanError && e.value === field);
  }
});
test('missing required, legacy IPC and auto_reserve are rejected at the existing router boundary', () => {
  assert.throws(() => routed('ask'), /required option prompt is missing/);
  assert.throws(() => routed('ask_ipc', [s('prompt', 'p')]), /unknown Discord slash command/);
  assert.throws(() => routed('settings', [b('auto_reserve', true)]), /자동 Reserve/);
  assert.throws(() => routed('qa_buttons', [], false), /unknown Discord slash command/);
});
test('planner requires owned slash work and refuses autocomplete, component and structural forgeries', () => {
  let calls = 0;
  for (const value of [{Slash: {name: 'help', values: {}}}, new Proxy({}, {get() {calls++; throw new Error('get');}})]) {
    assert.throws(() => planSlash(value as RoutedInteractionWork), TypeError);
  }
  const component = decodeGatewayInteraction(serializeSerdeValue({
    application_id: '2', authorizing_integration_owners: {}, id: '4', token: 'fake', type: 3n,
    data: {custom_id: 'codex_approval:t:1', component_type: 2n},
  }));
  assert.throws(() => planSlash(routeGatewayComponent(component).work), TypeError);
  const autocomplete = decodeGatewayInteraction(serializeSerdeValue({
    application_id: '2', authorizing_integration_owners: {}, id: '4', token: 'fake', type: 4n,
    data: {id: '3', name: 'settings', type: 1n, options: [{...s('model', 'gpt'), focused: true}]},
  }));
  assert.throws(() => planSlash(routeGatewayCommand(autocomplete, false).work), TypeError);
  assert.equal(calls, 0);
});
test('planned actions are immutable and retain source external-tagged JSON integer tokens', () => {
  const action = plan('context');
  assert.ok(Object.isFrozen(action) && Object.isFrozen(Object.values(action)[0]));
  assert.equal(serializeSerdeValue(action), '{"Context":{"all_threads":false,"limit":10,"refresh":false}}');
  assert.equal(serializeSerdeValue(plan('help')), '"Help"');
});
