import {types} from 'node:util';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {OwnedWorkerBusyError} from '../owned-worker-slot.ts';
import {captureMirrorDiscoveryLimits,type MirrorThreadHint} from './discovery.ts';
import {captureMirrorStoreDiscoveryLimits,type MirrorStoreSnapshot} from './store-discovery.ts';
import {discoverMirrorSnapshot,type MirrorSnapshotLimits,type MirrorDiscoverySnapshot} from './discovery-snapshot.ts';
import {MirrorDispatch,type MirrorDispatchResult} from './dispatch.ts';
import type {MirrorReadyLimits} from './ready.ts';
import type {MirrorPollCounts,MirrorTargetFinished} from './execution.ts';
export type SnapshotMirrorPoll=(thread:MirrorThreadHint,channel:bigint,jobs:MirrorStoreSnapshot['jobs'],signal:AbortSignal)=>Promise<MirrorPollCounts>;
export class MirrorTargetUnavailableError extends Error{constructor(){super('Mirror target unavailable in original Codex discovery');this.name='MirrorTargetUnavailableError';}}
/** Native discovery plus source-order dispatch ownership. Every submitted poll
 * captures the exact thread/queue snapshot before its Promise microtask starts.
 * Later refresh cannot retarget running work or replace its ownership evidence.
 * Poll remains an explicit trusted adapter that must own/join its children and
 * reconcile receipts before effects. No timer, cursor commit or service startup. */
export class MirrorSnapshotOwner{
 readonly #state:string;readonly #bridge:string;readonly #limits:MirrorSnapshotLimits;readonly #poll:SnapshotMirrorPoll;readonly #dispatch:MirrorDispatch;readonly #abort=new AbortController();
 #threads=new Map<string,MirrorThreadHint>();#faulted=false;#snapshot:MirrorDiscoverySnapshot|null=null;#refresh:Promise<void>|null=null;#closed=false;#closing:Promise<readonly MirrorTargetFinished[]>|null=null;
 constructor(state:string,bridge:string,limits:MirrorSnapshotLimits,ready:MirrorReadyLimits,poll:SnapshotMirrorPoll,render:(error:unknown)=>string){
  requireDiscordText(state);requireDiscordText(bridge);if(typeof poll!=='function'||types.isProxy(poll)||types.isGeneratorFunction(poll))throw new TypeError('Expected owned snapshot poll adapter');
  this.#state=state;this.#bridge=bridge;this.#limits=Object.freeze({threads:captureMirrorDiscoveryLimits(own(limits,'threads') as MirrorSnapshotLimits['threads']),store:captureMirrorStoreDiscoveryLimits(own(limits,'store') as MirrorSnapshotLimits['store'])});this.#poll=poll;
  this.#dispatch=new MirrorDispatch(ready,()=>Promise.reject(new Error('Mirror snapshot binding missing')),render);
 }
 #open():void{if(this.#closed||this.#faulted)throw new TypeError('Mirror snapshot owner closed or faulted');}
 get activeCount():number{return this.#dispatch.activeCount;}
 get refreshing():boolean{return this.#refresh!==null;}
 async refresh(signal?:AbortSignal):Promise<void>{
  this.#open();signal?.throwIfAborted();if(this.#refresh!==null)throw new OwnedWorkerBusyError();
  const abort=new AbortController(),stop=()=>abort.abort(this.#abort.signal.reason),cancel=()=>abort.abort(signal!.reason);
  this.#abort.signal.addEventListener('abort',stop,{once:true});signal?.addEventListener('abort',cancel,{once:true});if(this.#abort.signal.aborted)stop();if(signal?.aborted)cancel();
  const operation=(async()=>{const snapshot=await discoverMirrorSnapshot(this.#state,this.#bridge,this.#limits,abort.signal);abort.signal.throwIfAborted();this.#open();const threads=new Map(snapshot.threads.map(t=>[t.id,t]));this.#dispatch.refresh(snapshot.targets.map(t=>({thread:t.codexThreadId,channel:t.discordThreadId})));this.#threads=threads;this.#snapshot=snapshot;})();this.#refresh=operation;
  try{await operation;}catch(error){this.#faulted=true;throw error;}finally{this.#refresh=null;this.#abort.signal.removeEventListener('abort',stop);signal?.removeEventListener('abort',cancel);}
 }
 dispatch():number{
  this.#open();if(this.#refresh!==null)throw new OwnedWorkerBusyError();const snapshot=this.#snapshot;if(snapshot===null)throw new TypeError('Mirror snapshot has not been discovered');
  const threads=this.#threads;const poll=this.#poll;
  return this.#dispatch.dispatch((target,signal)=>{const thread=threads.get(target.thread);return thread===undefined?Promise.reject(new MirrorTargetUnavailableError()):poll(thread,target.channel,snapshot.jobs,signal);});
 }
 harvest():readonly MirrorDispatchResult[]{this.#open();return this.#dispatch.harvest();}
 waitForSettlement(signal?:AbortSignal):Promise<boolean>{this.#open();return this.#dispatch.waitForSettlement(signal);}
 close(reason:unknown=new Error('Mirror snapshot owner stopped')):Promise<readonly MirrorTargetFinished[]>{
  if(this.#closing!==null)return this.#closing;this.#closed=true;const refresh=this.#refresh;this.#abort.abort(reason);const targets=this.#dispatch.close(reason);
  this.#closing=(async()=>{await refresh?.catch(()=>undefined);const result=await targets;this.#snapshot=null;this.#threads.clear();return result;})();return this.#closing;
 }
}
Object.freeze(MirrorSnapshotOwner.prototype);
