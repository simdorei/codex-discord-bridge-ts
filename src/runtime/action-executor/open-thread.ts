import {PortableResidentLifecycle} from '../../app-server/portable-resident-lifecycle.ts';
import {interruptTurn,resumeThreadWithTimeout} from '../../app-server/requests.ts';
import {ActionThreadSelection} from './thread-selection.ts';
import {ActionTargetServices} from './action-target.ts';
import {BridgeState} from '../bridge-state.ts';
import {snapshotActionResult,type ActionResult} from '../action-result.ts';
import {InvalidActionRequestError,MissingActionAppServerError} from './errors.ts';
import {requireDiscordText} from '../../discord/text.ts';
/** Explicit original reference -> prepared target -> optional interrupt -> resume.
 * Persist selection only after successful resume. No automatic retry/fork fallback
 * on a remote error; target preparation is the existing reviewed service. */
export class OpenThreadAction {
 readonly #selection:ActionThreadSelection;readonly #targets:ActionTargetServices;readonly #bridge:BridgeState;readonly #server:PortableResidentLifecycle|null;readonly #timeout:number;
 constructor(selection:ActionThreadSelection,targets:ActionTargetServices,bridge:BridgeState,server:PortableResidentLifecycle|null,resumeTimeoutMs:number){resumeThreadWithTimeout('',resumeTimeoutMs);this.#selection=selection;this.#targets=targets;this.#bridge=bridge;this.#server=server;this.#timeout=resumeTimeoutMs;Object.freeze(this);}
 async open(reference:string,abort:boolean,signal?:AbortSignal):Promise<ActionResult>{
  requireDiscordText(reference);if(typeof abort!=='boolean')throw new TypeError('Expected open-abort flag');signal?.throwIfAborted();const thread=await this.#selection.resolveThread(0n,reference);signal?.throwIfAborted();const target=await this.#targets.prepareActionTarget(thread.id,'reference');signal?.throwIfAborted();const server=this.#server;if(server===null)throw new MissingActionAppServerError();
  const turn=await PortableResidentLifecycle.prototype.activeTurnId.call(server,target.threadId);signal?.throwIfAborted();if(turn!==null){if(!abort)throw new InvalidActionRequestError(`thread ${target.threadId} has an active turn; use open_abort to interrupt it`);await PortableResidentLifecycle.prototype.execute.call(server,interruptTurn(target.threadId,turn),PortableResidentLifecycle.prototype.generation.call(server),signal);signal?.throwIfAborted();}
  await PortableResidentLifecycle.prototype.execute.call(server,resumeThreadWithTimeout(target.threadId,this.#timeout),PortableResidentLifecycle.prototype.generation.call(server),signal);signal?.throwIfAborted();BridgeState.prototype.setSelectedThreadId.call(this.#bridge,target.threadId);return snapshotActionResult({text:`Opened Codex thread\nthread_id: ${target.threadId}\ntitle: ${thread.title}`,waitsForFinal:false,ui:null});
 }
}
Object.freeze(OpenThreadAction.prototype);
