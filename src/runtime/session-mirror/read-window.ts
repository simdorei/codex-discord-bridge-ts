import {MirrorFileWindow} from './file-window.ts';
import {decodeMirrorWindowOffThread,collectMirrorWindowOffThread,snapshotMirrorItemOptions,type MirrorItemOptions,mirrorDecoderBusy,joinMirrorDecoder} from './decode-reader.ts';
import {OwnedWorkerBusyError} from '../owned-worker-slot.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
export interface MirrorReadLimits {readonly maxWindowBytes:number;readonly maxRecordBytes:number;readonly maxRecords:number;readonly decodeTimeoutMs:number;}
/** Actual bounded file observation -> off-thread decode -> identity recheck.
 * Captures this worker's exit promise before awaiting; timeout/cancel never
 * abandons owned decoding or waits on a later unrelated decoder's lifetime.
 * Returns complete-record prefix evidence only. Caller must durably hand off that
 * prefix and bind the cursor to file identity; this function never writes a cursor. */
async function readStable<T>(path:string,offset:bigint,input:MirrorReadLimits,decode:(bytes:Uint8Array,limits:MirrorReadLimits)=>Promise<T>,signal?:AbortSignal){
 const bytes=own(input,'maxWindowBytes'),record=own(input,'maxRecordBytes'),records=own(input,'maxRecords'),timeout=own(input,'decodeTimeoutMs');
 if(typeof bytes!=='number'||!Number.isSafeInteger(bytes)||bytes<1||bytes>1048576||typeof record!=='number'||!Number.isSafeInteger(record)||record<1||record>262144||record>bytes||typeof records!=='number'||!Number.isSafeInteger(records)||records<1||records>1024||typeof timeout!=='number'||!Number.isSafeInteger(timeout)||timeout<0||timeout>2147483647)throw new RangeError('Invalid bounded mirror read limits');
 signal?.throwIfAborted();
 const window=await MirrorFileWindow.read(path,offset,bytes,signal);
 if(mirrorDecoderBusy())throw new OwnedWorkerBusyError();
 const pending=decode(window.copyBytes(),{maxWindowBytes:bytes,maxRecordBytes:record,maxRecords:records,decodeTimeoutMs:timeout});
 const exited=joinMirrorDecoder();
 let decoded;
 try{decoded=await pending;}finally{await exited;}
 signal?.throwIfAborted();await window.verifyCurrent(signal);signal?.throwIfAborted();
 return Object.freeze({window,decoded});
}

export function readStableMirrorWindow(path:string,offset:bigint,input:MirrorReadLimits,signal?:AbortSignal){
 return readStable(path,offset,input,(bytes,limits)=>decodeMirrorWindowOffThread(bytes,offset,limits.maxWindowBytes,limits.maxRecordBytes,limits.maxRecords,limits.decodeTimeoutMs,signal),signal);
}
/** Complete-file-window observation plus worker-only display transformation. This
 * remains evidence for a later durable handoff, never a cursor commit permission. */
export async function readStableMirrorItems(path:string,offset:bigint,input:MirrorReadLimits,options:MirrorItemOptions,signal?:AbortSignal){
 const context=snapshotMirrorItemOptions(options);
 return readStable(path,offset,input,(bytes,limits)=>collectMirrorWindowOffThread(bytes,offset,limits.maxWindowBytes,limits.maxRecordBytes,limits.maxRecords,context,limits.decodeTimeoutMs,signal),signal);
}
