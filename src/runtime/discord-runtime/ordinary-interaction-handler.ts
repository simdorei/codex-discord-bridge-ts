import {OrdinaryInteractionDispatcher, type OrdinaryDispatcherOptions} from '../discord-dispatch/ordinary-dispatcher.ts';
import {InteractionClaimCache} from '../discord-dispatch/claim-cache.ts';
import {captureInteractionIngress, type InteractionLaneHandler} from './interaction-lane.ts';
import {refreshMirrorPolicy} from './mirror-policy.ts';

/** Create once and share between Normal and Reserved lanes. Each input refreshes
 * policy before dispatch, including expired inputs. The root queue sender and
 * HTTP client are borrowed and must outlive all handler calls. This is the
 * ordinary dispatcher profile, not recovery staging or command execution. */
export function createOrdinaryInteractionHandler(
  options: Omit<OrdinaryDispatcherOptions, 'claims'>,
): InteractionLaneHandler {
  const captured = Object.freeze({...options});
  const claims = new InteractionClaimCache(4096);
  return async (input, force) => {
    force.throwIfAborted();
    const item = captureInteractionIngress(input);
    // Join real store work before observing cancellation; never abandon a read.
    const policy = await refreshMirrorPolicy(captured.policy, captured.database);
    force.throwIfAborted();
    const dispatcher = new OrdinaryInteractionDispatcher({...captured, policy, claims});
    let failed = false, primary: unknown;
    try {await dispatcher.dispatch(item.event, item.receivedAtMs, item.tag, force);}
    catch (error) {failed = true; primary = error;}
    try {dispatcher.dispose();}
    catch (error) {
      if (failed) throw new AggregateError([primary, error], 'Interaction handler and sender cleanup failed');
      throw error;
    }
    if (failed) throw primary;
  };
}
