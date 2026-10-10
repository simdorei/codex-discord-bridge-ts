import {OwnedWorkerBusyError,OwnedWorkerSlot} from '../owned-worker-slot.ts';
import {copyBoundedMirrorRecordWindow,type MirrorRecordWindow} from './record-window.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {serdeField} from '../../app-server/value.ts';
const slot=new OwnedWorkerSlot();
export function mirrorDecoderBusy():boolean{return slot.busy;}
export function joinMirrorDecoder():Promise<void>{return slot.join();}
/** One process-wide decode owner, zero waiting queue, <=1 MiB submitted input.
 * Caller timeout/abort never releases its worker slot before native exit. This
 * observes bytes only; it does not establish file generation or commit a cursor. */
export async function decodeMirrorWindowOffThread(input:Uint8Array,startOffset:bigint,maxWindowBytes:number,maxRecordBytes:number,maxRecords:number,timeoutMs=3000,signal?:AbortSignal):Promise<MirrorRecordWindow>{
 signal?.throwIfAborted();if(slot.busy)throw new OwnedWorkerBusyError();
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<0||timeoutMs>2147483647)throw new RangeError('Expected bounded mirror decode deadline');
 const bytes=copyBoundedMirrorRecordWindow(input,startOffset,maxWindowBytes,maxRecordBytes,maxRecords);
 const response=cloneOwnedSerdeValue(await slot.run(new URL('./decode-worker.ts',import.meta.url),{bytes,startOffset,maxWindowBytes,maxRecordBytes,maxRecords},timeoutMs,signal));
 if(serdeField(response,'ok')!==true){const message=serdeField(response,'message');throw new Error(typeof message==='string'?message:'Mirror decode worker failed');}
 const value=serdeField(response,'value'),offset=serdeField(value,'nextOffset'),records=serdeField(value,'scannedRecords'),events=serdeField(value,'events'),stop=serdeField(value,'stop');
 if(typeof offset!=='bigint'||offset<startOffset||offset>startOffset+BigInt(bytes.length)||typeof records!=='number'||!Number.isSafeInteger(records)||records<0||records>maxRecords||!Array.isArray(events)||events.length>records||typeof stop!=='string'||!['WindowEnd','IncompleteRecord','RecordLimit','OversizedRecord','InvalidUtf8','InvalidJson'].includes(stop))throw new Error('Invalid mirror decode worker response');
 return value as MirrorRecordWindow;
}
