import type {ThreadInfo} from './thread.ts';
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

export async function renderContextView(input:readonly ThreadInfo[],refresh:boolean,limit:number,mode:RecentTextMode='Visible',signal?:AbortSignal):Promise<string>{
 const threads=cloneOwnedSerdeValue(input) as readonly ThreadInfo[];if(!Array.isArray(threads)||typeof refresh!=='boolean'||!Number.isSafeInteger(limit)||limit<0||mode!=='Visible'&&mode!=='UserAndFinal')throw new TypeError('Expected context view options');
 for(const thread of threads){for(const value of [thread.id,thread.title,thread.model,thread.reasoningEffort,thread.rolloutPath])requireDiscordText(value);if(thread.tokensUsed!==null&&(typeof thread.tokensUsed!=='bigint'||thread.tokensUsed<-(1n<<63n)||thread.tokensUsed>=(1n<<63n)))throw new TypeError('Expected cumulative i64');}
 const response=cloneOwnedSerdeValue(await slot.run(new URL('./context-worker.ts',import.meta.url),{operation:'render',threads,refresh,targets:threads.map(t=>({thread:t.id,path:t.rolloutPath})),budget:DEFAULT_CONTEXT_BUDGET,maxFiles:50,recentLimit:refresh?Math.max(1,Math.min(limit,50)):null,mode},3000,signal));
 if(serdeField(response,'ok')!==true){const message=serdeField(response,'message');throw new Error(typeof message==='string'?message:'context reader failed');}const text=serdeField(response,'value');requireDiscordText(text);return text;
}

const listSlot=new OwnedWorkerSlot();
export function joinThreadListReader():Promise<void>{return listSlot.join();}
export async function renderThreadList(input:readonly ThreadInfo[],selected:string|null,limit:number,archived:boolean,states:ReadonlyMap<string,string>,signal?:AbortSignal):Promise<string>{
 const threads=cloneOwnedSerdeValue(input) as readonly ThreadInfo[];if(!Array.isArray(threads)||!Number.isSafeInteger(limit)||limit<0||limit>0xffffffff||typeof archived!=='boolean')throw new TypeError('Expected list options');if(selected!==null)requireDiscordText(selected);
 const observations=[...Map.prototype.entries.call(states)];for(const [id,state] of observations){requireDiscordText(id);requireDiscordText(state);}for(const thread of threads){for(const text of [thread.id,thread.title,thread.cwd,thread.rolloutPath,thread.model,thread.reasoningEffort])requireDiscordText(text);}
 const targets=threads.slice(0,limit===0?threads.length:limit).map(t=>({thread:t.id,path:t.rolloutPath}));const result=cloneOwnedSerdeValue(await listSlot.run(new URL('./context-worker.ts',import.meta.url),{operation:'list',threads,selected,limit,archived,states:observations,targets,budget:DEFAULT_CONTEXT_BUDGET,maxFiles:50,recentLimit:null,mode:'Visible'},3000,signal));if(serdeField(result,'ok')!==true){const message=serdeField(result,'message');throw new Error(typeof message==='string'?message:'thread list reader failed');}const text=serdeField(result,'value');requireDiscordText(text);return text;
}
