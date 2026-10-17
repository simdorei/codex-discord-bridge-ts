import assert from 'node:assert/strict';
import {test} from 'node:test';
import {decodeGatewayInteraction} from '../../../src/discord/gateway/decoded-interaction.ts';
import {routeGatewayCommand, type RoutedInteractionWork} from '../../../src/discord/interaction-routing.ts';
import {AutocompleteCatalog} from '../../../src/runtime/discord-dispatch/autocomplete.ts';
import {interactionDispatchResponse} from '../../../src/runtime/discord-dispatch/response.ts';
import {autocompleteResponse, deferredChannelResponse, interactionMessage, serializeInteractionResponse} from '../../../src/discord/interaction-response.ts';

function input(option = 'model', current = '', selected: string | null = null, type = 4) {
  return decodeGatewayInteraction(JSON.stringify({
    application_id: '2', authorizing_integration_owners: {}, channel_id: '10', id: '4',
    token: 'offline-token', type, user: {id: '20', username: 'tester', discriminator: '0001'},
    data: {id: '3', name: type === 4 ? 'settings' : 'help', type: 1,
      options: type === 4 ? [
        ...(selected === null ? [] : [{name: 'model', type: 3, value: selected}]),
        {name: option, type: 3, value: current, focused: true},
      ] : []},
  }));
}
const work = (option = 'model', current = '', selected: string | null = null) => routeGatewayCommand(input(option, current, selected), false).work;
const names = (catalog: AutocompleteCatalog, invocation = work()) => catalog.choices(invocation).map(choice => choice.name);
const row = (model: string, efforts: string[] = []) => ({model, supportedReasoningEfforts: efforts.map(reasoningEffort => ({reasoningEffort}))});

