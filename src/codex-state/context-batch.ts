import {statSync} from 'node:fs';
import {readContextSnapshotBlocking,validateContextBudget,DEFAULT_CONTEXT_BUDGET,ContextReadError,type ContextReadBudget,type ContextSnapshot} from './context-read.ts';
import {cloneOwnedSerdeValue} from '../core/owned-serde-value.ts';
import {requireDiscordText} from '../discord/text.ts';
import type {RecentTextMode} from './context-text.ts';
export interface ContextReadTarget {readonly thread:string;readonly path:string;}
export interface ContextBatchEntry {readonly thread:string;readonly snapshot:ContextSnapshot|null;readonly error:string|null;}
export interface ContextBatch {readonly entries:readonly ContextBatchEntry[];readonly skipped:number;}
/** Blocking primitive for the owned worker. Shared byte charge is retained even
 * if an individual file subsequently fails decoding or identity verification. */
export function readContextBatchBlocking(input:readonly ContextReadTarget[],inputBudget:ContextReadBudget=DEFAULT_CONTEXT_BUDGET,maxFiles=50,recentLimit:number|null=null,mode:RecentTextMode='Visible'):ContextBatch {
 const targets=cloneOwnedSerdeValue(input) as readonly ContextReadTarget[];if(!Array.isArray(targets))throw new TypeError('Expected context targets');for(const target of targets){requireDiscordText(target.thread);requireDiscordText(target.path);}const budget=validateContextBudget(inputBudget);if(!Number.isSafeInteger(maxFiles)||maxFiles<0)throw new TypeError('Expected nonnegative file count');
 const start=performance.now(),count=Math.min(targets.length,maxFiles,50),entries:ContextBatchEntry[]=[];let remaining=BigInt(budget.maxBytes);
 for(const target of targets.slice(0,count)){
  try{const elapsed=performance.now()-start;if(elapsed>=budget.maxDurationMs)throw new ContextReadError('context batch time budget exceeded');let size:bigint;try{size=statSync(target.path,{bigint:true}).size;}catch(error){throw new ContextReadError(error instanceof Error?error.message:'file operation failed','Io',error);}if(size>remaining)throw new ContextReadError('context batch byte budget exceeded');remaining-=size;
   const snapshot=readContextSnapshotBlocking(target.path,target.thread,{maxBytes:Number(size),maxLineBytes:budget.maxLineBytes,maxDurationMs:Math.max(0,budget.maxDurationMs-(performance.now()-start))},recentLimit,mode);entries.push(Object.freeze({thread:target.thread,snapshot,error:null}));
  }catch(error){entries.push(Object.freeze({thread:target.thread,snapshot:null,error:error instanceof Error?error.message:'context read failed'}));}
 }
 return Object.freeze({entries:Object.freeze(entries),skipped:targets.length-count});
}
