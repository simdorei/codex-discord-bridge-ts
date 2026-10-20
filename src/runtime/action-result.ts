import {types} from 'node:util';
import {gatewayOwnField} from '../discord/gateway/values.ts';
import {requireDiscordText} from '../discord/text.ts';
import {isPreparedPrompt, type PreparedPrompt} from './server-prompt-redisplay.ts';
export type PromptActionUi = {readonly kind: 'Busy'; readonly choiceId: string; readonly allowSteer: boolean}
  | {readonly kind: 'ProBusy'; readonly choiceId: string};
export type ActionUi = PromptActionUi | {readonly kind: 'ServerPrompts'; readonly prompts: readonly PreparedPrompt[]};
export interface ActionResult {readonly text: string; readonly waitsForFinal: boolean; readonly ui: ActionUi | null}
/** Capture result data before delivery awaits; prompt snapshots must come from
 * verified preparation. This is not a substitute for per-chunk revalidation. */
export function snapshotActionResult(input: ActionResult): ActionResult {
  const text = gatewayOwnField(input, 'text'), waitsForFinal = gatewayOwnField(input, 'waitsForFinal'), raw = gatewayOwnField(input, 'ui');
  requireDiscordText(text); if (typeof waitsForFinal !== 'boolean') throw new TypeError('Expected action completion flag');
  let ui: ActionUi | null = null;
  if (raw !== null) {
    const kind = gatewayOwnField(raw, 'kind');
    if (kind === 'Busy' || kind === 'ProBusy') {
      const choiceId = gatewayOwnField(raw, 'choiceId'); requireDiscordText(choiceId);
      if (kind === 'ProBusy') ui = Object.freeze({kind, choiceId});
      else {const allowSteer = gatewayOwnField(raw, 'allowSteer'); if (typeof allowSteer !== 'boolean') throw new TypeError('Expected steer flag'); ui = Object.freeze({kind, choiceId, allowSteer});}
    } else if (kind === 'ServerPrompts') {
      const values = gatewayOwnField(raw, 'prompts'); if (!Array.isArray(values) || types.isProxy(values)) throw new TypeError('Expected prepared prompt array');
      const prompts: PreparedPrompt[] = [];
      for (let i = 0; i < values.length; i++) {const prompt = gatewayOwnField(values, String(i)); if (!isPreparedPrompt(prompt)) throw new TypeError('Expected prepared prompt snapshot'); prompts.push(prompt);}
      ui = Object.freeze({kind, prompts: Object.freeze(prompts)});
    } else throw new TypeError('Expected action UI variant');
  }
  return Object.freeze({text, waitsForFinal, ui});
}
