import {open,stat} from 'node:fs/promises';
import {snapshotMirrorCursorAnchor as captureExpected,mirrorCursorAnchorVersionForPath,type MirrorCursorAnchor} from '../../core/mirror-cursor-anchor.ts';
import {observeMirrorBatch,type MirrorBatchObservation} from './batch-observation.ts';
import {snapshotMirrorReadLimits,type MirrorReadLimits} from './read-window.ts';
import {snapshotMirrorItemOptions,type MirrorItemOptions} from './decode-reader.ts';
import {createHash,type Hash} from 'node:crypto';
import {MirrorFileWindow,type MirrorFileStamp,MirrorFileChangedError} from './file-window.ts';
import {requireDiscordText} from '../../discord/text.ts';
export type {MirrorCursorAnchor} from '../../core/mirror-cursor-anchor.ts';
export type MirrorContinuity='UnchangedMetadataAndAnchors'|'SameIdentityGrowthAndAnchors';
const stampKeys=['dev','ino','birthtimeNs','mtimeNs','ctimeNs','size'] as const;
const token=Symbol('native mirror continuity observation');
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const sameStamp=(a:MirrorFileStamp,b:MirrorFileStamp)=>stampKeys.every(k=>a[k]===b[k]);
// Bounded process-local acceleration only. No cache survives restart and every
// changed native stamp requires a fresh prefix verification. Hash.copy retains
// constant-sized SHA state, never consumed rollout contents.
const historyCache=new Map<string,{path:string;offset:bigint;stamp:MirrorFileStamp;digest:Hash}>();
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
/** V1/V2 sample 256 prefix + 256 pre-cursor bytes. V3 additionally hashes every
 * consumed byte under the full-prefix resource budget.
 * A zero cursor needs one bounded byte read for native metadata only.
 * The caller must already know what the offset means; capturing now does not
 * retroactively prove old delivery, generation or append-only history. */
export async function captureMirrorCursorAnchor(path:string,offset:bigint,signal?:AbortSignal,fullPrefix=false):Promise<MirrorContinuityObservation>{
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
 const historyHash=fullPrefix?await hashMirrorHistoryPrefix(tail.path,offset,tail.generation,signal):undefined;
 const anchor=captureExpected({...(historyHash===undefined?{}:{historyHash}),version:fullPrefix?3:mirrorCursorAnchorVersionForPath(tail.path),path:tail.path,offset,stamp:tail.generation,prefixHash:hash(prefixBytes),tailHash:hash(tailBytes)});
 signal?.throwIfAborted();return new MirrorContinuityObservation(token,anchor,tail);
}
/** Replacement, shrink, changed anchors or same-size metadata changes refuse.
 * V3 also compares the complete consumed prefix, including middle rewrites.
 * V1/V2 still require a separate producer append-only contract. No version
 * retroactively establishes delivery or permission to adopt a legacy cursor. */
export async function observeMirrorCursorContinuity(expected:MirrorCursorAnchor,signal?:AbortSignal):Promise<Readonly<{kind:MirrorContinuity;observation:MirrorContinuityObservation}>>{
 const prior=captureExpected(expected);signal?.throwIfAborted();
 const observation=await captureMirrorCursorAnchor(prior.path,prior.offset,signal,prior.version===3),now=observation.anchor;
 if(prior.stamp.dev!==now.stamp.dev||prior.stamp.ino!==now.stamp.ino||prior.stamp.birthtimeNs!==now.stamp.birthtimeNs||now.stamp.size<prior.stamp.size||prior.prefixHash!==now.prefixHash||prior.tailHash!==now.tailHash||prior.historyHash!==now.historyHash)throw new MirrorFileChangedError();
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
  const batch=this.#batch;const next=await captureMirrorCursorAnchor(batch.path,batch.nextOffset,signal,this.expectedAnchor.version===3);
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

/** Verify consumed bytes with 1 MiB memory and a ten-second deadline. Unchanged
 * generations reuse verified SHA state; advancing within that generation hashes
 * only the new range. Changed generations and process restarts verify afresh,
 * including middle rewrites followed by append. No fixed file-size cutoff. */
async function hashMirrorHistoryPrefix(path:string,offset:bigint,expected:MirrorFileStamp,signal?:AbortSignal):Promise<string>{
 const file=await open(path,'r'),deadline=performance.now()+10000;
 try{if(!sameStamp(expected,await file.stat({bigint:true})))throw new MirrorFileChangedError();
  let digest=createHash('sha256'),at=0n;
  for(const cached of historyCache.values())if(cached.path===path&&cached.offset<=offset&&cached.offset>=at&&sameStamp(cached.stamp,expected)){digest=cached.digest.copy();at=cached.offset;}
  const buffer=Buffer.alloc(1048576);
  while(at<offset){signal?.throwIfAborted();if(performance.now()>deadline)throw new RangeError('Mirror history verification deadline');const length=Number(offset-at>1048576n?1048576n:offset-at),{bytesRead}=await file.read(buffer,0,length,at);if(bytesRead===0)throw new MirrorFileChangedError();digest.update(buffer.subarray(0,bytesRead));at+=BigInt(bytesRead);}
  if(!sameStamp(expected,await file.stat({bigint:true}))||!sameStamp(expected,await stat(path,{bigint:true})))throw new MirrorFileChangedError();
  signal?.throwIfAborted();const key=path+'\0'+offset;historyCache.delete(key);historyCache.set(key,{path,offset,stamp:expected,digest:digest.copy()});
  while(historyCache.size>32)historyCache.delete(historyCache.keys().next().value!);
  return digest.digest('hex');
 }finally{await file.close();}
}