test('model list keeps first insertion order, merges effort lists, and hides only boolean true', () => {
  const catalog = new AutocompleteCatalog(JSON.stringify({data: [
    row(' z ', [' low ', 'high']), row('a', ['high', 'max']), row('z', ['low', 'medium']),
    {model: 'invisible', hidden: true}, {model: 'visible', hidden: 'true'},
  ]}));
  assert.deepEqual(names(catalog), ['z', 'a', 'visible']);
  assert.deepEqual(names(catalog, work('effort', '', 'z')), ['low', 'high', 'medium']);
});
test('empty or non-string model falls back to id and malformed rows are ignored', () => {
  const catalog = new AutocompleteCatalog(JSON.stringify({data: [
    null, 1, [], {}, {model: ' \u0085 ', id: ' alternate '}, {model: 2, id: 'id-model'},
    {model: 'preferred', id: 'ignored'}, {model: false, id: false},
  ]}));
  assert.deepEqual(names(catalog), ['alternate', 'id-model', 'preferred']);
});
test('effort fallback is BTreeMap model order, deduplicated by first occurrence', () => {
  const catalog = new AutocompleteCatalog(JSON.stringify({data: [
    row('z', ['high', 'low']), row('a', ['max', 'high']), row('b', ['medium']),
  ]}));
  assert.deepEqual(names(catalog, work('effort')), ['max', 'high', 'medium', 'low']);
  assert.deepEqual(names(catalog, work('effort', '', 'missing')), ['max', 'high', 'medium', 'low']);
});
test('BTreeMap fallback uses Unicode scalar order rather than UTF-16 order', () => {
  const catalog = new AutocompleteCatalog(JSON.stringify({data: [row('😀', ['astral']), row('\ue000', ['bmp'])]}));
  assert.deepEqual(names(catalog, work('effort')), ['bmp', 'astral']);
});
test('known model with no efforts returns empty; selected model is not trimmed', () => {
  const catalog = new AutocompleteCatalog(JSON.stringify({data: [row('empty'), row('populated', ['high'])]}));
  assert.deepEqual(names(catalog, work('effort', '', 'empty')), []);
  assert.deepEqual(names(catalog, work('effort', '', ' empty ')), ['high']);
});
test('matching trims Rust whitespace and folds only ASCII letters', () => {
  const catalog = new AutocompleteCatalog(JSON.stringify({data: [row('GPT-Ä'), row('gpt-ä'), row('gpt-İ'), row('gpt-i')]}));
  assert.deepEqual(names(catalog, work('model', '\u0085 GPT-Ä \u0085')), ['GPT-Ä']);
  assert.deepEqual(names(catalog, work('model', 'GPT-i')), ['gpt-i']);
});
test('Rust trim removes NEL but preserves BOM in model names and search', () => {
  const catalog = new AutocompleteCatalog(JSON.stringify({data: [row('\u0085 A \u0085'), row('\ufeffB\ufeff')]}));
  assert.deepEqual(names(catalog), ['A', '\ufeffB\ufeff']);
  assert.deepEqual(names(catalog, work('model', '\ufeffB')), ['\ufeffB\ufeff']);
  assert.deepEqual(names(catalog, work('model', '\ufeffA')), []);
});
test('filtering happens before 25-choice cap and source does not truncate long strings', () => {
  const long = 'x'.repeat(130);
  const catalog = new AutocompleteCatalog(JSON.stringify({data: [
    ...Array.from({length: 30}, (_, i) => row('first-' + i)),
    ...Array.from({length: 30}, (_, i) => row('match-' + i)), row(long),
  ]}));
  assert.equal(names(catalog).length, 25);
  assert.deepEqual(names(catalog, work('model', 'match-')), Array.from({length: 25}, (_, i) => 'match-' + i));
  assert.deepEqual(catalog.choices(work('model', long)), [{name: long, value: long}]);
});
test('empty and non-object JSON have empty catalogues; invalid JSON stays an input error', () => {
  for (const json of ['{}', 'null', '1', '[]', '{"data":{}}']) assert.deepEqual(names(new AutocompleteCatalog(json)), []);
  assert.throws(() => new AutocompleteCatalog('{'), SyntaxError);
  assert.throws(() => new AutocompleteCatalog('{"data":[{"model":"\\ud800"}]}'));
});
test('catalogue and choices are immutable and unowned invocation does not execute hooks', () => {
  const catalog = new AutocompleteCatalog(JSON.stringify({data: [row('one')]}));
  const choices = catalog.choices(work());
  assert.ok(Object.isFrozen(catalog) && Object.isFrozen(choices) && Object.isFrozen(choices[0]));
  let calls = 0;
  assert.throws(() => catalog.choices(new Proxy({}, {get() {calls++; throw new Error('get');}}) as RoutedInteractionWork), TypeError);
  assert.equal(calls, 0);
  assert.throws(() => catalog.choices(routeGatewayCommand(input('model', '', null, 2), false).work), TypeError);
});
test('normal autocomplete response contains string choices with omitted localizations', () => {
  const interaction = input(), routed = routeGatewayCommand(interaction, false).work;
  const response = interactionDispatchResponse(interaction, 'Normal', interactionMessage('initial', true), routed,
    new AutocompleteCatalog(JSON.stringify({data: [row('model-a')]})));
  assert.equal(serializeInteractionResponse(response), '{"type":8,"data":{"choices":[{"name":"model-a","value":"model-a"}]}}');
});
test('busy/stopping autocomplete and denied autocomplete return empty choices without catalogue access', () => {
  const interaction = input(), routed = routeGatewayCommand(interaction, false).work;
  let calls = 0; const unused = new Proxy({}, {get() {calls++; throw new Error('get');}}) as AutocompleteCatalog;
  for (const tag of ['Busy', 'Stopping'] as const) {
    assert.equal(serializeInteractionResponse(interactionDispatchResponse(interaction, tag, interactionMessage('denied', true), routed, unused)), '{"type":8,"data":{"choices":[]}}');
  }
  assert.equal(serializeInteractionResponse(interactionDispatchResponse(interaction, 'Normal', interactionMessage('denied', true), null, unused)), '{"type":8,"data":{"choices":[]}}');
  assert.equal(calls, 0);
});
test('reserved non-autocomplete work replaces defer with exact ephemeral busy/stopping messages', () => {
  const interaction = input('model', '', null, 2), routed = routeGatewayCommand(interaction, false).work;
  const initial = deferredChannelResponse(), catalog = new AutocompleteCatalog();
  assert.equal(interactionDispatchResponse(interaction, 'Normal', initial, routed, catalog), initial);
  for (const [tag, text] of [['Busy', 'Codex Discord is busy. Please retry shortly.'], ['Stopping', 'Codex Discord is stopping. Please retry after restart.']] as const) {
    const response = JSON.parse(serializeInteractionResponse(interactionDispatchResponse(interaction, tag, initial, routed, catalog)));
    assert.deepEqual(response, {type: 4, data: {allowed_mentions: {parse: []}, content: text, flags: 64}});
    assert.equal(interactionDispatchResponse(interaction, tag, initial, null, catalog), initial);
  }
});
test('autocomplete response owns a copy of supported strings and rejects oversized choice arrays', () => {
  const source = [{name: 'a', value: 'b'}], response = autocompleteResponse(source);
  source[0]!.name = 'changed'; source.push({name: 'c', value: 'd'});
  assert.equal(serializeInteractionResponse(response), '{"type":8,"data":{"choices":[{"name":"a","value":"b"}]}}');
  assert.throws(() => autocompleteResponse(Array.from({length: 26}, () => ({name: 'a', value: 'a'}))), TypeError);
  assert.throws(() => autocompleteResponse([{name: '\ud800', value: 'a'}]), TypeError);
});
