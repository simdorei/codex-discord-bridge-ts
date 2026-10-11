import {resolve} from 'node:path';
import {types} from 'node:util';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import type {RuntimePaths} from '../runtime-paths/resolve.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../owned-worker-slot.ts';
export class RuntimeStoragePreparationError extends Error{
 readonly stage:'Codex'|'Bridge';
 constructor(stage:'Codex'|'Bridge',detail:string){super('Runtime storage preparation failed at '+stage+': '+detail);this.name='RuntimeStoragePreparationError';this.stage=stage;}
}
export class RuntimeStoragePreparationUnconfirmed extends Error{
 readonly stateDb:string;readonly mirrorDb:string;
 constructor(cause:unknown,stateDb:string,mirrorDb:string){super('Runtime storage preparation interrupted after submission; inspect store before another startup',{cause});this.name='RuntimeStoragePreparationUnconfirmed';this.stateDb=stateDb;this.mirrorDb=mirrorDb;}
}
const slot=new OwnedWorkerSlot('Control');
function path(value:unknown):string{requireDiscordText(value);if(value.includes('\0')||value.length>32768||Buffer.byteLength(value)>32768)throw new RangeError('Invalid startup storage path');const result=resolve(value);if(result.length>32768||Buffer.byteLength(result)>32768)throw new RangeError('Invalid startup storage path');return result;}
/** Source prepare_storage ordering in a fixed owned worker: existing Codex open
 * probe then the existing bridge initializer/backups/migrations. Caller must hold
 * its single-instance guard and explicitly choose these paths. Preparation may
 * create/change ONLY the bridge store and its normal backup files.
 * Deadline/abort joins native exit but does not assert rollback or non-execution;
 * submitted interruption is explicitly unconfirmed, with no automatic retry.
 * Same-file guard also checks native file IDs, but does not defeat hostile path
 * replacement races. No resident, gateway, cursor sidecar or service is started. */
export async function prepareRuntimeStorageOffThread(input:Pick<RuntimePaths,'stateDb'|'mirrorDb'>,timeoutMs=10000,signal?:AbortSignal):Promise<void>{
 if(signal!==undefined&&(types.isProxy(signal)||!(signal instanceof AbortSignal)))throw new TypeError('Expected owned startup abort signal');signal?.throwIfAborted();
 const stateDb=path(own(input,'stateDb')),mirrorDb=path(own(input,'mirrorDb'));
 if(stateDb===mirrorDb)throw new TypeError('Codex state and bridge store must be different paths');
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw new RangeError('Invalid storage preparation deadline');
 if(slot.busy)throw new OwnedWorkerBusyError();
 const pending=slot.run(new URL('./storage-preparation-worker.ts',import.meta.url),{stateDb,mirrorDb},timeoutMs,signal),joined=slot.join(),submitted=slot.busy;let response:unknown;
 try{try{response=await pending;}finally{await joined;}}catch(error){if(!submitted)throw error;throw new RuntimeStoragePreparationUnconfirmed(error,stateDb,mirrorDb);}
 if(signal?.aborted)throw new RuntimeStoragePreparationUnconfirmed(signal.reason,stateDb,mirrorDb);
 if(own(response,'ok')===true)return;
 const stage=own(response,'stage'),detail=own(response,'detail');
 if((stage!=='Codex'&&stage!=='Bridge')||typeof detail!=='string')throw new RuntimeStoragePreparationUnconfirmed(new TypeError('Invalid preparation worker response'),stateDb,mirrorDb);
 throw new RuntimeStoragePreparationError(stage,detail);
}
