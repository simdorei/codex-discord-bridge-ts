import {rustTrim} from '../app-server/value.ts';
import {AUTO_RESERVE_REMOVED, isRoutedInteractionWork, slashBoolean, slashHasOption, slashInteger, slashString,
  type RoutedInteractionWork, type SlashInvocation} from '../discord/interaction-routing.ts';

export type SlashCommandAction =
  | 'Help' | 'Where' | 'Doctor' | 'Approval' | 'Runners' | 'MirrorCheck' | 'QaButtons'
  | {readonly List: {readonly limit: bigint}}
  | {readonly ArchivedList: {readonly limit: bigint}}
  | {readonly Use: {readonly reference: string}}
  | {readonly Status: {readonly reference: string | null}}
  | {readonly Settings: {readonly reference: string | null; readonly model: string | null; readonly effort: string | null; readonly speed: string | null}}
  | {readonly Context: {readonly all_threads: boolean; readonly refresh: boolean; readonly limit: bigint}}
  | {readonly Usage: {readonly days: bigint}}
  | {readonly New: {readonly prompt: string}}
  | {readonly Ask: {readonly prompt: string}}
  | {readonly Interview: {readonly prompt: string}}
  | {readonly Retract: {readonly reference: string | null}}
  | {readonly BridgeSync: {readonly limit: bigint | null}};

export class CommandPlanError extends Error {
  readonly kind: 'Unsupported' | 'MissingOption' | 'BlankOption';
  readonly value: string;
  constructor(kind: 'Unsupported' | 'MissingOption' | 'BlankOption', value: string) {
    super(kind === 'Unsupported' ? `unsupported slash command: ${value}`
      : kind === 'MissingOption' ? `required slash command option is unavailable: ${value}`
      : `slash command option must not be blank: ${value}`);
    this.name = 'CommandPlanError'; this.kind = kind; this.value = value;
  }
}
function required(invocation: SlashInvocation, name: string): string {
  const value = slashString(invocation, name);
  if (value === null) throw new CommandPlanError('MissingOption', name);
  const trimmed = rustTrim(value);
  if (trimmed === '') throw new CommandPlanError('BlankOption', name);
  return trimmed;
}
function optional(invocation: SlashInvocation, name: string): string | null {
  return slashString(invocation, name) === null ? null : required(invocation, name);
}
function bounded(raw: bigint | null, fallback: bigint, max: bigint): bigint {
  const value = raw ?? fallback;
  return value < 1n ? 1n : value > max ? max : value;
}
function owned<T extends Exclude<SlashCommandAction, string>>(action: T): T {
  for (const value of Object.values(action)) Object.freeze(value);
  return Object.freeze(action);
}

/** Source plan_slash for the complete registered slash inventory. Input is the
 * existing decoder/router's owned work; no execution, state lookup or token.
 * External-tagged JSON shape is retained; u32/i64 are bigint for integer tokens.
 * This is not the full text-command parser or all CommandAction deserialization. */
export function planSlash(work: RoutedInteractionWork): SlashCommandAction {
  if (!isRoutedInteractionWork(work) || !Object.hasOwn(work, 'Slash')) throw new TypeError('Expected owned routed slash work');
  const invocation = (work as Extract<RoutedInteractionWork, {Slash: unknown}>).Slash;
  switch (invocation.name) {
    case 'help': return 'Help';
    case 'list': return owned({List: {limit: bounded(slashInteger(invocation, 'limit'), 10n, 30n)}});
    case 'archived_list': return owned({ArchivedList: {limit: bounded(slashInteger(invocation, 'limit'), 10n, 50n)}});
    case 'use': return owned({Use: {reference: required(invocation, 'ref')}});
    case 'status': return owned({Status: {reference: optional(invocation, 'ref')}});
    case 'settings':
      if (slashHasOption(invocation, 'auto_reserve')) throw new CommandPlanError('Unsupported', AUTO_RESERVE_REMOVED);
      return owned({Settings: {reference: optional(invocation, 'ref'), model: optional(invocation, 'model'),
        effort: optional(invocation, 'effort'), speed: optional(invocation, 'speed')}});
    case 'where': return 'Where';
    case 'context': return owned({Context: {all_threads: slashBoolean(invocation, 'all_threads') ?? false,
      refresh: slashBoolean(invocation, 'refresh') ?? false, limit: bounded(slashInteger(invocation, 'limit'), 10n, 30n)}});
    case 'usage': return owned({Usage: {days: bounded(slashInteger(invocation, 'days'), 7n, 30n)}});
    case 'new': return owned({New: {prompt: required(invocation, 'prompt')}});
    case 'ask': return owned({Ask: {prompt: required(invocation, 'prompt')}});
    case 'interview': return owned({Interview: {prompt: required(invocation, 'prompt')}});
    case 'doctor': return 'Doctor';
    case 'approval': return 'Approval';
    case 'runners': return 'Runners';
    case 'retract': return owned({Retract: {reference: optional(invocation, 'ref')}});
    case 'mirror_check': return 'MirrorCheck';
    case 'bridge_sync': return owned({BridgeSync: {limit: slashInteger(invocation, 'limit')}});
    case 'qa_buttons': return 'QaButtons';
    default: throw new CommandPlanError('Unsupported', invocation.name);
  }
}
