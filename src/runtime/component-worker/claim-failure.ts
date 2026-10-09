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
