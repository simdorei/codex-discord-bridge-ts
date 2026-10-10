import {actionExecutionErrorInfo} from '../action-executor/action-error.ts';
import {ownedQueueFailure} from '../queue-runner/errors.ts';
import {busyComponentErrorInfo} from './busy-errors.ts';
import {ownedRequestFailure} from '../../app-server/request-client.ts';
import {ownedResidentFailure} from '../../app-server/resident-state.ts';
import {ownedServerResponseFailure} from '../../app-server/server-request-state.ts';
import {isOwnedAppServerSpawnError} from '../../app-server/portable-process.ts';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
export type ClaimFailureDisposition = 'Release' | 'RetainIndeterminate';
/** Only owned concrete error identities justify release. Portable missing pipes
 * are represented by owned Spawn errors; arbitrary JS errors remain uncertain. */
export function appServerClaimFailure(error: unknown): ClaimFailureDisposition {
  const resident = ownedResidentFailure(error);
  return isOwnedAppServerSpawnError(error) || ownedRequestFailure(error)?.kind === 'Remote'
    || resident?.kind === 'GenerationMismatch' || resident?.kind === 'GenerationQuarantined'
    || ownedServerResponseFailure(error) === 'StaleServerRequest' ? 'Release' : 'RetainIndeterminate';
}
export async function retainOrReleaseComponentClaim(database: string, claimId: string, error: unknown): Promise<ClaimFailureDisposition> {
  const disposition = appServerClaimFailure(error);
  if (disposition === 'Release') await state.releaseComponentClaim(database, claimId);
  return disposition;
}

/** Native TS-owned variants only. Unrepresented Rust lock-poison/system-time queue
 * wrappers and unknown JS failures remain held rather than guessed releasable. */
export function actionClaimFailure(error: unknown): ClaimFailureDisposition {
  const action = actionExecutionErrorInfo(error); if (action === null) return 'RetainIndeterminate';
  if (action.kind === 'AppServer') return appServerClaimFailure(action.source);
  if (action.kind === 'NoTarget' || action.kind === 'IntegerRange') return 'Release';
  if (action.kind === 'Queue') {const queue = ownedQueueFailure(action.source); if (queue?.kind === 'IntegerRange') return 'Release'; if (queue?.kind === 'Backend') {const flag = Object.getOwnPropertyDescriptor(queue.failure, 'ambiguous'); return flag !== undefined && Object.hasOwn(flag, 'value') && flag.value === false ? 'Release' : 'RetainIndeterminate';}}
  return 'RetainIndeterminate';
}
export function busyActionClaimFailure(error: unknown): ClaimFailureDisposition {
  const busy = busyComponentErrorInfo(error); if (busy === null) return 'RetainIndeterminate';
  if (busy.kind === 'Action') return actionClaimFailure(busy.source);
  if (busy.kind === 'AppServer') return appServerClaimFailure(busy.source);
  return ['NoActiveTurn', 'ControlNotDispatched', 'NoTarget', 'SteerNotAllowed'].includes(busy.kind) ? 'Release' : 'RetainIndeterminate';
}
export async function retainOrReleaseBusyClaim(database: string, choiceId: string, error: unknown): Promise<ClaimFailureDisposition> {
  const disposition = busyActionClaimFailure(error);
  if (disposition === 'Release') await state.releaseBusyChoiceClaim(database, choiceId);
  return disposition;
}
