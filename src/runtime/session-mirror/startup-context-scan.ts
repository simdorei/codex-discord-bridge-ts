import {isMainThread} from 'node:worker_threads';
import {parseSerdeValue} from '../../core/serde-json-parse.ts';
import {serdeField,serdeObject} from '../../app-server/value.ts';
import {MirrorFileWindow,MirrorFileChangedError} from './file-window.ts';
import {captureMirrorCursorAnchor,observeMirrorCursorContinuity} from './continuity-observation.ts';
import {MirrorStartupContextHeldError,sameMirrorStartupStamp,type MirrorStartupCutoffData,type MirrorStartupContextLimits} from './startup-context-limits.ts';

function nativeOnly():void{if(isMainThread)throw new TypeError('Mirror startup file scans require the owned native worker');}
/** Fixed <=515-byte native capture. A non-LF EOF is retained as a held cutoff,
 * never rounded down and never made valid by observing a later append. */
export async function captureMirrorStartupCutoffNative(path:string,check:()=>void,fullPrefix=false):Promise<MirrorStartupCutoffData> {
 nativeOnly();check();const first=await MirrorFileWindow.read(path,0n,1);check();const offset=first.generation.size;
 if(offset<0n||offset>=(1n<<63n))throw new RangeError('Mirror startup EOF is outside nonnegative i64');
 if(offset>0n){
  const last=await MirrorFileWindow.read(first.path,offset-1n,1);check();
  if(!sameMirrorStartupStamp(first.generation,last.generation))throw new MirrorFileChangedError();
  if(!last.isCompleteRecordBoundary(offset)){await first.verifyCurrent();check();return {path:first.path,offset,stamp:first.generation,anchor:null};}
 }
 const observed=await captureMirrorCursorAnchor(first.path,offset,undefined,fullPrefix);check();
 if(!sameMirrorStartupStamp(first.generation,observed.anchor.stamp))throw new MirrorFileChangedError();
 await first.verifyCurrent();check();return {path:first.path,offset,stamp:first.generation,anchor:observed.anchor};
}

/** Rust d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34 turn_context.rs L7-L36.
 * https://github.com/simdorei/codex-discord-remote-rust/blob/d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34/crates/cdr-runtime/src/session_mirror/turn_context.rs#L7-L36
 * Decode every line as UTF8 before the first-200-Unicode-scalar keyword filter.
 * Only LF and an immediately preceding CR are stripped. Parse failures and
 * nonobjects are ignored; a nonempty payload.turn_id replaces the prior value.
 * No event_msg gate, trimming, terminal clearing, or display collector policy. */
function turnFromLine(bytes:Uint8Array,decoder:TextDecoder):string|undefined {
 let end=bytes.length;if(end>0&&bytes[end-1]===13)end--;
 let line:string;try{line=decoder.decode(bytes.subarray(0,end));}catch(error){throw new MirrorStartupContextHeldError('InvalidUtf8',error);}
 let prefix='',scalars=0;for(const scalar of line){if(scalars++===200)break;prefix+=scalar;}
 if(!prefix.includes('turn_context')&&!prefix.includes('task_started'))return undefined;
 let value:unknown;try{value=parseSerdeValue(line);}catch{return undefined;}
 if(!serdeObject(value))return undefined;const payload=serdeField(value,'payload');
 if(serdeField(value,'type')!=='turn_context'&&serdeField(payload,'type')!=='task_started')return undefined;
 const turn=serdeField(payload,'turn_id');return typeof turn==='string'&&turn!==''?turn:undefined;
}

/** Scan only [0,N), never the newly observed EOF. All bytes, records and parser
 * work are bounded and remain in the native owner. Same-identity pre-scan growth
 * is classified by existing sampled anchors, not certified append-only history.
 * Any observed change during this scan refuses the complete result. */
export async function readMirrorStartupContextNative(cutoff:MirrorStartupCutoffData,limits:MirrorStartupContextLimits,check:()=>void) {
 nativeOnly();check();if(cutoff.anchor===null)throw new MirrorStartupContextHeldError('IncompleteBoundary');
 if(cutoff.offset>BigInt(limits.maxBytes))throw new MirrorStartupContextHeldError('ByteBudget');
 const continuity=await observeMirrorCursorContinuity(cutoff.anchor);check();const anchor=continuity.observation.anchor;
 const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}),record=new Uint8Array(limits.maxRecordBytes);
 let offset=0n,used=0,scannedRecords=0,currentTurn:string|null=null;
 while(offset<cutoff.offset){
  check();const remaining=cutoff.offset-offset,maximum=Number(remaining<BigInt(limits.maxWindowBytes)?remaining:BigInt(limits.maxWindowBytes));
  const window=await MirrorFileWindow.read(cutoff.path,offset,maximum);check();
  if(window.byteLength!==maximum||!sameMirrorStartupStamp(anchor.stamp,window.generation))throw new MirrorFileChangedError();
  const bytes=window.copyBytes();let start=0;
  while(start<bytes.length){
   check();if(scannedRecords===limits.maxRecords)throw new MirrorStartupContextHeldError('RecordBudget');
   const lf=bytes.indexOf(10,start),end=lf===-1?bytes.length:lf+1,length=end-start;
   if(used+length>limits.maxRecordBytes)throw new MirrorStartupContextHeldError('RecordBytes');
   record.set(bytes.subarray(start,end),used);used+=length;start=end;
   if(lf!==-1){const turn=turnFromLine(record.subarray(0,used-1),decoder);if(turn!==undefined)currentTurn=turn;scannedRecords++;used=0;check();}
  }
  offset+=BigInt(bytes.length);
 }
 if(used!==0)throw new MirrorStartupContextHeldError('IncompleteBoundary');
 if(currentTurn!==null&&(currentTurn.length>limits.maxTurnBytes||Buffer.byteLength(currentTurn)>limits.maxTurnBytes))throw new MirrorStartupContextHeldError('TurnBudget');
 await continuity.observation.verifyCurrent();check();
 return {anchor,continuity:continuity.kind,currentTurn,scannedRecords,scannedBytes:offset};
}
