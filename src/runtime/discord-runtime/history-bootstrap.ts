import {captureNativeHistoryTargetLimits,type NativeHistoryTargetLimits} from './native-history-targets.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import type {AdmissionGate} from '../../admission/drain-gate.ts';
import type {DiscordChannelClient} from '../../discord/channel-client.ts';
import type {MessageGapReceiver} from '../../discord/gateway/message-gaps.ts';
import {capturePreparedMessageOptions,type RuntimeMessageStartup,type RuntimeMessageStartupOptions} from './message-bootstrap.ts';
import {createDiscordHistoryOperations} from './history-operations.ts';
export interface RuntimeHistoryStartupOptions extends RuntimeMessageStartupOptions{readonly allowedChannelIds:ReadonlySet<bigint>;readonly startupChannelId:bigint|null;readonly historyTargetLimits:NativeHistoryTargetLimits;}
/** Exact bootstrap owners and captured configuration, borrowed gap receiver.
 * Existing revision fences, whole-page validation and durable custody remain
 * authoritative. The history consumer alone disposes its original receiver. */
export function createPreparedHistoryOperations(input:RuntimeMessageStartup,gate:AdmissionGate,http:DiscordChannelClient,gaps:MessageGapReceiver,options:RuntimeHistoryStartupOptions){
 const captured=capturePreparedMessageOptions(input,gate,http,options),nativeTargetLimits=captureNativeHistoryTargetLimits(own(options,'historyTargetLimits') as NativeHistoryTargetLimits);
 return createDiscordHistoryOperations(gaps,{...captured,nativeTargetLimits,allowedChannelIds:own(options,'allowedChannelIds') as ReadonlySet<bigint>,startupChannelId:own(options,'startupChannelId') as bigint|null});
}
