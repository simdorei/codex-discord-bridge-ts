import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {copyBoundedMirrorRecordWindow} from '../session-mirror/record-window.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../owned-worker-slot.ts';
import {NewReplyObserver,type NewReplyObservationIdentity,type NewReplyObservationState} from './observation.ts';
import type {NewReplyWindowLimits,NewReplyWindowResult,NewReplyWindowStop} from './window.ts';
const slot=new OwnedWorkerSlot();
export const DEFAULT_NEW_REPLY_WINDOW_LIMITS:NewReplyWindowLimits=Object.freeze({maxWindowBytes:1048576,maxRecordBytes:262144,maxRecords:256});
/** One zero-queue native decode/hash owner within the shared Background budget.
 * Timeout/abort joins that exact native exit before returning; a late result is
 * discarded. Main thread receives only bounded state/counts, not parsed events.
 * Input bytes and old state must already have authentic file/cursor provenance. */
export async function scanNewReplyWindowOffThread(input:Uint8Array,offset:bigint,inputIdentity:NewReplyObservationIdentity,inputState:NewReplyObservationState,inputLimits:NewReplyWindowLimits=DEFAULT_NEW_REPLY_WINDOW_LIMITS,timeoutMs=3000,signal?:AbortSignal):Promise<NewReplyWindowResult>{
 signal?.throwIfAborted();if(slot.busy)throw new OwnedWorkerBusyError();if(!Number.isSafeInteger(timeoutMs)||timeoutMs<0||timeoutMs>30000)throw new RangeError('Invalid bounded new reply scan deadline');
 const limits={maxWindowBytes:own(inputLimits,'maxWindowBytes') as number,maxRecordBytes:own(inputLimits,'maxRecordBytes') as number,maxRecords:own(inputLimits,'maxRecords') as number};
 if(!Number.isSafeInteger(limits.maxRecords)||limits.maxRecords<1||limits.maxRecords>256)throw new RangeError('New reply record limit exceeds 256');
 const bytes=copyBoundedMirrorRecordWindow(input,offset,limits.maxWindowBytes,limits.maxRecordBytes,limits.maxRecords);
 if(boundedSerdeByteCount(inputIdentity,131072)===null||boundedSerdeByteCount(inputState,32768)===null)throw new RangeError('New reply scan metadata exceeds budget');
 const identity=cloneOwnedSerdeValue(inputIdentity) as NewReplyObservationIdentity,state=new NewReplyObserver(identity,inputState).snapshot();
 const pending=slot.run(new URL('./window-worker.ts',import.meta.url),{bytes,offset,identity,state,limits},timeoutMs,signal),exited=slot.join();let raw:unknown;try{raw=await pending;}finally{await exited;}
 signal?.throwIfAborted();if(boundedSerdeByteCount(raw,65536)===null)throw new RangeError('New reply native result exceeds metadata budget');const response=cloneOwnedSerdeValue(raw);
 if(own(response,'ok')!==true){const message=own(response,'message');throw new Error(typeof message==='string'?message:'New reply native scan failed');}
 const value=own(response,'value'),nextOffset=own(value,'nextOffset'),scannedRecords=own(value,'scannedRecords'),stop=own(value,'stop'),observed=new NewReplyObserver(identity,own(value,'state') as NewReplyObservationState).snapshot();
 if(typeof nextOffset!=='bigint'||nextOffset<offset||nextOffset>offset+BigInt(bytes.length)||nextOffset!==offset&&bytes[Number(nextOffset-offset)-1]!==10||typeof scannedRecords!=='number'||!Number.isSafeInteger(scannedRecords)||scannedRecords<0||scannedRecords>limits.maxRecords||typeof stop!=='string'||!['Matched','WindowEnd','IncompleteRecord','RecordLimit','TimeBudget'].includes(stop)||(stop==='Matched')!==observed.matched)throw new Error('Invalid new reply native window result');
 return Object.freeze({state:observed,nextOffset,scannedRecords,stop:stop as NewReplyWindowStop});
}
