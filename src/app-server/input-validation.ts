import {cloneOwnedSerdeValue} from '../core/owned-serde-value.ts';
import {AppServerInvalidReplyError} from './client-errors.ts';
import {serdeField, rustTrim} from './value.ts';
function invalid(message: string): never {throw new AppServerInvalidReplyError(message);}
function labels(question: unknown): string[] {
  const options = serdeField(question, 'options'); if (options === undefined || options === null) return [];
  if (!Array.isArray(options)) return invalid('Pending input options were not an array.');
  return options.map(option => {
    const label = serdeField(option, 'label');
    if (typeof label !== 'string' || rustTrim(label) === '') return invalid('Pending input option had a missing or empty label.');
    return rustTrim(label);
  });
}
/** Shared structural validation for displaying/answering decoded input; returns
 * an immutable snapshot instead of borrowing a mutable caller object. */
export function validateInputQuestions(params: unknown): readonly unknown[] {
  const captured = cloneOwnedSerdeValue(params), questions = serdeField(captured, 'questions');
  if (!Array.isArray(questions) || questions.length === 0) return invalid('No pending input questions were available.');
  const ids = new Set<string>();
  for (const question of questions) {
    const raw = serdeField(question, 'id');
    if (typeof raw !== 'string' || rustTrim(raw) === '') return invalid('Pending input question did not include an id.');
    const id = rustTrim(raw); if (ids.has(id)) return invalid('Pending input contained duplicate question ids.'); ids.add(id); labels(question);
  }
  return questions;
}
export function inputOptionLabels(question: unknown): readonly string[] {return Object.freeze(labels(cloneOwnedSerdeValue(question)));}
