import {OwnedWorkerSlot} from '../runtime/owned-worker-slot.ts';
import {cloneOwnedSerdeValue} from '../core/owned-serde-value.ts';
import {serdeField} from '../app-server/value.ts';
import {requireDiscordText} from '../discord/text.ts';
import {DEFAULT_CONTEXT_BUDGET,validateContextBudget,type ContextReadBudget} from './context-read.ts';
import type {ContextReadTarget,ContextBatch} from './context-batch.ts';
import type {RecentTextMode} from './context-text.ts';
const slot=new OwnedWorkerSlot();
export function contextReaderBusy():boolean{return slot.busy;}
export function joinContextReader():Promise<void>{return slot.join();}
/** Shared singleton worker slot matches source process-wide reader ownership.
 * File I/O, JSON decode and accumulator work all happen outside the async loop. */
export async function readContextBatch(targets:readonly ContextReadTarget[],budget:ContextReadBudget=DEFAULT_CONTEXT_BUDGET,maxFiles=50,recentLimit:number|null=null,mode:RecentTextMode='Visible',signal?:AbortSignal):Promise<ContextBatch>{
 const owned=cloneOwnedSerdeValue(targets);if(!Array.isArray(owned))throw new TypeError('Expected context targets');for(const item of owned){requireDiscordText(serdeField(item,'thread'));requireDiscordText(serdeField(item,'path'));}const pinned=validateContextBudget(budget);if(!Number.isSafeInteger(maxFiles)||maxFiles<0||recentLimit!==null&&(!Number.isSafeInteger(recentLimit)||recentLimit<0)||mode!=='Visible'&&mode!=='UserAndFinal')throw new TypeError('Expected context read options');
 const result=await slot.run(new URL('./context-worker.ts',import.meta.url),{targets:owned,budget:pinned,maxFiles,recentLimit,mode},3000,signal);const response=cloneOwnedSerdeValue(result);if(serdeField(response,'ok')!==true){const message=serdeField(response,'message');throw new Error(typeof message==='string'?message:'context reader failed');}const value=serdeField(response,'value');if(!Array.isArray(serdeField(value,'entries'))||typeof serdeField(value,'skipped')!=='number')throw new Error('Invalid context worker response');return value as ContextBatch;
}
