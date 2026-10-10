import {types} from 'node:util';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import type {MessageGapReceiver,MessageGapNotice} from '../../discord/gateway/message-gaps.ts';
import {drainGateErrorInfo} from '../../admission/owned-key.ts';
import {invokeSynchronousVoid} from '../../core/synchronous-void.ts';
import {passiveErrorText} from '../../core/passive-error-text.ts';
import {historyMessageWatermark} from '../history-poll/state.ts';
import {HistoryPollRunError} from '../history-poll/runner.ts';
import {recoverDiscordHistoryChannel,isDiscordHistoryPolicyError,type DiscordHistoryGapOptions} from '../history-poll/discord-gap.ts';
/** Source gap pass only. Acknowledgement uses the original revision-bound notice,
 * never a fresh snapshot after effects. Incomplete coverage and recoverable errors
 * leave the sticky notice intact. Caller supplies identity-guarded cancellation. */
export async function recoverPendingDiscordHistory(gaps:MessageGapReceiver,options:DiscordHistoryGapOptions,signal?:AbortSignal):Promise<void>{
 signal?.throwIfAborted();const report=own(options,'report');if(typeof report!=='function'||types.isProxy(report)||types.isAsyncFunction(report)||types.isGeneratorFunction(report))throw new TypeError('Expected synchronous history report');
 const snapshot=own(gaps,'snapshot'),acknowledge=own(gaps,'acknowledge');
 for(const fn of [snapshot,acknowledge])if(typeof fn!=='function'||types.isProxy(fn)||types.isAsyncFunction(fn)||types.isGeneratorFunction(fn))throw new TypeError('Expected owned gap receiver');
 const emit=(code:string,detail:string)=>invokeSynchronousVoid(report,{},[code,detail]);
 const notices=Reflect.apply(snapshot as Function,gaps,[]) as readonly MessageGapNotice[];if(!Array.isArray(notices)||types.isProxy(notices))throw new TypeError('Expected gap notices');
 for(const notice of notices){
  signal?.throwIfAborted();const read=own(notice,'snapshot');if(typeof read!=='function'||types.isProxy(read)||types.isAsyncFunction(read)||types.isGeneratorFunction(read))throw new TypeError('Expected original gap notice');
  const current=Reflect.apply(read,notice,[]),channel=own(current,'channelId') as bigint,earliest=own(current,'earliest'),floor=historyMessageWatermark(own(earliest,'timestampMicros') as bigint,own(earliest,'messageId') as bigint);if(floor===null)throw new TypeError('Invalid message gap floor');
  let outcome;
  try{outcome=await recoverDiscordHistoryChannel(options,channel,floor,signal);}
  catch(error){
   if(signal?.aborted&&error===signal.reason)throw error;
   if(drainGateErrorInfo(error)?.kind==='Sealed'){emit('discord_message_gap_deferred','restart_drain_sealed');return;}
   if(isDiscordHistoryPolicyError(error)){emit('discord_message_gap_failed',`channel=${channel} stage=policy ${passiveErrorText(error,'policy failed')}`);continue;}
   if(error instanceof HistoryPollRunError&&['Source','Adaptation','Claim'].includes(error.stage)){emit('discord_message_gap_failed',`channel=${channel} stage=${error.stage.toLowerCase()} ${passiveErrorText(error,'history failed')}`);continue;}
   throw error;
  }
  signal?.throwIfAborted();
  if(outcome.coverage==='Reached'){
   const result=Reflect.apply(acknowledge as Function,gaps,[notice]);if(result!=='Cleared'&&result!=='Stale')throw new TypeError('Invalid gap acknowledgement');
   emit(result==='Cleared'?'discord_message_gap_recovered':'discord_message_gap_ack_stale',`channel=${channel} fetched=${outcome.fetched} processed=${outcome.processed}`);
  }else emit('discord_message_gap_degraded',`channel=${channel} fetched=${outcome.fetched} status=incomplete`);
 }
}
