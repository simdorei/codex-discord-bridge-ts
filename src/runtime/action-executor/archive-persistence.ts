import {setTimeout as delay} from 'node:timers/promises';
import {CodexThreadStore} from '../../codex-state/store.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {InvalidActionRequestError} from './errors.ts';
/** Read-only post-dispatch evidence, never a retry permission. The caller keeps
 * its durable reservation until every scope member is confirmed archived.
 * Synchronous Codex DB reads still require production ownership/offload. */
export async function verifyArchivedScope(path:string,input:readonly string[],signal?:AbortSignal):Promise<void>{
 requireDiscordText(path);const scope=cloneOwnedSerdeValue(input);if(!Array.isArray(scope)||scope.length===0||scope.length>101)throw new TypeError('Expected bounded archive scope');
 for(const id of scope)requireDiscordText(id);if(new Set(scope).size!==scope.length||scope.some(id=>id===''))throw new TypeError('Expected unique nonempty archive scope');
 const deadline=performance.now()+3000;
 for(;;){
  signal?.throwIfAborted();const store=CodexThreadStore.open(path),unverified:string[]=[];
  for(const thread of scope){signal?.throwIfAborted();if(store.loadThread(thread,true)===null)unverified.push(thread);}
  signal?.throwIfAborted();if(unverified.length===0)return;
  const remaining=deadline-performance.now();if(remaining<=0)throw new InvalidActionRequestError(`archive was acknowledged but persisted state was not verified for [${unverified.join(', ')}]; other scope members may already be archived; do not automatically retry`);
  try{await delay(Math.min(100,remaining),undefined,{signal});}catch(error){if(signal?.aborted)throw signal.reason;throw error;}
 }
}
