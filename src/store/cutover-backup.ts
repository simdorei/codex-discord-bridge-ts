import {joinRuntimePath} from '../runtime/runtime-paths/path-text.ts';
import {randomUUID} from 'node:crypto';import {dirname,parse} from 'node:path';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../runtime/owned-worker-slot.ts';
import {requireDiscordText} from '../discord/text.ts';import {gatewayOwnField as own} from '../discord/gateway/values.ts';
const slot=new OwnedWorkerSlot('Control');
export interface CutoverBackupAttempt{readonly source:string;readonly directory:string;readonly stem:string;readonly suffix:string}
export class CutoverBackupUnconfirmedError extends Error{readonly attempt:CutoverBackupAttempt;constructor(attempt:CutoverBackupAttempt,cause:unknown){super('Cutover backup outcome is unconfirmed; inspect the retained attempt before any retry',{cause});this.name='CutoverBackupUnconfirmedError';this.attempt=attempt;}}
export class CutoverBackupWorkerError extends Error{readonly attempt:CutoverBackupAttempt;readonly sourceName:string;readonly target:string|null;constructor(attempt:CutoverBackupAttempt,sourceName:string,message:string,target:string|null){super(message);this.name='CutoverBackupWorkerError';this.attempt=attempt;this.sourceName=sourceName;this.target=target;}}
export function cutoverBackupBusy():boolean{return slot.busy;}
export function joinCutoverBackup():Promise<void>{return slot.join();}
function text(v:unknown,max:number):asserts v is string{if(typeof v!=='string'||v.length>max||v.includes('\0'))throw new TypeError('Invalid cutover backup text');requireDiscordText(v);}
function target(attempt:CutoverBackupAttempt,value:unknown):string{ text(value,65536);const prefix=attempt.stem+'.v',suffix='-cutover.'+attempt.suffix+'.sqlite',base=parse(value).base;if(dirname(value)!==attempt.directory||!base.startsWith(prefix)||!base.endsWith(suffix)||!/^-[0-9]+$|^[0-9]+$/.test(base.slice(prefix.length,-suffix.length)))throw new TypeError('Backup output does not match owned attempt');return value;}
/** One native portable cutover snapshot. No source creation/migration. Cancellation
 * requests cooperative backup termination and joins actual exit; an uncertain
 * caller outcome retains its unique attempt and is never permission to retry.
 * This is not a native Windows or adversarial pathname-custody implementation. */
export async function snapshotCutoverStore(path:string,signal?:AbortSignal,timeoutMs=30000):Promise<string>{
 signal?.throwIfAborted();text(path,32768);if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw new RangeError('Invalid backup timeout');if(slot.busy)throw new OwnedWorkerBusyError();
 const platform=process.platform==='win32'?'win32':'posix',source=joinRuntimePath(process.cwd(),path,platform),stamp=new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z'),attempt=Object.freeze({source,directory:joinRuntimePath(dirname(source),'.codex-discord-backups',platform),stem:parse(source).name||'store',suffix:stamp+'.'+randomUUID().replaceAll('-','').slice(0,12)});
 const cancelled=new Int32Array(new SharedArrayBuffer(4)),abort=()=>{Atomics.store(cancelled,0,1);},timer=setTimeout(abort,timeoutMs);signal?.addEventListener('abort',abort,{once:true});
 let reply:unknown;
 try{const work=slot.run(new URL('./cutover-backup-worker.ts',import.meta.url),{attempt,cancelled:cancelled.buffer},timeoutMs,signal),joined=slot.join();try{reply=await work;}finally{await joined;}}
 catch(error){if(error instanceof OwnedWorkerBusyError)throw error;throw new CutoverBackupUnconfirmedError(attempt,error);}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
 try{const ok=own(reply,'ok');if(ok===true)return target(attempt,own(reply,'path'));
 if(ok!==false)throw new CutoverBackupUnconfirmedError(attempt,new TypeError('Malformed backup worker result'));
 const name=own(reply,'name'),message=own(reply,'message'),rawTarget=own(reply,'target');text(name,100);text(message,4096);const attemptedTarget=rawTarget===null?null:target(attempt,rawTarget);throw new CutoverBackupWorkerError(attempt,name,message,attemptedTarget);}
 catch(error){if(error instanceof CutoverBackupWorkerError||error instanceof CutoverBackupUnconfirmedError)throw error;throw new CutoverBackupUnconfirmedError(attempt,error);}
}
