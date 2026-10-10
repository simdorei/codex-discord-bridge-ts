import {types} from 'node:util';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {MessageGapFenceError,type MessageGapReceiver} from '../../discord/gateway/message-gaps.ts';
import {drainGateErrorInfo} from '../../admission/owned-key.ts';
import {invokeSynchronousVoid} from '../../core/synchronous-void.ts';
import {passiveErrorText} from '../../core/passive-error-text.ts';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {HistoryPollState} from '../history-poll/state.ts';
import {HistoryPollRunError} from '../history-poll/runner.ts';
import {pollDiscordHistoryChannel,isDiscordHistoryPolicyError,type DiscordHistoryGapOptions} from '../history-poll/discord-gap.ts';
const sourceLabels={Startup:'startup',Allowed:'allowed',MirrorProject:'mirror_project',MirrorThread:'mirror_thread'} as const;
export interface PeriodicHistoryOptions extends DiscordHistoryGapOptions{readonly allowedChannelIds:ReadonlySet<bigint>;readonly startupChannelId:bigint|null}
/** One source-ordered periodic pass. Successful target lookup alone may prune
 * cursors. Each channel owns its permit and clear revision through the adapter.
 * Caller runs this serially under the Gateway identity cancellation guard. */
export async function runPeriodicDiscordHistory(history:HistoryPollState,gaps:MessageGapReceiver,options:PeriodicHistoryOptions,signal?:AbortSignal):Promise<void>{
 signal?.throwIfAborted();const report=own(options,'report');if(typeof report!=='function'||types.isProxy(report)||types.isAsyncFunction(report)||types.isGeneratorFunction(report))throw new TypeError('Expected synchronous history reporter');
 const emit=(code:string,detail:string)=>invokeSynchronousVoid(report,{},[code,detail]);
 const database=own(own(options,'context'),'database') as string,allowed=own(options,'allowedChannelIds') as ReadonlySet<bigint>,startup=own(options,'startupChannelId') as bigint|null;
 let targets;try{targets=await state.historyPollTargets(database,allowed,startup);}catch(error){if(signal?.aborted&&error===signal.reason)throw error;signal?.throwIfAborted();emit('discord_history_targets_failed',passiveErrorText(error,'history target lookup failed'));return;}
 signal?.throwIfAborted();HistoryPollState.prototype.retainChannels.call(history,targets.map(t=>t.channelId));
 for(const target of targets){
  signal?.throwIfAborted();let outcome;
  try{outcome=await pollDiscordHistoryChannel(options,history,gaps,target.channelId,signal);}
  catch(error){
   if(signal?.aborted&&error===signal.reason)throw error;
   if(drainGateErrorInfo(error)?.kind==='Sealed'){emit('discord_history_poll_skipped','restart_drain_sealed');return;}
   if(isDiscordHistoryPolicyError(error)){emit('discord_history_policy_failed',`channel=${target.channelId} source=${sourceLabels[target.source]} ${passiveErrorText(error,'policy failed')}`);continue;}
   if(error instanceof HistoryPollRunError){
    if(error.stage==='Claim'&&error.source instanceof MessageGapFenceError){if(error.source.kind==='Advanced'){emit('discord_history_poll_skipped',`channel=${target.channelId} reason=message_gap_advanced`);continue;}throw error;}
    if(error.stage==='Source'||error.stage==='Adaptation'||error.stage==='Claim'){emit(`discord_history_${error.stage.toLowerCase()}_failed`,`channel=${target.channelId} ${passiveErrorText(error,'history failed')}`);continue;}
   }
   throw error;
  }
  signal?.throwIfAborted();if(outcome===null)emit('discord_history_poll_skipped',`channel=${target.channelId} reason=pending_message_gap`);
  else emit('discord_history_poll',`channel=${target.channelId} source=${sourceLabels[target.source]} phase=${outcome.phase} fetched=${outcome.fetched} processed=${outcome.processed}`);
 }
}
