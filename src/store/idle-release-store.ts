import type {DatabaseSync} from "node:sqlite";
import {cloneOwnedSerdeValue} from "../core/owned-serde-value.ts";
import {StoreIntegrityError} from "./schema-assembly.ts";
import {decodeI64} from "./sqlite-values.ts";
import {IDLE_COLUMNS,selectIdleIntentIn,decodeIdleIntentRow,type IdleIntent} from "./idle-release-row.ts";
import {botIdleIn} from "./idle-release-admission.ts";
import {observationScopeVerifiedIn} from "./observation-ledger.ts";
import {withStoreTransaction,usingInitializedStore,commitStore,rollbackStore} from "./owned-scope.ts";
export type {IdleIntent} from "./idle-release-row.ts";
function text(value:string):void{if(typeof value!=="string"||/[\uD800-\uDFFF]/u.test(value))throw new TypeError("Expected well-formed idle text");}
function integer(value:bigint):void{if(typeof value!=="bigint"||value<-(1n<<63n)||value>=(1n<<63n))throw new TypeError("Expected signed idle integer");}
export function snapshotIdleIntent(input:IdleIntent):Readonly<IdleIntent>{
  const v=cloneOwnedSerdeValue(input),keys=["intentId","ownerId","generation","threadId","turnId","jobId","revision","state","detail"];
  if(v===null||typeof v!=="object"||Array.isArray(v)||Object.keys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k)))throw new TypeError("Expected exact idle intent");const i=v as IdleIntent;for(const key of ["intentId","ownerId","threadId","turnId","jobId","state","detail"] as const)text(i[key]);integer(i.generation);integer(i.revision);return i;
}
export function pendingIdleIntentsIn(db:DatabaseSync):IdleIntent[]{const q=db.prepare(`SELECT ${IDLE_COLUMNS} FROM cdr_idle_release WHERE state!='Settled' ORDER BY thread_id LIMIT 128`);q.setReadBigInts(true);return [...q.iterate()].map(decodeIdleIntentRow);}
function sameRevision(a:IdleIntent,b:IdleIntent):boolean{return a.intentId===b.intentId&&a.ownerId===b.ownerId&&a.generation===b.generation&&a.threadId===b.threadId&&a.turnId===b.turnId&&a.jobId===b.jobId&&a.revision===b.revision;}
export function verifyIdleIntentIn(db:DatabaseSync,input:IdleIntent,requireIdle:boolean):void{
  const expected=snapshotIdleIntent(input);if(typeof requireIdle!=="boolean")throw new TypeError("Expected idle requirement");const current=selectIdleIntentIn(db,expected.threadId);
  if(current===null||!sameRevision(current,expected)||current.state!==expected.state)throw new StoreIntegrityError("idle release identity/state changed");
  if(requireIdle&&!botIdleIn(db,expected.threadId))throw new StoreIntegrityError("idle release deferred: unresolved bot work");
}
export function verifyIdleIntentWithObservationsOn(db:DatabaseSync,input:IdleIntent,requireIdle:boolean):void{
  const expected=snapshotIdleIntent(input);return withStoreTransaction(db,"DEFERRED",()=>{
    verifyIdleIntentIn(db,expected,requireIdle);if(requireIdle&&!observationScopeVerifiedIn(db,{ownerId:expected.ownerId,generation:expected.generation},0n))throw new StoreIntegrityError("idle unverified: durable observation range remains");return commitStore(undefined);
  });
}
function update(db:DatabaseSync,old:IdleIntent,state:string,detail:string):void{
  const bounded=Array.from(detail).slice(0,512).join("");const changed=db.prepare(`UPDATE cdr_idle_release SET state=?,detail=?,revision=revision+1
    WHERE intent_id=? AND owner_id=? AND generation=? AND thread_id=? AND turn_id=? AND job_id=? AND revision=? AND state=?`).run(state,bounded,old.intentId,old.ownerId,old.generation,old.threadId,old.turnId,old.jobId,old.revision,old.state).changes;
  if(BigInt(changed)!==1n)throw new StoreIntegrityError("idle release compare-and-set lost");
}
export function beforeIdleMutationOn(db:DatabaseSync,owner:string,generation:bigint,thread:string):IdleIntent|null{
  text(owner);integer(generation);text(thread);return withStoreTransaction(db,"IMMEDIATE",()=>{
    const intent=selectIdleIntentIn(db,thread);if(intent===null||intent.state==="Settled")return rollbackStore(null);
    if(intent.state==="Candidate"){update(db,intent,"Settled","CancelledBeforeSend");return commitStore(null);}
    if(intent.state==="AwaitUnload"&&intent.ownerId===owner&&intent.generation===generation){
      update(db,intent,"Resubscribing","real resume required before next mutation");
      // Source returns its prior detail although the stored detail changed; detail is
      // deliberately not part of same_revision. Do not silently rewrite that result.
      return commitStore({...intent,revision:decodeI64(intent.revision+1n,"idle revision"),state:"Resubscribing"});
    }
    throw new StoreIntegrityError(`idle release ${intent.state} requires review for thread ${thread}; no automatic resume/start: ${intent.detail}`);
  });
}
export function idleTransitionAllowed(from:string,to:string,reason:string):boolean{
  text(from);text(to);text(reason);
  return (from==="Candidate"&&(to==="Dispatching"||to==="Candidate"))||(from==="Dispatching"&&to==="AwaitUnload")||((from==="Dispatching"||from==="Resubscribing")&&to==="Unknown")||
    (to==="Settled"&&(reason==="CancelledBeforeSend"?(from==="Candidate"||from==="Dispatching"):reason==="UnloadedConfirmed"?from==="AwaitUnload":reason==="SupersededByConfirmedResubscribe"?from==="Resubscribing":reason==="OldServerExited"?from!=="Settled":false))||
    (from==="Resubscribing"&&to==="AwaitUnload"&&reason==="ResumeCancelledBeforeSend");
}
export function transitionIdleIntentOn(db:DatabaseSync,input:IdleIntent,state:string,detail:string):IdleIntent{
  const old=snapshotIdleIntent(input);text(state);text(detail);if(!idleTransitionAllowed(old.state,state,detail))throw new StoreIntegrityError(`invalid idle release transition ${old.state} -> ${state}`);
  return withStoreTransaction(db,"IMMEDIATE",()=>{update(db,old,state,detail);const next=selectIdleIntentIn(db,old.threadId);if(next===null)throw new StoreIntegrityError("updated idle intent missing");return commitStore(next);});
}
/** Exact old-child owner is a REQUIRED upstream capability; UUID/generation change alone
 * is never enough. This low-level store leaf cannot establish native exit by itself. */
