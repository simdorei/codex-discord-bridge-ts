import {types} from "node:util";
import {withPromptIntakeWriter} from "./prompt-intake.ts";
import {ensureForkHandoffTable} from "./fork-handoff-admission.ts";
import {forkHandoffByIdIn,forkHandoffBySourceIn,forkHandoffByAmbiguousJobIn,type AppServerForkHandoff} from "./fork-handoff-by-id.ts";
import {ForkHandoffConflictingIntentError} from "./fork-definite-stage.ts";
import {ForkTransitionError,validateForkStartingIn,validateForkNoOtherInflightIn,forkMappingSnapshotIn} from "./fork-transition-validation.ts";
import {trimUnicodeWhitespace as trim,takeUnicodeScalarChars} from "./queue-preflight-failure.ts";
import {targetIsHeldIn} from "./dead-generation-admission.ts";
import {DeadGenerationTargetHeldError} from "./fork-completed-target.ts";
import {SystemTimeError} from "./queue-mark-running.ts";
export interface NewAppServerForkHandoff {handoffId:string;ambiguousJobId:string|null;sourceThreadId:string;expectedGeneration:bigint;quarantineReason:string}
export interface BegunAppServerForkHandoff {handoff:AppServerForkHandoff;created:boolean}
export function forkNow():number{const value=Date.now();if(value<0)throw new SystemTimeError(-value);if(!Number.isFinite(value))throw new TypeError("Expected finite system time");return value/1000;}
export function validateForkIdentity(value:unknown):asserts value is string{
  if(typeof value!=="string"||/[\uD800-\uDFFF]/u.test(value))throw new TypeError("Expected well-formed fork identity");
  if(value===""||trim(value)!==value)throw new ForkTransitionError({kind:"InvalidIdentity"});
}
export async function beginAppServerForkHandoff(path:string,input:NewAppServerForkHandoff):Promise<BegunAppServerForkHandoff>{
  if(input===null||typeof input!=="object"||types.isProxy(input)||Array.isArray(input))throw new TypeError("Expected fork request data");
  const get=(key:string):unknown=>{const d=Object.getOwnPropertyDescriptor(input,key);if(!d||!Object.hasOwn(d,"value"))throw new TypeError("Expected own fork request field");return d.value;};
  const id=get("handoffId"),source=get("sourceThreadId"),job=get("ambiguousJobId"),generation=get("expectedGeneration"),rawReason=get("quarantineReason");
  validateForkIdentity(id);validateForkIdentity(source);if(job!==null)validateForkIdentity(job);
  if(typeof generation!=="bigint"||generation<-(1n<<63n)||generation>=(1n<<63n))throw new TypeError("Expected i64 generation");
  if(typeof rawReason!=="string"||/[\uD800-\uDFFF]/u.test(rawReason))throw new TypeError("Expected well-formed reason");
  const reason=takeUnicodeScalarChars(trim(rawReason)||"ambiguous app-server fork handoff",900);
  return withPromptIntakeWriter<BegunAppServerForkHandoff>(path,db=>{
    if(targetIsHeldIn(db,source))throw new DeadGenerationTargetHeldError(source);ensureForkHandoffTable(db);
    const existing=forkHandoffByIdIn(db,id);
    if(existing!==null){
      if(existing.ambiguousJobId!==job||existing.sourceThreadId!==source||existing.expectedGeneration!==generation||existing.quarantineReason!==reason)throw new ForkHandoffConflictingIntentError(source);
      return {value:{handoff:existing,created:false},commit:true};
    }
    if(forkHandoffBySourceIn(db,source)!==null||(job!==null&&forkHandoffByAmbiguousJobIn(db,job)!==null))throw new ForkHandoffConflictingIntentError(source);
    const now=forkNow();validateForkStartingIn(db,job,source,generation,now);validateForkNoOtherInflightIn(db,source,job);
    const [channel,thread]=forkMappingSnapshotIn(db,source);
    db.prepare(`INSERT INTO codex_thread_fork_handoffs(handoff_id,ambiguous_job_id,source_thread_id,expected_generation,discord_channel_id,discord_thread_id,
      quarantine_reason,last_fork_error,fork_failure_ambiguous,observed_target_thread_id,target_thread_id,completed_generation,created_at,completed_at)
      VALUES (?,?,?,?,?,?,?,'',0,NULL,NULL,NULL,?,NULL)`).run(id,job,source,generation,channel,thread,reason,now);
    const handoff:AppServerForkHandoff={handoffId:id,ambiguousJobId:job,sourceThreadId:source,expectedGeneration:generation,discordChannelId:channel,discordThreadId:thread,
      quarantineReason:reason,lastForkError:"",forkFailureAmbiguous:false,observedTargetThreadId:null,targetThreadId:null,completedGeneration:null};
    return {value:{handoff,created:true},commit:true};
  },false);
}
