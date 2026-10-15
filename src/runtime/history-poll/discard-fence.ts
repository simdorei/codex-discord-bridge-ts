import {GatewayAcceptedMessageView,captureAcceptedGatewayMessages} from '../../discord/gateway/message-custody.ts';
import {types} from 'node:util';
import {gatewayOwnField} from '../../discord/gateway/values.ts';
import type {MessageGapFence,MessageGapReceiver} from '../../discord/gateway/message-gaps.ts';
import {MessageCandidate} from '../message-worker/classification.ts';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
const authority=Symbol('history discard fence');
/** Captures the channel and its clear revision together. Only a dedup marker is
 * written; no ingress, executable admission or first-prompt consumption occurs.
 * Connection initialization precedes the final synchronous fence+INSERT. */
export class DiscordHistoryDiscardFence {
 readonly #channel:bigint;readonly #fence:MessageGapFence;readonly #with:MessageGapReceiver['withCurrentFence'];readonly #accepted:GatewayAcceptedMessageView|null;
 private constructor(token:symbol,channel:bigint,fence:MessageGapFence,run:MessageGapReceiver['withCurrentFence'],accepted:GatewayAcceptedMessageView|null){if(token!==authority)throw new TypeError('Expected owned history fence');this.#channel=channel;this.#fence=fence;this.#with=run;this.#accepted=accepted;Object.freeze(this);}
 static capture(receiver:MessageGapReceiver,channel:bigint,accepted?:GatewayAcceptedMessageView):DiscordHistoryDiscardFence|null{
  if(typeof channel!=='bigint'||channel<=0n||channel>=1n<<64n)throw new TypeError('Expected nonzero u64 channel');
  const view=captureAcceptedGatewayMessages(accepted);
  const capture=gatewayOwnField(receiver,'captureClearFence'),run=gatewayOwnField(receiver,'withCurrentFence');
  for(const fn of [capture,run])if(typeof fn!=='function'||types.isProxy(fn)||types.isAsyncFunction(fn)||types.isGeneratorFunction(fn))throw new TypeError('Expected synchronous gap receiver');
  const fence=Reflect.apply(capture as Function,receiver,[channel]) as MessageGapFence|null;
  return fence===null?null:new DiscordHistoryDiscardFence(authority,channel,fence,(run as MessageGapReceiver['withCurrentFence']).bind(receiver),view);
 }
 async claim(candidate:MessageCandidate,observedAt:number,signal?:AbortSignal):Promise<boolean>{
  signal?.throwIfAborted();this.#with(this.#fence,()=>{});
  const parts=MessageCandidate.prototype.intoAdmissionParts.call(candidate);
  if(parts.channelId!==this.#channel)throw new TypeError('History discard candidate channel mismatch');
  if(typeof observedAt!=='number'||!Number.isFinite(observedAt)||observedAt<0)throw new TypeError('Expected nonnegative finite discard time');
  return state.claimProcessedMessageGuarded(parts.database,parts.persistedId,observedAt,operation=>{
   // Cancellation and accepted-original deferral stay outside the gap fence,
   // so neither poisons it. No await can intervene before the guarded INSERT.
   signal?.throwIfAborted();if(this.#accepted!==null)GatewayAcceptedMessageView.prototype.assertDiscardable.call(this.#accepted,parts.channelId,parts.persistedId);this.#with(this.#fence,operation);
  });
 }
}
Object.freeze(DiscordHistoryDiscardFence.prototype);
