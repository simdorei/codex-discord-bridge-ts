import {snapshotMirrorCursorAnchor as captureExpected,type MirrorCursorAnchor} from '../../core/mirror-cursor-anchor.ts';
import {observeMirrorBatch,type MirrorBatchObservation} from './batch-observation.ts';
import {snapshotMirrorReadLimits,type MirrorReadLimits} from './read-window.ts';
import {snapshotMirrorItemOptions,type MirrorItemOptions} from './decode-reader.ts';
import {createHash} from 'node:crypto';
import {MirrorFileWindow,type MirrorFileStamp,MirrorFileChangedError} from './file-window.ts';
import {requireDiscordText} from '../../discord/text.ts';
export type {MirrorCursorAnchor} from '../../core/mirror-cursor-anchor.ts';
export type MirrorContinuity='UnchangedMetadataAndAnchors'|'SameIdentityGrowthAndAnchors';
const stampKeys=['dev','ino','birthtimeNs','mtimeNs','ctimeNs','size'] as const;
const token=Symbol('native mirror continuity observation');
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const sameStamp=(a:MirrorFileStamp,b:MirrorFileStamp)=>stampKeys.every(k=>a[k]===b[k]);
/** A bounded point-in-time continuity observation, never historical integrity,
 * delivery evidence, cursor authority or permission to adopt a legacy cursor. */
export class MirrorContinuityObservation{
 readonly anchor:MirrorCursorAnchor;readonly historyIntegrityVerified=false;readonly #window:MirrorFileWindow;
 constructor(key:symbol,anchor:MirrorCursorAnchor,window:MirrorFileWindow){
  if(key!==token)throw new TypeError('Expected native mirror continuity observation');
  this.anchor=anchor;this.#window=window;Object.freeze(this);
 }
 async verifyCurrent(signal?:AbortSignal):Promise<void>{await this.#window.verifyCurrent(signal);}
}
Object.freeze(MirrorContinuityObservation.prototype);
/** Reads at most 256 prefix + 256 pre-cursor bytes, not the whole rollout.
 * A zero cursor needs one bounded byte read for native metadata only.
 * The caller must already know what the offset means; capturing now does not
 * retroactively prove old delivery, generation or append-only history. */
export async function captureMirrorCursorAnchor(path:string,offset:bigint,signal?:AbortSignal):Promise<MirrorContinuityObservation>{
 requireDiscordText(path);if(path.length>32768||Buffer.byteLength(path)>32768)throw new RangeError('Mirror anchor path budget exceeded');
 if(typeof offset!=='bigint'||offset<0n||offset>=(1n<<64n))throw new RangeError('Expected u64 cursor');
 const length=Number(offset<256n?offset:256n),start=offset-BigInt(length);
 const tail=await MirrorFileWindow.read(path,start,length||1,signal),tailBytes=tail.copyBytes().slice(0,length);
 if(tailBytes.length!==length||(offset>0n&&tailBytes[length-1]!==10))throw new MirrorFileChangedError();
 let prefixBytes:Uint8Array=tailBytes;
 if(start>0n){
  const prefix=await MirrorFileWindow.read(path,0n,length,signal);
  if(!sameStamp(tail.generation,prefix.generation))throw new MirrorFileChangedError();
  prefixBytes=prefix.copyBytes();
 }
 const anchor=captureExpected({version:1,path:tail.path,offset,stamp:tail.generation,prefixHash:hash(prefixBytes),tailHash:hash(tailBytes)});
 signal?.throwIfAborted();return new MirrorContinuityObservation(token,anchor,tail);
}
/** Replacement, observed shrink, changed anchors, or same-size metadata change
 * is refused. Growth with matching bounded anchors is classified, NOT certified:
 * an in-place rewrite outside those anchors followed by append can remain unseen.
 * Use requires a separate producer append-only contract; never silently upgrade
 * an unbound legacy cursor or infer successful delivery from this result. */
export async function observeMirrorCursorContinuity(expected:MirrorCursorAnchor,signal?:AbortSignal):Promise<Readonly<{kind:MirrorContinuity;observation:MirrorContinuityObservation}>>{
 const prior=captureExpected(expected);signal?.throwIfAborted();
 const observation=await captureMirrorCursorAnchor(prior.path,prior.offset,signal),now=observation.anchor;
 if(prior.stamp.dev!==now.stamp.dev||prior.stamp.ino!==now.stamp.ino||prior.stamp.birthtimeNs!==now.stamp.birthtimeNs||now.stamp.size<prior.stamp.size||prior.prefixHash!==now.prefixHash||prior.tailHash!==now.tailHash)throw new MirrorFileChangedError();
 const sameSize=prior.stamp.size===now.stamp.size;
 if(sameSize&&!sameStamp(prior.stamp,now.stamp))throw new MirrorFileChangedError();
 return Object.freeze({kind:sameSize?'UnchangedMetadataAndAnchors':'SameIdentityGrowthAndAnchors',observation});
}

/** Couples the checked old boundary to the exact native decoded file window.
 * Both anchors are still observations: no receipt/ownership/DB commit authority. */
export class AnchoredMirrorBatch{
 readonly continuity:MirrorContinuity;readonly expectedAnchor:MirrorCursorAnchor;readonly prior:MirrorCursorAnchor;readonly batch:MirrorBatchObservation;readonly historyIntegrityVerified=false;readonly #batch:MirrorBatchObservation;
 constructor(key:symbol,continuity:MirrorContinuity,prior:MirrorCursorAnchor,batch:MirrorBatchObservation,expectedAnchor:MirrorCursorAnchor=prior){
  if(key!==token)throw new TypeError('Expected owned anchored mirror batch');
  this.continuity=continuity;this.expectedAnchor=expectedAnchor;this.prior=prior;this.batch=batch;this.#batch=batch;Object.freeze(this);
 }
 /** Private-field brand check before any public property is observed. */
 captured():Readonly<{expectedAnchor:MirrorCursorAnchor;batch:MirrorBatchObservation}>{
  const batch=this.#batch;return Object.freeze({expectedAnchor:this.expectedAnchor,batch});
 }
 async verifyCurrent(signal?:AbortSignal):Promise<void>{await this.#batch.verifyCurrent(signal);}
 /** Capture only the decoded complete-prefix boundary. Any intervening append
  * also refuses this observation; already confirmed receipts must be reconciled
  * on the next poll, not blindly resent or treated as permission to reset. */
 async observeNextBoundary(signal?:AbortSignal):Promise<MirrorContinuityObservation>{
  const batch=this.#batch;const next=await captureMirrorCursorAnchor(batch.path,batch.nextOffset,signal);
  if(!sameStamp(next.anchor.stamp,batch.fileStamp))throw new MirrorFileChangedError();
  return next;
 }
}
Object.freeze(AnchoredMirrorBatch.prototype);
export async function observeAnchoredMirrorBatch(expected:MirrorCursorAnchor,limits:MirrorReadLimits,options:MirrorItemOptions,signal?:AbortSignal):Promise<AnchoredMirrorBatch>{
 const pinned=captureExpected(expected),bounds=snapshotMirrorReadLimits(limits),context=snapshotMirrorItemOptions(options);
 const observed=await observeMirrorCursorContinuity(pinned,signal),anchor=observed.observation.anchor;
 const batch=await observeMirrorBatch(anchor.path,anchor.offset,bounds,context,signal);
 if(!sameStamp(anchor.stamp,batch.fileStamp))throw new MirrorFileChangedError();
 signal?.throwIfAborted();return new AnchoredMirrorBatch(token,observed.kind,anchor,batch,pinned);
}
