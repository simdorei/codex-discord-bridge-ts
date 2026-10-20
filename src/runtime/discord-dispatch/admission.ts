import {AdmissionGate, type AdmissionPermit} from '../../admission/drain-gate.ts';
import {drainGateErrorInfo} from '../../admission/owned-key.ts';
import {isRoutedInteractionWork, type RoutedInteractionWork} from '../../discord/interaction-routing.ts';
import {InteractionDispatchError} from './errors.ts';

export interface InteractionAdmission {
  readonly permit: AdmissionPermit | null;
  readonly sealed: boolean;
}
const enter = AdmissionGate.prototype.tryEnter;
// Capture the primitive observed entry: tryEnterControl delegates through an
// overridable instance method. Only the permit is used here, like Rust admit().
const enterControl = AdmissionGate.prototype.tryEnterControlObserved;

export function isInteractionDrainControl(work: RoutedInteractionWork): boolean {
  if (!isRoutedInteractionWork(work)) throw new TypeError('Expected owned routed interaction work');
  if (!Object.hasOwn(work, 'Component')) return false;
  const component = (work as {Component: import('../../discord/components.ts').ComponentId}).Component;
  return Object.hasOwn(component, 'Approval') || Object.hasOwn(component, 'BoundApproval')
    || Object.hasOwn(component, 'Input') || Object.hasOwn(component, 'BoundInput')
    || (Object.hasOwn(component, 'Busy') && 'Busy' in component && component.Busy.action === 'Stop');
}

/** Borrowed shared gate. A returned permit must be transferred with work or
 * released by the caller on EVERY response/error/deadline/duplicate path.
 * An admitted control reports sealed=false even during draining: the boolean
 * denotes rejected admission, not the gate's current sealed state.
 * This does not acknowledge Discord, stage durable custody, or enqueue work. */
export function admitInteraction(
  gate: AdmissionGate | null,
  work: RoutedInteractionWork | null,
): InteractionAdmission {
  if (gate === null || work === null) return Object.freeze({permit: null, sealed: false});
  const control = isInteractionDrainControl(work);
  try {
    const permit = control ? enterControl.call(gate)[0] : enter.call(gate);
    return Object.freeze({permit, sealed: false});
  } catch (error) {
    const info = drainGateErrorInfo(error);
    if (info?.kind === 'Sealed') return Object.freeze({permit: null, sealed: true});
    if (info !== null) throw new InteractionDispatchError('Admission', error);
    throw error;
  }
}
