import {AppServerInvalidReplyError} from './client-errors.ts';
import {validateInputQuestions, inputOptionLabels} from './input-validation.ts';
import {rustTrim, serdeField} from './value.ts';
import {requireDiscordText} from '../discord/text.ts';
import {parseRustU64} from '../config/remote.ts';
import {cloneOwnedSerdeValue} from '../core/owned-serde-value.ts';
export interface InputResponse {
  readonly payload: unknown;
  readonly answersByQuestion: Readonly<Record<string, readonly string[]>>;
}
function invalid(message: string): never {throw new AppServerInvalidReplyError(message);}
const asciiLower = (value: string): string => value.replace(/[A-Z]/g, c => c.toLowerCase());
const compare = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
export function splitInputValues(raw: string): readonly string[] {
  requireDiscordText(raw); return Object.freeze(raw.split('|').map(rustTrim).filter(value => value !== ''));
}
export function resolveInputAnswers(question: unknown, raw: string): readonly string[] {
  const values = splitInputValues(raw); if (values.length === 0) return invalid('Answer text was empty.');
  const labels = inputOptionLabels(question);
  return Object.freeze(values.map(value => {
    const index = parseRustU64(value);
    if (index !== null && index > 0n && index <= BigInt(labels.length)) return labels[Number(index - 1n)]!;
    return labels.find(label => asciiLower(label) === asciiLower(value)) ?? value;
  }));
}
/** Pure Rust reply grammar. It does not authorize secret input, select a pending
 * occurrence, or submit answers. JSON dictionaries replace BTreeMap at the API;
 * serializeSerdeValue preserves Rust UTF-8 key order when emitted on the wire. */
export function buildInputResponse(params: unknown, answer: string): InputResponse {
  const questions = validateInputQuestions(params); requireDiscordText(answer);
  const questionMap = new Map<string, unknown>();
  for (const question of questions) questionMap.set(rustTrim(serdeField(question, 'id') as string), question);
  const normalized = rustTrim(answer); if (normalized === '') return invalid('Answer text was empty.');
  const assignments = new Map<string, string>();
  if (questionMap.size === 1 && !normalized.includes('=')) assignments.set(questionMap.keys().next().value!, normalized);
  else for (const segment of normalized.split(';').map(rustTrim).filter(value => value !== '')) {
    const equal = segment.indexOf('=');
    if (equal < 0) return invalid('Multi-question replies must use question_id=value; other_id=value format.');
    const id = rustTrim(segment.slice(0, equal)); if (id === '') return invalid('A reply_input assignment was missing the question id.');
    assignments.set(id, rustTrim(segment.slice(equal + 1)));
  }
  const missing = [...questionMap.keys()].filter(id => !assignments.has(id)).sort(compare);
  if (missing.length) return invalid(`Missing answers for question ids: ${missing.join(', ')}`);
  const unknown = [...assignments.keys()].filter(id => !questionMap.has(id)).sort(compare);
  if (unknown.length) return invalid(`Unknown question ids: ${unknown.join(', ')}`);
  const entries = [...assignments].sort(([a], [b]) => compare(a, b)).map(([id, raw]) => [id, resolveInputAnswers(questionMap.get(id), raw)] as const);
  const answersByQuestion = cloneOwnedSerdeValue(Object.fromEntries(entries)) as Readonly<Record<string, readonly string[]>>;
  const payload = cloneOwnedSerdeValue({answers: Object.fromEntries(entries.map(([id, answers]) => [id, {answers}]))});
  return Object.freeze({payload, answersByQuestion});
}
