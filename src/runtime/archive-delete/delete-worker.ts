import {parentPort,workerData} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {open,lstat,rename,unlink} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {basename,dirname,join} from 'node:path';
import {WindowsFilePin} from '../windows/windows-file-pin.ts';
import {RemoteFileMutations,fileDigest} from '../../remote-agent/files/mutations.ts';
import {deleteArchivedStateRows,deleteArchivedLogRows} from './records.ts';
import {planArchiveJsonScrub,planArchiveIndexScrub} from './metadata-plans.ts';
import {readBackedUpArchiveMetadata,verifyArchivedRecordsDeletedIn} from './verification.ts';
import {assertArchivedRolloutContained} from './preflight.ts';
import {deleteArchivedMirrorStateExisting,completeArchiveDeletionExisting} from '../../store/archive-deletion.ts';
import type {ArchivePreparationReceipt} from './native-preparation.ts';
import type {ValidatedArchiveBackupPaths} from './native-backup.ts';
if(parentPort===null)throw new Error('Archive deletion requires an owned worker');
const input=workerData as {mirror:string;paths:ValidatedArchiveBackupPaths;id:string;prepared:ArchivePreparationReceipt;cancelled:SharedArrayBuffer};
const {paths,id,prepared}=input,flag=new Int32Array(input.cancelled),pins:WindowsFilePin[]=[],connections:DatabaseSync[]=[];
let stage='backup',result:unknown;
const check=()=>{if(Atomics.load(flag,0)!==0)throw new Error('Archive deletion cancelled; reconcile backup and fence');};
const pin=(path:string,kind:'file'|'directory',update=false)=>{if(process.platform==='win32')pins.push(WindowsFilePin.acquire(path,kind,kind==='file',update));};
const exists=async(path:string)=>{try{await lstat(path);return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}};
const db=(path:string,readOnly:boolean)=>{pin(path,'file');const value=new DatabaseSync(path,{readOnly,timeout:100});connections.push(value);return value;};
async function hash(path:string){const file=await open(path,'r');try{const before=await file.stat({bigint:true});if(!before.isFile()||before.nlink!==1n||before.size>134217728n)throw new Error('Unsafe archive transcript');const h=createHash('sha256'),b=Buffer.alloc(65536);let used=0;for(;;){check();const n=(await file.read(b,0,b.length,null)).bytesRead;if(!n)break;used+=n;if(used>134217728)throw new Error('Archive transcript grew');h.update(b.subarray(0,n));}const after=await file.stat({bigint:true});if(before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs)throw new Error('Archive transcript changed');return{digest:h.digest('hex'),stat:before};}finally{await file.close();}}
try{
 check();pin(prepared.directory,'directory');pin(prepared.sourceDirectory,'directory');pin(paths.archivedSessions,'directory');
 const mirror=db(input.mirror,true);if(mirror.prepare("SELECT token FROM cdr_archive_fences WHERE target_thread_id=? AND phase='deleting'").get(id)?.token!==prepared.token)throw new Error('Archive reservation differs');
 for(const key of ['bridge','global','index'] as const)readBackedUpArchiveMetadata(paths[key],join(prepared.sourceDirectory,basename(paths[key])),1048576);
 assertArchivedRolloutContained(prepared.rollout,paths.archivedSessions);pin(prepared.rollout,'file',true);const transcript=await hash(prepared.rollout);pin(join(prepared.sourceDirectory,'transcript','rollout.jsonl'),'file');if(transcript.digest!==(await hash(join(prepared.sourceDirectory,'transcript','rollout.jsonl'))).digest)throw new Error('Transcript differs from backup');
 const state=db(paths.state,false),savedState=db(join(prepared.sourceDirectory,basename(paths.state)),true);check();deleteArchivedStateRows(state,savedState,id,prepared.rollout,{maxRows:4096,maxBytes:4194304});stage='state row deletion';
 let logs:DatabaseSync|null=null,deletedLogs=0n;
 if(await exists(paths.logs)){logs=db(paths.logs,false);const saved=db(join(prepared.sourceDirectory,basename(paths.logs)),true);check();deletedLogs=deleteArchivedLogRows(logs,saved,id,{maxRows:4096,maxBytes:4194304});}else if(await exists(join(prepared.sourceDirectory,basename(paths.logs))))throw new Error('Log source disappeared');stage='log deletion';
 for(const key of ['bridge','global','index'] as const){check();const original=readBackedUpArchiveMetadata(paths[key],join(prepared.sourceDirectory,basename(paths[key])),1048576);if(original!==null){let replacement:string|null=null;if(key==='index')replacement=planArchiveIndexScrub(original,id,1048576).replacement;else{const plan=planArchiveJsonScrub(original,id,key==='bridge',1048576);if(plan.changed.length)replacement=JSON.stringify(plan.value)+'\n';}if(replacement!==null){const files=await RemoteFileMutations.bind(dirname(paths[key]));try{await files.write(basename(paths[key]),Buffer.from(replacement),fileDigest(original));}finally{files.close();}}}stage=key+' metadata';}
 check();assertArchivedRolloutContained(prepared.rollout,paths.archivedSessions);const before=await hash(prepared.rollout);if(before.digest!==transcript.digest||before.stat.dev!==transcript.stat.dev||before.stat.ino!==transcript.stat.ino)throw new Error('Transcript changed before delete');
 const retired=join(dirname(prepared.rollout),'.cdr-archive-'+randomUUID()+'.retired');await rename(prepared.rollout,retired);const moved=await lstat(retired,{bigint:true});if(moved.dev!==transcript.stat.dev||moved.ino!==transcript.stat.ino)throw new Error('Transcript rename identity differs; retained for reconciliation');await unlink(retired);stage='rollout deletion';
 verifyArchivedRecordsDeletedIn(state,logs,id,prepared.rollout);check();const counts=deleteArchivedMirrorStateExisting(input.mirror,id,prepared.token);stage='mirror deletion';completeArchiveDeletionExisting(input.mirror,id,prepared.token);stage='completed';result={ok:true,stage,deletedLogs,...counts};
}catch(error){result={ok:false,stage,message:error instanceof Error?error.message:'Archive deletion failed'};}
finally{const errors:unknown[]=[];for(const c of connections.reverse())try{c.close();}catch(e){errors.push(e);}for(const p of pins.reverse())try{p.close();}catch(e){errors.push(e);}if(errors.length)result={ok:false,stage,message:'Archive native cleanup is unconfirmed'};}
parentPort.postMessage(result);parentPort.close();
