import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {types} from 'node:util';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {snapshotStoredIngress,storedIngressEqual} from '../../store/ingress-snapshot.ts';
import type {StoredIngress} from '../../store/ingress-read.ts';
import {getOwn} from '../../store/async-resolution-json-helpers.ts';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {BridgeState} from '../bridge-state.ts';
import {NativeBridgeStateOwner,type BridgeSelectionSnapshot,type BridgeSelectionLease} from '../bridge-state-native.ts';
import {snapshotSettingsBinding,validateSelectedSettingsSnapshot} from '../action-executor/settings-snapshot.ts';
import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../owned-worker-slot.ts';
export interface NativeRepairClaim {readonly __nativeRepairClaim?:never}
export class NativeRepairClaimUnknownError extends Error {
 constructor(cause:unknown){super('Native Repair recovery admission changed or has no confirmed acknowledgement after native exit; retain original custody, no fresh claim or retry',{cause});this.name='NativeRepairClaimUnknownError';}
}
function capture(input:StoredIngress):StoredIngress{
 if(input===null||typeof input!=='object'||types.isProxy(input)||Object.getOwnPropertySymbols(input).length!==0)throw new TypeError('Expected original Repair ingress data');
 const probe=Object.create(null);for(const key of Object.getOwnPropertyNames(input)){const value=own(input,key);Object.defineProperty(probe,key,{value:key==='outcome'&&value===undefined?null:value,enumerable:true});}
 if(boundedSerdeByteCount(probe,1048576)===null)throw new RangeError('Repair ingress evidence exceeds budget');return snapshotStoredIngress(input);
}
function checkSignal(signal:AbortSignal|undefined):void{
 if(signal!==undefined&&(types.isProxy(signal)||Object.getPrototypeOf(signal)!==AbortSignal.prototype||['throwIfAborted','aborted','reason','addEventListener','removeEventListener'].some(key=>Object.hasOwn(signal,key))))throw new TypeError('Expected unmodified native Repair AbortSignal');
 if(signal!==undefined)AbortSignal.prototype.throwIfAborted.call(signal);
}
/** Dedicated Repair write owner, not a RecoveryClaim minting adapter. The exact
 * original and confirmed post-write snapshot never leave this owner. Its opaque
 * token only authorizes synchronous checks on that same SQLite main database.
 * One installed owner survives execute calls: any submitted unknown result
 * permanently blocks further claims, including a different ingress. Control1,
 * zero queue; Selected lease and worker slot remain owned through real exit.
 * Native Selected users must share one Bridge owner with no mixed writers. */
