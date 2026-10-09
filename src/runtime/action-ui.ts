import {types} from 'node:util';
import {busyButtonRow, proBusyButtonRow, serializeDiscordComponent, ComponentError, type DiscordComponent} from '../discord/components.ts';
import {gatewayOwnField} from '../discord/gateway/values.ts';
import type {PromptActionUi} from './action-result.ts';
/** Read projection only. Server prompt authorization/request/generation fields
 * belong to the future full PreparedPrompt owner, not this rendering function. */
export type RenderableActionUi = PromptActionUi | {readonly kind: 'ServerPrompts';
  readonly prompts: readonly {readonly prompt: {readonly components: readonly DiscordComponent[]}}[]};
function array(value: unknown): readonly unknown[] {if (!Array.isArray(value) || types.isProxy(value)) throw new ComponentError('Invalid'); return value;}
export function renderActionUi(ui: RenderableActionUi | null): readonly DiscordComponent[] {
  if (ui === null) return Object.freeze([]);
  const kind = gatewayOwnField(ui, 'kind');
  if (kind === 'Busy') return Object.freeze([busyButtonRow(gatewayOwnField(ui, 'choiceId') as string, gatewayOwnField(ui, 'allowSteer') as boolean)]);
  if (kind === 'ProBusy') return Object.freeze([proBusyButtonRow(gatewayOwnField(ui, 'choiceId') as string)]);
  if (kind !== 'ServerPrompts') throw new ComponentError('Invalid');
  const prompts = array(gatewayOwnField(ui, 'prompts')), rows: DiscordComponent[] = [];
  for (let i = 0; i < prompts.length; i++) {
    const prompt = gatewayOwnField(gatewayOwnField(prompts, String(i)), 'prompt');
    const components = array(gatewayOwnField(prompt, 'components'));
    for (let j = 0; j < components.length; j++) {
      const component = gatewayOwnField(components, String(j)) as DiscordComponent; serializeDiscordComponent(component); rows.push(component);
    }
  }
  if (rows.length > 5) throw new ComponentError('Invalid');
  return Object.freeze(rows);
}
