import {discoverMirrorThreads,captureMirrorDiscoveryLimits,type MirrorDiscoveryLimits,type MirrorThreadHint} from './discovery.ts';
import {discoverMirrorStore,captureMirrorStoreDiscoveryLimits,type MirrorStoreDiscoveryLimits,type MirrorStoreSnapshot} from './store-discovery.ts';
import {OwnedWorkerBusyError} from '../owned-worker-slot.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
export interface MirrorSnapshotLimits{readonly threads:MirrorDiscoveryLimits;readonly store:MirrorStoreDiscoveryLimits;}
export interface MirrorDiscoverySnapshot extends MirrorStoreSnapshot{readonly threads:readonly MirrorThreadHint[];}
let busy=false;
export function mirrorSnapshotDiscoveryBusy():boolean{return busy;}
function path(value:string):void{requireDiscordText(value);if(value.includes('\0')||Buffer.byteLength(value)>32768)throw new RangeError('Invalid mirror snapshot path');}
/** Source order: original Codex threads, bridge mapping, then queue. All blocking
 * SQL and queue JSON decoding occur in fixed native workers. Publishes only
 * after both complete; never exposes a valid first half after second-half failure.
 * This is observation, not execution/delivery authority or a cross-DB transaction.
 * No timer, polling loop, store initializer, cursor write or fallback is hidden. */
export async function discoverMirrorSnapshot(stateDb:string,mirrorDb:string,input:MirrorSnapshotLimits,signal?:AbortSignal):Promise<MirrorDiscoverySnapshot>{
 signal?.throwIfAborted();path(stateDb);path(mirrorDb);
 const threadsLimits=captureMirrorDiscoveryLimits(own(input,'threads') as MirrorDiscoveryLimits),storeLimits=captureMirrorStoreDiscoveryLimits(own(input,'store') as MirrorStoreDiscoveryLimits);
 if(busy)throw new OwnedWorkerBusyError();busy=true;
 try{const threads=await discoverMirrorThreads(stateDb,threadsLimits,signal);signal?.throwIfAborted();const store=await discoverMirrorStore(mirrorDb,storeLimits,signal);signal?.throwIfAborted();return Object.freeze({threads,targets:store.targets,jobs:store.jobs});}
 finally{busy=false;}
}
