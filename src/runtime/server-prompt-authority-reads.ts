import {types} from 'node:util';
import {gatewayOwnField} from '../discord/gateway/values.ts';
import {requireDiscordText} from '../discord/text.ts';
import {StateAccessFacade, type IStateAccessFacade} from '../store/state-access-facade.ts';
import {createNativeControlReads} from './action-executor/control-evidence-state.ts';
import {createNativePromptIntakeState} from './prompt-intake/native-state.ts';
import {createNativeQueueReadState} from './queue-runner/native-read-state.ts';
export type PromptAuthorityReads = Pick<IStateAccessFacade, 'hasObservedCompletion' | 'listQueueJobs' | 'mirroredThreadId'>;
/** Passive own-data functions, captured before the caller's first await. Every
 * invocation is a fresh, separately joined observation of the original path.
 * This port grants no response permission and never catches or replaces errors. */
export function capturePromptAuthorityReads(path: string, input: PromptAuthorityReads = StateAccessFacade): PromptAuthorityReads {
  requireDiscordText(path);
  const capture = <K extends keyof PromptAuthorityReads>(key: K): PromptAuthorityReads[K] => {
    const fn = gatewayOwnField(input, key);
    if (typeof fn !== 'function' || types.isProxy(fn) || types.isGeneratorFunction(fn)) throw new TypeError('Expected passive prompt authority read');
    return fn as PromptAuthorityReads[K];
  };
  const completed = capture('hasObservedCompletion'), jobs = capture('listQueueJobs'), mapping = capture('mirroredThreadId');
  const check = (given: string) => {if (given !== path) throw new TypeError('Prompt authority reads belong to another database');};
  const promise = <T>(value: Promise<T>): Promise<T> => {if (!types.isPromise(value)) throw new TypeError('Expected prompt authority read Promise'); return value;};
  return Object.freeze({
    hasObservedCompletion: (given, thread, turn) => {check(given); return promise(Reflect.apply(completed, undefined, [given, thread, turn]));},
    listQueueJobs: given => {check(given); return promise(Reflect.apply(jobs, undefined, [given]));},
    mirroredThreadId: (given, channel) => {check(given); return promise(Reflect.apply(mapping, undefined, [given, channel]));},
  });
}
/** Installed standard approval/input profile only. All three existing adapters
 * use existing-only stores and bounded zero-queue Control admission, and join
 * actual native exit on errors, deadlines and cancellation. No combined SQL
 * snapshot, cached result, filtered queue substitute or compatibility fallback. */
export function createNativePromptAuthorityReads(path: string): PromptAuthorityReads {
  const mapping = createNativePromptIntakeState(path).mirroredThreadId;
  const control = createNativeControlReads(path, mapping), list = createNativeQueueReadState(path).listFiltered;
  // Null filters run the same allJobs SQL/decoder as source listQueueJobs.
  return capturePromptAuthorityReads(path, {...control, listQueueJobs: given => list(given, null, null)});
}
