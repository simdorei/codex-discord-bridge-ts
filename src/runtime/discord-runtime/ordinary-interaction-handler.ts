import {types} from 'node:util';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {nativeGatewayShutdownClock} from '../../discord/gateway/shutdown.ts';
import type {InteractionAccessPolicy} from '../../discord/interaction-access.ts';
import {InteractionDispatchError} from '../discord-dispatch/errors.ts';
import {takeMirrorPolicyCapacityRefusal} from './native-mirror-policy.ts';
import {captureInteractionJournalContext} from '../interaction-worker/journal.ts';
import {OrdinaryInteractionDispatcher, type OrdinaryDispatcherOptions} from '../discord-dispatch/ordinary-dispatcher.ts';
import {InteractionClaimCache} from '../discord-dispatch/claim-cache.ts';
import {captureInteractionIngress, type InteractionLaneHandler} from './interaction-lane.ts';
import {refreshMirrorPolicy} from './mirror-policy.ts';

export type InteractionPolicyRefresh=(policy:InteractionAccessPolicy,database:string,signal:AbortSignal)=>Promise<InteractionAccessPolicy>;

/** Create once and share between Normal and Reserved lanes. Each input refreshes
 * policy before dispatch, including expired inputs. The root queue sender and
 * HTTP client are borrowed and must outlive all handler calls. This is the
 * ordinary dispatcher profile, not recovery staging or command execution. */
export function createOrdinaryInteractionHandler(
  options: Omit<OrdinaryDispatcherOptions, 'claims'> & {readonly refreshPolicy?:InteractionPolicyRefresh},
): InteractionLaneHandler {
  // Capture the database, callback and clock methods before any refresh awaits.
  // Direct callers retain the compatibility profile unless explicitly installed.
  const database=own(options,'database') as string,journal=captureInteractionJournalContext(database,options);
  const optional=(key:string):unknown=>{const field=Object.getOwnPropertyDescriptor(options,key);if(field!==undefined&&!Object.hasOwn(field,'value'))throw new TypeError('Expected passive interaction handler option');return field?.value;};
  const supplied=optional('refreshPolicy'),refresh=(supplied===undefined?refreshMirrorPolicy:supplied) as InteractionPolicyRefresh;
  if(typeof refresh!=='function'||types.isProxy(refresh)||types.isGeneratorFunction(refresh))throw new TypeError('Expected interaction policy refresh function');
  const source=(optional('clock')??nativeGatewayShutdownClock) as NonNullable<OrdinaryDispatcherOptions['clock']>,clock=Object.freeze({now:source.now.bind(source),sleepUntil:source.sleepUntil.bind(source)});
  const report=own(options,'report') as OrdinaryDispatcherOptions['report'],custodyNow=optional('custodyNow') as OrdinaryDispatcherOptions['custodyNow'];
  for(const fn of [report,...(custodyNow===undefined?[]:[custodyNow])])if(typeof fn!=='function'||types.isProxy(fn)||types.isAsyncFunction(fn)||types.isGeneratorFunction(fn))throw new TypeError('Expected synchronous interaction handler callback');
  const captured=Object.freeze({client:own(options,'client'),queue:own(options,'queue'),policy:own(options,'policy'),qaEnabled:own(options,'qaEnabled'),autocomplete:own(options,'autocomplete'),admission:own(options,'admission'),settingsResolver:own(options,'settingsResolver'),database,clock,report,...(custodyNow===undefined?{}:{custodyNow}),interactionJournal:journal}) as Omit<OrdinaryDispatcherOptions,'claims'>;
  const claims = new InteractionClaimCache(4096);
  return async (input, force) => {
    force.throwIfAborted();
    const item = captureInteractionIngress(input);
    // Join real store work before observing cancellation; never abandon a read.
    let policy:InteractionAccessPolicy,pending:Promise<InteractionAccessPolicy>|undefined;
    try{
      pending=refresh(captured.policy,captured.database,force);
      if(!types.isPromise(pending))throw new TypeError('Expected interaction policy refresh Promise');
      policy=await pending;
    }catch(error){
      if(takeMirrorPolicyCapacityRefusal(pending,error))throw new InteractionDispatchError('Capacity','native mirror policy capacity is occupied; no refresh submitted');
      throw error;
    }
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
