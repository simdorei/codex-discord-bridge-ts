import {types} from 'node:util';
import {gatewayOwnField as own,gatewayId} from '../../discord/gateway/values.ts';
import type {GatewayIdentity} from '../../discord/gateway/identity.ts';
import type {MessageGapReceiver} from '../../discord/gateway/message-gaps.ts';
import type {HistoryConsumerOperations} from './history-consumer.ts';
import {recoverPendingDiscordHistory} from './gap-recovery.ts';
import {runPeriodicDiscordHistory,type PeriodicHistoryOptions} from './periodic-history.ts';
export type DiscordHistoryOperationsOptions=Omit<PeriodicHistoryOptions,'applicationId'|'botUserId'>;
/** Borrow the exact receiver owned/disposed by the history consumer. Identity
 * supplied by its guard binds both recovery and periodic HTTP/business work.
 * Shared services/gate/resolver remain bootstrap-owned, not recreated per pass. */
export function createDiscordHistoryOperations(gaps:MessageGapReceiver,options:DiscordHistoryOperationsOptions):HistoryConsumerOperations{
 const allowed=own(options,'allowedChannelIds');if(allowed===null||typeof allowed!=='object'||types.isProxy(allowed))throw new TypeError('Expected native allowed channel set');const ids=new Set<bigint>();Set.prototype.forEach.call(allowed,(id:unknown)=>ids.add(gatewayId(id)));
 const captured={} as Record<string,unknown>;for(const key of ['context','gate','classification','policy','resolver','report','startupChannelId'])captured[key]=own(options,key);captured.allowedChannelIds=ids;Object.freeze(captured);
 const bind=(identity:GatewayIdentity):PeriodicHistoryOptions=>Object.freeze({...captured,applicationId:gatewayId(own(identity,'applicationId')),botUserId:gatewayId(own(identity,'userId'))}) as unknown as PeriodicHistoryOptions;
 return Object.freeze({recover:async(identity,signal)=>{await recoverPendingDiscordHistory(gaps,bind(identity),signal);},poll:async(history,identity,signal)=>{await runPeriodicDiscordHistory(history,gaps,bind(identity),signal);}} satisfies HistoryConsumerOperations);
}
