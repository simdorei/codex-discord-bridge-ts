import {parentPort,workerData} from 'node:worker_threads';
import {DatabaseSync,backup} from 'node:sqlite';
import {mkdirSync,lstatSync,openSync,fstatSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import {loadArchivedRolloutIn} from './preflight.ts';
import {StateAccessFacade} from '../../store/state-access-facade.ts';
import type {ArchiveDeletionConfirmation} from '../../store/archive-deletion.ts';
import {createArchiveBackupInWorker,type ArchiveBackupWorkerInput} from './backup-core.ts';
if(parentPort===null)throw new Error('Archive preparation requires native worker ownership');
const input=workerData as {mirror:string;id:string;now:number;confirmation:ArchiveDeletionConfirmation;paths:ArchiveBackupWorkerInput['paths'];cancelled:SharedArrayBuffer};
const flag=new Int32Array(input.cancelled);
const check=()=>{if(Atomics.load(flag,0)!==0)throw new Error('Archive preparation cancelled; retain fence and recovery artifacts');};
let token:string|null=null,directory:string|null=null,result:unknown;
try{
 check();const sourceRead=new DatabaseSync(input.paths.state,{readOnly:true,timeout:100});try{loadArchivedRolloutIn(sourceRead,input.id);}finally{sourceRead.close();}
 check();token=StateAccessFacade.beginArchiveDeletionExisting(input.mirror,input.id,input.now,input.confirmation);
 check();mkdirSync(input.paths.root,{recursive:true});const root=lstatSync(input.paths.root);if(!root.isDirectory()||root.isSymbolicLink())throw new Error('Archive recovery root is not a regular directory');
 directory=join(input.paths.root,'archive-guard-'+token);mkdirSync(directory);
 const target=join(directory,'mirror.sqlite'),fd=openSync(target,'wx');const identity=fstatSync(fd,{bigint:true});closeSync(fd);
 const db=new DatabaseSync(input.mirror,{readOnly:true,timeout:100});try{await backup(db,target,{rate:100,progress(){check();}});}finally{db.close();}
 check();const named=lstatSync(target,{bigint:true});if(!named.isFile()||named.dev!==identity.dev||named.ino!==identity.ino)throw new Error('Archive mirror backup target changed');
 const saved=new DatabaseSync(target,{readOnly:true,timeout:100});try{
  if(saved.prepare('PRAGMA quick_check').get()?.quick_check!=='ok')throw new Error('Archive mirror backup integrity failed');
  const row=saved.prepare("SELECT token,phase FROM cdr_archive_fences WHERE target_thread_id=?").get(input.id);
  if(row?.token!==token||row.phase!=='deleting')throw new Error('Archive mirror backup lost reservation identity');
 }finally{saved.close();}
 check();const source=await createArchiveBackupInWorker({paths:{...input.paths,root:join(directory,'source')},id:input.id,cancelled:input.cancelled}) as {ok:boolean;directory:string|null;files?:number;rollout?:string;message?:string};
 if(source.ok!==true)throw new Error(source.message??'Archive source backup failed');check();
 result={ok:true,token,directory,sourceDirectory:source.directory,rollout:source.rollout,files:source.files};
}catch(error){result={ok:false,token,directory,message:error instanceof Error?error.message.slice(0,4096):'Archive preparation failed'};}
parentPort.postMessage(result);parentPort.close();
