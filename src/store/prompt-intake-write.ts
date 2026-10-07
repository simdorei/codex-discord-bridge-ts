import {types} from "node:util";
import type {DatabaseSync} from "node:sqlite";
import {getPromptIntakeIn,promptIntakeByMessageIn,withPromptIntakeWriter,PromptIntakeNotFoundError,type StoredPromptIntake,type PromptIntakeClaim} from "./prompt-intake.ts";
import {migratePromptIntake} from "./schema-extensions-b1.ts";
import {canonicalCompletedTargetIn} from "./fork-canonical-target.ts";
import {linkPromptOwnerIn} from "./ingress-prompt-ownership.ts";
import {trimUnicodeWhitespace as trim} from "./queue-preflight-failure.ts";
import {rustDebugString} from "../core/rust-debug.ts";
import {StoreIntegrityError} from "./schema-assembly.ts";
import {SystemTimeError} from "./queue-mark-running.ts";
export interface NewPromptIntake {
  jobId:string;targetThreadId:string;channelId:bigint;ownerUserId:bigint|null;discordMessageId:bigint|null;
  rawPrompt:string;autoQueueWhenBusy:boolean;requireCurrentMirror:boolean;createdAt:number;
}
export interface PromptIntakeAdmission{intake:StoredPromptIntake;created:boolean}
export class InvalidPromptIntakeIdentityError extends Error{
  readonly kind="InvalidPromptIntakeIdentity";readonly jobId:string;readonly targetThreadId:string;
  constructor(job:string,target:string){super(`invalid durable prompt intake identity: job=${rustDebugString(job)}, target=${rustDebugString(target)}`);this.name="InvalidPromptIntakeIdentityError";this.jobId=job;this.targetThreadId=target;}
}
export class PromptIntakeIdentityConflictError extends Error{
  readonly kind="PromptIntakeIdentityConflict";readonly jobId:string;readonly discordMessageId:bigint|null;
  constructor(job:string,message:bigint|null){super(`durable prompt intake identity conflict: job=${job}, Discord message=${message===null?"None":`Some(${message})`}`);this.name="PromptIntakeIdentityConflictError";this.jobId=job;this.discordMessageId=message;}
}
export class PromptIntakeClaimLostError extends Error{
  readonly kind="PromptIntakeClaimLost";readonly jobId:string;
  constructor(id:string){super(`durable prompt intake claim is no longer current: job=${id}`);this.name="PromptIntakeClaimLostError";this.jobId=id;}
}
function data(value:unknown,key:string):unknown{
  if(value===null||typeof value!=="object"||types.isProxy(value)||Array.isArray(value))throw new TypeError("Expected intake data object");
  const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!Object.hasOwn(d,"value"))throw new TypeError("Expected own intake data field");return d.value;
}
function string(value:unknown):string{if(typeof value!=="string"||/[\uD800-\uDFFF]/u.test(value))throw new TypeError("Expected well-formed text");return value;}
function integer(value:unknown):bigint{if(typeof value!=="bigint"||value<-(1n<<63n)||value>=(1n<<63n))throw new TypeError("Expected i64 value");return value;}
function optional(value:unknown):bigint|null{return value===null?null:integer(value);}
function number(value:unknown):number{if(typeof value!=="number")throw new TypeError("Expected numeric timestamp");return value;}
function boolean(value:unknown):boolean{if(typeof value!=="boolean")throw new TypeError("Expected boolean");return value;}
export function snapshotNewPromptIntake(input:NewPromptIntake):NewPromptIntake{
  return {jobId:string(data(input,"jobId")),targetThreadId:string(data(input,"targetThreadId")),channelId:integer(data(input,"channelId")),
    ownerUserId:optional(data(input,"ownerUserId")),discordMessageId:optional(data(input,"discordMessageId")),rawPrompt:string(data(input,"rawPrompt")),
    autoQueueWhenBusy:boolean(data(input,"autoQueueWhenBusy")),requireCurrentMirror:boolean(data(input,"requireCurrentMirror")),createdAt:number(data(input,"createdAt"))};
}
export function snapshotPromptIntakeClaim(input:PromptIntakeClaim):PromptIntakeClaim{
  const value=data(input,"intake"),base=snapshotNewPromptIntake(value as NewPromptIntake),token=data(value,"claimToken");
  return {claimToken:string(data(input,"claimToken")),intake:{...base,attemptCount:integer(data(value,"attemptCount")),lastError:string(data(value,"lastError")),
    retryAfter:number(data(value,"retryAfter")),claimToken:token===null?null:string(token),claimExpiresAt:number(data(value,"claimExpiresAt")),updatedAt:number(data(value,"updatedAt"))}};
}
function validateIdentity(input:NewPromptIntake):void{
  if(input.jobId===""||trim(input.jobId)!==input.jobId||input.targetThreadId===""||trim(input.targetThreadId)!==input.targetThreadId)
    throw new InvalidPromptIntakeIdentityError(input.jobId,input.targetThreadId);
}
export function admitPromptIntakeIn(db:DatabaseSync,input:NewPromptIntake):PromptIntakeAdmission{
  const request=snapshotNewPromptIntake(input);validateIdentity(request);
  if(!db.isTransaction)throw new StoreIntegrityError("Borrowed mutation requires an active transaction");
  migratePromptIntake(db);
  const byJob=getPromptIntakeIn(db,request.jobId),byMessage=request.discordMessageId===null?null:promptIntakeByMessageIn(db,request.discordMessageId);
  if(byJob!==null&&(byMessage===null?byJob.discordMessageId!==request.discordMessageId:byJob.jobId!==byMessage.jobId))throw new PromptIntakeIdentityConflictError(request.jobId,request.discordMessageId);
  const existing=byJob??byMessage;
  if(existing!==null){linkPromptOwnerIn(db,existing);return {intake:existing,created:false};}
  const target=canonicalCompletedTargetIn(db,request.targetThreadId);
  db.prepare(`INSERT INTO codex_prompt_intakes(job_id,target_thread_id,channel_id,owner_user_id,discord_message_id,raw_prompt,auto_queue_when_busy,require_current_mirror,
    attempt_count,last_error,retry_after,claim_token,claim_expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,0,'',0,NULL,0,?,?)`)
    .run(request.jobId,target,request.channelId,request.ownerUserId,request.discordMessageId,request.rawPrompt,Number(request.autoQueueWhenBusy),Number(request.requireCurrentMirror),request.createdAt,request.createdAt);
  const intake=getPromptIntakeIn(db,request.jobId);if(intake===null)throw new PromptIntakeNotFoundError(request.jobId);
  linkPromptOwnerIn(db,intake);return {intake,created:true};
}
export async function admitPromptIntake(path:string,input:NewPromptIntake):Promise<PromptIntakeAdmission>{
  const request=snapshotNewPromptIntake(input);validateIdentity(request);
  return withPromptIntakeWriter(path,db=>({value:admitPromptIntakeIn(db,request),commit:true}),false);
}
export async function canonicalizePromptIntakeTarget(path:string,id:string):Promise<StoredPromptIntake|null>{
  return withPromptIntakeWriter(path,db=>{
    const intake=getPromptIntakeIn(db,id);if(intake===null)return {value:null,commit:true};
    const canonical=canonicalCompletedTargetIn(db,intake.targetThreadId);
    if(canonical!==intake.targetThreadId){const ms=Date.now();if(ms<0)throw new SystemTimeError(-ms);if(!Number.isFinite(ms))throw new TypeError("system clock must be finite");
      db.prepare("UPDATE codex_prompt_intakes SET target_thread_id=?,updated_at=? WHERE job_id=? AND target_thread_id=?").run(canonical,ms/1000,id,intake.targetThreadId);}
    return {value:getPromptIntakeIn(db,id),commit:true};
  });
}
export async function removePromptIntakeIfQueued(path:string,id:string):Promise<boolean>{
  return withPromptIntakeWriter(path,db=>({value:BigInt(db.prepare(`DELETE FROM codex_prompt_intakes WHERE job_id=?1
    AND NOT EXISTS(SELECT 1 FROM codex_dead_generation_holds hold WHERE hold.target_thread_id=codex_prompt_intakes.target_thread_id)
    AND (EXISTS(SELECT 1 FROM codex_turn_queue WHERE job_id=?1) OR EXISTS(SELECT 1 FROM codex_delivery_outbox WHERE job_id=?1))`).run(id).changes)===1n,commit:true}));
}
