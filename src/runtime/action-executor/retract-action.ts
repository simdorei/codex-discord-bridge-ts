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
 readonly #path:string;readonly #selection:ActionThreadSelection;readonly #now:()=>number;
 constructor(path:string,selection:ActionThreadSelection,now:()=>number=systemNow){requireDiscordText(path);if(typeof now!=='function'||types.isProxy(now)||types.isAsyncFunction(now)||types.isGeneratorFunction(now))throw new TypeError('Expected synchronous clock');this.#path=path;this.#selection=selection;this.#now=now;Object.freeze(this);}
 async retract(channel:bigint,user:bigint,reference:string|null,signal?:AbortSignal):Promise<string>{
  for(const id of [channel,user])if(typeof id!=='bigint'||id<0n||id>=1n<<63n)throw new ActionIntegerRangeError();if(reference!==null)requireDiscordText(reference);signal?.throwIfAborted();
  const [target,source]=reference===null?await this.#selection.target(channel):[this.#selection.resolveReference(reference,false).id,'explicit'] as const;signal?.throwIfAborted();
  // The store primitive owns commit/rollback. Once invoked, await its exact result
  // rather than pretending cancellation means its committed deletion did not occur.
  const removed=await state.cancelLatestPending(this.#path,target,channel,user,readCustodyTimestamp(this.#now),source==='mirror');
  return removed===null?`No unstarted request found for ${target}.`:`Retracted unstarted request ${removed} for ${target}.`;
 }
}
Object.freeze(RetractAction.prototype);
