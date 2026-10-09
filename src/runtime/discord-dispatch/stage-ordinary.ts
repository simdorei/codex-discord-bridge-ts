import {types} from 'node:util';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {StoreIntegrityError} from '../../store/schema-assembly.ts';
import {busyChoiceDataField, BusyChoiceUnavailableError} from '../../store/busy-choice.ts';
import type {NewIngress} from '../../store/ingress-types.ts';
import {now as systemNow} from '../../store/queue-attach-goal.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {isRoutedInteractionWork, type RoutedInteractionWork} from '../../discord/interaction-routing.ts';
import type {SlashSettingsTargetResolver} from '../settings-binding.ts';
import {prepareSettingsAdmission} from './settings-admission.ts';
import {interactionCustodyFromAdmission, readCustodyTimestamp, type InteractionCustodyStage, type CustodyOptions} from './staged-custody.ts';

export interface OrdinaryInteractionStageRequest {
  readonly applicationId: bigint;
  readonly interactionId: bigint;
  readonly channelId: bigint;
  readonly userId: bigint;
  readonly sourceMessageId: bigint | null;
  readonly work: RoutedInteractionWork;
}
export interface OrdinaryInteractionStageOptions {
  readonly settingsResolver: SlashSettingsTargetResolver | null;
  readonly cleanup: CustodyOptions;
}
export type OrdinaryInteractionStage = InteractionCustodyStage | {readonly kind: 'BusyChoiceUnavailable'};
const admit = state.admitIngress, admitMapped = state.admitMappedSlashIngress, admitBusy = state.admitBusyInteraction;
function u64(value: unknown): bigint {
  if (typeof value !== 'bigint' || value < 0n || value >= 1n << 64n) throw new TypeError('Expected u64 interaction identity');
  return value;
}
function i64(value: bigint, kind: string): bigint {
  if (value >= 1n << 63n) throw new StoreIntegrityError(`Discord ${kind} ID exceeds SQLite range`);
  return value;
}
function cleanupOptions(input: CustodyOptions): Required<CustodyOptions> {
  const report = busyChoiceDataField(input, 'report');
  // Optional own-data clock; inherited/getter values never become callbacks.
  if (input === null || typeof input !== 'object' || types.isProxy(input)) throw new TypeError('Expected custody options');
  const descriptor = Object.getOwnPropertyDescriptor(input, 'now');
  if (descriptor !== undefined && !Object.hasOwn(descriptor, 'value')) throw new TypeError('Expected own clock data');
  const now = descriptor === undefined || descriptor.value === undefined ? systemNow : descriptor.value;
  for (const value of [now, report]) {
    if (typeof value !== 'function' || types.isProxy(value) || types.isAsyncFunction(value) || types.isGeneratorFunction(value)) {
      throw new TypeError('Expected synchronous custody clock and reporter');
    }
  }
  return Object.freeze({now: now as () => number, report: report as CustodyOptions['report']});
}

/** Concrete durable stage for normal executable slash/ordinary component work.
 * Recovery publication/abandonment are EXCLUDED until original actor binding is
 * implemented; autocomplete must not enter executable custody. No fallback target,
 * callback token, HTTP acknowledgement or queue dispatch is created here.
 * Caller must await disposal of returned Created custody on every abandoned path. */
export async function stageOrdinaryInteraction(
  database: string, input: OrdinaryInteractionStageRequest, options: OrdinaryInteractionStageOptions,
): Promise<OrdinaryInteractionStage> {
  requireDiscordText(database);
  const field = (key: string): unknown => busyChoiceDataField(input, key);
  const application = u64(field('applicationId')), interaction = u64(field('interactionId'));
  const channel = u64(field('channelId')), user = u64(field('userId')), rawMessage = field('sourceMessageId');
  const sourceMessage = rawMessage === null ? null : u64(rawMessage), work = field('work');
  if (!isRoutedInteractionWork(work) || Object.hasOwn(work, 'Autocomplete')) throw new TypeError('Expected owned executable interaction work');
  const component = Object.hasOwn(work, 'Component') ? (work as Extract<RoutedInteractionWork, {Component: unknown}>).Component : null;
  const slash = Object.hasOwn(work, 'Slash') ? (work as Extract<RoutedInteractionWork, {Slash: unknown}>).Slash : null;
  if (component !== null && (Object.hasOwn(component, 'RecoveryPublicationDecision') || Object.hasOwn(component, 'RecoveryAbandonDecision'))) {
    throw new TypeError('Recovery interaction custody requires its original actor-binding implementation');
  }
  const cleanup = cleanupOptions(busyChoiceDataField(options, 'cleanup') as CustodyOptions);
  const resolver = busyChoiceDataField(options, 'settingsResolver') as SlashSettingsTargetResolver | null;
  // Original conversion order precedes settings lookup; application conversion is
  // later, as in NewIngress construction in Rust custody::stage.
  const interactionId = i64(interaction, 'interaction'), channelId = i64(channel, 'channel'), userId = i64(user, 'user');
  const sourceMessageId = sourceMessage === null ? null : i64(sourceMessage, 'source message');
  const ingressId = `interaction:${interactionId}`;
  const settings = await prepareSettingsAdmission(work, resolver, channel);
  const busy = component !== null && Object.hasOwn(component, 'Busy') ? (component as Extract<typeof component, {Busy: unknown}>).Busy : null;
  const applicationId = i64(application, 'application');
  const now = readCustodyTimestamp(cleanup.now);
  const request: NewIngress = {
    ingressId, kind: 'interaction', eventId: interactionId, applicationId, channelId, ownerUserId: userId, sourceMessageId,
    payload: {version: 1n, processing_mode: 'normal', work, settings_binding: settings.binding, request_rejection: settings.rejection},
    targetThreadId: settings.binding?.target ?? null,
    canonicalOwner: busy === null ? ingressId : `busy-choice:${busy.choice_id}`, now,
  };
  let admission;
  if (busy !== null) {
    const action = {Steer: 'steer', Queue: 'queue', Stop: 'stop', Ignore: 'ignore'}[busy.action];
    try {admission = await admitBusy(database, request, busy.choice_id, action);}
    catch (error) {
      if (error instanceof BusyChoiceUnavailableError) return Object.freeze({kind: 'BusyChoiceUnavailable'});
      throw error;
    }
  } else if (slash !== null && (slash.name === 'ask' || slash.name === 'interview')) {
    admission = await admitMapped(database, request);
  } else admission = await admit(database, request);
  return interactionCustodyFromAdmission(database, admission, busy !== null, cleanup);
}
