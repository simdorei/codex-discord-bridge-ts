import {captureAcceptedGatewayMessages} from '../../discord/gateway/message-custody.ts';
import {captureNativeHistoryTargetLimits,type NativeHistoryTargetLimits} from './native-history-targets.ts';
import {types} from 'node:util';
import {gatewayOwnField as own,gatewayId} from '../../discord/gateway/values.ts';
import type {GatewayIdentity} from '../../discord/gateway/identity.ts';
import type {MessageGapReceiver} from '../../discord/gateway/message-gaps.ts';
import type {HistoryConsumerOperations} from './history-consumer.ts';
import {captureHistoryPolicyRefresh} from '../history-poll/discord-gap.ts';
import {recoverPendingDiscordHistory} from './gap-recovery.ts';
import {runPeriodicDiscordHistory,type PeriodicHistoryOptions} from './periodic-history.ts';
export type DiscordHistoryOperationsOptions=Omit<PeriodicHistoryOptions,'applicationId'|'botUserId'>;
/** Borrow the exact receiver owned/disposed by the history consumer. Identity
 * supplied by its guard binds both recovery and periodic HTTP/business work.
 * Shared services/gate/resolver remain bootstrap-owned, not recreated per pass. */
export function createDiscordHistoryOperations(gaps:MessageGapReceiver,options:DiscordHistoryOperationsOptions):HistoryConsumerOperations{
 const allowed=own(options,'allowedChannelIds');if(allowed===null||typeof allowed!=='object'||types.isProxy(allowed))throw new TypeError('Expected native allowed channel set');const ids=new Set<bigint>();Set.prototype.forEach.call(allowed,(id:unknown)=>ids.add(gatewayId(id)));
 const source=own(options,'context'),context={} as Record<string,unknown>;
 for(const key of ['database','server','http','config','attachmentRoot','attachmentTransport','attachmentReport','controlVerifier','services'])context[key]=own(source,key);
 for(const key of ['now','messageJournal','nativePromptReceipts','promptAuthorityReads'])if(Object.hasOwn(source as object,key))context[key]=own(source,key);
 const captured={context:Object.freeze(context),refreshPolicy:captureHistoryPolicyRefresh(options)} as Record<string,unknown>;for(const key of ['gate','classification','policy','resolver','report','startupChannelId'])captured[key]=own(options,key);captured.allowedChannelIds=ids;if(Object.hasOwn(options,'nativeTargetLimits'))captured.nativeTargetLimits=captureNativeHistoryTargetLimits(own(options,'nativeTargetLimits') as NativeHistoryTargetLimits);if(Object.hasOwn(options,'acceptedMessages'))captured.acceptedMessages=captureAcceptedGatewayMessages(own(options,'acceptedMessages'))??undefined;Object.freeze(captured);
 const bind=(identity:GatewayIdentity):PeriodicHistoryOptions=>Object.freeze({...captured,applicationId:gatewayId(own(identity,'applicationId')),botUserId:gatewayId(own(identity,'userId'))}) as unknown as PeriodicHistoryOptions;
 return Object.freeze({recover:(identity,signal)=>recoverPendingDiscordHistory(gaps,bind(identity),signal),poll:async(history,identity,signal)=>{await runPeriodicDiscordHistory(history,gaps,bind(identity),signal);}} satisfies HistoryConsumerOperations);
}
