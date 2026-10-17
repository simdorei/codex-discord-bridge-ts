import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../runtime/owned-worker-slot.ts';
import {requireDiscordText} from '../discord/text.ts';
import {cloneOwnedSerdeValue} from '../core/owned-serde-value.ts';
import {serdeField} from '../app-server/value.ts';
const slot=new OwnedWorkerSlot();
export type PluginInventoryFailure='Spawn'|'Timeout'|'Exit'|'TooLarge'|'Utf8';
export class PluginInventoryError extends Error{readonly kind:PluginInventoryFailure;readonly exitCode:number|null;constructor(kind:PluginInventoryFailure,detail:string,exitCode:number|null=null){super(detail);this.name='PluginInventoryError';this.kind=kind;this.exitCode=exitCode;}}
export function pluginInventoryBusy():boolean{return slot.busy;}
/** POSIX direct-child inventory probe. One process-wide worker, zero waiting queue,
 * fixed literal argv, 10s native timeout, 2MiB aggregate native capture cap
 * and 1MiB per-stream accepted-output budget.
 * Cancellation does not mean child termination: always join the worker, including
 * its synchronous native process wait, before returning. A child that cannot be
 * reaped keeps this promise and capacity occupied for outer fail-stop handling.
 * Descendant process-tree and Windows ownership are not certified here. */
export async function readCodexPluginInventory(executable:string,signal?:AbortSignal):Promise<string>{
 signal?.throwIfAborted();requireDiscordText(executable);if(executable===''||executable.includes('\0'))throw new TypeError('Expected inventory executable path');
 if(process.platform==='win32')throw new TypeError('Windows inventory process ownership is not implemented by the portable profile');
 if(slot.busy)throw new OwnedWorkerBusyError();
 const work=slot.run(new URL('./inventory-worker.ts',import.meta.url),{executable},11000,signal),exited=slot.join();let response:unknown;
 try{response=cloneOwnedSerdeValue(await work);}finally{await exited;}
 signal?.throwIfAborted();
 if(serdeField(response,'ok')===true){const text=serdeField(response,'text');if(typeof text!=='string'||Buffer.byteLength(text)>1048576)throw new TypeError('Invalid inventory worker output');return text;}
 const kind=serdeField(response,'kind'),detail=serdeField(response,'detail'),code=serdeField(response,'exitCode');
 if(typeof kind!=='string'||!['Spawn','Timeout','Exit','TooLarge','Utf8'].includes(kind)||typeof detail!=='string'||(kind==='Exit'&&(typeof code!=='number'||!Number.isInteger(code))))throw new TypeError('Invalid inventory worker failure');
 throw new PluginInventoryError(kind as PluginInventoryFailure,detail,kind==='Exit'?code as number:null);
}
