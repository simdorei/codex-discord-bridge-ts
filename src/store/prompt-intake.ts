import type {DatabaseSync,SQLInputValue} from "node:sqlite";
import {randomUUID} from "node:crypto";
import {openInitialized} from "./owned-driver.ts";
import {migratePromptIntake} from "./schema-extensions-b1.ts";
import {decodeI64,decodeOptionalI64,decodeTimestamp,decodeTextField,textDecoderFor} from "./sqlite-values.ts";
import {reasonIn} from "./execution-hold.ts";
import {trimUnicodeWhitespace,takeUnicodeScalarChars} from "./queue-preflight-failure.ts";
import {UNRESOLVED_FORK_ERROR_PREFIX} from "./fork-definite-format.ts";
import {SystemTimeError} from "./queue-mark-running.ts";
export interface StoredPromptIntake {
  jobId:string;targetThreadId:string;channelId:bigint;ownerUserId:bigint|null;discordMessageId:bigint|null;rawPrompt:string;
  autoQueueWhenBusy:boolean;requireCurrentMirror:boolean;attemptCount:bigint;lastError:string;retryAfter:number;
  claimToken:string|null;claimExpiresAt:number;createdAt:number;updatedAt:number;
}
export interface PromptIntakeClaim {intake:StoredPromptIntake;claimToken:string}
export class PromptIntakeNotFoundError extends Error{
  readonly kind="PromptIntakeNotFound";readonly jobId:string;
  constructor(id:string){super(`durable prompt intake not found: ${id}`);this.name="PromptIntakeNotFoundError";this.jobId=id;}
}
function display(value:number):string{
  if(Number.isNaN(value))return "NaN";if(value===Infinity)return "inf";if(value===-Infinity)return "-inf";if(Object.is(value,-0))return "-0";
  const raw=String(value);if(!/[eE]/.test(raw))return raw;
  const [mantissa,exp]=raw.split("e"),sign=mantissa!.startsWith("-")?"-":"",unsigned=mantissa!.replace(/^-/,'');
  const point=unsigned.indexOf("."),digits=unsigned.replace(".",""),position=(point<0?digits.length:point)+Number(exp);
  return sign+(position<=0?"0."+"0".repeat(-position)+digits:position>=digits.length?digits+"0".repeat(position-digits.length):digits.slice(0,position)+"."+digits.slice(position));
}
export class InvalidPromptIntakeLeaseError extends Error{
  readonly kind="InvalidPromptIntakeLease";readonly now:number;readonly claimExpiresAt:number;
  constructor(now:number,expires:number){super(`invalid durable prompt intake claim lease: now=${display(now)}, claim_expires_at=${display(expires)}`);this.name="InvalidPromptIntakeLeaseError";this.now=now;this.claimExpiresAt=expires;}
}
export class InvalidPromptIntakeRetryError extends Error{
  readonly kind="InvalidPromptIntakeRetry";readonly retryAfter:number;
  constructor(value:number){super(`invalid durable prompt intake retry timestamp: ${display(value)}`);this.name="InvalidPromptIntakeRetryError";this.retryAfter=value;}
}
const COLUMNS="job_id,target_thread_id,channel_id,owner_user_id,discord_message_id,raw_prompt,auto_queue_when_busy,require_current_mirror,attempt_count,last_error,retry_after,claim_token,claim_expires_at,created_at,updated_at";
const TEXT=["job_id","target_thread_id","raw_prompt","last_error","claim_token"];
const SELECT=`SELECT ${COLUMNS},${TEXT.map(c=>`CAST(${c} AS BLOB) AS b_${c}`).join(",")},(SELECT encoding FROM pragma_encoding) AS encoding FROM codex_prompt_intakes`;
function decode(row:Record<string,unknown>):StoredPromptIntake{
  const decoder=textDecoderFor(row.encoding),text=(key:string,optional=false)=>decodeTextField(row[key],row["b_"+key],key,optional,decoder);
  // Keep Rust's field decoding order, including text after integer IDs.
  const jobId=text("job_id")!,targetThreadId=text("target_thread_id")!,channelId=decodeI64(row.channel_id,"channel_id"),
    ownerUserId=decodeOptionalI64(row.owner_user_id,"owner_user_id"),discordMessageId=decodeOptionalI64(row.discord_message_id,"discord_message_id"),
    rawPrompt=text("raw_prompt")!,autoQueueWhenBusy=decodeI64(row.auto_queue_when_busy,"auto_queue_when_busy")!==0n,
    requireCurrentMirror=decodeI64(row.require_current_mirror,"require_current_mirror")!==0n,attemptCount=decodeI64(row.attempt_count,"attempt_count"),
    lastError=text("last_error")!,retryAfter=decodeTimestamp(row.retry_after,"retry_after"),claimToken=text("claim_token",true),
    claimExpiresAt=decodeTimestamp(row.claim_expires_at,"claim_expires_at"),createdAt=decodeTimestamp(row.created_at,"created_at"),updatedAt=decodeTimestamp(row.updated_at,"updated_at");
  return {jobId,targetThreadId,channelId,ownerUserId,discordMessageId,rawPrompt,autoQueueWhenBusy,requireCurrentMirror,attemptCount,lastError,retryAfter,claimToken,claimExpiresAt,createdAt,updatedAt};
}
function validText(value:unknown):asserts value is string {
  if(typeof value!=="string"||/[\uD800-\uDFFF]/u.test(value))throw new TypeError("Expected well-formed text");
}
function one(db:DatabaseSync,where:string,param:SQLInputValue):StoredPromptIntake|null{
  const query=db.prepare(SELECT+where);query.setReadBigInts(true);const row=query.get(param);return row===undefined?null:decode(row);
}
export function getPromptIntakeIn(db:DatabaseSync,id:string):StoredPromptIntake|null{validText(id);return one(db," WHERE job_id=?",id);}
export function promptIntakeByMessageIn(db:DatabaseSync,id:bigint):StoredPromptIntake|null{return one(db," WHERE discord_message_id=?",id);}
export async function getPromptIntake(path:string,id:string):Promise<StoredPromptIntake|null>{
  validText(path);validText(id);const db=await openInitialized(path);try{migratePromptIntake(db);return getPromptIntakeIn(db,id);}finally{db.close();}
}
export async function listPromptIntakes(path:string,readyAt:number|null=null):Promise<StoredPromptIntake[]>{
  validText(path);if(readyAt!==null&&typeof readyAt!=="number")throw new TypeError("Expected readiness timestamp");
  const db=await openInitialized(path);try{
    migratePromptIntake(db);const query=db.prepare(SELECT+(readyAt===null?"":" WHERE retry_after<=? AND claim_expires_at<=?")+" ORDER BY created_at,job_id");
    query.setReadBigInts(true);const rows=readyAt===null?query.iterate():query.iterate(readyAt,readyAt);const result:StoredPromptIntake[]=[];for(const row of rows)result.push(decode(row));return result;
  }finally{db.close();}
}
export async function promptIntakeHasDurableOwner(path:string,id:string):Promise<boolean>{
  validText(path);validText(id);
  const db=await openInitialized(path);try{migratePromptIntake(db);
    const query=db.prepare("SELECT NOT EXISTS(SELECT 1 FROM codex_prompt_intakes WHERE job_id=?1) AND (EXISTS(SELECT 1 FROM codex_turn_queue WHERE job_id=?1) OR EXISTS(SELECT 1 FROM codex_delivery_outbox WHERE job_id=?1)) AS owned");
    query.setReadBigInts(true);return decodeI64(query.get(id)?.owned,"owned")!==0n;
  }finally{db.close();}
}
async function writer<T>(path:string,work:(db:DatabaseSync)=>{value:T;commit:boolean},ensureSchema=true):Promise<T>{
  validText(path);const db=await openInitialized(path);let committed=false;
  try{db.exec("BEGIN IMMEDIATE");if(ensureSchema)migratePromptIntake(db);const result=work(db);if(result.commit){db.exec("COMMIT");committed=true;}return result.value;}
  finally{if(!committed&&db.isTransaction){try{db.exec("ROLLBACK");}catch{/* close rolls back */}}db.close();}
}
function lease(now:number,expires:number):void{
  if(typeof now!=="number"||typeof expires!=="number")throw new TypeError("Expected lease timestamps");
  if(!Number.isFinite(now)||!Number.isFinite(expires)||expires<=now)throw new InvalidPromptIntakeLeaseError(now,expires);
}
export async function tryClaimPromptIntake(path:string,id:string,now:number,expires:number):Promise<PromptIntakeClaim|null>{
  validText(id);lease(now,expires);const token=randomUUID();
  return writer(path,db=>{
    if(reasonIn(db,id)!==null)return {value:null,commit:false};
    const changed=db.prepare(`UPDATE codex_prompt_intakes SET claim_token=?,claim_expires_at=?,updated_at=?
      WHERE job_id=? AND retry_after<=? AND claim_expires_at<=? AND NOT EXISTS(SELECT 1 FROM codex_dead_generation_holds hold
        WHERE hold.target_thread_id=codex_prompt_intakes.target_thread_id)`).run(token,expires,now,id,now,now).changes;
    if(BigInt(changed)!==1n)return {value:null,commit:true};
    const intake=getPromptIntakeIn(db,id);if(intake===null)throw new PromptIntakeNotFoundError(id);
    return {value:{intake,claimToken:token},commit:true};
  });
}
export async function renewPromptIntakeClaimIfCurrent(path:string,claim:PromptIntakeClaim,now:number,expires:number):Promise<PromptIntakeClaim|null>{
  lease(now,expires);const id=claim.intake.jobId,token=claim.claimToken;validText(id);validText(token);
  return writer(path,db=>{
    const changed=db.prepare("UPDATE codex_prompt_intakes SET claim_expires_at=?,updated_at=? WHERE job_id=? AND claim_token=? AND claim_expires_at>? AND claim_expires_at<?").run(expires,now,id,token,now,expires).changes;
    if(BigInt(changed)!==1n)return {value:null,commit:true};
    const intake=getPromptIntakeIn(db,id);if(intake===null)throw new PromptIntakeNotFoundError(id);
    return {value:{intake,claimToken:token},commit:true};
  });
}
/** Startup only, after the process has acquired the singleton runtime guard. Never periodic recovery. */
export async function releaseAllPromptIntakeClaims(path:string):Promise<bigint>{
  return writer(path,db=>({value:BigInt(db.prepare("UPDATE codex_prompt_intakes SET claim_token=NULL,claim_expires_at=0 WHERE claim_token IS NOT NULL OR claim_expires_at!=0").run().changes),commit:true}));
}
export async function recordPromptIntakeFailureIfClaimed(path:string,claim:PromptIntakeClaim,error:string,retryAfter:number):Promise<StoredPromptIntake|null>{
  if(typeof retryAfter!=="number")throw new TypeError("Expected retry timestamp");
  if(!Number.isFinite(retryAfter))throw new InvalidPromptIntakeRetryError(retryAfter);
  if(typeof error!=="string"||/[\uD800-\uDFFF]/u.test(error))throw new TypeError("Expected well-formed error");
  const bounded=takeUnicodeScalarChars(trimUnicodeWhitespace(error)||"prompt intake processing failed without an error message",1000),ms=Date.now();
  if(ms<0)throw new SystemTimeError(-ms);if(!Number.isFinite(ms))throw new TypeError("system clock must be finite");
  const id=claim.intake.jobId,token=claim.claimToken;validText(id);validText(token);
  return writer(path,db=>{
    const changed=db.prepare(`UPDATE codex_prompt_intakes SET attempt_count=CASE WHEN attempt_count<9223372036854775807 THEN attempt_count+1 ELSE attempt_count END,
      last_error=CASE WHEN instr(last_error,?)=1 THEN last_error ELSE ? END,retry_after=?,claim_token=NULL,claim_expires_at=0,updated_at=? WHERE job_id=? AND claim_token=?`)
      .run(UNRESOLVED_FORK_ERROR_PREFIX,bounded,retryAfter,ms/1000,id,token).changes;
    return {value:BigInt(changed)===1n?getPromptIntakeIn(db,id):null,commit:true};
  });
}

export {writer as withPromptIntakeWriter};
