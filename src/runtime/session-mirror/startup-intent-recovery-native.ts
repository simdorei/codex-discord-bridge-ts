import {isMainThread} from 'node:worker_threads';
import {statSync} from 'node:fs';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {usingExistingReadOnlyStore} from '../../store/owned-scope.ts';
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
