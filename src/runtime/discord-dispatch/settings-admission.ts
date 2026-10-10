import {isRoutedInteractionWork, type RoutedInteractionWork} from '../../discord/interaction-routing.ts';
import {StoreIntegrityError} from '../../store/schema-assembly.ts';
import {CommandPlanError, planSlash} from '../command-plan.ts';
import {SlashSettingsTargetResolver, isSlashSettingsMutation, isSettingsRequestRejection, settingsErrorText} from '../settings-binding.ts';
import type {FrozenSettingsBinding} from '../action-executor/settings-snapshot.ts';
export interface SettingsAdmission {
  readonly binding: FrozenSettingsBinding | null;
  readonly rejection: string | null;
}
const empty = (): SettingsAdmission => Object.freeze({binding: null, rejection: null});

/** Prepare only; the caller must persist binding/rejection in original custody.
 * Ordinary route/input rejection is recorded, while DB/custody errors stay fatal. */
export async function prepareSettingsAdmission(
  work: RoutedInteractionWork, resolver: SlashSettingsTargetResolver | null, channel: bigint,
): Promise<SettingsAdmission> {
  if (!isRoutedInteractionWork(work)) throw new TypeError('Expected owned routed work');
  if (!Object.hasOwn(work, 'Slash') || !('Slash' in work) || work.Slash.name !== 'settings') return empty();
  let action;
  try {action = planSlash(work);}
  catch (error) {
    if (!(error instanceof CommandPlanError)) throw error;
    return Object.freeze({binding: null, rejection: error.message});
  }
  if (!isSlashSettingsMutation(action)) return empty();
  if (resolver === null) throw new StoreIntegrityError('settings admission resolver is unavailable');
  try {
    return Object.freeze({binding: await SlashSettingsTargetResolver.prototype.bind.call(resolver, action, channel), rejection: null});
  } catch (error) {
    if (isSettingsRequestRejection(error)) return Object.freeze({binding: null, rejection: settingsErrorText(error)});
    throw new StoreIntegrityError(settingsErrorText(error));
  }
}