export function settleExitedIdleOwnerIn(db:DatabaseSync,owner:string,generation:bigint):void{text(owner);integer(generation);db.prepare("UPDATE cdr_idle_release SET state='Settled',detail='OldServerExited',revision=revision+1 WHERE owner_id=? AND generation=? AND state!='Settled'").run(owner,generation);}
export function beforeIdleCleanupIn(db:DatabaseSync,thread:string):void{text(thread);if(!db.isTransaction)throw new StoreIntegrityError("Borrowed idle cleanup requires an active transaction");const old=selectIdleIntentIn(db,thread);if(old?.state==="Candidate")update(db,old,"Settled","CancelledBeforeSend");}
export function getIdleIntent(path:string,thread:string):Promise<IdleIntent|null>{text(thread);return usingInitializedStore(path,db=>selectIdleIntentIn(db,thread));}
export function pendingIdleIntents(path:string):Promise<IdleIntent[]>{return usingInitializedStore(path,pendingIdleIntentsIn);}
export function beforeIdleMutation(path:string,owner:string,generation:bigint,thread:string):Promise<IdleIntent|null>{text(owner);integer(generation);text(thread);return usingInitializedStore(path,db=>beforeIdleMutationOn(db,owner,generation,thread));}
export function transitionIdleIntent(path:string,input:IdleIntent,state:string,detail:string):Promise<IdleIntent>{const old=snapshotIdleIntent(input);text(state);text(detail);if(!idleTransitionAllowed(old.state,state,detail))return Promise.reject(new StoreIntegrityError(`invalid idle release transition ${old.state} -> ${state}`));return usingInitializedStore(path,db=>transitionIdleIntentOn(db,old,state,detail));}
export function verifyIdleIntent(path:string,input:IdleIntent,requireIdle:boolean):Promise<void>{const old=snapshotIdleIntent(input);if(typeof requireIdle!=="boolean")throw new TypeError("Expected idle requirement");return usingInitializedStore(path,db=>verifyIdleIntentIn(db,old,requireIdle));}
export function verifyIdleIntentWithObservations(path:string,input:IdleIntent,requireIdle:boolean):Promise<void>{const old=snapshotIdleIntent(input);if(typeof requireIdle!=="boolean")throw new TypeError("Expected idle requirement");return usingInitializedStore(path,db=>verifyIdleIntentWithObservationsOn(db,old,requireIdle));}
export function settleExitedIdleOwner(path:string,owner:string,generation:bigint):Promise<void>{text(owner);integer(generation);return usingInitializedStore(path,db=>settleExitedIdleOwnerIn(db,owner,generation));}
