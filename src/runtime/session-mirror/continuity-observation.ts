import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {MirrorFileWindow,type MirrorFileStamp,MirrorFileChangedError} from './file-window.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
export interface MirrorCursorAnchor{
 readonly version:1;readonly path:string;readonly offset:bigint;readonly stamp:MirrorFileStamp;
 readonly prefixHash:string;readonly tailHash:string;
}
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
function captureExpected(input:MirrorCursorAnchor):MirrorCursorAnchor{
 const version=own(input,'version'),path=own(input,'path'),offset=own(input,'offset'),raw=own(input,'stamp'),prefixHash=own(input,'prefixHash'),tailHash=own(input,'tailHash');
 requireDiscordText(path);
 if(version!==1||path.includes('\0')||path.length>32768||Buffer.byteLength(path)>32768||resolve(path)!==path||typeof offset!=='bigint'||offset<0n||offset>=(1n<<64n))throw new TypeError('Invalid persisted mirror anchor');
 const fields=Object.create(null) as Record<typeof stampKeys[number],bigint>;
 for(const k of stampKeys){const value=own(raw,k);if(typeof value!=='bigint')throw new TypeError('Invalid mirror file stamp');fields[k]=value;}
 if(fields.dev<0n||fields.ino<=0n||fields.birthtimeNs<=0n||fields.size<offset||fields.size>=(1n<<64n))throw new TypeError('Unusable mirror file identity');
 for(const value of [prefixHash,tailHash])if(typeof value!=='string'||value.length!==64||!/^[0-9a-f]{64}$/.test(value))throw new TypeError('Invalid mirror anchor hash');
 return Object.freeze({version:1,path,offset,stamp:Object.freeze({...fields}),prefixHash:prefixHash as string,tailHash:tailHash as string});
}
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
