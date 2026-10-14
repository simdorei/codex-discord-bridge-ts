import {isMainThread} from 'node:worker_threads';
import {statSync} from 'node:fs';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {usingExistingReadOnlyStore,usingExistingStore} from '../../store/owned-scope.ts';
import {MirrorStartupIntentConflictError} from '../../store/mirror-startup-intent.ts';
import {MirrorFileChangedError} from './file-window.ts';
import {captureMirrorCursorAnchor} from './continuity-observation.ts';
import {readMirrorStartupContextNative} from './startup-context-scan.ts';
import {sameMirrorStartupStamp,type MirrorStartupContextLimits} from './startup-context-limits.ts';
import {snapshotMirrorStartupDatabaseIdentity,sameMirrorStartupDatabase,type MirrorStartupDatabaseIdentity,type MirrorStartupRecoveryData} from './startup-intent-recovery-data.ts';
function nativeOnly():void {if(isMainThread)throw new TypeError('Startup recovery requires an owned native worker');}
function identity(path:string):MirrorStartupDatabaseIdentity {
 const value=statSync(path,{bigint:true});if(!value.isFile())throw new TypeError('Expected existing startup database file');return snapshotMirrorStartupDatabaseIdentity({dev:value.dev,ino:value.ino,birthtimeNs:value.birthtimeNs});
}
/** Each read owns and closes its own short read-only DB scope. Never hold a DB
 * snapshot across file IO: the second read must observe newly committed state.
 * Native identity brackets detect observed database replacement, not unseen ABA. */
function readIn<T>(path:string,database:MirrorStartupDatabaseIdentity,read:(db:Parameters<typeof state.readPendingMirrorStartupIntent>[0])=>T):T {
 if(!sameMirrorStartupDatabase(database,identity(path)))throw new MirrorStartupIntentConflictError();
 const value=usingExistingReadOnlyStore(path,read);
 if(!sameMirrorStartupDatabase(database,identity(path)))throw new MirrorStartupIntentConflictError();return value;
}
export async function recoverMirrorStartupContextNative(path:string,thread:string,operationId:string,limits:MirrorStartupContextLimits,check:()=>void):Promise<MirrorStartupRecoveryData> {
 nativeOnly();check();const database=identity(path),pending=readIn(path,database,db=>state.readPendingMirrorStartupIntent(db,thread));
 if(pending===null||pending.operationId!==operationId)throw new MirrorStartupIntentConflictError();check();
 // No structural cutoff is accepted from the caller and no later EOF is sampled.
 const context=await readMirrorStartupContextNative(pending.cutoff,limits,check);check();
 readIn(path,database,db=>state.verifyPendingMirrorStartupIntent(db,pending));check();
 return {database,pending,context};
}
/** Recheck an owner's exact successful observation. This is a read-only sampled
 * check, NOT atomic commit proof: all later writes must perform their own checks.
 * File metadata/anchors and database identity cannot certify unseen history. */
export async function verifyMirrorStartupRecoveryNative(path:string,input:MirrorStartupRecoveryData,check:()=>void):Promise<void> {
 nativeOnly();check();const {database,pending,context}=input;
 readIn(path,database,db=>state.verifyPendingMirrorStartupIntent(db,pending));check();
 const now=(await captureMirrorCursorAnchor(context.anchor.path,context.anchor.offset)).anchor;check();
 if(!sameMirrorStartupStamp(context.anchor.stamp,now.stamp)||context.anchor.prefixHash!==now.prefixHash||context.anchor.tailHash!==now.tailHash)throw new MirrorFileChangedError();
 readIn(path,database,db=>state.verifyPendingMirrorStartupIntent(db,pending));check();
}

/** Internal worker protocol only: the owning store authenticates the retained
 * observation before submission. The pending branch rechecks DB/file evidence,
 * then performs one DB-only atomic transition. There remains a filesystem race
 * window; neither sampled anchors nor a committed DB row prove unseen history.
 * An exact completed retry is read-only and does not need obsolete pending/file
 * presence; a changed cursor or database identity is always held. */
export async function completeMirrorStartupRecoveryNative(path:string,input:MirrorStartupRecoveryData,check:()=>void):Promise<import('../../store/mirror-startup-intent.ts').MirrorStartupCompletionResult> {
 nativeOnly();check();const {database,pending,context}=input,plan=state.prepareMirrorStartupIntentCompletion(pending,context);
 const done=readIn(path,database,db=>state.readPreparedMirrorStartupCompletion(db,plan));check();
 if(done!==null)return Object.freeze({kind:'Reconciled',cursor:done});
 const now=(await captureMirrorCursorAnchor(context.anchor.path,context.anchor.offset)).anchor;check();
 if(!sameMirrorStartupStamp(context.anchor.stamp,now.stamp)||context.anchor.prefixHash!==now.prefixHash||context.anchor.tailHash!==now.tailHash)throw new MirrorFileChangedError();
 // Re-read in the write transaction too: a competing completion can commit
 // after this observation. Only the identical result can reconcile that race.
 check();const result=usingExistingStore(path,db=>{
  check();if(!sameMirrorStartupDatabase(database,identity(path)))throw new MirrorStartupIntentConflictError();
  const file=statSync(context.anchor.path,{bigint:true});
  if(!file.isFile()||!sameMirrorStartupStamp(context.anchor.stamp,{dev:file.dev,ino:file.ino,birthtimeNs:file.birthtimeNs,mtimeNs:file.mtimeNs,ctimeNs:file.ctimeNs,size:file.size}))throw new MirrorFileChangedError();
  return state.completePreparedMirrorStartupIntent(db,plan);
 },100);
 if(!sameMirrorStartupDatabase(database,identity(path)))throw new MirrorStartupIntentConflictError();check();return result;
}