export class NativeRepairClaimOwner{
 readonly #path:string;readonly #bridge:BridgeState;readonly #native:NativeBridgeStateOwner|undefined;readonly #slot=new OwnedWorkerSlot('Control');
 readonly #claims=new WeakMap<object,{record:StoredIngress;location:string;selection:BridgeSelectionSnapshot|null}>();
 #unknown:NativeRepairClaimUnknownError|null=null;#active:Promise<NativeRepairClaim>|null=null;#closed=false;#controller:AbortController|null=null;
 constructor(path:string,bridge:BridgeState,native?:NativeBridgeStateOwner){
  requireDiscordText(path);if(path.includes('\0')||Buffer.byteLength(path)>32768)throw new TypeError('Invalid Repair store path');this.#path=pinNativeRuntimePath(path);if(Buffer.byteLength(this.#path)>32768)throw new RangeError('Repair store path exceeds budget');if(native!==undefined)NativeBridgeStateOwner.prototype.path.call(native);this.#bridge=bridge;this.#native=native;Object.freeze(this);
 }
 assertOwner(path:string,bridge:BridgeState,native?:NativeBridgeStateOwner):void{if(pinNativeRuntimePath(path)!==this.#path||bridge!==this.#bridge||native!==this.#native)throw new TypeError('Repair claim owner belongs to another database or Bridge');}
 #selected(record:StoredIngress,selection:BridgeSelectionSnapshot|null):void{
  const binding=snapshotSettingsBinding(getOwn(record.payload,'lifecycle_binding'));
  if(binding.route==='Selected'&&this.#native!==undefined){if(selection===null)throw new TypeError('Missing original Repair selection snapshot');NativeBridgeStateOwner.prototype.validateSelected.call(this.#native,selection,binding.target);}
  else{if(selection!==null)throw new TypeError('Unexpected Repair selection snapshot');validateSelectedSettingsSnapshot(binding,this.#bridge);}
 }
 claim(input:StoredIngress,selection:BridgeSelectionSnapshot|null=null,signal?:AbortSignal,timeoutMs=5000):Promise<NativeRepairClaim>{
  checkSignal(signal);if(this.#closed)throw new Error('Repair claim owner is closed');if(this.#unknown!==null)throw this.#unknown;if(this.#active!==null||this.#slot.busy)throw new OwnedWorkerBusyError();
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>5000)throw new TypeError('Expected bounded Repair claim deadline');
  const record=capture(input),binding=snapshotSettingsBinding(getOwn(record.payload,'lifecycle_binding'));
  if(getOwn(binding.command,'Repair')===undefined)throw new TypeError('Native Repair owner requires original Repair custody');this.#selected(record,selection);
  // Reuse Repair's existing synchronous preclaim read. Capture the fixed-path
  // SQLite identity before submission; an ACK cannot nominate another database.
  const read=state.openCheckedRead(this.#path);let expectedLocation:string;
  try{const db=read.connection();state.validateRecoveryEffectIn(db,binding,record.channelId,null);const location=DatabaseSync.prototype.location.call(db,'main');requireDiscordText(location);if(location.length===0||Buffer.byteLength(location)>32768)throw new TypeError('Invalid original Repair database location');expectedLocation=location;read.finish();}finally{read.close();}

  const id=randomUUID(),now=Date.now()/1000,controller=new AbortController();this.#controller=controller;
  const source=signal,aborted=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'aborted')!.get!,reason=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'reason')!.get!;
  const abort=()=>{if(source!==undefined&&aborted.call(source))controller.abort(reason.call(source));};if(source!==undefined)EventTarget.prototype.addEventListener.call(source,'abort',abort,{once:true});abort();
  let admitted=false,lease:BridgeSelectionLease|undefined;
  const task=(async()=>{try{
   if(selection!==null)lease=NativeBridgeStateOwner.prototype.holdSelected.call(this.#native!,selection,binding.target,id,record.ingressId);
   const proof=lease===undefined?null:NativeBridgeStateOwner.prototype.selectedLeaseProof.call(this.#native!,lease);
   const pending=this.#slot.run(new URL('./native-repair-worker.ts',import.meta.url),{id,path:this.#path,operation:'claimRepair',record,now,proof},timeoutMs,controller.signal);admitted=this.#slot.busy;
   let raw:unknown;try{raw=await pending;}finally{await this.#slot.join();if(lease!==undefined)NativeBridgeStateOwner.prototype.validateSelectedLease.call(this.#native!,lease);}
   checkSignal(source);controller.signal.throwIfAborted();if(this.#closed)throw new Error('Repair owner closed before acknowledgement');this.#selected(record,selection);
   if(raw===null||typeof raw!=='object'||types.isProxy(raw)||Object.getOwnPropertySymbols(raw).length!==0||Object.getOwnPropertyNames(raw).length!==6)throw new TypeError('Invalid Repair acknowledgement envelope');
   if(own(raw,'id')!==id||own(raw,'path')!==this.#path||own(raw,'operation')!=='claimRepair'||own(raw,'ok')!==true)throw new Error('Unconfirmed Repair claim acknowledgement');
   const location=own(raw,'location');requireDiscordText(location);if(location!==expectedLocation)throw new TypeError('Repair acknowledgement belongs to another database');
   const saved=capture(own(raw,'record') as StoredIngress),expected=snapshotStoredIngress(record);expected.phase='recovery_claimed';expected.updatedAt=now;if(!storedIngressEqual(saved,expected))throw new Error('Repair claim acknowledgement changed original identity');
   const token=Object.freeze({});this.#claims.set(token,{record:saved,location,selection});return token;
  }catch(error){if(admitted){this.#unknown=new NativeRepairClaimUnknownError(error);throw this.#unknown;}throw error;}
  finally{try{if(lease!==undefined)NativeBridgeStateOwner.prototype.releaseSelectedLease.call(this.#native!,lease);}finally{if(source!==undefined)EventTarget.prototype.removeEventListener.call(source,'abort',abort);}}})();
  this.#active=task;const clear=()=>{if(this.#active===task){this.#active=null;this.#controller=null;}};void task.then(clear,clear);return task;
 }
 /** Borrow the caller's transaction, including its uncommitted changes. No open,
  * commit, rollback, await, snapshot replacement or JSON capability import. */
 checkIn(token:NativeRepairClaim,db:DatabaseSync):undefined{
  if(this.#closed)throw new Error('Repair claim owner is closed');if(this.#unknown!==null)throw this.#unknown;
  const claim=typeof token==='object'&&token!==null?this.#claims.get(token):undefined;if(claim===undefined)throw new TypeError('Unknown native Repair claim');
  if(DatabaseSync.prototype.location.call(db,'main')!==claim.location)throw new TypeError('Repair claim belongs to another database');
  this.#selected(claim.record,claim.selection);state.validateIngressRecoverySnapshotIn(db,claim.record);state.validateRecoveryEffectIn(db,getOwn(claim.record.payload,'lifecycle_binding'),claim.record.channelId,null);return undefined;
 }
 async close(reason:unknown=new Error('Repair claim owner closed')):Promise<void>{this.#closed=true;this.#controller?.abort(reason);await Promise.allSettled(this.#active===null?[]:[this.#active]);await this.#slot.join();}
}
Object.freeze(NativeRepairClaimOwner.prototype);
