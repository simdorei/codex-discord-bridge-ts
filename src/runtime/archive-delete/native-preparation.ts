import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {containerI64} from '../../store/mirror-container-creation.ts';
import type {ArchiveDeletionConfirmation} from '../../store/archive-deletion.ts';
import type {ValidatedArchiveBackupPaths} from './native-backup.ts';
import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../owned-worker-slot.ts';
const slot=new OwnedWorkerSlot();
export interface ArchivePreparationReceipt {readonly token:string;readonly directory:string;readonly sourceDirectory:string;readonly rollout:string;readonly files:number;}
export class ArchivePreparationError extends Error {
 constructor(message:string,readonly token:string|null,readonly recoveryDirectory:string|null){super(message);this.name='ArchivePreparationError';}
}
/** One bounded native owner reserves the exact original confirmation and backs
 * up mirror and source state. No source deletion. Any post-admission error or
 * cancellation may retain a durable reservation; never retry or release it
 * automatically. Native exit is joined before this Promise settles. */
export async function prepareArchiveDeletion(mirror:string,paths:ValidatedArchiveBackupPaths,id:string,now:number,input:ArchiveDeletionConfirmation,timeoutMs:number,signal?:AbortSignal):Promise<Readonly<ArchivePreparationReceipt>>{
 signal?.throwIfAborted();requireDiscordText(mirror);requireDiscordText(id);if(mirror.includes('\0')||Buffer.byteLength(mirror)>32768)throw new TypeError('Invalid archive mirror path');
 if(id.length===0||id.length>4096||typeof now!=='number'||!Number.isFinite(now)||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw new RangeError('Invalid archive preparation request');
 const captured=Object.create(null) as Record<string,string>;
 for(const key of ['state','logs','global','bridge','index','archivedSessions','root']){const value=own(paths,key);requireDiscordText(value);if(value.includes('\0')||Buffer.byteLength(value)>32768)throw new TypeError('Invalid archive preparation path');captured[key]=pinNativeRuntimePath(value);}
 const mirrorPath=pinNativeRuntimePath(mirror);if(new Set([...Object.values(captured),mirrorPath]).size!==8)throw new TypeError('Archive preparation paths must be distinct');
 const reference=own(input,'reference');requireDiscordText(reference);if(Buffer.byteLength(reference)>4096)throw new RangeError('Archive confirmation reference exceeds budget');const confirmation={messageId:containerI64(own(input,'messageId')),channelId:containerI64(own(input,'channelId')),userId:containerI64(own(input,'userId')),reference};
 if(slot.busy)throw new OwnedWorkerBusyError();const cancelled=new SharedArrayBuffer(4),flag=new Int32Array(cancelled),cancel=()=>Atomics.store(flag,0,1);signal?.addEventListener('abort',cancel,{once:true});const timer=setTimeout(cancel,timeoutMs);
 try{
  const pending=slot.run(new URL('./preparation-worker.ts',import.meta.url),{mirror:mirrorPath,paths:captured,id,now,confirmation,cancelled},timeoutMs,signal),joined=slot.join();let result:unknown;try{result=await pending;}finally{await joined;}
  signal?.throwIfAborted();const token=own(result,'token'),directory=own(result,'directory');
  if(own(result,'ok')!==true){const message=own(result,'message');throw new ArchivePreparationError(typeof message==='string'?message:'Archive preparation failed',typeof token==='string'?token:null,typeof directory==='string'?directory:null);}
  const sourceDirectory=own(result,'sourceDirectory'),rollout=own(result,'rollout'),files=own(result,'files');
  if(typeof token!=='string'||token.length!==36||typeof directory!=='string'||typeof sourceDirectory!=='string'||typeof rollout!=='string'||typeof files!=='number'||!Number.isInteger(files)||files<2||files>6)throw new ArchivePreparationError('Invalid archive preparation receipt',null,null);
  return Object.freeze({token,directory,sourceDirectory,rollout,files});
 }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
}
