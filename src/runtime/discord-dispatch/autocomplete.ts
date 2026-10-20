import {parseSerdeValue} from '../../core/serde-json-parse.ts';
import {serdeField, rustTrim} from '../../app-server/value.ts';
import {isRoutedInteractionWork, type RoutedInteractionWork} from '../../discord/interaction-routing.ts';
import type {AutocompleteChoice} from '../../discord/interaction-response.ts';

const asciiLower = (value: string): string => value.replace(/[A-Z]/g, char => char.toLowerCase());
function clean(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const result = rustTrim(value);
  return result === '' ? null : result;
}
function pushUnique(target: string[], value: string): void {
  if (!target.includes(value)) target.push(value);
}

/** Immutable snapshot of source model/list JSON. Parsed JSON is the explicit
 * input boundary, avoiding caller getters and preserving existing Serde parsing.
 * Source does not truncate long model/effort labels or Unicode-fold matching. */
export class AutocompleteCatalog {
  readonly #models: readonly string[];
  readonly #efforts: ReadonlyMap<string, readonly string[]>;

  constructor(modelListJson = '{}') {
    const input: unknown = parseSerdeValue(modelListJson);
    const models: string[] = [], efforts = new Map<string, string[]>();
    const data = serdeField(input, 'data');
    for (const row of Array.isArray(data) ? data : []) {
      if (serdeField(row, 'hidden') === true) continue;
      const model = clean(serdeField(row, 'model')) ?? clean(serdeField(row, 'id'));
      if (model === null) continue;
      pushUnique(models, model);
      let values = efforts.get(model);
      if (values === undefined) {values = []; efforts.set(model, values);}
      const supported = serdeField(row, 'supportedReasoningEfforts');
      for (const effort of Array.isArray(supported) ? supported : []) {
        const value = clean(serdeField(effort, 'reasoningEffort'));
        if (value !== null) pushUnique(values, value);
      }
    }
    this.#models = Object.freeze(models);
    // Rust BTreeMap<String, _> sorts by UTF-8/codepoint order, not JS UTF-16 order.
    this.#efforts = new Map([...efforts].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
      .map(([model, values]) => [model, Object.freeze(values)]));
    Object.freeze(this);
  }

  choices(work: RoutedInteractionWork): readonly AutocompleteChoice[] {
    if (!isRoutedInteractionWork(work) || !Object.hasOwn(work, 'Autocomplete')) {
      throw new TypeError('Expected owned routed autocomplete work');
    }
    const invocation = (work as Extract<RoutedInteractionWork, {Autocomplete: unknown}>).Autocomplete;
    let values: readonly string[];
    if (invocation.option_name === 'model') values = this.#models;
    else if (invocation.option_name === 'effort') {
      const selected = invocation.selected_model === null ? undefined : this.#efforts.get(invocation.selected_model);
      if (selected !== undefined) values = selected;
      else {
        const all: string[] = [];
        for (const entries of this.#efforts.values()) for (const value of entries) pushUnique(all, value);
        values = all;
      }
    } else values = [];
    const current = asciiLower(rustTrim(invocation.current));
    const choices: AutocompleteChoice[] = [];
    for (const value of values) {
      if (current !== '' && !asciiLower(value).includes(current)) continue;
      choices.push(Object.freeze({name: value, value}));
      if (choices.length === 25) break;
    }
    return Object.freeze(choices);
  }
}
Object.freeze(AutocompleteCatalog.prototype);
