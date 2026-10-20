import {OwnedWorkerSlot,OwnedWorkerBusyError,OwnedWorkerTimeoutError} from '../owned-worker-slot.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import type {MirrorCursorAnchor,MirrorFileStamp} from '../../core/mirror-cursor-anchor.ts';
import {captureMirrorCursorAnchor,type MirrorContinuity} from './continuity-observation.ts';
import {MirrorFileChangedError} from './file-window.ts';
import {MIRROR_STARTUP_CONTEXT_HOLDS,MirrorStartupContextHeldError,sameMirrorStartupStamp,snapshotMirrorStartupContextLimits,snapshotMirrorStartupCutoffData,snapshotMirrorStartupContextResult,type MirrorStartupContextHold,type MirrorStartupContextLimits,type MirrorStartupCutoffData} from './startup-context-limits.ts';
export {MirrorStartupContextHeldError,type MirrorStartupContextHold,type MirrorStartupContextLimits} from './startup-context-limits.ts';
const token=Symbol('owned mirror startup context'),slot=new OwnedWorkerSlot();
export const mirrorStartupContextReaderBusy=():boolean=>slot.busy;
export const joinMirrorStartupContextReader=():Promise<void>=>slot.join();

/** Authentic exact native EOF, kept separately from its reconstruction. Keep
 * this instance for retries. A held non-LF cutoff stays held even after append.
 * Capturing a file does not prove this target is genuinely fresh in the store. */
export class MirrorStartupCutoff {
 readonly path:string;readonly offset:bigint;readonly fileStamp:MirrorFileStamp;readonly completeRecordBoundary:boolean;readonly #data:MirrorStartupCutoffData;
 constructor(key:symbol,data:MirrorStartupCutoffData){if(key!==token)throw new TypeError('Expected native mirror startup cutoff');this.#data=data;this.path=data.path;this.offset=data.offset;this.fileStamp=data.stamp;this.completeRecordBoundary=data.anchor!==null;Object.freeze(this);}
 captured():MirrorStartupCutoffData{return this.#data;}
}
Object.freeze(MirrorStartupCutoff.prototype);

/** Read-only reconstruction evidence, not bootstrap or cursor-write authority.
 * Null means a complete successful scan found no qualifying nonempty turn ID.
 * It never means a read, decode, budget, cancellation or continuity failure.
 * Sampled anchors do not certify unseen middle rewrites plus append; the existing
 * independent producer append-only contract is still required. This introduces
 * no DB state and claims no Rust persist-EOF-before-lazy-context crash parity. */
export class MirrorStartupContextObservation {
 readonly cutoff:MirrorStartupCutoff;readonly anchor:MirrorCursorAnchor;readonly continuity:MirrorContinuity;readonly currentTurn:string|null;readonly scannedRecords:number;readonly scannedBytes:bigint;readonly historyIntegrityVerified=false;readonly #anchor:MirrorCursorAnchor;
 constructor(key:symbol,cutoff:MirrorStartupCutoff,anchor:MirrorCursorAnchor,continuity:MirrorContinuity,currentTurn:string|null,scannedRecords:number){
  if(key!==token)throw new TypeError('Expected native mirror startup context');this.#anchor=anchor;this.cutoff=cutoff;this.anchor=anchor;this.continuity=continuity;this.currentTurn=currentTurn;this.scannedRecords=scannedRecords;this.scannedBytes=cutoff.offset;Object.freeze(this);
 }
 captured():Readonly<{cutoff:MirrorStartupCutoff;anchor:MirrorCursorAnchor;currentTurn:string|null}>{void this.#anchor;return Object.freeze({cutoff:this.cutoff,anchor:this.anchor,currentTurn:this.currentTurn});}
 /** Only <=512 anchor bytes are read here. Append after the reconstruction is
  * a changed observation, not permission to replace its exact N or context. */
 async verifyCurrent(signal?:AbortSignal):Promise<void>{
  const anchor=this.#anchor,now=(await captureMirrorCursorAnchor(anchor.path,anchor.offset,signal,anchor.version===3)).anchor;
  if(!sameMirrorStartupStamp(anchor.stamp,now.stamp)||anchor.prefixHash!==now.prefixHash||anchor.tailHash!==now.tailHash||anchor.historyHash!==now.historyHash)throw new MirrorFileChangedError();
 }
}
Object.freeze(MirrorStartupContextObservation.prototype);

/** One owned native reader, zero queue. Capture is separate so no failed read
 * implicitly resamples EOF. No store is opened, initialized or written here. */
export async function captureMirrorStartupCutoff(path:string,timeoutMs=5000,signal?:AbortSignal,fullPrefix=false):Promise<MirrorStartupCutoff> {
 signal?.throwIfAborted();boundedPath(path);const pinned=pinNativeRuntimePath(path);boundedPath(pinned);deadline(timeoutMs);
 const value=await native({kind:'Capture',path:pinned,fullPrefix},timeoutMs,signal),data=snapshotMirrorStartupCutoffData(value);
 if(data.path!==pinned)throw new TypeError('Unexpected native mirror startup path');
 return new MirrorStartupCutoff(token,data);
}
export async function readMirrorStartupContext(cutoff:MirrorStartupCutoff,input:MirrorStartupContextLimits,signal?:AbortSignal):Promise<MirrorStartupContextObservation> {
 signal?.throwIfAborted();const data=MirrorStartupCutoff.prototype.captured.call(cutoff),limits=snapshotMirrorStartupContextLimits(input);
 if(data.anchor===null)throw new MirrorStartupContextHeldError('IncompleteBoundary');
 if(data.offset>BigInt(limits.maxBytes))throw new MirrorStartupContextHeldError('ByteBudget');
 const value=await native({kind:'Read',cutoff:data,limits},limits.timeoutMs,signal),result=snapshotMirrorStartupContextResult(data,limits,value);
 return new MirrorStartupContextObservation(token,cutoff,result.anchor,result.continuity,result.currentTurn,result.scannedRecords);
}
function boundedPath(path:string):void{if(typeof path!=='string'||path.length>32768)throw new RangeError('Invalid mirror startup path budget');requireDiscordText(path);if(path.includes('\0')||Buffer.byteLength(path)>32768)throw new RangeError('Invalid mirror startup path budget');}
function deadline(timeoutMs:number):void{if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid mirror startup deadline');}
async function native(request:unknown,timeoutMs:number,signal?:AbortSignal):Promise<unknown> {
 signal?.throwIfAborted();if(slot.busy)throw new OwnedWorkerBusyError();
 const cancel=new Int32Array(new SharedArrayBuffer(4)),abort=()=>{Atomics.store(cancel,0,1);};signal?.addEventListener('abort',abort,{once:true});
 let result:unknown;
 try{
  const pending=slot.run(new URL('./startup-context-worker.ts',import.meta.url),{...request as object,cancel:cancel.buffer,timeoutMs},timeoutMs,signal),exited=slot.join();
  try{result=await pending;}catch(error){abort();if(error instanceof OwnedWorkerTimeoutError)throw new MirrorStartupContextHeldError('Deadline',error);throw error;}finally{await exited;}
 }finally{signal?.removeEventListener('abort',abort);}
 signal?.throwIfAborted();if(own(result,'ok')!==true){const reason=own(result,'reason');if(typeof reason!=='string'||!MIRROR_STARTUP_CONTEXT_HOLDS.includes(reason as MirrorStartupContextHold))throw new TypeError('Invalid native mirror startup failure');throw new MirrorStartupContextHeldError(reason as MirrorStartupContextHold);}
 return own(result,'value');
}
