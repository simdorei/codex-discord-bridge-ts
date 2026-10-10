import {types} from 'node:util';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
export const MAX_MIRROR_THREAD_BYTES=16384;
export interface MirrorTargetHint{readonly thread:string;readonly channel:bigint;}
export interface MirrorReadyLimits{readonly maxTargets:number;readonly maxBytes:number;}
/** Bounded discovery hints only, never delivery/cursor authority or active-work
 * ownership. Snapshot overflow is explicit and preserves previous ready state.
 * The runtime owner must retain thread/channel leases until actual work settles,
 * regardless of timeout. Refresh order preserves waiters ahead of new targets. */
export class MirrorTargetReady{
 readonly #count:number;readonly #bytes:number;#ready:MirrorTargetHint[]=[];
 constructor(limits:MirrorReadyLimits){const count=own(limits,'maxTargets'),bytes=own(limits,'maxBytes');if(typeof count!=='number'||!Number.isSafeInteger(count)||count<1||count>4096||typeof bytes!=='number'||!Number.isSafeInteger(bytes)||bytes<1||bytes>1048576)throw new RangeError('Invalid mirror discovery hint budget');this.#count=count;this.#bytes=bytes;}
 get length():number{return this.#ready.length;}
 snapshot():readonly MirrorTargetHint[]{return Object.freeze([...this.#ready]);}
 refresh(input:readonly MirrorTargetHint[],activeThreads:ReadonlySet<string>):void{
  if(types.isProxy(input)||!Array.isArray(input))throw new TypeError('Expected owned mirror targets');if(input.length>this.#count)throw new RangeError('Mirror discovery target budget exceeded');
  const targets:MirrorTargetHint[]=[],destinations=new Map<string,bigint>();let used=0;
  for(let i=0;i<input.length;i++){const row=own(input,String(i)),thread=own(row,'thread'),channel=own(row,'channel');requireDiscordText(thread);if(Buffer.byteLength(thread,'utf8')>MAX_MIRROR_THREAD_BYTES)throw new RangeError('Mirror thread identity budget exceeded');if(typeof channel!=='bigint'||channel<-(1n<<63n)||channel>(1n<<63n)-1n)throw new TypeError('Expected signed mirror channel');used+=Buffer.byteLength(thread,'utf8')+8;if(used>this.#bytes)throw new RangeError('Mirror discovery byte budget exceeded');if(destinations.has(thread))throw new TypeError('Duplicate mirror target');destinations.set(thread,channel);targets.push(Object.freeze({thread,channel}));}
  const next:MirrorTargetHint[]=[];
  for(const row of this.#ready){const channel=destinations.get(row.thread);if(channel===undefined)continue;destinations.delete(row.thread);if(!activeThreads.has(row.thread))next.push(Object.freeze({thread:row.thread,channel}));}
  for(const row of targets)if(destinations.delete(row.thread)&&!activeThreads.has(row.thread))next.push(row);
  this.#ready=next;
 }
 /** Trusted owner sets/readiness callback. The caller claims the selected thread
  * and channel synchronously before asking for another hint. A delayed retry is
  * rediscovered by the next complete refresh, matching source dispatch. */
 take(activeThreads:ReadonlySet<string>,activeChannels:ReadonlySet<bigint>,ready:(thread:string)=>boolean):MirrorTargetHint|null{
  if(typeof ready!=='function'||types.isProxy(ready)||types.isAsyncFunction(ready)||types.isGeneratorFunction(ready))throw new TypeError('Expected synchronous retry predicate');
  const remaining=[...this.#ready];let chosen:MirrorTargetHint|null=null;
  for(let i=0,n=remaining.length;i<n;i++){const row=remaining.shift()!;if(activeThreads.has(row.thread))continue;if(activeChannels.has(row.channel)){remaining.push(row);continue;}const result=ready(row.thread);if(typeof result!=='boolean'){if(types.isPromise(result))void Promise.prototype.then.call(result,undefined,()=>undefined);throw new TypeError('Expected boolean retry readiness');}if(!result)continue;chosen=row;break;}
  this.#ready=remaining;return chosen;
 }
}
Object.freeze(MirrorTargetReady.prototype);
