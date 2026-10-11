import type {Dir} from 'node:fs';
import {opendir} from 'node:fs/promises';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
export class RuntimePathBudgetError extends Error {
 readonly kind:'directoryEntries'|'directoryBytes'|'pathInput'|'pathComponents';
 constructor(kind:RuntimePathBudgetError['kind']){super(`Runtime path discovery exceeds ${kind} budget`);this.name='RuntimePathBudgetError';this.kind=kind;}
}
export class RuntimeDirectoryCleanupError extends AggregateError {
 readonly directory:Dir;
 constructor(directory:Dir,cleanup:unknown,failed:boolean,primary:unknown){super(failed?[cleanup,primary]:[cleanup],'Runtime directory cleanup failed',{cause:cleanup});this.name='RuntimeDirectoryCleanupError';this.directory=directory;}
}
export interface RuntimeDirectoryBudget{readonly entries:number;readonly bytes:number}
/** Bounded immediate names; open failures retain source empty-list semantics.
 * A post-open read/budget/close error refuses the entire list. Actual native
 * directory close is awaited before resolution; failure retains its exact owner. Raw invalid UTF8 names count
 * against both budgets before being skipped, matching previous decoding policy.
 * Bounds limit materialization, not filesystem latency or native Windows QA. */
export async function readRuntimeDirectory(directory:string,input:RuntimeDirectoryBudget={entries:10000,bytes:4194304}):Promise<readonly string[]>{
 const entries=own(input,'entries'),bytes=own(input,'bytes');
 if(typeof entries!=='number'||!Number.isSafeInteger(entries)||entries<1||entries>10000||typeof bytes!=='number'||!Number.isSafeInteger(bytes)||bytes<1||bytes>4194304)throw new RangeError('Invalid runtime directory budget');
 // Latin1 preserves each native byte; current @types OpenDirOptions omits buffer.
 let dir;try{dir=await opendir(directory,{encoding:'latin1',bufferSize:32});}catch{return Object.freeze([]);}
 const names:string[]=[],decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});let count=0,total=0,failed=false;let primary:unknown;
 try{for(;;){const entry=await dir.read();if(entry===null)break;const name:unknown=entry.name;if(typeof name!=='string'||/[^\x00-\xff]/.test(name))throw new TypeError('Expected byte-preserving native directory name');if(++count>entries)throw new RuntimePathBudgetError('directoryEntries');total+=name.length;if(total>bytes)throw new RuntimePathBudgetError('directoryBytes');let text:string;try{text=decoder.decode(Buffer.from(name,'latin1'));}catch{continue;}names.push(text);}}
 catch(error){failed=true;primary=error;}
 try{await dir.close();}catch(cleanup){throw new RuntimeDirectoryCleanupError(dir,cleanup,failed,primary);}
 if(failed)throw primary;return Object.freeze(names);
}
