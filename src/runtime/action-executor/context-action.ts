import {CodexThreadStore} from '../../codex-state/store.ts';
import {renderContextView} from '../../codex-state/context-reader.ts';
import {ActionThreadSelection} from './thread-selection.ts';
import {InvalidActionRequestError} from './errors.ts';
import {snapshotActionResult,type ActionResult} from '../action-result.ts';
import {requireDiscordText} from '../../discord/text.ts';
/** Original saved target is rechecked after owned worker finishes. No canonical
 * fork substitution, native server mutation or fallback to another room. */
export class ContextAction {
 readonly #path:string;readonly #selection:ActionThreadSelection;
 constructor(statePath:string,selection:ActionThreadSelection){requireDiscordText(statePath);this.#path=statePath;this.#selection=selection;Object.freeze(this);}
 async context(channel:bigint,allThreads:boolean,refresh:boolean,limit:bigint,signal?:AbortSignal):Promise<ActionResult>{
  if(typeof channel!=='bigint'||channel<0n||channel>=(1n<<64n)||typeof allThreads!=='boolean'||typeof refresh!=='boolean'||typeof limit!=='bigint'||limit<0n||limit>0xffffffffn)throw new TypeError('Expected context action fields');signal?.throwIfAborted();
  const store=CodexThreadStore.open(this.#path),threads=allThreads?store.loadRecentThreads(limit):[await this.#selection.resolveThread(channel,null)],original=allThreads?null:threads[0]!.id;signal?.throwIfAborted();let text:string;
  try{text=await renderContextView(threads,refresh,Number(limit),'Visible',signal);}catch(error){signal?.throwIfAborted();throw new InvalidActionRequestError(error instanceof Error?error.message:'context reader failed');}signal?.throwIfAborted();if(original!==null&&(await this.#selection.target(channel))[0]!==original)throw new InvalidActionRequestError('context target changed during read; no current-room snapshot confirmed');signal?.throwIfAborted();return snapshotActionResult({text,waitsForFinal:false,ui:null});
 }
}
Object.freeze(ContextAction.prototype);
