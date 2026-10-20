import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {MessageCandidate} from './classification.ts';
/** Historical backfill suppression owns only the unique processed marker.
 * Never admits an executable message, consumes !new, or creates a permit. */
export async function discardMessageCandidateAt(candidate:MessageCandidate,observedAt:number):Promise<boolean>{
 const parts=MessageCandidate.prototype.intoAdmissionParts.call(candidate);
 if(typeof observedAt!=='number'||!Number.isFinite(observedAt)||observedAt<0)throw new TypeError('Expected nonnegative finite discard time');
 return state.claimProcessedMessage(parts.database,parts.persistedId,observedAt);
}
