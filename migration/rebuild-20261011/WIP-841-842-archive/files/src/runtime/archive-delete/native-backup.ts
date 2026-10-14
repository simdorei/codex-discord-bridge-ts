import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../owned-worker-slot.ts';
export interface ArchiveBackupPaths{readonly state:string;readonly logs:string;readonly global:string;readonly bridge:string;readonly index:string;readonly rollout:string;readonly root:string;}
export class ArchiveBackupError extends Error{constructor(message:string,readonly recoveryDirectory:string|null){super(message);this.name='ArchiveBackupError';}}
const slot=new OwnedWorkerSlot();
/** Backup creation only. Never deletes source or recovery files. Failed attempts
 * retain partial artifacts. Caller still needs reservation, source revalidation,
 * rollout containment and platform handle protection before deletion. */
export async function createArchiveBackup(paths:ArchiveBackupPaths,id:string,timeoutMs:number,signal?:AbortSignal):Promise<Readonly<{directory:string;files:number}>>{
 signal?.throwIfAborted();requireDiscordText(id);if(id.length>4096||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw new RangeError('Invalid archive backup request');
 const captured=Object.create(null) as Record<string,string>;
 for(const key of ['state','logs','global','bridge','index','rollout','root']){const value=own(paths,key);if(typeof value!=='string')throw new TypeError('Invalid archive backup path');requireDiscordText(value);if(value.includes('\0')||Buffer.byteLength(value)>32768)throw new RangeError('Invalid archive backup path');captured[key]=pinNativeRuntimePath(value);}
 if(new Set(Object.values(captured)).size!==7)throw new TypeError('Archive backup paths must be distinct');
 if(slot.busy)throw new OwnedWorkerBusyError();const cancelled=new SharedArrayBuffer(4),flag=new Int32Array(cancelled),cancel=()=>Atomics.store(flag,0,1);signal?.addEventListener('abort',cancel,{once:true});const timer=setTimeout(cancel,timeoutMs);
 try{const pending=slot.run(new URL('./backup-worker.ts',import.meta.url),{paths:captured,id,cancelled},timeoutMs,signal),joined=slot.join();let result:unknown;try{result=await pending;}finally{await joined;}signal?.throwIfAborted();if(own(result,'ok')!==true){const directory=own(result,'directory'),message=own(result,'message');throw new ArchiveBackupError(typeof message==='string'?message:'Invalid backup response',typeof directory==='string'?directory:null);}const directory=own(result,'directory'),files=own(result,'files');if(typeof directory!=='string'||typeof files!=='number'||!Number.isInteger(files)||files<2||files>6)throw new ArchiveBackupError('Invalid backup receipt',null);return Object.freeze({directory,files});}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
}
