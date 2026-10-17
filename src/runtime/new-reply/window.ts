import {performance} from 'node:perf_hooks';
import {parseSerdeValue} from '../../core/serde-json-parse.ts';
import {copyBoundedMirrorRecordWindow} from '../session-mirror/record-window.ts';
import {NewReplyObserver,type NewReplyObservationIdentity,type NewReplyObservationState} from './observation.ts';
export interface NewReplyWindowLimits{readonly maxWindowBytes:number;readonly maxRecordBytes:number;readonly maxRecords:number;}
export type NewReplyWindowStop='Matched'|'WindowEnd'|'IncompleteRecord'|'RecordLimit'|'TimeBudget';
export interface NewReplyWindowResult{readonly state:NewReplyObservationState;readonly nextOffset:bigint;readonly scannedRecords:number;readonly stop:NewReplyWindowStop;}
/** Pure bounded scan intended to execute inside one native worker. LF is required
 * for every consumed JSON record; malformed JSON/UTF-8 rejects the entire result.
 * The 20ms check is cooperative between bounded records, not a hard CPU deadline.
 * No file generation, cursor commit or permission to release a hold is provided. */
export function scanNewReplyWindow(input:Uint8Array,offset:bigint,identity:NewReplyObservationIdentity,state:NewReplyObservationState,limits:NewReplyWindowLimits):NewReplyWindowResult{
 if(!Number.isSafeInteger(limits.maxRecords)||limits.maxRecords<1||limits.maxRecords>256)throw new RangeError('New reply scan record limit exceeds 256');
 const bytes=copyBoundedMirrorRecordWindow(input,offset,limits.maxWindowBytes,limits.maxRecordBytes,limits.maxRecords),observer=new NewReplyObserver(identity,state),decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}),started=performance.now();let cursor=0,records=0;
 const result=(stop:NewReplyWindowStop):NewReplyWindowResult=>Object.freeze({state:observer.snapshot(),nextOffset:offset+BigInt(cursor),scannedRecords:records,stop});
 if(state.matched)return result('Matched');
 while(cursor<bytes.length){
  if(records===limits.maxRecords)return result('RecordLimit');let end=cursor;
  while(end<bytes.length&&end-cursor<limits.maxRecordBytes&&bytes[end]!==10)end++;
  if(end===bytes.length){if(end-cursor>=limits.maxRecordBytes)throw new RangeError('New rollout line exceeds record budget');return result('IncompleteRecord');}
  if(end-cursor+1>limits.maxRecordBytes)throw new RangeError('New rollout line exceeds record budget');
  let event:unknown;try{event=parseSerdeValue(decoder.decode(bytes.subarray(cursor,end)));}catch{throw new Error(`Invalid new rollout JSON/UTF-8 at byte ${offset+BigInt(cursor)}`);}
  const matched=observer.observe(event);cursor=end+1;records++;if(matched)return result('Matched');if(performance.now()-started>=20)return result('TimeBudget');
 }
 return result('WindowEnd');
}
