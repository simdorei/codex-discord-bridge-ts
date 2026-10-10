import {OwnedWorkerSlot} from '../runtime/owned-worker-slot.ts';
import {cloneOwnedSerdeValue} from '../core/owned-serde-value.ts';
import {serdeField} from '../app-server/value.ts';
import {requireDiscordText} from '../discord/text.ts';
import type {RestartReadinessSnapshot} from './restart-snapshot-pure.ts';
const slot=new OwnedWorkerSlot();
export class RestartSnapshotWorkerError extends Error {readonly sourceName:string;constructor(sourceName:string,message:string){super(message);this.name='RestartSnapshotWorkerError';this.sourceName=sourceName;}}
export function restartSnapshotReaderBusy():boolean{return slot.busy;}
export function joinRestartSnapshotReader():Promise<void>{return slot.join();}
/** One bounded native reader. Abort/timeout never releases ownership before exit.
 * Failures remain failures, never an empty/ready snapshot. Native error identity
 * does not survive the worker boundary; sourceName is diagnostic only. */
export async function restartReadinessSnapshot(path:string,signal?:AbortSignal):Promise<RestartReadinessSnapshot>{
 requireDiscordText(path);signal?.throwIfAborted();
 const reply=cloneOwnedSerdeValue(await slot.run(new URL('./restart-readiness-worker.ts',import.meta.url),{path},3000,signal));
 if(serdeField(reply,'ok')!==true){const name=serdeField(reply,'name'),message=serdeField(reply,'message');throw new RestartSnapshotWorkerError(typeof name==='string'?name:'UnknownError',typeof message==='string'?message:'Restart snapshot worker failed');}
 const value=serdeField(reply,'value');
 const strings=(key:string)=>{const a=serdeField(value,key);if(!Array.isArray(a))throw new TypeError('Malformed restart snapshot');return Object.freeze(a.map(x=>{requireDiscordText(x);return x;}));};
 return Object.freeze({targetThreadIds:strings('targetThreadIds'),blockers:strings('blockers'),observations:strings('observations')});
}
