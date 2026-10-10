import {types} from 'node:util';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {isProCommand} from '../../pro/prompt.ts';
import {snapshotActionResult, type ActionResult} from '../action-result.ts';
import {QueueReadCoordinator} from '../queue-runner/read-coordinator.ts';
import {ControlTurnVerifier} from './control-turn.ts';
import {ActionIntegerRangeError, InvalidActionRequestError, MissingActionAppServerError} from './errors.ts';
import {readCustodyTimestamp} from '../discord-dispatch/staged-custody.ts';
import {now as systemNow} from '../../store/queue-attach-goal.ts';
function id(value:bigint):bigint {if(value<0n||value>=(1n<<63n))throw new ActionIntegerRangeError();return value;}
/** Creates only the original busy choice and pinned control binding. No steer,
 * resume or queue submission occurs here. Caller supplies the shared target lock. */
export class BusyResultProducer {
  readonly #database:string;readonly #verifier:ControlTurnVerifier;readonly #binding:(target:string)=>Promise<readonly [string|null,string|null]>;readonly #now:()=>number;
  constructor(database:string,verifier:ControlTurnVerifier,reads:QueueReadCoordinator,now:()=>number=systemNow){
    requireDiscordText(database);
    if(typeof now!=='function'||types.isProxy(now)||types.isAsyncFunction(now)||types.isGeneratorFunction(now))throw new TypeError('Expected synchronous busy clock');
    this.#database=database;this.#verifier=verifier;this.#binding=QueueReadCoordinator.prototype.controlBinding.bind(reads);this.#now=now;Object.freeze(this);
  }
  async busyResult(thread:string,channel:bigint,user:bigint,prompt:string,requestedSteer:boolean,mapped:boolean,signal?:AbortSignal):Promise<ActionResult>{
    requireDiscordText(thread);requireDiscordText(prompt);
    if(typeof channel!=='bigint'||typeof user!=='bigint'||typeof requestedSteer!=='boolean'||typeof mapped!=='boolean')throw new TypeError('Expected busy request fields');
    signal?.throwIfAborted();const lease=await this.#verifier.lock(thread,signal);
    try{
      signal?.throwIfAborted();const [turn,job]=await this.#binding(thread);signal?.throwIfAborted();
      const pro=isProCommand(prompt);let allowSteer=false,status:string|null=null;
      if(pro)status='Pro requests require connection checks and cannot be steered; choose Queue next to submit this request through Pro validation.';
      else if(requestedSteer&&turn!==null){
        try{await this.#verifier.control(channel,thread,turn);allowSteer=true;}
        catch(error){
          if(error!==null&&typeof error==='object'&&!types.isProxy(error)&&Object.getPrototypeOf(error)===InvalidActionRequestError.prototype)status=(error as InvalidActionRequestError).message.slice('invalid command request: '.length);
          else if(error!==null&&typeof error==='object'&&!types.isProxy(error)&&Object.getPrototypeOf(error)===MissingActionAppServerError.prototype)status=(error as MissingActionAppServerError).message;
          else throw error;
        }
      }else status='no currently owned active turn is confirmed; controls will be checked again when clicked';
      signal?.throwIfAborted();const choiceId=await state.createBusyChoice(this.#database,{ownerUserId:id(user),channelId:id(channel),targetThreadId:thread,prompt,allowSteer,now:readCustodyTimestamp(this.#now),timeToLive:1800},mapped);
      // If cancellation races the durable insert, finish the binding before returning.
      await state.bindBusyControl(this.#database,choiceId,thread,turn,job);signal?.throwIfAborted();
      return snapshotActionResult({text:`Codex is busy for ${thread}. Choose what to do with this request.${status===null?'':'\nControl status: '+status}`,waitsForFinal:false,ui:pro?{kind:'ProBusy',choiceId}:{kind:'Busy',choiceId,allowSteer}});
    }finally{lease.release();}
  }
}
Object.freeze(BusyResultProducer.prototype);
