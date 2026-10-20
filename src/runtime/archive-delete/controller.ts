import {OwnedWorkerSlot} from '../owned-worker-slot.ts';
import {prepareArchiveDeletion} from './native-preparation.ts';
import type {ValidatedArchiveBackupPaths} from './native-backup.ts';
import type {ArchiveDeletionConfirmation} from '../../store/archive-deletion.ts';
import {resolveThreadReferenceOffThread} from '../../codex-state/reference-reader.ts';
import type {ActionResult} from '../action-result.ts';
export function createArchiveDeletionController(mirror:string,paths:ValidatedArchiveBackupPaths){
 const slot=new OwnedWorkerSlot();let busy=false;
 return async(reference:string,actor:{discordMessageId:bigint|null;channelId:bigint;userId:bigint},signal?:AbortSignal):Promise<ActionResult>=>{
  if(busy)throw new Error('Archive deletion already active');if(actor.discordMessageId===null)throw new Error('Archive confirmation requires original ingress');busy=true;
  let directory:string|null=null;
  try{const thread=await resolveThreadReferenceOffThread(paths.state,reference,null,true,signal,6000,paths.bridge);const confirmation:ArchiveDeletionConfirmation={messageId:actor.discordMessageId,channelId:actor.channelId,userId:actor.userId,reference};
   const prepared=await prepareArchiveDeletion(mirror,paths,thread.id,Date.now()/1000,confirmation,30000,signal);directory=prepared.directory;
   const cancelled=new SharedArrayBuffer(4),flag=new Int32Array(cancelled),cancel=()=>Atomics.store(flag,0,1);signal?.addEventListener('abort',cancel,{once:true});const timer=setTimeout(cancel,30000);
   try{signal?.throwIfAborted();const pending=slot.run(new URL('./delete-worker.ts',import.meta.url),{mirror,paths,id:thread.id,prepared,cancelled},30000,signal),joined=slot.join();let output:any;try{output=await pending;}finally{await joined;}if(output?.ok!==true)throw new Error(`Archive stage ${output?.stage??'unknown'}: ${output?.message??'unconfirmed'}`);return{text:`Archived thread deleted after backup\nthread_id: ${thread.id}\nbackup_dir: ${prepared.directory}\nbackup_files: ${prepared.files+1}\ndeleted_log_rows: ${output.deletedLogs}\ndeleted_rollout_path: ${prepared.rollout}\nmirror_rows: ${output.mirrorThreads}\nmirror_offsets: ${output.sessionMirrorOffsets}`,waitsForFinal:false,ui:null};}finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
  }catch(error){throw new Error(`Archive deletion remains fenced if admitted; do not retry automatically. Recovery: ${directory??'inspect archive preparation receipt'}`,{cause:error});}finally{busy=false;}
 };
}
