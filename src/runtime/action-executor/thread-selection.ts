import {NativeBridgeStateOwner} from '../bridge-state-native.ts';
import {types} from 'node:util';
import {gatewayOwnField} from '../../discord/gateway/values.ts';
import {resolveThreadReferenceOffThread} from '../../codex-state/reference-reader.ts';
import {CodexThreadStore} from '../../codex-state/store.ts';
import {resolveThreadRef, ThreadResolveError} from '../../codex-state/thread-reference.ts';
import type {ThreadInfo} from '../../codex-state/thread.ts';
import {rustTrim} from '../../app-server/value.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {StateAccessFacade} from '../../store/state-access-facade.ts';
import {BridgeState} from '../bridge-state.ts';
import {ActionIntegerRangeError, InvalidActionRequestError, NoActionTargetError} from './errors.ts';
export type ActionMappingRead = typeof StateAccessFacade.mirroredThreadId;
export interface ActionThreadReads {readonly resolve:(reference:string,archived:boolean,signal?:AbortSignal)=>Promise<ThreadInfo>;readonly exact:(id:string,archived:boolean,signal?:AbortSignal)=>Promise<ThreadInfo|null>}
function captureReads(input:ActionThreadReads|undefined):ActionThreadReads|undefined{if(input===undefined)return undefined;const capture=<K extends keyof ActionThreadReads>(key:K):ActionThreadReads[K]=>{const f=gatewayOwnField(input,key);if(typeof f!=='function'||types.isProxy(f)||types.isGeneratorFunction(f))throw new TypeError('Expected passive thread read function');return f as ActionThreadReads[K];};return Object.freeze({resolve:capture('resolve'),exact:capture('exact')});}
function nativePromise<T>(p:Promise<T>):Promise<T>{if(!types.isPromise(p))throw new TypeError('Expected native thread read Promise');return p;}
/** Original-target selection only. Never canonicalizes forks or substitutes a
 * selected target for a stale room mapping. Synchronous Codex/bridge reads need
 * the production owned filesystem boundary; Windows reference parity pending. */
