import {openSync,closeSync,fstatSync,statSync,readSync} from 'node:fs';
import {ContextUsageAccumulator,type ContextUsage} from './context-usage.ts';
import {RecentText,type ContextTextItem,type RecentTextMode} from './context-text.ts';
import {parseSerdeValue} from '../core/serde-json-parse.ts';
import {serdeField,serdeObject} from '../app-server/value.ts';
import {cloneOwnedSerdeValue} from '../core/owned-serde-value.ts';
import {requireDiscordText} from '../discord/text.ts';
export interface ContextReadBudget {readonly maxBytes:number;readonly maxLineBytes:number;readonly maxDurationMs:number;}
export const DEFAULT_CONTEXT_BUDGET:ContextReadBudget=Object.freeze({maxBytes:128*1024*1024,maxLineBytes:8*1024*1024,maxDurationMs:2000});
export interface ContextSnapshot {readonly usage:ContextUsage|null;readonly recentItems:readonly ContextTextItem[];}
export class ContextReadError extends Error {readonly kind:'Invalid'|'Io';readonly detail:string;constructor(detail:string,kind:'Invalid'|'Io'='Invalid',cause?:unknown){super(`${kind==='Io'?'context file I/O failed':'context observation unavailable'}: ${detail}`,{cause});this.name='ContextReadError';this.detail=detail;this.kind=kind;}}
function io<T>(operation:()=>T):T {try{return operation();}catch(error){const d=error instanceof Error?Object.getOwnPropertyDescriptor(error,'message'):undefined;throw new ContextReadError(d&&Object.hasOwn(d,'value')&&typeof d.value==='string'?d.value:'file operation failed','Io',error);}}
export function validateContextBudget(b:ContextReadBudget):ContextReadBudget {
 const {maxBytes,maxLineBytes,maxDurationMs}=cloneOwnedSerdeValue(b) as ContextReadBudget;if(!Number.isSafeInteger(maxBytes)||maxBytes<0||!Number.isSafeInteger(maxLineBytes)||maxLineBytes<0||!Number.isFinite(maxDurationMs)||maxDurationMs<0)throw new TypeError('Expected finite nonnegative context read budget');return Object.freeze({maxBytes,maxLineBytes,maxDurationMs});
}
/** Blocking bounded primitive, intended for an owned worker, never the command
 * event loop. Reads only the opening file length and validates final metadata. */
export function readContextSnapshotBlocking(path:string,thread:string,input:ContextReadBudget=DEFAULT_CONTEXT_BUDGET,limit:number|null=null,mode:RecentTextMode='Visible'):ContextSnapshot {
 requireDiscordText(path);requireDiscordText(thread);const budget=validateContextBudget(input),recent=limit===null?null:new RecentText(limit,mode),start=performance.now(),fd=io(()=>openSync(path,'r'));
 try{
  const before=io(()=>fstatSync(fd,{bigint:true}));if(!before.isFile()||before.size>BigInt(budget.maxBytes)||budget.maxLineBytes===0)throw new ContextReadError('file exceeds context read budget or is not a regular file');
  let remaining=Number(before.size),buffer=Buffer.alloc(0),position=0,identified=false;const accumulator=new ContextUsageAccumulator(),decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
  for(;;){
   if(performance.now()-start>=budget.maxDurationMs)throw new ContextReadError('context read time budget exceeded');
   const parts:Buffer[]=[];let size=0,complete=false;
   for(;;){
    if(position===buffer.length){if(remaining===0)break;buffer=Buffer.allocUnsafe(Math.min(65536,remaining));const n=io(()=>readSync(fd,buffer,0,buffer.length,null));remaining-=n;if(n===0){remaining=0;break;}buffer=buffer.subarray(0,n);position=0;}
    const newline=buffer.indexOf(10,position),end=newline<0?buffer.length:newline+1,part=buffer.subarray(position,end);size+=part.length;if(size>budget.maxLineBytes)throw new ContextReadError('context record exceeds line budget');parts.push(part);position=end;if(newline>=0){complete=true;break;}
   }
   if(size===0)break;if(!complete)throw new ContextReadError('context record is incomplete; writer may still be appending');const raw=Buffer.concat(parts,size);if(raw.every(b=>b===9||b===10||b===12||b===13||b===32))continue;
   let event:unknown;try{event=parseSerdeValue(decoder.decode(raw));}catch{throw new ContextReadError('context record contains invalid JSON');}if(!serdeObject(event))throw new ContextReadError('context record is not an object');
   if(!identified||serdeField(event,'type')==='session_meta'){if(serdeField(event,'type')!=='session_meta'||serdeField(serdeField(event,'payload'),'id')!==thread||thread==='')throw new ContextReadError('session identity is absent or differs from the requested thread');identified=true;}
   accumulator.push(event);recent?.push(event);
  }
  if(!identified)throw new ContextReadError('session identity has not been recorded');const after=io(()=>fstatSync(fd,{bigint:true})),current=io(()=>statSync(path,{bigint:true}));if(before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.size!==current.size||before.mtimeNs!==current.mtimeNs)throw new ContextReadError('session changed during context read; snapshot is unverified');
  return Object.freeze({usage:accumulator.finish(),recentItems:recent?.finish()??Object.freeze([])});
 }finally{io(()=>closeSync(fd));}
}
