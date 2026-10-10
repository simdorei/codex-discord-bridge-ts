import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../runtime/owned-worker-slot.ts';
import {requireDiscordText} from '../discord/text.ts';
import {cloneOwnedSerdeValue} from '../core/owned-serde-value.ts';
import {serdeField} from '../app-server/value.ts';
const slot=new OwnedWorkerSlot();
export class PromptPreprocessError extends Error{readonly publicMessage:string;readonly recoveryAction:string;constructor(publicMessage:string,recoveryAction:string,cause?:unknown){super(publicMessage+' '+recoveryAction,{cause});this.name='PromptPreprocessError';this.publicMessage=publicMessage;this.recoveryAction=recoveryAction;}}
const failure=(detail:string,cause?:unknown)=>new PromptPreprocessError('Pro project directory could not be verified: '+detail,'Check the original Codex thread and its project folder; no replacement project was selected.',cause);
export function proProjectReaderBusy():boolean{return slot.busy;}
/** Exact original active thread only. Uses existing strict CodexThreadStore decoder
 * off-thread, preserves its full-row error order, then tests that exact cwd. No DB
 * create/migration, cwd fallback, canonical retargeting or browser/connector action.
 * One pending worker and zero queue; timeout/abort joins actual native completion. */
export async function resolveProWorkingDirectory(state:string,thread:string,signal?:AbortSignal):Promise<string>{
 signal?.throwIfAborted();requireDiscordText(state);requireDiscordText(thread);if(state.includes('\0')||Buffer.byteLength(state)>32768||Buffer.byteLength(thread)>16384)throw new TypeError('Invalid bounded Pro project query');
 if(slot.busy)throw failure('project reader is still running',new OwnedWorkerBusyError());
 let response:unknown;
 try{const pending=slot.run(new URL('./project-worker.ts',import.meta.url),{state,thread},10000,signal),exited=slot.join();try{response=cloneOwnedSerdeValue(await pending);}finally{await exited;}}
 catch(error){signal?.throwIfAborted();throw failure(error instanceof Error?error.message:'native project reader failed',error);}
 signal?.throwIfAborted();
 if(serdeField(response,'ok')!==true){const detail=serdeField(response,'detail');throw failure(typeof detail==='string'?detail:'invalid native project observation');}
 const directory=serdeField(response,'directory');if(typeof directory!=='string'||Buffer.byteLength(directory)>32768)throw failure('invalid native project directory');return directory;
}
