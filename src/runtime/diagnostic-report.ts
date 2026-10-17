import {OwnedWorkerSlot} from './owned-worker-slot.ts';
import {cloneOwnedSerdeValue} from '../core/owned-serde-value.ts';
import {serdeField} from '../app-server/value.ts';
import {requireDiscordText} from '../discord/text.ts';
import type {DiagnosticPaths} from './diagnostic-report-blocking.ts';
export type {DiagnosticPaths};
const reportSlot=new OwnedWorkerSlot(),queueSlot=new OwnedWorkerSlot();
export function diagnosticReaderBusy():boolean{return reportSlot.busy;}
export function queueDiagnosticReaderBusy():boolean{return queueSlot.busy;}
export async function joinDiagnosticReaders():Promise<void>{await Promise.all([reportSlot.join(),queueSlot.join()]);}
async function run(slot:OwnedWorkerSlot,input:unknown,signal?:AbortSignal):Promise<string>{
 const response=cloneOwnedSerdeValue(await slot.run(new URL('./diagnostic-worker.ts',import.meta.url),input,3000,signal));
 if(serdeField(response,'ok')!==true){const message=serdeField(response,'message');throw new Error(typeof message==='string'?message:'diagnostic worker failed');}
 const text=serdeField(response,'value');requireDiscordText(text);return text;
}
/** Distinct bounded readers keep diagnostic and queue lookup independent.
 * Cancellation releases the caller, not a still-running native worker slot. */
export async function diagnosticReport(input:DiagnosticPaths,signal?:AbortSignal):Promise<string>{
 const paths=cloneOwnedSerdeValue(input) as DiagnosticPaths;for(const key of ['state','mirror','bridge'] as const)requireDiscordText(serdeField(paths,key));signal?.throwIfAborted();return run(reportSlot,{operation:'report',paths},signal);
}
export async function queueDiagnosticReport(path:string,signal?:AbortSignal):Promise<string>{requireDiscordText(path);signal?.throwIfAborted();return run(queueSlot,{operation:'queue',path},signal);}
