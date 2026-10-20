import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildInputResponse, resolveInputAnswers, splitInputValues} from '../../src/app-server/input-replies.ts';
import {serializeSerdeValue} from '../../src/core/serde-json.ts';
const question = {id: 'q', options: [{label: ' One '}, {label: 'TWO'}, {label: 'Ä'}]};
const params = {questions: [question]};
test('pipe splitting uses Rust whitespace and retains literal BOM and repeated values', () => {
  assert.deepEqual(splitInputValues(' | \u0085yes | no\n |yes|\ufeff|'), ['yes', 'no', 'yes', '\ufeff']);
  assert.deepEqual(splitInputValues('||'), []); assert.throws(() => splitInputValues('\ud800'), TypeError);
});
test('one-based native 64-bit indices resolve without rounding or permissive numeric parsing', () => {
  assert.deepEqual(resolveInputAnswers(question, '1|+2|0003|0|-1|1.0|1e0|４|18446744073709551615|18446744073709551616'), ['One', 'TWO', 'Ä', '0', '-1', '1.0', '1e0', '４', '18446744073709551615', '18446744073709551616']);
});
test('label matching is ASCII-only case insensitive and first-match wins', () => {
  assert.deepEqual(resolveInputAnswers(question, 'one|two|ä|Ä'), ['One', 'TWO', 'ä', 'Ä']);
  assert.deepEqual(resolveInputAnswers({options: [{label: 'Same'}, {label: 'same'}]}, 'SAME'), ['Same']);
  assert.deepEqual(resolveInputAnswers({}, 'free text|a=b'), ['free text', 'a=b']);
});
test('single question without equals treats semicolon as literal text; explicit equals splits only once', () => {
  assert.deepEqual(buildInputResponse(params, 'a;b').payload, {answers: {q: {answers: ['a;b']}}});
  assert.deepEqual(buildInputResponse(params, 'q=a=b').payload, {answers: {q: {answers: ['a=b']}}});
  assert.throws(() => buildInputResponse(params, 'a=b'), /Missing answers for question ids: q/);
});
test('multi question assignments trim ids, skip empty segments, overwrite duplicate id and resolve per question', () => {
  const result = buildInputResponse({questions: [{id: ' z '}, question]}, '; z=first; q=1|2; z=last;;');
  assert.deepEqual(result.answersByQuestion, {q: ['One', 'TWO'], z: ['last']});
  assert.deepEqual(result.payload, {answers: {q: {answers: ['One', 'TWO']}, z: {answers: ['last']}}});
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.answersByQuestion.q));
});
test('missing ids precede unknown ids and diagnostics use UTF-8 rather than UTF-16 order', () => {
  const p = {questions: [{id: '😀'}, {id: '\ue000'}]};
  assert.throws(() => buildInputResponse(p, 'other=yes'), /Missing answers for question ids: \ue000, 😀/);
  assert.throws(() => buildInputResponse(p, '😀=a;\ue000=b;😀x=c;\ue000x=d'), /Unknown question ids: \ue000x, 😀x/);
});
test('malformed assignments and empty answers preserve source error ordering', () => {
  const p = {questions: [{id: 'a'}, {id: 'b'}]};
  assert.throws(() => buildInputResponse(p, 'plain'), /Multi-question replies/);
  assert.throws(() => buildInputResponse(p, '=x'), /missing the question id/);
  assert.throws(() => buildInputResponse(p, 'a=;b=x'), /Answer text was empty/);
  assert.throws(() => buildInputResponse(params, '\u0085'), /Answer text was empty/);
  assert.throws(() => resolveInputAnswers({options: false}, '||'), /Answer text was empty/);
  assert.throws(() => buildInputResponse({questions: [question, {id: 'q'}]}, ''), /duplicate question ids/);
  assert.throws(() => buildInputResponse({questions: [{id: 'q', options: false}]}, ''), /options were not an array/);
});
test('special dictionary ids are safe own data and wire serialization preserves exact keys', () => {
  const p = {questions: [{id: '__proto__'}, {id: 'constructor'}, {id: '10'}, {id: '2'}]};
  const result = buildInputResponse(p, '__proto__=yes;constructor=no;2=two;10=ten');
  assert.ok(Object.hasOwn(result.answersByQuestion, '__proto__')); assert.deepEqual(result.answersByQuestion.__proto__, ['yes']);
  assert.equal(serializeSerdeValue(result.payload), '{"answers":{"10":{"answers":["ten"]},"2":{"answers":["two"]},"__proto__":{"answers":["yes"]},"constructor":{"answers":["no"]}}}');
});
test('input snapshots reject hooks and do not add secret-input authorization to the pure builder', () => {
  let hooks = 0; assert.throws(() => buildInputResponse({get questions() {hooks++; return [];}}, 'x'), TypeError); assert.equal(hooks, 0);
  const p = {questions: [{id: 'q', isSecret: true}]}; const result = buildInputResponse(p, 'local fixture'); p.questions[0]!.id = 'changed';
  assert.deepEqual(result.answersByQuestion, {q: ['local fixture']});
});
