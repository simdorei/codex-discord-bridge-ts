import {types} from 'node:util';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {setTimeout as delay} from 'node:timers/promises';
import {CodexThreadStore} from '../../codex-state/store.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {InvalidActionRequestError} from './errors.ts';
export type ArchiveScopeRead=(path:string,scope:readonly string[],signal:AbortSignal|undefined,timeoutMs:number)=>Promise<readonly string[]>;
export function captureArchiveScopeRead(read:ArchiveScopeRead|undefined):ArchiveScopeRead|undefined{if(read!==undefined&&(typeof read!=='function'||types.isProxy(read)||types.isGeneratorFunction(read)))throw new TypeError('Expected passive archive scope read');return read;}
/** Read-only post-dispatch evidence, never a retry permission. The caller keeps
 * its durable reservation until every scope member is confirmed archived.
 * Optional native batch uses the remaining original three-second budget. */
export async function verifyArchivedScope(path:string,input:readonly string[],signal?:AbortSignal,read?:ArchiveScopeRead):Promise<void>{
 const batch=captureArchiveScopeRead(read);requireDiscordText(path);const scope=cloneOwnedSerdeValue(input);if(!Array.isArray(scope)||scope.length===0||scope.length>101)throw new TypeError('Expected bounded archive scope');
 for(const id of scope)requireDiscordText(id);if(new Set(scope).size!==scope.length||scope.some(id=>id===''))throw new TypeError('Expected unique nonempty archive scope');
 const deadline=performance.now()+3000;let lastMissing:readonly string[]=scope;
 const exhausted=()=>new InvalidActionRequestError(`archive was acknowledged but persisted state was not verified for [${lastMissing.join(', ')}]; other scope members may already be archived; do not automatically retry`);
 for(;;){
  signal?.throwIfAborted();let unverified:readonly string[];
  if(batch===undefined){const store=CodexThreadStore.open(path),missing:string[]=[];for(const thread of scope){signal?.throwIfAborted();if(store.loadThread(thread,true)===null)missing.push(thread);}unverified=missing;}
  else{const remaining=Math.floor(deadline-performance.now());if(remaining<1)throw exhausted();const pending=batch(path,scope,signal,remaining);if(!types.isPromise(pending))throw new TypeError('Expected native archive scope Promise');const raw=await pending;signal?.throwIfAborted();if(boundedSerdeByteCount(raw,4194304)===null)throw new TypeError('Invalid archive scope result');const missing=cloneOwnedSerdeValue(raw);if(!Array.isArray(missing)||missing.length>scope.length)throw new TypeError('Invalid archive scope result');let previous=-1;for(const id of missing){requireDiscordText(id);const at=scope.indexOf(id);if(at<=previous)throw new TypeError('Expected ordered original missing scope');previous=at;}unverified=missing;}
  lastMissing=unverified;
  signal?.throwIfAborted();if(unverified.length===0)return;
  const remaining=deadline-performance.now();if(remaining<=0)throw exhausted();
  try{await delay(Math.min(100,remaining),undefined,{signal});}catch(error){if(signal?.aborted)throw signal.reason;throw error;}
 }
}
