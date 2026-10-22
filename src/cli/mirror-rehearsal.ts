import {constants} from 'node:fs';
import {copyFile,mkdtemp,lstat,readdir,unlink,rmdir} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {snapshotCutoverStore} from '../store/cutover-backup.ts';
import {OwnedWorkerSlot} from '../runtime/owned-worker-slot.ts';
import {WindowsFilePin} from '../runtime/windows/windows-file-pin.ts';
import {legacyMirrorPolicy,type LegacyMirrorPolicy} from './legacy-mirror-policy.ts';

export interface RehearsalPorts{
 snapshot:(path:string,signal?:AbortSignal)=>Promise<string>;
 worker:(kind:'reconcile'|'migrate',data:Record<string,unknown>,signal?:AbortSignal)=>Promise<any>;
 cleanup:(directory:string)=>Promise<void>;
}
async function worker(kind:'reconcile'|'migrate',data:Record<string,unknown>,signal?:AbortSignal){
 const slot=new OwnedWorkerSlot('Control');let result:any;
 try{result=await slot.run(new URL(kind==='migrate'?'./mirror-migration-worker.ts':'./mirror-reconciliation-worker.ts',import.meta.url),data,kind==='migrate'?30000:10000,signal);}finally{await slot.join();}
 if(result?.ok!==true)throw new Error(result?.error??'Rehearsal worker outcome unconfirmed');return result.value;
}
async function cleanup(directory:string){
 // Nonrecursive: refuse any unexpected artifact instead of deleting foreign data.
 const names=await readdir(directory),allowed=new Set(['working.sqlite','working.sqlite-wal','working.sqlite-shm','working.sqlite-journal']);
 for(const name of names){if(!allowed.has(name))throw new Error('Unexpected rehearsal artifact retained');const item=await lstat(join(directory,name));if(!item.isFile()||item.isSymbolicLink()||item.nlink!==1)throw new Error('Rehearsal artifact identity unconfirmed');}
 for(const name of names)await unlink(join(directory,name));await rmdir(directory);
}
const defaults:RehearsalPorts={snapshot:snapshotCutoverStore,worker,cleanup};
/** Read-only source, retained consistent backup, isolated mutable rehearsal.
 * No runtime lock, markers, journal, service actions, or Discord client. */
export async function rehearseMirrorMigration(database:string,statePath:string,signal?:AbortSignal,ports:RehearsalPorts=defaults,requestedPolicy:LegacyMirrorPolicy='strict'){
 const policy=legacyMirrorPolicy(requestedPolicy);signal?.throwIfAborted();const backup=await ports.snapshot(database,signal);
 const directory=await mkdtemp(join(dirname(backup),'rehearsal-')),working=join(directory,'working.sqlite');
 let pin:WindowsFilePin|undefined,report:any;
 try{
  pin=process.platform==='win32'?WindowsFilePin.acquire(directory,'directory'):undefined;
  await copyFile(backup,working,constants.COPYFILE_EXCL);signal?.throwIfAborted();
  const diagnostics=await ports.worker('reconcile',{path:working,statePath,policy},signal);
  const migration=await ports.worker('migrate',{path:working,statePath,policy},signal);
  if(!Array.isArray(migration?.held)||!Array.isArray(migration?.migrated)||!Array.isArray(migration?.already)||!Array.isArray(diagnostics?.details))throw new Error('Invalid rehearsal worker report');
  const inactive=migration.inactivePreserved??[],deferred=migration.deferred??[];
  if(!Array.isArray(inactive)||!Array.isArray(deferred)||policy==='strict'&&(inactive.length+deferred.length>0)||policy==='rust-preserve'&&(migration.policy!==policy||diagnostics.policy!==policy))throw new Error('Rehearsal policy mismatch');
  const preserved=[...inactive,...deferred],all=[...migration.migrated,...migration.already,...migration.held.map((v:any)=>v.thread),...preserved.map((v:any)=>v.thread)];
  if(all.length!==diagnostics.details.length||new Set(all).size!==all.length||diagnostics.details.some((v:any)=>!all.includes(v.thread)))throw new Error('Incomplete rehearsal coverage');
  const metadataHolds=diagnostics.details.filter((v:any)=>v.classification!=='LFAligned'&&!preserved.some((p:any)=>p.thread===v.thread&&p.disposition===v.disposition&&p.reason===v.reason)).map((v:any)=>({thread:v.thread,reason:v.classification}));
  report={ready:migration.held.length===0&&metadataHolds.length===0,policy,status:migration.held.length||metadataHolds.length?'Held':deferred.length?'ReadyWithDeferredMirrors':'Ready',backup,diagnostics,metadataHolds,migration,sourceMutated:false,advisory:true};
 }catch(error){throw new Error('Rehearsal unconfirmed; retained work directory '+directory,{cause:error});}
 finally{pin?.close();}
 // Only a confirmed, joined result permits cleanup. Errors retain evidence.
 try{await ports.cleanup(directory);}catch(error){throw new Error('Rehearsal cleanup failed; retained '+directory,{cause:error});}
 return report;
}
