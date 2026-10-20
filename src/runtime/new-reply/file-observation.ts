import {serializeSerdeValue} from '../../core/serde-json.ts';
import {parseSerdeValue} from '../../core/serde-json-parse.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {snapshotMirrorCursorAnchor,encodeMirrorCursorAnchor,decodeMirrorCursorAnchor,type MirrorCursorAnchor,type MirrorFileStamp} from '../../core/mirror-cursor-anchor.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {MirrorFileWindow,MirrorFileChangedError} from '../session-mirror/file-window.ts';
import {captureMirrorCursorAnchor,observeMirrorCursorContinuity,type MirrorContinuity} from '../session-mirror/continuity-observation.ts';
import {NewReplyObserver,type NewReplyObservationIdentity,type NewReplyObservationState} from './observation.ts';
import {scanNewReplyWindowOffThread,DEFAULT_NEW_REPLY_WINDOW_LIMITS} from './window-reader.ts';
import type {NewReplyWindowLimits,NewReplyWindowStop} from './window.ts';
export interface NewReplyFileCursor{readonly version:1;readonly identity:NewReplyObservationIdentity;readonly anchor:MirrorCursorAnchor;readonly state:NewReplyObservationState;}
const TOKEN=Symbol('owned new reply file observation'),stampKeys=['dev','ino','birthtimeNs','mtimeNs','ctimeNs','size'] as const;
const sameStamp=(a:MirrorFileStamp,b:MirrorFileStamp)=>stampKeys.every(k=>a[k]===b[k]);
function identity(input:NewReplyObservationIdentity):NewReplyObservationIdentity{
 if(boundedSerdeByteCount(input,131072)===null)throw new RangeError('New reply identity budget exceeded');
 const captured=cloneOwnedSerdeValue(input) as NewReplyObservationIdentity;
 new NewReplyObserver(captured);return Object.freeze({threadId:captured.threadId,cwd:captured.cwd,turnId:captured.turnId,promptSha256:captured.promptSha256});
}
/** Data validation only. A restored cursor must have trusted durable provenance,
 * exact request identity, and an external producer append-only contract.
 * Bounded prefix/tail anchors do not certify the entire historical file. */
export function snapshotNewReplyFileCursor(input:NewReplyFileCursor):NewReplyFileCursor{
 if(own(input,'version')!==1)throw new TypeError('Unsupported new reply cursor version');
 const id=identity(own(input,'identity') as NewReplyObservationIdentity),anchor=snapshotMirrorCursorAnchor(own(input,'anchor') as MirrorCursorAnchor),state=new NewReplyObserver(id,own(input,'state') as NewReplyObservationState).snapshot();
 if(state.matched&&(!state.sessionSeen||id.turnId===null||state.turn!==id.turnId))throw new TypeError('Matched cursor has inconsistent original turn');
 if(anchor.offset===0n&&(state.sessionSeen||state.turn!==null||state.matched))throw new TypeError('Zero cursor cannot inherit prior observation');
 return Object.freeze({version:1,identity:id,anchor,state});
}
/** Bounded canonical checkpoint codec; decoding validates data, not authority. */
export function encodeNewReplyFileCursor(input:NewReplyFileCursor):string{
 const c=snapshotNewReplyFileCursor(input),id=c.identity,s=c.state;
 const encoded=serializeSerdeValue([1n,id.threadId,id.cwd,id.turnId,id.promptSha256,encodeMirrorCursorAnchor(c.anchor),s.sessionSeen,s.turn,s.matched]);
 if(Buffer.byteLength(encoded)>200000)throw new RangeError('Encoded new reply cursor exceeds budget');
 return encoded;
}
export function decodeNewReplyFileCursor(text:string):NewReplyFileCursor{
 if(typeof text!=='string'||text.length>200000||Buffer.byteLength(text)>200000)throw new RangeError('Encoded new reply cursor exceeds budget');
 const v=parseSerdeValue<unknown>(text);
 if(!Array.isArray(v)||v.length!==9||v[0]!==1n||typeof v[5]!=='string')throw new TypeError('Invalid new reply cursor tuple');
 const cursor=snapshotNewReplyFileCursor({version:1,identity:{threadId:v[1],cwd:v[2],turnId:v[3],promptSha256:v[4]},anchor:decodeMirrorCursorAnchor(v[5]),state:{sessionSeen:v[6],turn:v[7],matched:v[8]}});
 if(encodeNewReplyFileCursor(cursor)!==text)throw new TypeError('Noncanonical new reply cursor');
 return cursor;
}
/** Explicit new scan bootstrap, never automatic fallback for a rejected cursor.
 * No DB checkpoint, legacy adoption or first-reply hold release occurs here. */
