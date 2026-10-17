import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildServerPrompt, ServerPromptError} from '../../src/runtime/server-prompt.ts';
import {validateInputQuestions, inputOptionLabels} from '../../src/app-server/input-validation.ts';
import {AppServerInvalidReplyError} from '../../src/app-server/client-errors.ts';
import {ServerRequestOccurrence} from '../../src/protocol/ids.ts';
import type {PendingServerRequest} from '../../src/app-server/server-request-state.ts';
import {requestFingerprint, serializeDiscordComponent} from '../../src/discord/components.ts';
const occurrence = () => ServerRequestOccurrence.fromBytes(new Uint8Array(16).fill(3));
const request = (method: string, params: unknown, id: string | bigint = 'r'): PendingServerRequest => ({id, occurrence: occurrence(), method, params});
const input = (questions: unknown) => request('item/tool/requestUserInput', {threadId: ' t ', questions});
const q = (extra: Record<string, unknown> = {}) => ({id: 'q', question: 'Choose', options: [{label: 'One', description: 'first'}, {label: 'Two'}], ...extra});
const kind = (name: string) => (error: unknown) => error instanceof ServerPromptError && error.kind === name;
test('all five approval methods and URL elicitation produce occurrence-bound approval buttons', () => {
  for (const method of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'execCommandApproval', 'applyPatchApproval', 'mcpServer/elicitation/request']) {
    const prompt = buildServerPrompt(request(method, {threadId: ' t ', mode: 'url', reason: ' reason '}), 7n);
    assert.equal(prompt.threadId, 't'); assert.equal(prompt.text, `Approval required\nthread: t\nrequest: ${method}\ndetail: reason`);
    const row = JSON.parse(serializeDiscordComponent(prompt.components[0]!)); assert.equal(row.components.length, 4);
    assert.ok(row.components[0].custom_id.includes(requestFingerprint(7n, new Uint8Array(16).fill(3), 'r')));
    assert.ok(Object.isFrozen(prompt)); assert.ok(Object.isFrozen(prompt.components));
  }
});
test('approval detail precedence, array-string filtering and1000 scalar limit follow source trim', () => {
  const method = 'execCommandApproval';
  const detail = (params: Record<string, unknown>) => buildServerPrompt(request(method, {threadId: 't', ...params}), 0n).text.split('\ndetail: ')[1];
  assert.equal(detail({reason: '\u0085 ', command: [' echo ', 3n, 'yes'], message: 'ignored'}), 'echo  yes');
  assert.equal(detail({reason: '\ufeff', command: 'ignored'}), '\ufeff');
  assert.equal(detail({reason: '😀'.repeat(1001)}), '😀'.repeat(1000));
  assert.equal(detail({reason: {}, command: [], message: '  '}), method);
});
test('missing thread precedes unsupported method; non-URL elicitation stays unsupported', () => {
  assert.throws(() => buildServerPrompt(request('unknown', {}), 1n), kind('MissingThread'));
  assert.throws(() => buildServerPrompt(request('unknown', {threadId: 't'}), 1n), kind('Unsupported'));
  assert.throws(() => buildServerPrompt(request('mcpServer/elicitation/request', {threadId: 't', mode: 'form'}), 1n), kind('Unsupported'));
});
test('single input renders exact questions/descriptions/help and bound numeric choice buttons', () => {
  const prompt = buildServerPrompt(input([q()]), 7n), fp = requestFingerprint(7n, new Uint8Array(16).fill(3), 'r');
  assert.equal(prompt.text, `Codex needs input\nthread: t\n1. Choose [q]\n   1. One — first\n   2. Two\nReply in this channel with an option number, label, or free text.\nFor this exact request, copy the prefix and replace <answer>:\n[codex-reply:${fp}] <answer>`);
  const row = JSON.parse(serializeDiscordComponent(prompt.components[0]!)); assert.equal(row.components.length, 2);
  assert.ok(row.components[0].custom_id.endsWith(':1')); assert.ok(row.components[1].custom_id.endsWith(':2'));
});
test('multiple questions suppress buttons and retain raw IDs only in copyable pair example', () => {
  const prompt = buildServerPrompt(input([q({id: ' a '}), q({id: 'b', question: 'Second', options: null})]), 1n);
  assert.deepEqual(prompt.components, []); assert.match(prompt.text, /1\. Choose \[a\]/);
  assert.ok(prompt.text.includes('example:  a =1; b=1. Use | for multiple selections.'));
});
test('free text input accepts absent/null/empty options; more than five options stay in text with only five buttons', () => {
  for (const options of [undefined, null, []]) {
    const question = options === undefined ? {id: 'q', question: 'Write'} : {id: 'q', question: 'Write', options};
    assert.deepEqual(buildServerPrompt(input([question]), 1n).components, []);
  }
  const prompt = buildServerPrompt(input([q({options: Array.from({length: 7}, (_, i) => ({label: 'option' + i}))})]), 1n);
  assert.ok(prompt.text.includes('7. option6')); assert.equal(JSON.parse(serializeDiscordComponent(prompt.components[0]!)).components.length, 5);
});
test('secret questions never produce Discord UI, after full structural question validation', () => {
  assert.throws(() => buildServerPrompt(input([q({isSecret: true})]), 1n), kind('SecretInput'));
  assert.throws(() => buildServerPrompt(input([q({isSecret: true}), q({id: 'x', options: false})]), 1n), kind('InvalidQuestions'));
  assert.equal(buildServerPrompt(input([q({isSecret: 'true'})]), 1n).components.length, 1);
});
test('shared input validator rejects missing/duplicate trimmed IDs and malformed option labels', () => {
  for (const questions of [[], null, [q({id: ''})], [q({id: 'a'}), q({id: ' a '})], [q({options: false})], [q({options: [{label: ''}]})]]) {
    assert.throws(() => validateInputQuestions({questions}), AppServerInvalidReplyError);
    assert.throws(() => buildServerPrompt(input(questions), 1n), kind('InvalidQuestions'));
  }
  assert.throws(() => buildServerPrompt(input([q({question: ' '})]), 1n), kind('InvalidQuestions'));
  assert.deepEqual(inputOptionLabels({options: [{label: '\u0085One '}, {label: '\ufeff'}]}), ['One', '\ufeff']);
});
test('generation, request ID variant and occurrence all bind the exact request fingerprint', () => {
  const base = request('execCommandApproval', {threadId: 't'}, 7n), a = buildServerPrompt(base, 1n);
  const fingerprints = [a, buildServerPrompt({...base, id: '7'}, 1n), buildServerPrompt({...base, occurrence: ServerRequestOccurrence.fromBytes(new Uint8Array(16).fill(4))}, 1n), buildServerPrompt(base, 2n)].map(v => serializeDiscordComponent(v.components[0]!));
  assert.equal(new Set(fingerprints).size, 4); assert.throws(() => buildServerPrompt(base, -1n), TypeError);
});
test('snapshot validation rejects active JSON hooks and isolates caller changes', () => {
  let hits = 0; assert.throws(() => validateInputQuestions({get questions() {hits++; return [q()];}}), TypeError); assert.equal(hits, 0);
  const params = {questions: [q()]}, validated = validateInputQuestions(params); params.questions.length = 0;
  assert.equal(validated.length, 1); assert.ok(Object.isFrozen(validated));
  const params2 = {threadId: 't', questions: [q()]}, rendered = buildServerPrompt(request('item/tool/requestUserInput', params2), 1n);
  params2.questions[0]!.question = 'changed'; assert.match(rendered.text, /Choose/);
});
