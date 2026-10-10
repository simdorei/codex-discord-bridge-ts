import {I64_MAX} from "../protocol/ids.ts";
import {cloneIdleReleaseToken,type IdleReleaseToken,type IdleReleaseJournal} from "../app-server/idle-release-journal.ts";
import type {PortableResidentLifecycle} from "../app-server/portable-resident-lifecycle.ts";
import type {IdleIntent} from "../store/idle-release-row.ts";
import {StateAccessFacade as state} from "../store/state-access-facade.ts";
import {createRuntimeFenceErrors} from "./fence-errors.ts";
function integer(v:bigint):bigint{if(typeof v!=="bigint"||v<0n||v>I64_MAX)throw new RangeError("Idle journal u64 does not fit signed i64");return v;}
function intent(t:IdleReleaseToken):IdleIntent{const owned=cloneIdleReleaseToken(t);integer(owned.generation);return {...owned};}
/** Concrete synchronous adapter on the documented already initialized store profile.
 * Caller invokes oldChildExited only after the native owner confirms exact child exit. */
export function createRuntimeIdleJournal(path:string,render:(error:unknown)=>string):Required<IdleReleaseJournal>{
  if(typeof path!=="string"||/[\uD800-\uDFFF]/u.test(path))throw new TypeError("Expected store path");const errors=createRuntimeFenceErrors(render),run=<T>(fn:()=>T):T=>errors.run("IdleRelease",fn);
  const s={unknown:state.markUnknownObservationExisting,discover:state.discoverObservationExisting,scope:state.observationScopeVerifiedExisting,before:state.beforeIdleMutationExisting,guard:state.validateAsyncDispatchGuardsExisting,get:state.getIdleIntentExisting,verify:state.verifyIdleIntentWithObservationsExisting,transition:state.transitionIdleIntentExisting,exit:state.settleExitedIdleOwnerExisting};
  const check=(thread:string):void=>{
    s.guard(path,thread);const current=s.get(path,thread);
    if(current!==null&&current.state!=="Candidate"&&current.state!=="Settled")throw new Error(`thread ${thread} subscription ${current.state} requires review; automatic mutation held: ${current.detail}`);
  };
  return Object.freeze({
    tracksObservations:()=>true,
    recordObservationGap:(owner:string,generation:bigint)=>run(()=>s.unknown(path,{ownerId:owner,generation:integer(generation)},"unscoped observation failure; no source range proof")),
    observeSourceUpper:(owner:string,generation:bigint,upper:bigint)=>run(()=>s.discover(path,{ownerId:owner,generation:integer(generation)},integer(upper))),
    observationScopeVerified:(owner:string,generation:bigint,through:bigint)=>run(()=>s.scope(path,{ownerId:owner,generation:integer(generation)},integer(through))),
    beforeMutation:(owner:string,generation:bigint,thread:string)=>run(()=>{const value=s.before(path,owner,integer(generation),thread);return value===null?null:cloneIdleReleaseToken(value);}),
    checkMutation:(thread:string)=>run(()=>check(thread)),
    resumeRequired:(thread:string)=>run(()=>{if(s.get(path,thread)?.state==="AwaitUnload")return true;check(thread);return false;}),
    verify:(token:IdleReleaseToken,idle:boolean)=>run(()=>s.verify(path,intent(token),idle)),
    transition:(token:IdleReleaseToken,next:string,detail:string)=>run(()=>cloneIdleReleaseToken(s.transition(path,intent(token),next,detail))),
    oldChildExited:(owner:string,generation:bigint)=>run(()=>s.exit(path,owner,integer(generation))),
  });
}
/** Install before intake, recovery or question answers. Synchronous activation preserves
 * the source order: read old pending holds, activate scope, then attach the journal. */
export function installRuntimeIdleJournal(server:PortableResidentLifecycle,path:string,render:(error:unknown)=>string):void{
  const errors=createRuntimeFenceErrors(render),journal=createRuntimeIdleJournal(path,render);
  errors.run("IdleRelease",()=>{state.pendingIdleIntentsExisting(path);state.activateObservationExisting(path,{ownerId:server.instanceId,generation:integer(server.generation())});});
  server.installIdleReleaseJournal(journal);
}
