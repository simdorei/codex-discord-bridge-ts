import {types} from 'node:util';
import {PortableResidentLifecycle} from '../../app-server/portable-resident-lifecycle.ts';
import {steerTurn} from '../../app-server/requests.ts';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {prepareServerPrompts} from '../server-prompt-redisplay.ts';
import {snapshotActionResult,type ActionResult} from '../action-result.ts';
import {ActionThreadSelection} from './thread-selection.ts';
import {ActionTargetServices} from './action-target.ts';
import {ControlTurnVerifier} from './control-turn.ts';
import {MissingActionAppServerError} from './errors.ts';
import {readCustodyTimestamp} from '../discord-dispatch/staged-custody.ts';
import {now as systemNow} from '../../store/queue-attach-goal.ts';
function actor(value:bigint):void {if(typeof value!=='bigint'||value<0n||value>=1n<<64n)throw new TypeError('Expected u64 action actor');}
/** Original pending-request redisplay and exact active-turn steer. Approval only
 * displays privately prepared UI; it cannot submit an approval response. */
export class PromptControlActions {
 readonly #database:string;readonly #selection:ActionThreadSelection;readonly #targets:ActionTargetServices;readonly #control:ControlTurnVerifier;readonly #server:PortableResidentLifecycle|null;readonly #now:()=>number;
 constructor(database:string,selection:ActionThreadSelection,targets:ActionTargetServices,control:ControlTurnVerifier,server:PortableResidentLifecycle|null,now:()=>number=systemNow){requireDiscordText(database);if(typeof now!=='function'||types.isProxy(now)||types.isAsyncFunction(now)||types.isGeneratorFunction(now))throw new TypeError('Expected synchronous action clock');this.#database=database;this.#selection=selection;this.#targets=targets;this.#control=control;this.#server=server;this.#now=now;Object.freeze(this);}
 async approval(channel:bigint,user:bigint,signal?:AbortSignal):Promise<ActionResult> {
  actor(channel);actor(user);signal?.throwIfAborted();const [thread]=await this.#selection.target(channel);signal?.throwIfAborted();const server=this.#server;if(server===null)throw new MissingActionAppServerError();const prompts=await prepareServerPrompts(this.#database,server,thread,channel,user);signal?.throwIfAborted();
  return snapshotActionResult(prompts.length===0?{text:`No pending Codex approval or input request for ${thread}.`,waitsForFinal:false,ui:null}:{text:`Existing Codex approval/input requests: ${prompts.length}\nthread: ${thread}`,waitsForFinal:false,ui:{kind:'ServerPrompts',prompts}});
 }
 async steer(channel:bigint,prompt:string,signal?:AbortSignal):Promise<ActionResult> {
  actor(channel);requireDiscordText(prompt);signal?.throwIfAborted();const [original]=await this.#selection.target(channel);signal?.throwIfAborted();const thread=await this.#targets.canonicalizeCompletedTarget(original);signal?.throwIfAborted();const server=this.#server;if(server===null)throw new MissingActionAppServerError();const lease=await this.#control.lock(thread,signal);
  try{signal?.throwIfAborted();const [turn,generation]=await this.#control.control(channel,thread);signal?.throwIfAborted();await state.recordUserOrigin(this.#database,thread,turn,prompt,readCustodyTimestamp(this.#now));signal?.throwIfAborted();await PortableResidentLifecycle.prototype.execute.call(server,steerTurn(thread,prompt,turn),generation,signal);return snapshotActionResult({text:`Steering request submitted to ${thread}.`,waitsForFinal:false,ui:null});}finally{lease.release();}
 }
}
Object.freeze(PromptControlActions.prototype);