export class ActionThreadSelection {
 readonly #nativeBridge:NativeBridgeStateOwner|undefined;
  readonly #reads:ActionThreadReads|undefined;
  readonly #mapped: ActionMappingRead;
  readonly #statePath: string;
  readonly #bridgePath:string;
  readonly #mirrorPath: string;
  readonly #selected: () => string | null;
  readonly #select: (id: string | null) => void;
  constructor(statePath: string, mirrorPath: string, bridge: BridgeState, mapped: ActionMappingRead = StateAccessFacade.mirroredThreadId, reads?:ActionThreadReads,nativeBridge?:NativeBridgeStateOwner) {this.#nativeBridge=nativeBridge;
    this.#reads=captureReads(reads);
    if(typeof mapped!=='function'||types.isProxy(mapped)||types.isGeneratorFunction(mapped))throw new TypeError('Expected passive mapping read function');this.#mapped=mapped;
    requireDiscordText(statePath); requireDiscordText(mirrorPath);
    this.#statePath = statePath; this.#mirrorPath = mirrorPath;this.#bridgePath=BridgeState.prototype.path.call(bridge);
    this.#selected = BridgeState.prototype.selectedThreadId.bind(bridge);
    this.#select = BridgeState.prototype.setSelectedThreadId.bind(bridge);
    Object.freeze(this);
  }
  async target(channel: bigint): Promise<readonly [string, 'mirror' | 'selected']> {
    if (typeof channel !== 'bigint' || channel < 0n || channel >= 1n << 64n) throw new TypeError('Expected u64 channel');
    if (channel >= 1n << 63n) throw new ActionIntegerRangeError();
    const pending=this.#mapped(this.#mirrorPath,channel);if(!types.isPromise(pending))throw new TypeError('Expected native mapping read Promise');const mirror=await pending;
    if(mirror!==null)requireDiscordText(mirror);
    if (mirror !== null) return Object.freeze([mirror, 'mirror'] as const);
    const selected = this.#nativeBridge===undefined?this.#selected():await this.#nativeBridge.execute({kind:'Selected'}) as string|null;
    if (selected === null) throw new NoActionTargetError();
    return Object.freeze([selected, 'selected'] as const);
  }
  async targetThreadId(channel: bigint): Promise<string> {return (await this.target(channel))[0];}
  resolveReference(input: string, archived = false): ThreadInfo {
    requireDiscordText(input);
    if (typeof archived !== 'boolean') throw new TypeError('Expected archived flag');

    const store = CodexThreadStore.open(this.#statePath), reference = rustTrim(input);
    const exact = store.loadThread(reference, archived);
    if (exact !== null) return exact;
    const threads = archived ? store.loadArchivedThreads(0n) : store.loadRecentThreads(0n);
    return resolveThreadRef(threads, reference, this.#selected(), archived);
  }
  async archiveDeletePreview(reference:string,signal?:AbortSignal):Promise<string>{
    signal?.throwIfAborted();const thread=await resolveThreadReferenceOffThread(this.#statePath,reference,null,true,signal,6000,this.#bridgePath);
    return `Archived thread deletion preview\nthread_id: ${thread.id}\ntitle: ${thread.title}\ncwd: ${thread.cwd}\nrollout_path: ${thread.rolloutPath}\nTo delete, run !confirm_delete_archive ${thread.id}`;
  }
  async resolveReferenceAsync(input:string,archived=false,signal?:AbortSignal):Promise<ThreadInfo>{
    signal?.throwIfAborted();requireDiscordText(input);if(typeof archived!=='boolean')throw new TypeError('Expected archived flag');
    const result=this.#reads===undefined?this.resolveReference(input,archived):await nativePromise(this.#reads.resolve(input,archived,signal));signal?.throwIfAborted();return result;
  }
  async resolveThread(channel: bigint, reference: string | null,signal?:AbortSignal): Promise<ThreadInfo> {
    signal?.throwIfAborted();if (reference !== null) return this.resolveReferenceAsync(reference, false,signal);
    const target = await this.targetThreadId(channel);
    signal?.throwIfAborted();const thread = this.#reads===undefined?CodexThreadStore.open(this.#statePath).loadThread(target,false):await nativePromise(this.#reads.exact(target,false,signal));signal?.throwIfAborted();
    if (thread === null) throw new ThreadResolveError('NotFound', target);
    return thread;
  }
  async selectAsync(reference:string,signal?:AbortSignal):Promise<string>{
    const thread=await this.resolveReferenceAsync(reference,false,signal);signal?.throwIfAborted();if(this.#nativeBridge===undefined)this.#select(thread.id);else await this.#nativeBridge.execute({kind:'Select',id:thread.id},signal);
    const workspace=thread.cwd.split(/[\\/]/u).filter(part=>part!=='').at(-1)??'-';return `Selected Codex thread\nthread_id: ${thread.id}\nworkspace: ${workspace}\ntitle: ${thread.title}`;
  }
  select(reference: string): string {
    if(this.#nativeBridge!==undefined)throw new TypeError("Synchronous selection is unavailable with native Bridge owner");
    const thread = this.resolveReference(reference, false);
    this.#select(thread.id);
    const workspace = thread.cwd.split(/[\\/]/u).filter(part => part !== '').at(-1) ?? '-';
    return `Selected Codex thread\nthread_id: ${thread.id}\nworkspace: ${workspace}\ntitle: ${thread.title}`;
  }
  async whereMessage(channel: bigint): Promise<string> {
    const [target, source] = await this.target(channel);
    const thread = await this.resolveThread(channel, null);
    if (thread.id !== target) throw new InvalidActionRequestError('where target changed during lookup');
    const mapping = source === 'mirror' ? 'mapped to this Discord room' : 'unmapped; using global selected thread (not a room mapping)';
    return `Codex target\nsource: ${source}\nthread_id: ${target}\ndiscord_mapping: ${mapping}\ntitle: ${thread.title}\ncwd: ${thread.cwd}`;
  }
}
Object.freeze(ActionThreadSelection.prototype);