export async function beginNewReplyFileCursor(path:string,input:NewReplyObservationIdentity,signal?:AbortSignal):Promise<NewReplyFileCursor>{
 const id=identity(input),start=await captureMirrorCursorAnchor(path,0n,signal);
 return snapshotNewReplyFileCursor({version:1,identity:id,anchor:start.anchor,state:new NewReplyObserver(id).snapshot()});
}
export class NewReplyFileObservation{
 readonly cursor:NewReplyFileCursor;readonly continuity:MirrorContinuity;readonly scannedRecords:number;readonly stop:NewReplyWindowStop;readonly historyIntegrityVerified=false;
 readonly #window:MirrorFileWindow;
 constructor(token:symbol,cursor:NewReplyFileCursor,continuity:MirrorContinuity,scannedRecords:number,stop:NewReplyWindowStop,window:MirrorFileWindow){
  if(token!==TOKEN)throw new TypeError('Expected owned new reply file observation');
  this.cursor=cursor;this.continuity=continuity;this.scannedRecords=scannedRecords;this.stop=stop;this.#window=window;Object.freeze(this);
 }
 captured():NewReplyFileCursor{void this.#window;return this.cursor;}
 async verifyCurrent(signal?:AbortSignal):Promise<void>{await this.#window.verifyCurrent(signal);}
}
Object.freeze(NewReplyFileObservation.prototype);
/** Binds a bounded native scan to old/new complete-record anchors with identical
 * point-in-time metadata. Any observed replacement, shrink or mutation fails.
 * Append retains the old offset/state; nothing retries from zero automatically.
 * Caller still owns durable compare-and-swap and mapping/hold revalidation. */
export async function observeNewReplyFile(expected:NewReplyFileCursor,inputLimits:NewReplyWindowLimits=DEFAULT_NEW_REPLY_WINDOW_LIMITS,signal?:AbortSignal):Promise<NewReplyFileObservation>{
 const prior=snapshotNewReplyFileCursor(expected),limits={maxWindowBytes:own(inputLimits,'maxWindowBytes') as number,maxRecordBytes:own(inputLimits,'maxRecordBytes') as number,maxRecords:own(inputLimits,'maxRecords') as number};
 for(const [v,max] of [[limits.maxWindowBytes,1048576],[limits.maxRecordBytes,262144],[limits.maxRecords,256]] as const)if(!Number.isSafeInteger(v)||v<1||v>max)throw new RangeError('Invalid bounded new reply file limits');
 if(limits.maxRecordBytes>limits.maxWindowBytes)throw new RangeError('Record exceeds window budget');
 signal?.throwIfAborted();const continuity=await observeMirrorCursorContinuity(prior.anchor,signal),anchor=continuity.observation.anchor;
 const window=await MirrorFileWindow.read(anchor.path,anchor.offset,limits.maxWindowBytes,signal);
 if(!sameStamp(anchor.stamp,window.generation))throw new MirrorFileChangedError();
 const result=await scanNewReplyWindowOffThread(window.copyBytes(),anchor.offset,prior.identity,prior.state,limits,3000,signal);
 if(!window.isCompleteRecordBoundary(result.nextOffset))throw new Error('New reply scan returned incomplete boundary');
 const next=await captureMirrorCursorAnchor(anchor.path,result.nextOffset,signal);
 if(!sameStamp(next.anchor.stamp,window.generation))throw new MirrorFileChangedError();
 await window.verifyCurrent(signal);
 const cursor=snapshotNewReplyFileCursor({version:1,identity:prior.identity,anchor:next.anchor,state:result.state});
 return new NewReplyFileObservation(TOKEN,cursor,continuity.kind,result.scannedRecords,result.stop,window);
}
