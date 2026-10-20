import {types} from 'node:util';
import {gatewayOwnField} from '../../discord/gateway/values.ts';
import type {ActionThreadReads} from './thread-selection.ts';
import {PortableResidentLifecycle} from '../../app-server/portable-resident-lifecycle.ts';
import {resumeThreadWithTimeout,readThread} from '../../app-server/requests.ts';
import {serdeField} from '../../app-server/value.ts';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {CodexThreadStore} from '../../codex-state/store.ts';
import {ActionThreadSelection} from './thread-selection.ts';
import {InvalidActionRequestError} from './errors.ts';
import {originalOwnerActionError} from './archive-failure.ts';
import {requireDiscordText} from '../../discord/text.ts';
export type ArchivePreflightReads=Pick<typeof state,'listFiltered'|'listPromptIntakes'>&Pick<ActionThreadReads,'exact'>;
function captureReads(port:ArchivePreflightReads):ArchivePreflightReads{
 const capture=<K extends keyof ArchivePreflightReads>(key:K):ArchivePreflightReads[K]=>{const fn=gatewayOwnField(port,key);if(typeof fn!=='function'||types.isProxy(fn)||types.isGeneratorFunction(fn))throw new TypeError('Expected passive archive read function');return fn as ArchivePreflightReads[K];};
 return Object.freeze({listFiltered:capture('listFiltered'),listPromptIntakes:capture('listPromptIntakes'),exact:capture('exact')});
}
function readPromise<T>(value:Promise<T>):Promise<T>{if(!types.isPromise(value))throw new TypeError('Expected native archive read Promise');return value;}
/** Repeated observational guards only; not a reservation or archive permission.
 * Optional native reads preserve whole-queue/whole-intake/exact-row ordering.
 * Unfinished-ingress and selected-state checks remain direct. */
export class ArchiveTargetVerifier {
 readonly #reads:ArchivePreflightReads;readonly #mirror:string;readonly #codex:string;readonly #selection:ActionThreadSelection;readonly #server:PortableResidentLifecycle;readonly #resumeTimeout:number;
 constructor(mirror:string,codex:string,selection:ActionThreadSelection,server:PortableResidentLifecycle,resumeTimeoutMs:number,reads?:ArchivePreflightReads){this.#reads=captureReads(reads??{listFiltered:state.listFiltered,listPromptIntakes:state.listPromptIntakes,exact:async(id,archived)=>CodexThreadStore.open(codex).loadThread(id,archived)});requireDiscordText(mirror);requireDiscordText(codex);resumeThreadWithTimeout('',resumeTimeoutMs);this.#mirror=mirror;this.#codex=codex;this.#selection=selection;this.#server=server;this.#resumeTimeout=resumeTimeoutMs;Object.freeze(this);}
 async preflight(channel:bigint,reference:string|null,thread:string,generation:bigint,own:string|null,signal?:AbortSignal):Promise<void>{
  requireDiscordText(thread);if(reference!==null)requireDiscordText(reference);if(own!==null)requireDiscordText(own);if(typeof channel!=='bigint'||channel<0n||channel>=1n<<64n||typeof generation!=='bigint'||generation<0n||generation>=1n<<64n)throw new TypeError('Expected u64 archive scope');signal?.throwIfAborted();
  const server=this.#server,snapshot=PortableResidentLifecycle.prototype.lifecycleSnapshot.call(server);
  if(!snapshot.healthy||snapshot.quarantined||snapshot.restartPending||PortableResidentLifecycle.prototype.generation.call(server)!==generation)throw new InvalidActionRequestError('archive connection is unknown or changed; no archive was sent');
  if(reference===null&&(await ActionThreadSelection.prototype.target.call(this.#selection,channel))[0]!==thread)throw new InvalidActionRequestError('archive room target changed; no archive was sent');signal?.throwIfAborted();
  if(await PortableResidentLifecycle.prototype.activeTurnId.call(server,thread)!==null)throw new InvalidActionRequestError('refusing to archive a thread with an active turn');signal?.throwIfAborted();
  const pending=await state.unfinishedArchiveRequest(this.#mirror,thread,own);signal?.throwIfAborted();if(pending!==null)throw new InvalidActionRequestError(`refusing to archive while request ${pending} has unfinished ingress; request is preserved, no archive was sent`);
  const jobs=await readPromise(this.#reads.listFiltered(this.#mirror,null,null));signal?.throwIfAborted();if(jobs.some(job=>job.targetThreadId===thread))throw new InvalidActionRequestError('refusing to archive a thread with queued, running, or intake work; requests are preserved');
  const intake=await readPromise(this.#reads.listPromptIntakes(this.#mirror));signal?.throwIfAborted();if(intake.some(job=>job.targetThreadId===thread))throw new InvalidActionRequestError('refusing to archive a thread with queued, running, or intake work; requests are preserved');
  const stored=await readPromise(this.#reads.exact(thread,false,signal));signal?.throwIfAborted();if(stored===null)throw new InvalidActionRequestError('archive target is no longer an active stored thread');
 }
 async loadIdle(thread:string,generation:bigint,signal?:AbortSignal):Promise<void>{
  requireDiscordText(thread);if(typeof generation!=='bigint'||generation<0n||generation>=1n<<64n)throw new TypeError('Expected u64 archive generation');signal?.throwIfAborted();let resumed:unknown;
  try{resumed=await PortableResidentLifecycle.prototype.execute.call(this.#server,resumeThreadWithTimeout(thread,this.#resumeTimeout),generation,signal);}catch(error){if(signal?.aborted&&error===signal.reason)throw error;throw originalOwnerActionError('archive',thread,error);}
  signal?.throwIfAborted();if(serdeField(serdeField(resumed,'thread'),'id')!==thread)throw new InvalidActionRequestError('archive resume returned a missing or different thread identity');
  const read=await PortableResidentLifecycle.prototype.execute.call(this.#server,readThread(thread,false),generation,signal);signal?.throwIfAborted();if(serdeField(serdeField(read,'thread'),'id')!==thread||serdeField(serdeField(serdeField(read,'thread'),'status'),'type')!=='idle')throw new InvalidActionRequestError(`archive requires confirmed idle status for ${thread}; no archive was sent`);
 }
}
Object.freeze(ArchiveTargetVerifier.prototype);
