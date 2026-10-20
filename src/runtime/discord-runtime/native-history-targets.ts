import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import {types} from 'node:util';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import type {HistoryPollTarget,HistoryTargetSource} from '../../store/history-targets.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../owned-worker-slot.ts';
export interface NativeHistoryTargetLimits{readonly maxRows:number;readonly timeoutMs:number;}
export class NativeHistoryTargetError extends Error{constructor(detail:string){super('Native history target read failed: '+detail);this.name='NativeHistoryTargetError';}}
const slot=new OwnedWorkerSlot();
function id(value:unknown):asserts value is bigint{if(typeof value!=='bigint'||value<0n||value>=(1n<<64n))throw new TypeError('Expected u64 history channel');}
/** Existing-only off-thread profile. No schema initialization or partial list.
 * One local slot shares bounded global Background capacity, with no wait queue.
 * Timeout/abort joins the real worker exit before this operation settles. SQL
 * sorting may outlive the caller deadline; this does not promise hard preemption.
 * Legacy periodic callers remain unchanged until this profile is explicitly wired. */
export async function readHistoryTargetsOffThread(path:string,allowedChannelIds:ReadonlySet<bigint>,startup:bigint|null,limits:NativeHistoryTargetLimits,signal?:AbortSignal):Promise<readonly HistoryPollTarget[]>{
 signal?.throwIfAborted();requireDiscordText(path);if(path.includes('\0')||path.length>32768||Buffer.byteLength(path)>32768)throw new RangeError('Invalid native history path');const full=pinNativeRuntimePath(path);if(full.length>32768||Buffer.byteLength(full)>32768)throw new RangeError('Invalid native history path');
 if(startup!==null)id(startup);if(allowedChannelIds===null||typeof allowedChannelIds!=='object'||types.isProxy(allowedChannelIds))throw new TypeError('Expected native history channel set');
 const size=Object.getOwnPropertyDescriptor(Set.prototype,'size')!.get!.call(allowedChannelIds) as number;if(size>4096)throw new RangeError('Too many configured history channels');const allowed:bigint[]=[];Set.prototype.forEach.call(allowedChannelIds,(value:unknown)=>{id(value);allowed.push(value);});
 const {maxRows,timeoutMs}=captureNativeHistoryTargetLimits(limits);
 if(slot.busy)throw new OwnedWorkerBusyError();const pending=slot.run(new URL('./history-target-worker.ts',import.meta.url),{path:full,allowed,startup,maxRows},timeoutMs,signal),joined=slot.join();let response:unknown;try{response=await pending;}finally{await joined;}signal?.throwIfAborted();
 if(own(response,'ok')!==true){const detail=own(response,'detail');throw new NativeHistoryTargetError(typeof detail==='string'?detail:'invalid native result');}
 const raw=own(response,'targets');if(!Array.isArray(raw)||raw.length>50)throw new NativeHistoryTargetError('invalid target count');const seen=new Set<bigint>(),targets:HistoryPollTarget[]=[];
 for(const row of raw){const source=own(row,'source'),channelId=own(row,'channelId');id(channelId);if(channelId===0n||seen.has(channelId)||!['Startup','Allowed','MirrorProject','MirrorThread'].includes(source as string))throw new NativeHistoryTargetError('invalid native target');seen.add(channelId);targets.push(Object.freeze({source:source as HistoryTargetSource,channelId}));}return Object.freeze(targets);
}

export function captureNativeHistoryTargetLimits(limits:NativeHistoryTargetLimits):NativeHistoryTargetLimits{
const maxRows=own(limits,'maxRows'),timeoutMs=own(limits,'timeoutMs');if(typeof maxRows!=='number'||!Number.isSafeInteger(maxRows)||maxRows<1||maxRows>4096||typeof timeoutMs!=='number'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid native history limits');
 return Object.freeze({maxRows,timeoutMs});
}
