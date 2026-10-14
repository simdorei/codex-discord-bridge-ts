import type {DatabaseSync} from 'node:sqlite';
import {openSync,closeSync,readSync,fstatSync,lstatSync} from 'node:fs';
import {requireDiscordText} from '../../discord/text.ts';
import {ArchiveConcurrentMutationError} from './records.ts';
export class ArchiveDeletionVerificationError extends Error{constructor(readonly kind:'ThreadStillPresent'|'LogsStillPresent'|'RolloutStillPresent'){super('Archive deletion verification: '+kind);this.name='ArchiveDeletionVerificationError';}}
/** Bounded native-worker file read. It grants no lock or permission to rewrite;
 * the final platform writer must compare these exact bytes under exclusive use. */
function optionalBytes(path:string,maxBytes:number):Readonly<{bytes:Buffer;dev:bigint;ino:bigint}>|null{
 let fd:number;try{fd=openSync(path,'r');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
 try{const before=fstatSync(fd,{bigint:true});if(!before.isFile()||before.size>BigInt(maxBytes))throw new RangeError('Archive metadata is not a bounded regular file');const bytes=Buffer.alloc(maxBytes+1);let used=0;for(;;){const count=readSync(fd,bytes,used,bytes.length-used,null);used+=count;if(used>maxBytes)throw new RangeError('Archive metadata grew past byte budget');if(count===0)break;}const after=fstatSync(fd,{bigint:true}),named=lstatSync(path,{bigint:true});if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs||named.isSymbolicLink()||named.dev!==after.dev||named.ino!==after.ino)throw new ArchiveConcurrentMutationError();return {bytes:bytes.subarray(0,used),dev:after.dev,ino:after.ino};}finally{closeSync(fd);}
}
/** Expected bytes come from backup, never a replacement source snapshot. Both
 * absent is allowed; changed presence/content refuses. No write or deletion. */
export function readBackedUpArchiveMetadata(source:string,backup:string,maxBytes:number):Buffer|null{
 requireDiscordText(source);requireDiscordText(backup);if(source.includes('\0')||backup.includes('\0')||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>1048576)throw new RangeError('Invalid archive metadata request');
 if(source===backup)throw new ArchiveConcurrentMutationError();
 const saved=optionalBytes(backup,maxBytes),current=optionalBytes(source,maxBytes);
 if(saved===null&&current===null)return null;
 if(saved===null||current===null||(saved.dev===current.dev&&saved.ino===current.ino)||!saved.bytes.equals(current.bytes))throw new ArchiveConcurrentMutationError();return saved.bytes;
}
/** Final postcondition snapshot only. Caller has already performed effects and
 * owns both database connections. Never commits, rolls back, opens or closes DBs. */
export function verifyArchivedRecordsDeletedIn(state:DatabaseSync,logs:DatabaseSync|null,id:string,rollout:string):void{
 requireDiscordText(id);requireDiscordText(rollout);
 const remaining=(db:DatabaseSync,sql:string):bigint=>{const q=db.prepare(sql);q.setReadBigInts(true);const n=q.get(id)?.n;if(typeof n!=='bigint'||n<0n)throw new TypeError('Invalid native archive count');return n;};
 if(remaining(state,'SELECT COUNT(*) AS n FROM threads WHERE id=?1')!==0n)throw new ArchiveDeletionVerificationError('ThreadStillPresent');
 if(logs!==null&&remaining(logs,'SELECT COUNT(*) AS n FROM logs WHERE thread_id=?1')!==0n)throw new ArchiveDeletionVerificationError('LogsStillPresent');
 try{lstatSync(rollout);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
 throw new ArchiveDeletionVerificationError('RolloutStillPresent');
}
