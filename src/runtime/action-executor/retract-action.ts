import {NativeRetractWriter} from './retract-write-native.ts';
import {types} from 'node:util';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {now as systemNow} from '../../store/queue-attach-goal.ts';
import {readCustodyTimestamp} from '../discord-dispatch/staged-custody.ts';
import {ActionThreadSelection} from './thread-selection.ts';
import {ActionIntegerRangeError} from './errors.ts';
/** Cancels only the original actor's eligible unstarted request using the existing
 * atomic store primitive. This is never an interrupt of running native work. */
export class RetractAction {
 readonly #path:string;readonly #selection:ActionThreadSelection;readonly #now:()=>number;readonly #native:NativeRetractWriter|undefined;
 constructor(path:string,selection:ActionThreadSelection,now:()=>number=systemNow,native?:NativeRetractWriter){requireDiscordText(path);if(native!==undefined)NativeRetractWriter.prototype.assertPath.call(native,path);this.#native=native;if(typeof now!=='function'||types.isProxy(now)||types.isAsyncFunction(now)||types.isGeneratorFunction(now))throw new TypeError('Expected synchronous clock');this.#path=path;this.#selection=selection;this.#now=now;Object.freeze(this);}
 async retract(channel:bigint,user:bigint,reference:string|null,signal?:AbortSignal,ingress?:{readonly key:string;readonly eventId:bigint}):Promise<string>{
  for(const id of [channel,user])if(typeof id!=='bigint'||id<0n||id>=1n<<63n)throw new ActionIntegerRangeError();if(reference!==null)requireDiscordText(reference);signal?.throwIfAborted();
  const [target,source]=reference===null?await this.#selection.target(channel):[(await this.#selection.resolveReferenceAsync(reference,false,signal)).id,'explicit'] as const;signal?.throwIfAborted();
  // Compatibility construction keeps the initialized helper. Production pins a
  // native owner and original ingress; submitted uncertainty is never retried.
  if(this.#native!==undefined&&ingress===undefined)throw new TypeError('Original Retract ingress identity is required');
  const now=readCustodyTimestamp(this.#now);
  const removed=this.#native===undefined?await state.cancelLatestPending(this.#path,target,channel,user,now,source==='mirror'):await NativeRetractWriter.prototype.execute.call(this.#native,{ingressKey:ingress!.key,eventId:ingress!.eventId,target,channelId:channel,ownerUserId:user,now,requireMirror:source==='mirror'},signal);
  return removed===null?`No unstarted request found for ${target}.`:`Retracted unstarted request ${removed} for ${target}.`;
 }
}
Object.freeze(RetractAction.prototype);
