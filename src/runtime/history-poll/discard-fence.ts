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
 readonly #channel:bigint;readonly #fence:MessageGapFence;readonly #with:MessageGapReceiver['withCurrentFence'];
 private constructor(token:symbol,channel:bigint,fence:MessageGapFence,run:MessageGapReceiver['withCurrentFence']){if(token!==authority)throw new TypeError('Expected owned history fence');this.#channel=channel;this.#fence=fence;this.#with=run;Object.freeze(this);}
 static capture(receiver:MessageGapReceiver,channel:bigint):DiscordHistoryDiscardFence|null{
  if(typeof channel!=='bigint'||channel<=0n||channel>=1n<<64n)throw new TypeError('Expected nonzero u64 channel');
  const capture=gatewayOwnField(receiver,'captureClearFence'),run=gatewayOwnField(receiver,'withCurrentFence');
  for(const fn of [capture,run])if(typeof fn!=='function'||types.isProxy(fn)||types.isAsyncFunction(fn)||types.isGeneratorFunction(fn))throw new TypeError('Expected synchronous gap receiver');
  const fence=Reflect.apply(capture as Function,receiver,[channel]) as MessageGapFence|null;
  return fence===null?null:new DiscordHistoryDiscardFence(authority,channel,fence,(run as MessageGapReceiver['withCurrentFence']).bind(receiver));
 }
 async claim(candidate:MessageCandidate,observedAt:number,signal?:AbortSignal):Promise<boolean>{
  signal?.throwIfAborted();this.#with(this.#fence,()=>{});
  const parts=MessageCandidate.prototype.intoAdmissionParts.call(candidate);
  if(parts.channelId!==this.#channel)throw new TypeError('History discard candidate channel mismatch');
  if(typeof observedAt!=='number'||!Number.isFinite(observedAt)||observedAt<0)throw new TypeError('Expected nonnegative finite discard time');
  return state.claimProcessedMessageGuarded(parts.database,parts.persistedId,observedAt,operation=>{
   // Cancellation is checked before entering the synchronous fence, so normal
   // aborts do not poison the tracker. No await can intervene before INSERT.
   signal?.throwIfAborted();this.#with(this.#fence,operation);
  });
 }
}
Object.freeze(DiscordHistoryDiscardFence.prototype);
