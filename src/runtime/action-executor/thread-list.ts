import {CodexThreadStore} from '../../codex-state/store.ts';
import {renderThreadList} from '../../codex-state/context-reader.ts';
import {PortableResidentLifecycle} from '../../app-server/portable-resident-lifecycle.ts';
import {readThreadStates} from './thread-state-probe.ts';
import {BridgeState} from '../bridge-state.ts';
import {snapshotActionResult,type ActionResult} from '../action-result.ts';
import {InvalidActionRequestError} from './errors.ts';
import {requireDiscordText} from '../../discord/text.ts';
/** Inventory visibility never depends on successful live probes. Archived list
 * performs neither native execution-state probes nor rollout reads. */
export class ThreadListAction {
 readonly #path:string;readonly #bridge:BridgeState;readonly #server:PortableResidentLifecycle|null;readonly #render:(error:unknown)=>string;
 constructor(path:string,bridge:BridgeState,server:PortableResidentLifecycle|null,renderError:(error:unknown)=>string){requireDiscordText(path);this.#path=path;this.#bridge=bridge;this.#server=server;this.#render=renderError;Object.freeze(this);}
 async list(limit:bigint,archived:boolean,signal?:AbortSignal):Promise<ActionResult>{
  if(typeof limit!=='bigint'||limit<0n||limit>0xffffffffn||typeof archived!=='boolean')throw new TypeError('Expected thread list fields');signal?.throwIfAborted();const store=CodexThreadStore.open(this.#path),threads=archived?store.loadArchivedThreads(0n):store.loadRecentThreads(0n);if(threads.length===0)return snapshotActionResult({text:archived?'No archived Codex threads found in the local state DB.':'No Codex threads found in the local state DB.',waitsForFinal:false,ui:null});
  const selected=BridgeState.prototype.selectedThreadId.call(this.#bridge),states=archived?new Map<string,string>():await readThreadStates(this.#server,threads,limit===0n?threads.length:Number(limit),this.#render,signal);signal?.throwIfAborted();let text:string;try{text=await renderThreadList(threads,selected,Number(limit),archived,states,signal);}catch(error){signal?.throwIfAborted();throw new InvalidActionRequestError(error instanceof Error?error.message:'thread list reader failed');}signal?.throwIfAborted();return snapshotActionResult({text,waitsForFinal:false,ui:null});
 }
}
Object.freeze(ThreadListAction.prototype);
